import { useState, useEffect, useRef, useCallback } from "react";
import type { WebContainer, FileSystemTree } from "@webcontainer/api";

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

export interface UseWebContainerResult {
  status: WebContainerStatus;
  statusLabel: string;
  previewUrl: string | null;
  error: string | null;
  logs: WebContainerLog[];
  syncFile: (path: string, content: string) => Promise<void>;
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
        const res = await fetch(`/api/projects/${pid}/files/all-content`);
        if (!res.ok) throw new Error(`Failed to fetch files: ${res.statusText}`);
        const files = (await res.json()) as Array<{ path: string; content: string }>;
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
    restart,
  };
}
