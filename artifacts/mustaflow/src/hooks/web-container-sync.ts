import type { ProjectFilesChangedPayload } from "@/lib/event-types";

const PACKAGE_FILES = new Set(["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

const RESTART_PATTERNS = [
  /^vite\.config\.[jt]s$/,
  /^webpack\.config\.[jt]s$/,
  /^tsconfig.*\.json$/,
  /^\.env(\.[^/]+)?$/,
  /^next\.config\.[jt]s$/,
  /^svelte\.config\.[jt]s$/,
  /^nuxt\.config\.[jt]s$/,
  /^remix\.config\.[jt]s$/,
  /^astro\.config\.[jt]s$/,
  /^babel\.config\.[jt]s$/,
  /^rollup\.config\.[jt]s$/,
  /^metro\.config\.[jt]s$/,
  /^app\.json$/,
];

export const PREVIEW_SYNC_SAFETY_WARNING =
  "[WC] Preview sync paused after repeated install/restart requests; keeping the last good dev server running.";

export interface WebContainerSyncAdapter {
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  installDependencies: (
    changedFiles: Array<{ path: string; content: string | undefined }>,
  ) => Promise<boolean>;
  restartDevServer: () => Promise<void>;
  warn: (message: string) => void;
}

export interface WebContainerSyncOptions {
  debounceMs?: number;
  maxLifecycleActions?: number;
  lifecycleWindowMs?: number;
  now?: () => number;
  onTiming?: (
    phase: "sync_finish" | "webcontainer_ready",
    payload: ProjectFilesChangedPayload,
    timestamp: string,
  ) => void;
}

export interface WebContainerSyncResult {
  writtenPaths: string[];
  removedPaths: string[];
  skippedPaths: string[];
  installRan: boolean;
  restartRan: boolean;
  safetyBrakeEngaged: boolean;
}

type PendingWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export function isPackageDependencyPath(path: string): boolean {
  return PACKAGE_FILES.has(basename(path));
}

export function isDevServerConfigPath(path: string): boolean {
  const name = basename(path);
  return RESTART_PATTERNS.some((pattern) => pattern.test(name));
}

/** Simple djb2-style hash, sufficient for byte-change detection in preview sync. */
export function hashWebContainerContent(content: string): string {
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function mergeProjectFilePayloads(
  current: ProjectFilesChangedPayload | null,
  incoming: ProjectFilesChangedPayload,
): ProjectFilesChangedPayload {
  if (!current || current.projectId !== incoming.projectId) {
    return {
      ...incoming,
      changedPaths: [...incoming.changedPaths],
      removedPaths: [...incoming.removedPaths],
      files: { ...incoming.files },
    };
  }

  const files = { ...current.files, ...incoming.files };
  const removedPaths = new Set([...current.removedPaths, ...incoming.removedPaths]);

  for (const path of Object.keys(incoming.files)) {
    removedPaths.delete(path);
  }
  for (const path of incoming.removedPaths) {
    delete files[path];
  }

  return {
    projectId: incoming.projectId,
    revision: Math.max(current.revision, incoming.revision),
    operationType: incoming.operationType,
    changedPaths: Array.from(new Set([...current.changedPaths, ...incoming.changedPaths])),
    removedPaths: Array.from(removedPaths),
    files,
    requiresInstall: current.requiresInstall || incoming.requiresInstall,
    requiresRestart: current.requiresRestart || incoming.requiresRestart,
    generatedAt: incoming.generatedAt,
    authoritative: current.authoritative === true || incoming.authoritative === true,
  };
}

/**
 * Serializes and coalesces backend file bursts before applying them to a
 * WebContainer. Decisions are based on content that actually changed, not on
 * repeated SSE hints, so duplicate task/project events are harmless.
 */
export class WebContainerSyncController {
  private readonly debounceMs: number;
  private readonly maxLifecycleActions: number;
  private readonly lifecycleWindowMs: number;
  private readonly now: () => number;
  private readonly onTiming: WebContainerSyncOptions["onTiming"];
  private readonly knownHashes = new Map<string, string>();
  private readonly lifecycleActionTimes: number[] = [];
  private pendingPayload: ProjectFilesChangedPayload | null = null;
  private pendingWaiters: PendingWaiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private safetyWarningShown = false;
  private disposed = false;
  private lastResult: WebContainerSyncResult | null = null;

  constructor(
    private readonly adapter: WebContainerSyncAdapter,
    options: WebContainerSyncOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 250;
    this.maxLifecycleActions = options.maxLifecycleActions ?? 3;
    this.lifecycleWindowMs = options.lifecycleWindowMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onTiming = options.onTiming;
  }

  seed(files: Array<{ path: string; content: string }>): void {
    this.knownHashes.clear();
    for (const file of files) {
      this.knownHashes.set(file.path, hashWebContainerContent(file.content));
    }
  }

  enqueue(payload: ProjectFilesChangedPayload): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pendingPayload = mergeProjectFilePayloads(this.pendingPayload, payload);

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingWaiters.push({ resolve, reject });
    });
    this.schedule();
    return promise;
  }

  async flushNow(): Promise<WebContainerSyncResult | null> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.running) {
      await this.running;
      if (this.pendingPayload) return this.flushNow();
      return this.lastResult;
    }

    if (!this.pendingPayload || this.disposed) return this.lastResult;

    const payload = this.pendingPayload;
    const waiters = this.pendingWaiters;
    this.pendingPayload = null;
    this.pendingWaiters = [];

    this.running = this.applyPayload(payload)
      .then((result) => {
        this.lastResult = result;
        for (const waiter of waiters) waiter.resolve();
      })
      .catch((error) => {
        for (const waiter of waiters) waiter.reject(error);
      })
      .finally(() => {
        this.running = null;
        if (this.pendingPayload && !this.disposed) this.schedule();
      });

    await this.running;
    return this.lastResult;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingPayload = null;
    for (const waiter of this.pendingWaiters) waiter.resolve();
    this.pendingWaiters = [];
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  private allowLifecycleAction(): boolean {
    const cutoff = this.now() - this.lifecycleWindowMs;
    while (
      this.lifecycleActionTimes.length > 0 &&
      (this.lifecycleActionTimes[0] ?? Number.POSITIVE_INFINITY) < cutoff
    ) {
      this.lifecycleActionTimes.shift();
    }

    if (this.lifecycleActionTimes.length >= this.maxLifecycleActions) {
      if (!this.safetyWarningShown) {
        this.safetyWarningShown = true;
        this.adapter.warn(PREVIEW_SYNC_SAFETY_WARNING);
      }
      return false;
    }

    this.lifecycleActionTimes.push(this.now());
    return true;
  }

  private async applyPayload(payload: ProjectFilesChangedPayload): Promise<WebContainerSyncResult> {
    const writtenPaths: string[] = [];
    const removedPaths: string[] = [];
    const skippedPaths: string[] = [];

    for (const [path, content] of Object.entries(payload.files)) {
      const nextHash = hashWebContainerContent(content);
      if (this.knownHashes.get(path) === nextHash) {
        skippedPaths.push(path);
        continue;
      }

      try {
        await this.adapter.writeFile(path, content);
        this.knownHashes.set(path, nextHash);
        writtenPaths.push(path);
      } catch {
        // A later payload can retry the write because the known hash is unchanged.
      }
    }

    const authoritativeRemovedPaths = payload.authoritative
      ? [...this.knownHashes.keys()].filter((path) => !(path in payload.files))
      : [];
    const pathsToRemove = new Set([...payload.removedPaths, ...authoritativeRemovedPaths]);

    for (const path of pathsToRemove) {
      if (!this.knownHashes.has(path)) {
        skippedPaths.push(path);
        continue;
      }

      try {
        await this.adapter.removeFile(path);
        this.knownHashes.delete(path);
        removedPaths.push(path);
      } catch {
        // A later payload can retry the removal because the known hash remains.
      }
    }

    this.onTiming?.("sync_finish", payload, new Date(this.now()).toISOString());

    const changedPaths = [...writtenPaths, ...removedPaths];
    const needsInstall = changedPaths.some(isPackageDependencyPath);
    const needsRestart = changedPaths.some(isDevServerConfigPath);
    let installRan = false;
    let restartRan = false;
    let safetyBrakeEngaged = false;

    if ((needsInstall || needsRestart) && !this.allowLifecycleAction()) {
      safetyBrakeEngaged = true;
    } else {
      let installSucceeded = true;
      if (needsInstall) {
        installRan = true;
        installSucceeded = await this.adapter.installDependencies(
          changedPaths
            .filter(isPackageDependencyPath)
            .map((path) => ({ path, content: payload.files[path] })),
        );
      }
      if (needsRestart && installSucceeded) {
        restartRan = true;
        await this.adapter.restartDevServer();
      }
    }

    this.onTiming?.("webcontainer_ready", payload, new Date(this.now()).toISOString());

    return {
      writtenPaths,
      removedPaths,
      skippedPaths,
      installRan,
      restartRan,
      safetyBrakeEngaged,
    };
  }
}
