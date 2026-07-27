import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFilesChangedPayload } from "@/lib/event-types";
import {
  PREVIEW_SYNC_SAFETY_WARNING,
  WebContainerSyncController,
  type WebContainerSyncAdapter,
} from "../web-container-sync";

function payload(
  files: Record<string, string>,
  options: Partial<ProjectFilesChangedPayload> = {},
): ProjectFilesChangedPayload {
  return {
    projectId: 34,
    operationType: "build",
    changedPaths: Object.keys(files),
    removedPaths: [],
    files,
    requiresInstall: Object.keys(files).some((path) =>
      ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"].includes(path),
    ),
    requiresRestart: Object.keys(files).some(
      (path) => path.startsWith("vite.config.") || path.startsWith("tsconfig"),
    ),
    ...options,
  };
}

function createAdapter() {
  const adapter: WebContainerSyncAdapter = {
    writeFile: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    installDependencies: vi.fn(async () => true),
    restartDevServer: vi.fn(async () => {}),
    warn: vi.fn(),
  };
  return adapter;
}

describe("WebContainerSyncController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a generation burst into one install and at most one config restart", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const controller = new WebContainerSyncController(adapter, { debounceMs: 200 });
    controller.seed([
      { path: "package.json", content: '{"dependencies":{"react":"old"}}' },
      { path: "vite.config.ts", content: "export default { old: true }" },
      { path: "src/App.tsx", content: "export default function App(){return null}" },
    ]);

    const queued = [
      controller.enqueue(
        payload(
          { "src/App.tsx": "export default function App(){return <p>first</p>}" },
          { requiresInstall: false, requiresRestart: false },
        ),
      ),
      controller.enqueue(
        payload({
          "package.json": '{"dependencies":{"react":"latest"}}',
          "src/index.css": "body { color: rebeccapurple; }",
        }),
      ),
      controller.enqueue(
        payload({
          "vite.config.ts": "export default { server: { port: 5173 } }",
          "src/App.tsx": "export default function App(){return <p>final</p>}",
        }),
      ),
    ];

    await vi.advanceTimersByTimeAsync(200);
    await Promise.all(queued);

    expect(adapter.writeFile).toHaveBeenCalledTimes(4);
    expect(adapter.writeFile).toHaveBeenCalledWith(
      "src/App.tsx",
      "export default function App(){return <p>final</p>}",
    );
    expect(adapter.installDependencies).toHaveBeenCalledOnce();
    expect(adapter.restartDevServer).toHaveBeenCalledOnce();

    const duplicate = controller.enqueue(
      payload({
        "package.json": '{"dependencies":{"react":"latest"}}',
        "vite.config.ts": "export default { server: { port: 5173 } }",
        "src/App.tsx": "export default function App(){return <p>final</p>}",
        "src/index.css": "body { color: rebeccapurple; }",
      }),
    );
    await vi.advanceTimersByTimeAsync(200);
    await duplicate;

    expect(adapter.writeFile).toHaveBeenCalledTimes(4);
    expect(adapter.installDependencies).toHaveBeenCalledOnce();
    expect(adapter.restartDevServer).toHaveBeenCalledOnce();
  });

  it("leaves ordinary source-file writes to HMR even when an SSE hint is overly broad", async () => {
    const adapter = createAdapter();
    const controller = new WebContainerSyncController(adapter, { debounceMs: 1_000 });
    controller.seed([{ path: "src/App.tsx", content: "old" }]);

    const queued = controller.enqueue(
      payload(
        { "src/App.tsx": "new" },
        { requiresInstall: true, requiresRestart: true },
      ),
    );
    const result = await controller.flushNow();
    await queued;

    expect(result?.writtenPaths).toEqual(["src/App.tsx"]);
    expect(adapter.installDependencies).not.toHaveBeenCalled();
    expect(adapter.restartDevServer).not.toHaveBeenCalled();
  });

  it("installs a real package manifest change without restarting the running dev server", async () => {
    const adapter = createAdapter();
    const controller = new WebContainerSyncController(adapter, { debounceMs: 1_000 });
    controller.seed([{ path: "package.json", content: '{"dependencies":{}}' }]);

    const queued = controller.enqueue(
      payload({ "package.json": '{"dependencies":{"react":"latest"}}' }),
    );
    await controller.flushNow();
    await queued;

    expect(adapter.installDependencies).toHaveBeenCalledOnce();
    expect(adapter.restartDevServer).not.toHaveBeenCalled();
  });

  it("engages one safety warning after three lifecycle cycles in a minute", async () => {
    const adapter = createAdapter();
    const controller = new WebContainerSyncController(adapter, {
      debounceMs: 1_000,
      maxLifecycleActions: 3,
      lifecycleWindowMs: 60_000,
      now: () => 10_000,
    });
    controller.seed([
      { path: "package.json", content: '{"version":0}' },
      { path: "vite.config.ts", content: "export default { version: 0 }" },
    ]);

    let lastResult = null;
    for (let version = 1; version <= 5; version += 1) {
      const queued = controller.enqueue(
        payload({
          "package.json": `{"version":${version}}`,
          "vite.config.ts": `export default { version: ${version} }`,
        }),
      );
      lastResult = await controller.flushNow();
      await queued;
    }

    expect(adapter.writeFile).toHaveBeenCalledTimes(10);
    expect(adapter.installDependencies).toHaveBeenCalledTimes(3);
    expect(adapter.restartDevServer).toHaveBeenCalledTimes(3);
    expect(adapter.warn).toHaveBeenCalledOnce();
    expect(adapter.warn).toHaveBeenCalledWith(PREVIEW_SYNC_SAFETY_WARNING);
    expect(lastResult).toMatchObject({
      safetyBrakeEngaged: true,
      installRan: false,
      restartRan: false,
    });
  });
});
