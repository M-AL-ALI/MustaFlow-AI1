import { useState, useEffect, useRef, useCallback } from "react";
import type { WebContainer, FileSystemTree } from "@webcontainer/api";
import { getProjectAllFileContent } from "@workspace/api-client-react";
import type { ProjectFilesChangedPayload } from "@/lib/event-types";

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

/** Simple djb2-style hash — good enough to detect package.json drift. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

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

  const wcRef = useRef<WebContainer | null>(null);
  const devProcessRef = useRef<{ kill: () => void } | null>(null);
  const mountedRef = useRef(true);
  const projectIdRef = useRef(projectId);
  const serverReadyListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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

      setStatus("booting");
      setError(null);
      setPreviewUrl(null);
      setLogs([]);

      try {
        addLog("[WC] Booting WebContainer…");
        const wc = await acquireWebContainer();
        if (!mountedRef.current || projectIdRef.current !== pid) return;
        wcRef.current = wc;

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

        // Kill any existing dev process
        devProcessRef.current?.kill();
        devProcessRef.current = null;

        // Package install caching: hash the package.json to skip npm install
        // when dependencies haven't changed since the last successful boot.
        const pkgFile = files.find((f) => f.path === "package.json");
        const pkgHash = pkgFile ? hashString(pkgFile.content) : "";
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

  // Listen for file-saved events from the code editor and sync to the running WC FS
  const syncFile = useCallback(async (path: string, content: string) => {
    const wc = wcRef.current;
    if (!wc) return;
    try {
      const segments = path.split("/");
      if (segments.length > 1) {
        const dir = segments.slice(0, -1).join("/");
        await wc.fs.mkdir(dir, { recursive: true });
      }
      await wc.fs.writeFile(path, content);
    } catch {
      // Non-fatal: Vite HMR will handle retry on next hot-update
    }
  }, []);

  /**
   * Sync a batch of backend-written files into the WebContainer FS.
   * Called from PreviewTab when a project_files_changed SSE event arrives.
   * - Writes all changed files (creating parent dirs as needed).
   * - Removes deleted files (best-effort, non-fatal).
   * - Re-runs npm install + restart when package.json changes.
   * - Restarts dev server (no install) when vite.config/tsconfig/.env changes.
   * - Otherwise Vite HMR picks up changes without a restart.
   */
  const syncFromBackend = useCallback(
    async (payload: ProjectFilesChangedPayload): Promise<void> => {
      const wc = wcRef.current;
      if (!wc) return;

      // Write all changed files
      for (const [path, content] of Object.entries(payload.files)) {
        try {
          const segments = path.split("/");
          if (segments.length > 1) {
            const dir = segments.slice(0, -1).join("/");
            await wc.fs.mkdir(dir, { recursive: true });
          }
          await wc.fs.writeFile(path, content);
        } catch {
          // Non-fatal: continue with remaining files
        }
      }

      // Remove deleted files (best-effort)
      for (const path of payload.removedPaths) {
        try {
          await wc.fs.rm(path);
        } catch {
          // Non-fatal: file may already not exist
        }
      }

      // Helper: resolves when WC emits "server-ready" (or after 30 s timeout).
      // Additive to the boot-flow serverReadyListenerRef — does not interfere with it.
      const waitForServerReady = (): Promise<void> =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          const unlisten = wc.on("server-ready", () => {
            clearTimeout(timer);
            unlisten();
            resolve();
          });
        });

      if (payload.requiresInstall) {
        // Kill dev server, reinstall, restart
        devProcessRef.current?.kill();
        devProcessRef.current = null;
        if (!mountedRef.current) return;
        setStatus("installing");
        addLog("[WC] package.json changed — running npm install…");
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
          if (!mountedRef.current) return;
          if (exitCode !== 0) {
            addLog("[WC] npm install failed — dev server not restarted");
            setStatus("error");
            return;
          }
          const pkgContent = payload.files["package.json"];
          if (pkgContent) _installHashCache.set(projectIdRef.current, hashString(pkgContent));
        } catch (err) {
          addLog(`[WC] npm install error: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (!mountedRef.current) return;
        setStatus("starting");
        addLog("[WC] Restarting dev server…");
        try {
          const devProcess = await wc.spawn("npm", ["run", "dev"]);
          devProcessRef.current = devProcess;
          devProcess.output.pipeTo(
            new WritableStream({
              write(chunk: string) {
                addLog(chunk);
              },
            }),
          );
          // Await server-ready so callers (e.g. refreshTrigger effect) delay iframe
          // reload until the new server is actually serving requests.
          await waitForServerReady();
        } catch (err) {
          addLog(
            `[WC] Dev server restart failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (payload.requiresRestart) {
        // Config changed — kill and restart without reinstalling
        devProcessRef.current?.kill();
        devProcessRef.current = null;
        if (!mountedRef.current) return;
        setStatus("starting");
        addLog("[WC] Config file changed — restarting dev server…");
        try {
          const devProcess = await wc.spawn("npm", ["run", "dev"]);
          devProcessRef.current = devProcess;
          devProcess.output.pipeTo(
            new WritableStream({
              write(chunk: string) {
                addLog(chunk);
              },
            }),
          );
          // Await server-ready so callers delay iframe reload until the server is up.
          await waitForServerReady();
        } catch (err) {
          addLog(
            `[WC] Dev server restart failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // If neither requiresInstall nor requiresRestart, Vite HMR picks up the
      // FS writes automatically — no explicit restart needed.
    },
    [addLog],
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
