import { describe, expect, it } from "vitest";
import type {
  WorkspaceReadinessBlockedCause,
  WorkspaceReadinessSurface,
} from "@workspace/ora-contracts";
import {
  composeTerminalAndReadiness,
  parseWorkspaceReadinessReceipt,
  workspaceReadinessSubjectFromTerminal,
  WORKSPACE_READINESS_UNBLOCK_LABELS,
} from "./workspace-readiness";

const context = {
  projectId: 7,
  subject: { versionId: 11, taskId: 13, revision: 1 as const },
};

const terminal = {
  schema: "zero-terminal-v1",
  taskId: 13,
  intent: "mutate",
  intentReceiptId: 17,
  completedAt: "2026-08-22T00:00:00.000Z",
  outcome: "mutation_succeeded",
  runStatus: "completed",
  evidence: {
    versionId: 11,
    diffRef: { kind: "task_report", taskId: 13, revision: 1 },
    preview: { promised: true, state: "ready", receiptId: "preview-13" },
  },
};

const ready = {
  schema: "workspace-readiness-v1",
  ...context,
  state: "ready",
  evidence: {
    terminalRef: { kind: "zero_terminal", schema: "zero-terminal-v1", taskId: 13 },
    versionId: 11,
    diffRef: { kind: "task_report", taskId: 13, revision: 1 },
    architect: {
      state: "pass",
      reviewedAt: "2026-08-22T00:00:00.000Z",
      receiptId: "architect-11",
    },
    validation: { state: "passed", receiptId: "validation-11" },
    preview: { state: "ready", receiptId: "preview-11" },
    publish: { env: "testing", canPublish: true, receiptId: "publish-11" },
  },
};

const blockedContracts: Array<
  [WorkspaceReadinessBlockedCause, keyof typeof WORKSPACE_READINESS_UNBLOCK_LABELS]
> = [
  ["architect_failed", "retry_architect"],
  ["unresolved_findings", "resolve_findings"],
  ["validation_failed", "fix_validation"],
  ["validation_partial", "rerun_validation"],
  ["preview_pending", "wait_or_retry_preview"],
  ["preview_broken", "wait_or_retry_preview"],
  ["staged_changes_pending", "apply_or_discard"],
  ["test_approval_required", "run_or_approve_test"],
  ["publish_gate_failed", "complete_publish_checks"],
];

describe("workspace readiness consumers", () => {
  it("binds a readiness request to the terminal's exact version and task", () => {
    expect(workspaceReadinessSubjectFromTerminal(terminal)).toEqual(context.subject);
    expect(
      workspaceReadinessSubjectFromTerminal({ ...terminal, outcome: "response_succeeded" }),
    ).toBeNull();
  });

  it("uses the sole presenter on every user-facing surface", () => {
    for (const surface of [
      "chat",
      "notification",
      "preview",
      "publish",
      "mobile",
    ] satisfies WorkspaceReadinessSurface[]) {
      const receipt = parseWorkspaceReadinessReceipt(ready, context, surface);
      expect(receipt.presentation).toMatchObject({
        state: "ready",
        canCelebrate: true,
        canPublish: true,
      });
    }
  });

  it("fails closed when receipt evidence names another subject", () => {
    const receipt = parseWorkspaceReadinessReceipt(
      { ...ready, subject: { ...context.subject, versionId: 99 } },
      context,
      "publish",
    );
    expect(receipt.presentation).toMatchObject({
      state: "unknown",
      canCelebrate: false,
      canPublish: false,
      unblock: "recheck",
    });
  });

  it.each(blockedContracts)("renders the typed unblock action for %s", (cause, unblock) => {
    const receipt = parseWorkspaceReadinessReceipt(
      {
        schema: "workspace-readiness-v1",
        ...context,
        state: "blocked",
        cause,
        unblock,
        evidence: {
          receiptId: `${cause}-11`,
          ...(cause === "unresolved_findings" ? { findingCount: 2 } : {}),
        },
      },
      context,
      "publish",
    );
    expect(receipt.presentation).toMatchObject({
      state: "blocked",
      canCelebrate: false,
      canPublish: false,
      unblock,
    });
    expect(WORKSPACE_READINESS_UNBLOCK_LABELS[unblock]).not.toHaveLength(0);
    expect(`${receipt.presentation.title} ${receipt.presentation.message}`).not.toMatch(
      /app is ready|ready to publish|all gates passed/i,
    );
  });

  it("never celebrates a saved mutation when its preview is broken", () => {
    const receipt = parseWorkspaceReadinessReceipt(
      {
        schema: "workspace-readiness-v1",
        ...context,
        state: "blocked",
        cause: "preview_broken",
        unblock: "wait_or_retry_preview",
        evidence: { receiptId: "preview-broken-11" },
      },
      context,
      "chat",
    );
    expect(composeTerminalAndReadiness("Saved 3 project files.", receipt)).toEqual({
      title: "Preview needs attention",
      message:
        "Saved 3 project files. Open the preview details, fix the problem, or retry the preview.",
      canCelebrate: false,
      canPublish: false,
    });
  });
});
