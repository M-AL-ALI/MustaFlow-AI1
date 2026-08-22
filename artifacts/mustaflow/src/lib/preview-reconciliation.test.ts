import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WebContainerSyncController } from "../hooks/web-container-sync";
import { loadEvidenceFixture } from "./__tests__/evidence-fixture";
import type { ProjectFilesChangedPayload } from "./event-types";
import {
  acceptPreviewPayload,
  createPreviewRevisionState,
  markPreviewRevisionApplied,
  reconcilePreviewRevision,
  selectPreviewRevisionSubstrate,
  type ProjectPreviewState,
} from "./preview-reconciliation";

const here = dirname(fileURLToPath(import.meta.url));
const capturePath = resolve(
  here,
  "../../../../docs/evidence/wave-d33/production-task-140-inventory.json",
);
const captureBytes = loadEvidenceFixture(
  capturePath,
  "abe274dad9fc997a659f81cd78b8a6deb500b38adf9c76539f7f8d4d3b23cae6",
);
const captured = JSON.parse(captureBytes.toString("utf8")) as {
  capture: { projectId: number; taskId: number; frameCount: number };
  ordered: Array<{ id: number; eventType: string; createdAt: string; ordinal: number }>;
  samples: {
    project_files_changed: Array<{
      createdAt: string;
      data: {
        changedPaths: string[];
        generatedAt: string;
        operationType: "build";
        projectId: number;
        removedPaths: string[];
        requiresInstall: boolean;
        requiresRestart: boolean;
      };
    }>;
  };
};

const LIVE_REVISION = 75;

function metadata(overrides: Partial<ProjectPreviewState> = {}): ProjectPreviewState {
  return {
    projectId: captured.capture.projectId,
    revision: LIVE_REVISION,
    versionCreatedAt: "2026-07-29T15:24:06.132Z",
    reconciliationAllowed: true,
    blockedByTaskId: null,
    blockedByStatus: null,
    generatedAt: "2026-07-29T15:24:11.392Z",
    ...overrides,
  };
}

function capturedPayload(revision: number): ProjectFilesChangedPayload {
  const event = captured.samples.project_files_changed[0];
  if (!event) throw new Error("Task 140 capture is missing project_files_changed");
  return {
    ...event.data,
    revision,
    files: { "src/App.tsx": "export default function App() { return null; }" },
    authoritative: false,
  };
}

describe("preview revision reconciliation with production task 140 traffic", () => {
  it("routes Project 52's running legacy-labeled runtime away from WebContainer sync", () => {
    expect(
      selectPreviewRevisionSubstrate({
        containerId: "nrf-ab8e18ef4ebebedd-p52-preview-primary",
        containerStatus: "running",
        webContainerReady: false,
      }),
    ).toBe("live-runtime");
    expect(
      selectPreviewRevisionSubstrate({
        containerId: null,
        containerStatus: "stopped",
        webContainerReady: true,
      }),
    ).toBe("webcontainer");
    expect(
      selectPreviewRevisionSubstrate({
        containerId: "stopped-runtime",
        containerStatus: "stopped",
        webContainerReady: false,
      }),
    ).toBe("waiting");
  });

  it("pins the real 74-frame capture used by the disconnect regression", () => {
    expect(captured.capture).toMatchObject({ projectId: 44, taskId: 140, frameCount: 74 });
    expect(captured.ordered.at(-1)).toMatchObject({
      eventType: "completed",
      createdAt: "2026-07-29T15:24:11.392Z",
      ordinal: 74,
    });
  });

  it("reconciles from the terminal frame when the live-only project stream was disconnected", async () => {
    const state = createPreviewRevisionState(captured.capture.projectId);
    const writeFile = vi.fn(async () => undefined);
    const refreshIframe = vi.fn();
    const controller = new WebContainerSyncController(
      {
        writeFile,
        removeFile: vi.fn(async () => undefined),
        installDependencies: vi.fn(async () => true),
        restartDevServer: vi.fn(async () => undefined),
        warn: vi.fn(),
      },
      { debounceMs: 1_000 },
    );
    controller.seed([{ path: "src/App.tsx", content: "stale" }]);
    let syncPromise: Promise<void> | null = null;
    const enqueue = vi.fn((payload: ProjectFilesChangedPayload) => {
      // This is the same no-refresh WebContainer handoff used by PreviewTab.
      syncPromise = controller.enqueue(payload);
    });
    const pending = vi.fn();
    const fetchFiles = vi.fn(async (_projectId: number, revision: number) => {
      expect(revision).toBe(LIVE_REVISION);
      return [{ path: "src/App.tsx", content: "export default function App() { return 'live'; }" }];
    });

    // The project_files_changed frame at ordinal 65 is deliberately not delivered.
    // The real terminal frame at ordinal 74 drives the metadata reconciliation.
    await reconcilePreviewRevision({
      state,
      source: "task-terminal",
      fetchMetadata: async () => metadata(),
      fetchFiles,
      enqueue,
      onPendingChange: pending,
      log: vi.fn(),
    });

    expect(fetchFiles).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      projectId: 44,
      revision: LIVE_REVISION,
      operationType: "reconcile",
      authoritative: true,
      changedPaths: ["src/App.tsx"],
    });
    await controller.flushNow();
    await syncPromise;
    expect(writeFile).toHaveBeenCalledWith(
      "src/App.tsx",
      "export default function App() { return 'live'; }",
    );
    expect(refreshIframe).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledWith(true);
    expect(markPreviewRevisionApplied(state, LIVE_REVISION)).toBe(true);
    expect(state.appliedRevision).toBe(LIVE_REVISION);
  });

  it("ignores stale, duplicate, and out-of-order revisions from duplicate streams", () => {
    const state = createPreviewRevisionState(captured.capture.projectId);
    const log = vi.fn();

    expect(acceptPreviewPayload(state, capturedPayload(75), "task-stream", log)).toBe(true);
    expect(markPreviewRevisionApplied(state, 75)).toBe(true);
    expect(acceptPreviewPayload(state, capturedPayload(74), "project-stream", log)).toBe(false);
    expect(acceptPreviewPayload(state, capturedPayload(75), "project-stream", log)).toBe(false);
    expect(acceptPreviewPayload(state, capturedPayload(76), "project-stream", log)).toBe(true);
    expect(state.queuedRevision).toBe(76);
  });

  it("never fetches or applies a needs_review revision", async () => {
    const state = createPreviewRevisionState(captured.capture.projectId);
    const fetchFiles = vi.fn();
    const enqueue = vi.fn();

    await reconcilePreviewRevision({
      state,
      source: "stream-reconnect",
      fetchMetadata: async () =>
        metadata({
          reconciliationAllowed: false,
          blockedByTaskId: 141,
          blockedByStatus: "needs_review",
        }),
      fetchFiles,
      enqueue,
      log: vi.fn(),
    });

    expect(fetchFiles).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(state.queuedRevision).toBe(0);
  });

  it("fails closed when a task becomes staged while authoritative files are fetched", async () => {
    const state = createPreviewRevisionState(captured.capture.projectId);
    const fetchMetadata = vi
      .fn<() => Promise<ProjectPreviewState>>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        metadata({
          reconciliationAllowed: false,
          blockedByTaskId: 141,
          blockedByStatus: "needs_fix",
        }),
      );
    const enqueue = vi.fn();

    await reconcilePreviewRevision({
      state,
      source: "task-terminal",
      fetchMetadata,
      fetchFiles: async () => [{ path: "src/App.tsx", content: "staged" }],
      enqueue,
      log: vi.fn(),
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(state.queuedRevision).toBe(0);
  });
});
