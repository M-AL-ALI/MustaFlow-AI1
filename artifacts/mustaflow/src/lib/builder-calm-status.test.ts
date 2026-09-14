import { describe, expect, it } from "vitest";
import {
  CALM_STATUS_VOCABULARY,
  calmPhaseForTaskEvent,
  getCalmBuilderStatus,
  getEditorWorkStatus,
  reconcileEditorRunReceipt,
} from "./builder-calm-status";

describe("builder calm status", () => {
  it("uses the exact beginner-facing vocabulary", () => {
    expect(CALM_STATUS_VOCABULARY).toEqual({
      idle: "Ready for your next change.",
      answering: "Answering your question...",
      planning: "Planning your app...",
      building: "Building your app...",
      images: "Creating images for your app...",
      testing: "Testing what I built...",
      fixing: "Fixing an issue I found...",
    });
    expect(getCalmBuilderStatus({ phase: "building", fileCount: 12 })).toBe(
      "Building — 12 files so far",
    );
  });

  it("keeps preview reconciliation visible until WebContainer readiness", () => {
    expect(
      getCalmBuilderStatus({
        phase: "idle",
        previewSyncPending: true,
      }),
    ).toBe("Updating preview\u2026");
  });

  it.each([
    ["failed", "Request failed"],
    ["cancelled", "Run cancelled"],
    ["canceled", "Run cancelled"],
    ["discarded", "Run cancelled"],
  ])("stops stale preview progress after a persisted %s result", (status, label) => {
    expect(
      getCalmBuilderStatus({
        phase: "building",
        previewSyncPending: true,
        run: { projectId: 61, task: { projectId: 61, id: 329, status } },
      }),
    ).toBe(label);
  });

  it.each([
    ["failed", "Request failed"],
    ["cancelled", "Run cancelled"],
    ["unknown", "Run ended; status unavailable"],
  ] as const)(
    "uses a matching %s receipt even before the task query refreshes",
    (terminal, label) => {
      expect(
        getCalmBuilderStatus({
          phase: "building",
          previewSyncPending: true,
          run: {
            projectId: 61,
            task: { projectId: 61, id: 329, status: "building" },
            receipt: { projectId: 61, taskId: 329, terminal },
          },
        }),
      ).toBe(label);
    },
  );

  it("keeps a successful run's genuine preview update visible until it is ready", () => {
    const run = {
      projectId: 61,
      task: { projectId: 61, id: 329, status: "completed" },
      receipt: { projectId: 61, taskId: 329, terminal: "completed" as const },
    };
    expect(getCalmBuilderStatus({ phase: "idle", previewSyncPending: true, run })).toBe(
      "Updating preview\u2026",
    );
    expect(getCalmBuilderStatus({ phase: "idle", previewSyncPending: false, run })).toBe(
      CALM_STATUS_VOCABULARY.idle,
    );
  });

  it("does not carry a prior run's failure into a newer run or a different project", () => {
    const failed = { projectId: 61, taskId: 329, terminal: "failed" as const };
    for (const run of [
      { projectId: 61, task: { projectId: 61, id: 330, status: "building" }, receipt: failed },
      { projectId: 62, task: { projectId: 62, id: 329, status: "building" }, receipt: failed },
      { projectId: 62, task: { projectId: 61, id: 329, status: "failed" }, receipt: failed },
      { projectId: 61, task: null, receipt: failed },
    ]) {
      expect(getCalmBuilderStatus({ phase: "building", previewSyncPending: true, run })).toBe(
        "Updating preview\u2026",
      );
    }
  });

  it("does not label independent image creation as the previous app run's failure", () => {
    expect(
      getCalmBuilderStatus({
        phase: "images",
        independentImageGeneration: true,
        run: {
          projectId: 61,
          task: { projectId: 61, id: 329, status: "failed" },
          receipt: { projectId: 61, taskId: 329, terminal: "failed" },
        },
      }),
    ).toBe(CALM_STATUS_VOCABULARY.images);
  });

  it.each([
    ["failed", "Request failed"],
    ["cancelled", "Run cancelled"],
    ["unknown", "Run ended; status unavailable"],
  ] as const)("does not let stale task-owned images hide a %s result", (terminal, label) => {
    for (const previewSyncPending of [false, true]) {
      expect(
        getCalmBuilderStatus({
          phase: "images",
          previewSyncPending,
          run: {
            projectId: 61,
            task: { projectId: 61, id: 329, status: "building" },
            receipt: { projectId: 61, taskId: 329, terminal },
          },
        }),
      ).toBe(label);
    }
  });

  it("collapses internal task events into one calm phase", () => {
    expect(calmPhaseForTaskEvent("file_diff")).toBe("building");
    expect(calmPhaseForTaskEvent("command_output")).toBe("testing");
    expect(calmPhaseForTaskEvent("review_context")).toBe("testing");
    expect(calmPhaseForTaskEvent("narration", "Repairing the preview now")).toBe("fixing");
    expect(calmPhaseForTaskEvent("completed")).toBe("idle");
  });
});

const currentTask = { projectId: 61, id: 316, status: "running" };
const currentReceipt = {
  projectId: 61,
  taskId: 316,
  phase: "building" as const,
  activityLabel: "Writing code",
};

describe("editor current-work presentation", () => {
  it("puts the matching current run ahead of a previous failed build", () => {
    expect(
      getEditorWorkStatus({
        projectId: 61,
        projectStatus: "failed",
        task: currentTask,
        receipt: currentReceipt,
      }),
    ).toEqual({ label: "Writing code", tone: "active", previousBuildFailed: true });
  });

  it.each([
    ["completed", "Run completed"],
    ["failed", "Request failed"],
    ["cancelled", "Run cancelled"],
    ["unknown", "Run ended; status unavailable"],
  ] as const)("lets a %s terminal receipt end lingering progress", (terminal, label) => {
    expect(
      getEditorWorkStatus({
        projectId: 61,
        projectStatus: "building",
        task: currentTask,
        receipt: { ...currentReceipt, terminal },
        requestPending: true,
      }).label,
    ).toBe(label);
  });

  it.each(["answering", "planning"] as const)(
    "keeps a failed %s request distinct from historical build status",
    (phase) => {
      const input = {
        projectId: 61,
        task: { ...currentTask, status: phase },
        receipt: { ...currentReceipt, phase, terminal: "failed" as const },
        requestPending: true,
      };
      expect(getEditorWorkStatus({ ...input, projectStatus: "ready" })).toEqual({
        label: "Request failed",
        tone: "error",
        previousBuildFailed: false,
      });
      expect(getEditorWorkStatus({ ...input, projectStatus: "failed" })).toEqual({
        label: "Request failed",
        tone: "error",
        previousBuildFailed: true,
      });
    },
  );

  it("lets a persisted task failure end an older writing receipt", () => {
    expect(
      getEditorWorkStatus({
        projectId: 61,
        projectStatus: "building",
        task: { ...currentTask, status: "failed" },
        receipt: currentReceipt,
      }),
    ).toEqual({ label: "Request failed", tone: "error", previousBuildFailed: false });
  });

  it.each([
    ["queued", "Queued"],
    ["needs_approval", "Approval needed"],
    ["needs_review", "Review needed"],
    ["needs_fix", "Changes need attention"],
  ])("does not turn %s into active code generation", (status, label) => {
    expect(
      getEditorWorkStatus({
        projectId: 61,
        projectStatus: "failed",
        task: { ...currentTask, status },
        receipt: currentReceipt,
        requestPending: true,
      }).label,
    ).toBe(label);
  });

  it.each([null, { ...currentReceipt, taskId: 315 }, { ...currentReceipt, projectId: 62 }])(
    "requires a current-project and current-task receipt: %j",
    (receipt) => {
      expect(
        getEditorWorkStatus({
          projectId: 61,
          projectStatus: "failed",
          task: currentTask,
          receipt,
        }).label,
      ).toBe("Connecting to current run...");
    },
  );

  it("does not let another project's task or failure receipt set the header", () => {
    expect(
      getEditorWorkStatus({
        projectId: 62,
        projectStatus: "ready",
        task: currentTask,
        receipt: { ...currentReceipt, terminal: "failed" },
      }),
    ).toEqual({
      label: "Ready for your next change.",
      tone: "muted",
      previousBuildFailed: false,
    });
  });

  it("keeps a failed historical result visible when there is no current run", () => {
    expect(getEditorWorkStatus({ projectId: 61, projectStatus: "failed" })).toEqual({
      label: "Last build failed",
      tone: "error",
      previousBuildFailed: false,
    });
  });

  it("does not infer a live run from project.status alone", () => {
    expect(getEditorWorkStatus({ projectId: 61, projectStatus: "building" }).label).toBe(
      "Checking current run...",
    );
  });

  it("distinguishes a submitted request from a confirmed writing receipt", () => {
    expect(
      getEditorWorkStatus({ projectId: 61, projectStatus: "failed", requestPending: true }),
    ).toEqual({ label: "Request in progress...", tone: "active", previousBuildFailed: true });
  });
});

describe("editor receipt fencing", () => {
  const scope = { projectId: 61, taskId: 316 };

  it("does not let an old project's or old task's late frame replace the current receipt", () => {
    for (const incoming of [
      { ...currentReceipt, projectId: 62 },
      { ...currentReceipt, taskId: 315 },
    ]) {
      expect(reconcileEditorRunReceipt(currentReceipt, incoming, scope)).toBe(currentReceipt);
    }
  });

  it("retains terminal evidence through replayed progress", () => {
    const terminal = { ...currentReceipt, terminal: "failed" as const };
    expect(reconcileEditorRunReceipt(terminal, currentReceipt, scope)).toBe(terminal);
  });

  it("accepts a new run without carrying the previous run's terminal or activity", () => {
    expect(
      reconcileEditorRunReceipt(
        { ...currentReceipt, terminal: "failed" },
        { projectId: 61, taskId: 317, phase: "planning" },
        { projectId: 61, taskId: 317 },
      ),
    ).toEqual({
      projectId: 61,
      taskId: 317,
      phase: "planning",
      activityLabel: undefined,
    });
  });

  it("clears the old writing label when a later phase has no activity label", () => {
    const receipt = reconcileEditorRunReceipt(
      currentReceipt,
      { projectId: 61, taskId: 316, phase: "testing" },
      scope,
    );
    expect(getEditorWorkStatus({ projectId: 61, task: currentTask, receipt }).label).toBe(
      "Testing what I built...",
    );
  });
});
