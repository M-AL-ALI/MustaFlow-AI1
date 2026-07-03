import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { createAuthAdapter } from "./auth";
import { getOrCreateInstallIdentity } from "./install-identity";
import { OraxApiClient } from "./api-client";
import { HostManager } from "./host-manager";
import { PairingManager } from "./pairing-manager";
import { LocalProjectsManager } from "./local-projects";
import { RelayClient } from "./relay-client";
import { registerIpcHandlers } from "./ipc-handlers";

app.setName("Orax Desktop");

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app
  .whenReady()
  .then(() => {
    const identity = getOrCreateInstallIdentity();
    const auth = createAuthAdapter();
    const apiClient = new OraxApiClient(() => auth.getSession().then((s) => s?.token ?? null));
    const hostManager = new HostManager(apiClient, identity);
    const pairingManager = new PairingManager(apiClient);
    const localProjects = new LocalProjectsManager();
    const relayClient = new RelayClient(apiClient, hostManager, localProjects);

    mainWindow = createWindow();

    registerIpcHandlers({
      auth,
      hostManager,
      pairingManager,
      localProjects,
      relayClient,
      win: mainWindow,
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  })
  .catch((err: unknown) => {
    console.error("[Main] startup error:", err);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
