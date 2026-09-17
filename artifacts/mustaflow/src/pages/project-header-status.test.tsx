import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  getCalmBuilderStatus,
  getEditorWorkStatus,
  reconcileEditorRunReceipt,
  type CalmBuilderPhase,
  type EditorRunContext,
  type EditorRunReceipt,
} from "../lib/builder-calm-status";
import { requestConfirmedTaskStop } from "./projects/components/confirmed-task-stop";

const source = readFileSync(path.join(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");

// Execute the actual phase derivation, status call and Stop callback. Injecting
// an already chosen phase would miss task-owned image state surviving Stop.
const parsed = ts.createSourceFile(
  "project.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const initializerNames = new Set([
  "isCreatingImages",
  "visibleCalmPhase",
  "calmStatusText",
  "handleStopStream",
]);
const initializers = new Map<string, ts.Expression>();
function visit(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    initializerNames.has(node.name.getText(parsed)) &&
    node.initializer
  ) {
    const name = node.name.getText(parsed);
    if (initializers.has(name)) throw new Error(`Duplicate project initializer: ${name}`);
    initializers.set(name, node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
function initializer(name: string): string {
  const expression = initializers.get(name);
  if (!expression) throw new Error(`Missing actual project initializer: ${name}`);
  return expression.getText(parsed);
}
const compiled = ts.transpileModule(
  "(function (context) { const { liveImageGenerating = false, projectImages = { isGenerating: false }, isBusy = false, pendingIsConverse = false, pendingIsPlan = false, calmPhase = 'idle', calmFileCount = 0, previewSyncPending = false, editorRunContext } = context; const isCreatingImages = " +
    initializer("isCreatingImages") +
    "; const visibleCalmPhase = " +
    initializer("visibleCalmPhase") +
    "; return " +
    initializer("calmStatusText") +
    "; })",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);
const projectCalmStatus = new Script(compiled.outputText).runInNewContext(
  { getCalmBuilderStatus },
  { timeout: 1_000 },
) as (context: {
  liveImageGenerating?: boolean;
  projectImages?: { isGenerating: boolean };
  isBusy?: boolean;
  pendingIsConverse?: boolean;
  pendingIsPlan?: boolean;
  calmPhase?: CalmBuilderPhase;
  calmFileCount?: number;
  previewSyncPending?: boolean;
  editorRunContext: EditorRunContext;
}) => string;

const stopBindings = [
  "activeTaskId",
  "cancelTask",
  "pendingFeedTaskIdRef",
  "streamAbortRef",
  "taskEventSourceRef",
  "setLiveCodeBuffer",
  "setIsStreaming",
  "setStreamingText",
  "setStreamReconnectAttempt",
  "setStreamError",
  "setStreamErrorStatus",
  "setPendingIsConverse",
  "pendingIsConverseRef",
  "projectId",
  "editorRunGenerationRef",
  "editorRunScopeRef",
  "requestConfirmedTaskStop",
  "setEditorRunReceipt",
  "setLiveRunTerminalEvent",
  "setLiveImageGenerating",
  "setPendingBuildStartedAt",
  "pendingIsPlanRef",
  "setPendingIsPlan",
  "queryClient",
  "toast",
];
const compiledStop = ts.transpileModule(
  "(function (context) { const { " +
    stopBindings.join(", ") +
    " } = context; return " +
    initializer("handleStopStream") +
    "; })",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);
const projectStop = new Script(compiledStop.outputText).runInNewContext(
  {
    useCallback: (callback: () => void) => callback,
    reconcileEditorRunReceipt,
    getListTasksQueryKey: (id: number) => ["tasks", id],
    getListMessagesQueryKey: (id: number) => ["messages", id],
  },
  { timeout: 1_000 },
) as (context: Record<string, unknown>) => () => void;

function imageStopHarness(cancel: () => Promise<unknown> = async () => undefined) {
  const task = { projectId: 61, id: 329, status: "building" };
  let receipt: EditorRunReceipt | null = { projectId: 61, taskId: 329, phase: "images" };
  let liveImageGenerating = true;
  let pendingStop: Promise<void> | undefined;
  const close = vi.fn();
  const toast = vi.fn();
  const cancelMutation = vi.fn(cancel);
  const stop = projectStop({
    projectId: 61,
    activeTaskId: 329,
    cancelTask: { isPending: false, mutateAsync: cancelMutation },
    pendingFeedTaskIdRef: { current: 329 },
    streamAbortRef: { current: { abort: vi.fn() } },
    taskEventSourceRef: { current: { close } },
    pendingIsConverseRef: { current: false },
    pendingIsPlanRef: { current: false },
    editorRunGenerationRef: { current: 1 },
    editorRunScopeRef: { current: { projectId: 61, taskId: 329 } },
    requestConfirmedTaskStop: (input: Parameters<typeof requestConfirmedTaskStop>[0]) => {
      pendingStop = requestConfirmedTaskStop(input);
      return pendingStop;
    },
    setEditorRunReceipt: (
      update: (current: EditorRunReceipt | null) => EditorRunReceipt | null,
    ) => {
      receipt = update(receipt);
    },
    setLiveImageGenerating: (value: boolean) => {
      liveImageGenerating = value;
    },
    setLiveCodeBuffer: vi.fn(),
    setIsStreaming: vi.fn(),
    setStreamingText: vi.fn(),
    setStreamReconnectAttempt: vi.fn(),
    setStreamError: vi.fn(),
    setStreamErrorStatus: vi.fn(),
    setPendingIsConverse: vi.fn(),
    setLiveRunTerminalEvent: vi.fn(),
    setPendingBuildStartedAt: vi.fn(),
    setPendingIsPlan: vi.fn(),
    queryClient: { invalidateQueries: vi.fn(async () => undefined) },
    toast,
  });
  return {
    close,
    toast,
    cancelMutation,
    async stop() {
      stop();
      if (!pendingStop) throw new Error("The actual Stop callback did not request cancellation");
      await pendingStop;
    },
    status(previewSyncPending: boolean, independentImages = false) {
      const editorRunContext = { projectId: 61, task, receipt };
      return {
        header: getEditorWorkStatus(editorRunContext).label,
        chat: projectCalmStatus({
          liveImageGenerating,
          projectImages: { isGenerating: independentImages },
          isBusy: true,
          previewSyncPending,
          editorRunContext,
        }),
      };
    },
  };
}

describe("project header status truth", () => {
  it("distinguishes the last build result from the live runtime state", () => {
    expect(source).toContain("const baseEditorWorkStatus = getEditorWorkStatus({");
    expect(source).toContain('currentRequestFailure && baseEditorWorkStatus.tone !== "active"');
    expect(source).toContain("label: currentRequestFailure.title,");
    expect(source).toContain("projectStatus: project?.status,");
    expect(source).toContain("receipt: editorRunReceipt,");
    expect(source).toContain("{editorWorkStatus.label}");
    expect(source).toContain("editorWorkStatus.previousBuildFailed");
    expect(source).toContain("const data = await getContainerStatus(projectId);");
    expect(source).toContain("containerStatus={containerStatus}");
    expect(source).toContain("previewAccess={previewAccess}");
    expect(source).not.toContain("containerHealthStatus");
    expect(source).not.toMatch(/>\s*\{project\.status\}\s*<\/span>/);
  });

  it("retains historical failure without overriding the matching current run", () => {
    expect(getEditorWorkStatus({ projectId: 61, projectStatus: "failed" })).toEqual({
      label: "Last build failed",
      tone: "error",
      previousBuildFailed: false,
    });
    expect(
      getEditorWorkStatus({
        projectId: 61,
        projectStatus: "failed",
        task: { projectId: 61, id: 316, status: "building" },
        receipt: { projectId: 61, taskId: 316, phase: "building", activityLabel: "Writing code" },
      }),
    ).toEqual({ label: "Writing code", tone: "active", previousBuildFailed: true });
  });

  it("shows the current failure in the actual chat strip instead of stale preview progress", () => {
    const editorRunContext = {
      projectId: 61,
      task: { projectId: 61, id: 329, status: "building" },
      receipt: { projectId: 61, taskId: 329, terminal: "failed" as const },
    };
    expect(
      projectCalmStatus({
        isBusy: true,
        calmPhase: "building",
        calmFileCount: 4,
        previewSyncPending: true,
        editorRunContext,
      }),
    ).toBe("Request failed");
    expect(getEditorWorkStatus(editorRunContext).label).toBe("Request failed");
  });

  it("accepts persisted failure without a stream receipt and ignores an older run's terminal", () => {
    expect(
      projectCalmStatus({
        isBusy: false,
        previewSyncPending: true,
        editorRunContext: { projectId: 61, task: { projectId: 61, id: 329, status: "failed" } },
      }),
    ).toBe("Request failed");
    expect(
      projectCalmStatus({
        isBusy: true,
        calmPhase: "building",
        previewSyncPending: true,
        editorRunContext: {
          projectId: 61,
          task: { projectId: 61, id: 330, status: "building" },
          receipt: { projectId: 61, taskId: 329, terminal: "failed" },
        },
      }),
    ).toBe("Updating preview\u2026");
  });

  it("does not call a successful run's preview ready before reconciliation completes", () => {
    expect(
      projectCalmStatus({
        isBusy: false,
        previewSyncPending: true,
        editorRunContext: { projectId: 61, task: { projectId: 61, id: 329, status: "completed" } },
      }),
    ).toBe("Updating preview\u2026");
  });

  it.each([false, true])(
    "confirmed Stop ends task-owned image progress with pending preview %s",
    async (previewSyncPending) => {
      const run = imageStopHarness();
      expect(run.status(previewSyncPending).chat).toBe(
        previewSyncPending ? "Updating preview\u2026" : "Creating images for your app...",
      );
      await run.stop();
      expect(run.cancelMutation).toHaveBeenCalledWith({ id: 61, taskId: 329 });
      expect(run.close).toHaveBeenCalledTimes(1);
      expect(run.status(previewSyncPending)).toEqual({
        header: "Run cancelled",
        chat: "Run cancelled",
      });
    },
  );

  it("preserves independently active images after the app task is cancelled", async () => {
    const run = imageStopHarness();
    await run.stop();
    expect(run.status(false, true)).toEqual({
      header: "Run cancelled",
      chat: "Creating images for your app...",
    });
    expect(run.status(false, false).chat).toBe("Run cancelled");
  });

  it("does not claim cancellation or close the feed when the server rejects Stop", async () => {
    const run = imageStopHarness(async () => {
      throw new Error("Stop unavailable");
    });
    await run.stop();
    expect(run.close).not.toHaveBeenCalled();
    expect(run.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Stop was not confirmed" }),
    );
    expect(run.status(false)).toEqual({
      header: "Creating images for your app...",
      chat: "Creating images for your app...",
    });
  });
});
