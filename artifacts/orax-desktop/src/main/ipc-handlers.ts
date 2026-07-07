import { ipcMain, dialog, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import type { AuthAdapter } from "./auth";
import type { HostManager } from "./host-manager";
import type { PairingManager } from "./pairing-manager";
import type { LocalProjectsManager } from "./local-projects";
import type { RelayClient } from "./relay-client";
import type { PermissionMode } from "../shared/types";
import { buildSupportDiagnostics } from "./support-diagnostics";

interface Deps {
  auth: AuthAdapter;
  hostManager: HostManager;
  pairingManager: PairingManager;
  localProjects: LocalProjectsManager;
  relayClient: RelayClient;
  win: BrowserWindow;
}

export function registerIpcHandlers(deps: Deps): void {
  const { auth, hostManager, pairingManager, localProjects, relayClient, win } = deps;

  ipcMain.handle("auth:getSession", async () => {
    const session = await auth.getSession();
    if (!session) return null;
    return { userId: session.userId, email: session.email, displayName: session.displayName };
  });

  ipcMain.handle("auth:startSignIn", async () => {
    await auth.startSignIn();
  });

  ipcMain.handle("auth:signOut", async () => {
    await auth.signOut();
    relayClient.stop();
    hostManager.stop();
    pairingManager.clearState();
  });

  ipcMain.handle("host:register", async () => {
    return hostManager.register();
  });

  ipcMain.handle("host:getStatus", () => {
    return hostManager.getState();
  });

  ipcMain.handle("host:updatePermissionMode", async (_event, mode: PermissionMode) => {
    await hostManager.updatePermissionMode(mode);
  });

  ipcMain.handle("pairing:create", async () => {
    const { hostId } = hostManager.getState();
    if (!hostId) throw new Error("Host not registered");
    return pairingManager.createCode(hostId);
  });

  ipcMain.handle("pairing:cancel", async () => {
    await pairingManager.cancelCode();
  });

  ipcMain.handle("project:listLocalFolders", () => {
    return localProjects.list();
  });

  ipcMain.handle("project:addLocalFolder", async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Add Local Project Folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return localProjects.add(result.filePaths[0]!);
  });

  ipcMain.handle("project:removeLocalFolder", (_event, id: string) => {
    localProjects.remove(id);
  });

  ipcMain.handle("project:listCloudProjects", async () => {
    const session = await auth.getSession();
    if (!session) return { projects: [] };
    const apiBase = process.env.VITE_API_BASE_URL ?? "https://mustaflow.app";
    const res = await fetch(`${apiBase}/api/orax/projects`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) return { projects: [] };
    return res.json() as Promise<{ projects: unknown[] }>;
  });

  ipcMain.handle("project:createCloudProject", async (_event, name: string) => {
    const session = await auth.getSession();
    if (!session) throw new Error("Not signed in");
    const apiBase = process.env.VITE_API_BASE_URL ?? "https://mustaflow.app";
    const res = await fetch(`${apiBase}/api/orax/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Failed to create project: ${res.status}`);
    return res.json() as Promise<{ project: unknown }>;
  });

  ipcMain.handle("project:attachLocalFolderToProject", async (_event, projectId: string) => {
    const session = await auth.getSession();
    if (!session) throw new Error("Not signed in");
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Select folder to attach to project",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const localPath = result.filePaths[0]!;
    localProjects.add(localPath);
    const apiBase = process.env.VITE_API_BASE_URL ?? "https://mustaflow.app";
    const res = await fetch(`${apiBase}/api/orax/projects/${projectId}/sources/local-folder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localPath, displayName: localPath.split("/").pop() }),
    });
    if (!res.ok) throw new Error(`Failed to attach folder: ${res.status}`);
    return res.json() as Promise<{ source: unknown }>;
  });

  ipcMain.handle("app:getVersion", () => {
    const { app } = require("electron") as typeof import("electron");
    return app.getVersion();
  });

  ipcMain.handle("support:exportDiagnostics", async () => {
    const session = await auth.getSession();
    const diagnostics = buildSupportDiagnostics({
      session,
      hostState: hostManager.getState(),
      relayState: relayClient.getState(),
      localProjects: localProjects.list(),
    });
    const defaultPath = `orax-desktop-diagnostics-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    const result = await dialog.showSaveDialog(win, {
      title: "Export Orax Support Diagnostics",
      defaultPath,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await writeFile(result.filePath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
    return { filePath: result.filePath, diagnostics };
  });

  ipcMain.handle("relay:getStatus", () => {
    return relayClient.getState();
  });

  /**
   * project:runProjectThread
   *
   * Called by the renderer when Orax Desktop picks up a run_project_thread
   * action from the relay. Verifies that the local folder is bound to the
   * correct cloud project by reading (or writing) .orax/project.json.
   *
   * If .orax/project.json already exists and contains a different projectId,
   * the handler throws an error (mismatch) and execution is refused.
   * On first bind the file is created with projectId + executionSourceId.
   */
  ipcMain.handle(
    "project:runProjectThread",
    async (
      _event,
      params: {
        projectId: string;
        threadId: string;
        executionSourceId: string;
        localPath: string;
      },
    ) => {
      const { projectId, threadId, executionSourceId, localPath } = params;

      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      const projectJsonPath = path.join(localPath, ".orax", "project.json");

      let storedProjectId: string | null = null;
      try {
        const raw = await fs.readFile(projectJsonPath, "utf-8");
        const data = JSON.parse(raw) as { projectId?: string; executionSourceId?: string };
        storedProjectId = data.projectId ?? null;
      } catch {
        // File does not exist — first bind; we will create it below.
      }

      if (storedProjectId && storedProjectId !== projectId) {
        throw new Error(
          `.orax/project.json mismatch: this folder is bound to project ${storedProjectId}, not ${projectId}. ` +
            `Detach the folder from its current project before attaching it here.`,
        );
      }

      if (!storedProjectId) {
        const dir = path.join(localPath, ".orax");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          projectJsonPath,
          JSON.stringify(
            {
              projectId,
              executionSourceId,
              threadId,
              boundAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          "utf-8",
        );
      }

      return { ok: true, projectId, executionSourceId };
    },
  );

  hostManager.setOnChange((state) => {
    if (!win.isDestroyed()) win.webContents.send("host:stateChanged", state);
    if (state.status === "online" && state.hostId) {
      relayClient.start();
    } else if (state.status === "offline" || state.status === "unregistered") {
      relayClient.stop();
    }
  });

  pairingManager.setOnChange((state) => {
    if (!win.isDestroyed()) win.webContents.send("pairing:stateChanged", state);
  });

  relayClient.setOnChange((state) => {
    if (!win.isDestroyed()) win.webContents.send("relay:statusChanged", state);
  });
}
