import { useState, useEffect, useRef, useCallback } from "react";
import type { WebContainer, FileSystemTree } from "@webcontainer/api";
import { getProjectAllFileContent } from "@workspace/api-client-react";
import type { ProjectFilesChangedPayload } from "@/lib/event-types";
import { logPreviewTiming } from "@/lib/preview-reconciliation";
import {
  hashWebContainerContent,
  isDevServerConfigPath,
  isPackageDependencyPath,
  WebContainerSyncController,
} from "./web-container-sync";

export type WebContainerStatus =
  | "idle"
  | "booting"
  | "installing"
  | "starting"
  | "ready"
  | "error"
  | "unsupported";

export type WebContainerLog = {
  id: number;
  text: string;
  ts: number;
};

/**
 * Payload shape for a backend `project_files_changed` event.
 * Mirrors `ProjectFilesChangedPayload` from the API server but defined here
 * so the frontend has no server-side import dependency.
 */
export interface BackendFilesPayload {
  projectId: number;
  revision: number;
  operationType: string;
  /** All paths that changed (includes files excluded from `files` map due to size/binary). */
  changedPaths: string[];
  /** Paths that were deleted. */
  removedPaths: string[];
  /** Content of safe text files keyed by path. */
  files: Record<string, string>;
  /** True when package.json or lockfile changed — must run npm install. */
  requiresInstall: boolean;
  /** True when a config that requires a dev-server restart changed. */
  requiresRestart: boolean;
  generatedAt: string;
  authoritative?: boolean;
}

export interface UseWebContainerResult {
  status: WebContainerStatus;
  statusLabel: string;
  previewUrl: string | null;
  error: string | null;
  logs: WebContainerLog[];
  syncFile: (path: string, content: string) => Promise<void>;
  syncFromBackend: (payload: ProjectFilesChangedPayload) => Promise<void>;
  restart: () => void;
}

export const STATUS_LABELS: Record<WebContainerStatus, string> = {
  idle: "Initializing…",
  booting: "Booting container…",
  installing: "Installing packages…",
  starting: "Starting dev server…",
  ready: "Ready",
  error: "Error",
  unsupported: "Live preview unavailable",
};

// Module-level singleton — only one WebContainer can boot per browser tab.
let _wcInstance: WebContainer | null = null;
let _wcBootPromise: Promise<WebContainer> | null = null;

// Install cache: tracks the last package.json content hash per project so that
// subsequent boots for the same project skip `npm install` when package.json is
// unchanged (dependencies are already in node_modules from the previous mount).
const _installHashCache = new Map<number, string>();

async function acquireWebContainer(): Promise<WebContainer> {
  if (_wcInstance) return _wcInstance;
  if (_wcBootPromise) {
    _wcInstance = await _wcBootPromise;
    return _wcInstance;
  }
  const { WebContainer } = await import("@webcontainer/api");
  _wcBootPromise = WebContainer.boot();
  _wcInstance = await _wcBootPromise;
  return _wcInstance;
}

function buildFileSystemTree(files: Array<{ path: string; content: string }>): FileSystemTree {
  const tree: FileSystemTree = {};
  for (const file of files) {
    const parts = file.path.split("/");
    let node: FileSystemTree = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!node[part]) {
        node[part] = { directory: {} };
      }
      const entry = node[part];
      if (typeof entry === "object" && "directory" in entry) {
        node = entry.directory as FileSystemTree;
      }
    }
    const filename = parts[parts.length - 1]!;
    node[filename] = { file: { contents: file.content } };
  }
  return tree;
}

let logIdCounter = 0;

function detectSupport(): boolean {
  try {
    return typeof SharedArrayBuffer !== "undefined" && window.crossOriginIsolated === true;
  } catch {
    return false;
  }
}

export function useWebContainer({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): UseWebContainerResult {
  const isSupported = detectSupport();

  const [status, setStatus] = useState<WebContainerStatus>(!isSupported ? "unsupported" : "idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<WebContainerLog[]>([]);

  const devProcessRef = useRef<{ kill: () => void } | null>(null);
  const syncControllerRef = useRef<WebContainerSyncController | null>(null);
  const mountedRef = useRef(true);
  const projectIdRef = useRef(projectId);
  const serverReadyListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      syncControllerRef.current?.dispose();
      syncControllerRef.current = null;
      devProcessRef.current?.kill();
      devProcessRef.current = null;
    };
  }, []);

  const addLog = useCallback((text: string) => {
    if (!mountedRef.current) return;
    setLogs((prev) => [...prev.slice(-499), { id: logIdCounter++, text, ts: Date.now() }]);
  }, []);

  const boot = useCallback(
    async (pid: number) => {
      if (!isSupported || !enabled) return;

      syncControllerRef.current?.dispose();
      syncControllerRef.current = null;
      setStatus("booting");
      setError(null);
      setPreviewUrl(null);
      setLogs([]);

      try {
        addLog("[WC] Booting WebContainer…");
        const wc = await acquireWebContainer();
        if (!mountedRef.current || projectIdRef.current !== pid) return;

        // Fetch all project files with content in one shot
        addLog("[WC] Fetching project files…");
        const files = await getProjectAllFileContent(pid);
        if (!mountedRef.current || projectIdRef.current !== pid) return;

        if (files.length === 0) {
          setStatus("idle");
          return;
        }

        addLog(`[WC] Mounting ${files.length} files to virtual FS…`);
        const tree = buildFileSystemTree(files);
        await wc.mount(tree);
        if (!mountedRef.current || projectIdRef.current !== pid) return;
        addLog("[WC] Files mounted.");

        // Register the server-ready listener — remove previous one first
        if (serverReadyListenerRef.current) {
          serverReadyListenerRef.current();
          serverReadyListenerRef.current = null;
        }
        const unlisten = wc.on("server-ready", (port, url) => {
          if (!mountedRef.current || projectIdRef.current !== pid) return;
          addLog(`[WC] Dev server ready on port ${port}: ${url}`);
          setPreviewUrl(url);
          setStatus("ready");
        });
        serverReadyListenerRef.current = unlisten;

        const waitForServerReady = (): Promise<void> =>
          new Promise<void>((resolve) => {
            let stopListening = (): void => {};
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              stopListening();
              resolve();
            };
            const timer = setTimeout(finish, 30_000);
            stopListening = wc.on("server-ready", finish);
          });

        const syncController = new WebContainerSyncController(
          {
            writeFile: async (path, content) => {
              const segments = path.split("/");
              if (segments.length > 1) {
                await wc.fs.mkdir(segments.slice(0, -1).join("/"), { recursive: true });
              }
              await wc.fs.writeFile(path, content);
            },
            removeFile: async (path) => {
              await wc.fs.rm(path);
            },
            installDependencies: async (changedFiles) => {
              addLog("[WC] Dependency manifest changed — running npm install once…");
              try {
                const installProcess = await wc.spawn("npm", ["install"]);
                installProcess.output.pipeTo(
                  new WritableStream({
                    write(chunk: string) {
                      addLog(chunk);
                    },
                  }),
                );
                const exitCode = await installProcess.exit;
                if (!mountedRef.current || projectIdRef.current !== pid) return false;
                if (exitCode !== 0) {
                  addLog("[WC] npm install failed — keeping the current dev server running.");
                  return false;
                }

                const packageJson = changedFiles.find((file) => file.path === "package.json");
                if (packageJson?.content !== undefined) {
                  _installHashCache.set(pid, hashWebContainerContent(packageJson.content));
                }
                return true;
              } catch (err) {
                addLog(
                  `[WC] npm install error — keeping the current dev server running: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                return false;
              }
            },
            restartDevServer: async () => {
              devProcessRef.current?.kill();
              devProcessRef.current = null;
              if (!mountedRef.current || projectIdRef.current !== pid) return;

              setStatus("starting");
              addLog("[WC] Dev-server config changed — restarting once…");
              try {
                const ready = waitForServerReady();
                const devProcess = await wc.spawn("npm", ["run", "dev"]);
                devProcessRef.current = devProcess;
                devProcess.output.pipeTo(
                  new WritableStream({
                    write(chunk: string) {
                      addLog(chunk);
                    },
                  }),
                );
                await ready;
              } catch (err) {
                setStatus("error");
                addLog(
                  `[WC] Dev server restart failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            },
            warn: addLog,
          },
          {
            onTiming: (phase, payload, timestamp) => {
              if (payload.revision <= 0) return;
              logPreviewTiming({
                phase,
                projectId: payload.projectId,
                revision: payload.revision,
                ...(phase === "sync_finish"
                  ? { syncFinishedAt: timestamp }
                  : { webContainerReadyAt: timestamp }),
              });
            },
          },
        );
        syncController.seed(files);
        syncControllerRef.current = syncController;

        // Kill any existing dev process
        devProcessRef.current?.kill();
        devProcessRef.current = null;

        // Package install caching: hash the package.json to skip npm install
        // when dependencies haven't changed since the last successful boot.
        const pkgFile = files.find((f) => f.path === "package.json");
        const pkgHash = pkgFile ? hashWebContainerContent(pkgFile.content) : "";
        const cachedHash = _installHashCache.get(pid);
        const installNeeded = !pkgHash || pkgHash !== cachedHash;

        if (installNeeded) {
          setStatus("installing");
          addLog("[WC] Running npm install…");
          const installProcess = await wc.spawn("npm", ["install"]);
          installProcess.output.pipeTo(
            new WritableStream({
              write(chunk: string) {
                addLog(chunk);
              },
            }),
          );
          const installExit = await installProcess.exit;
          if (!mountedRef.current || projectIdRef.current !== pid) return;
          if (installExit !== 0) {
            throw new Error(`npm install failed (exit code ${installExit})`);
          }
          if (pkgHash) _installHashCache.set(pid, pkgHash);
        } else {
          addLog("[WC] Skipping npm install — package.json unchanged (cached).");
        }

        setStatus("starting");
        addLog("[WC] Starting dev server…");
        const devProcess = await wc.spawn("npm", ["run", "dev"]);
        devProcessRef.current = devProcess;
        devProcess.output.pipeTo(
          new WritableStream({
            write(chunk: string) {
              addLog(chunk);
            },
          }),
        );
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
        addLog(`[WC] Error: ${msg}`);
      }
    },
    [isSupported, enabled, addLog],
  );

  // Boot (or re-boot) when project changes
  useEffect(() => {
    if (!enabled || !isSupported) return;
    projectIdRef.current = projectId;
    void boot(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled, isSupported]);

  // Code-editor saves and backend SSE payloads share one content-aware queue.
  // Duplicate task/project events and generation bursts are coalesced before
  // touching the virtual FS, so ordinary source updates remain HMR-only.
  const syncFile = useCallback(async (path: string, content: string) => {
    await syncControllerRef.current?.enqueue({
      projectId: projectIdRef.current,
      revision: 0,
      operationType: "manual-save",
      changedPaths: [path],
      removedPaths: [],
      files: { [path]: content },
      requiresInstall: isPackageDependencyPath(path),
      requiresRestart: isDevServerConfigPath(path),
      generatedAt: new Date().toISOString(),
      authoritative: false,
    });
  }, []);

  const syncFromBackend = useCallback(
    async (payload: ProjectFilesChangedPayload): Promise<void> => {
      await syncControllerRef.current?.enqueue(payload);
    },
    [],
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const { path, content } = (e as CustomEvent<{ path: string; content: string }>).detail;
      void syncFile(path, content);
    };
    window.addEventListener("mustaflow:file-saved", handler);
    return () => window.removeEventListener("mustaflow:file-saved", handler);
  }, [syncFile]);

  const restart = useCallback(() => {
    devProcessRef.current?.kill();
    devProcessRef.current = null;
    void boot(projectIdRef.current);
  }, [boot]);

  if (!isSupported) {
    return {
      status: "unsupported",
      statusLabel: STATUS_LABELS.unsupported,
      previewUrl: null,
      error: null,
      logs: [],
      syncFile: async () => {},
      syncFromBackend: async () => {},
      restart: () => {},
    };
  }

  return {
    status,
    statusLabel: STATUS_LABELS[status],
    previewUrl,
    error,
    logs,
    syncFile,
    syncFromBackend,
    restart,
  };
}
