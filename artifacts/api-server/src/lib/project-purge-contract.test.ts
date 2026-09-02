import {
  PROJECT_PURGE_FAILURE_CODES,
  PROJECT_PURGE_STAGES,
  PROJECT_PURGE_STATES,
  PROJECT_PURGE_TRIGGERS,
  completedProjectPurgeReceipt,
  parseProjectPurgeReceipt,
  presentProjectPurge,
  type ProjectPurgeCompletedEvidence,
} from "@workspace/ora-contracts";
import { describe, expect, it } from "vitest";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const context = { operationId: "purge-operation-1", projectId: 42 } as const;

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: "project-purge-v1",
    operationId: context.operationId,
    projectId: context.projectId,
    retirementOperationIdHash: shaA,
    trigger: "expiry",
    state: "scheduled",
    stage: "verify",
    attemptCount: 0,
    dueAt: "2026-10-01T00:00:00.000Z",
    failureCode: null,
    failureRetryable: null,
    terminalEvidence: null,
    ...overrides,
  };
}

function completedEvidence(): ProjectPurgeCompletedEvidence {
  return {
    schema: "project-purge-terminal-v1",
    outcome: "completed",
    inventoryDigestSha256: shaA,
    absenceDigestSha256: shaB,
    removedResourceCount: 12,
    detachedResourceCount: 2,
  };
}

function compileTimeContract(): void {
  completedProjectPurgeReceipt({
    schema: "project-purge-v1",
    operationId: context.operationId,
    projectId: context.projectId,
    retirementOperationIdHash: shaA,
    trigger: "manual",
    state: "completed",
    stage: "absence",
    attemptCount: 1,
    dueAt: "2026-10-01T00:00:00.000Z",
    failureCode: null,
    failureRetryable: null,
    terminalEvidence: completedEvidence(),
  });

  completedProjectPurgeReceipt({
    schema: "project-purge-v1",
    operationId: context.operationId,
    projectId: context.projectId,
    retirementOperationIdHash: shaA,
    trigger: "manual",
    state: "completed",
    stage: "absence",
    attemptCount: 1,
    dueAt: "2026-10-01T00:00:00.000Z",
    failureCode: null,
    failureRetryable: null,
    // @ts-expect-error completed receipts require complete, typed terminal evidence
    terminalEvidence: { outcome: "completed" },
  });
}
void compileTimeContract;

describe("project purge durable contract", () => {
  it("keeps every control set closed", () => {
    expect(PROJECT_PURGE_TRIGGERS).toEqual(["manual", "expiry"]);
    expect(PROJECT_PURGE_STATES).toEqual([
      "scheduled",
      "accepted",
      "running",
      "failed",
      "completed",
      "canceled",
    ]);
    expect(PROJECT_PURGE_STAGES).toEqual([
      "verify",
      "inventory",
      "assets",
      "snapshots",
      "database",
      "addons",
      "runtime",
      "relational",
      "absence",
    ]);
    expect(new Set(PROJECT_PURGE_FAILURE_CODES).size).toBe(PROJECT_PURGE_FAILURE_CODES.length);
  });

  it.each([
    ["scheduled", receipt()],
    ["accepted", receipt({ state: "accepted", trigger: "manual" })],
    ["running", receipt({ state: "running", stage: "assets", attemptCount: 1 })],
    [
      "failed",
      receipt({
        state: "failed",
        stage: "runtime",
        attemptCount: 2,
        failureCode: "project_purge_runtime_release_failed",
        failureRetryable: true,
        terminalEvidence: {
          schema: "project-purge-terminal-v1",
          outcome: "failed",
          stage: "runtime",
          failureCode: "project_purge_runtime_release_failed",
          retryable: true,
        },
      }),
    ],
    [
      "completed",
      receipt({
        state: "completed",
        stage: "absence",
        terminalEvidence: completedEvidence(),
      }),
    ],
    [
      "canceled",
      receipt({
        state: "canceled",
        stage: "verify",
        terminalEvidence: {
          schema: "project-purge-terminal-v1",
          outcome: "canceled",
          reason: "project_restored",
        },
      }),
    ],
  ])("parses a coherent %s receipt", (state, value) => {
    const parsed = parseProjectPurgeReceipt(value, context);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.state).toBe(state);
  });

  it.each([
    receipt({ projectId: 99 }),
    receipt({ operationId: "other" }),
    receipt({ retirementOperationIdHash: "not-a-digest" }),
    receipt({ dueAt: "not-a-time" }),
    receipt({ state: "completed", stage: "absence" }),
    receipt({
      state: "completed",
      stage: "absence",
      terminalEvidence: { ...completedEvidence(), providerResponse: { secret: true } },
    }),
    receipt({
      state: "failed",
      stage: "runtime",
      failureCode: "project_purge_runtime_release_failed",
      failureRetryable: true,
      terminalEvidence: {
        schema: "project-purge-terminal-v1",
        outcome: "failed",
        stage: "assets",
        failureCode: "project_purge_runtime_release_failed",
        retryable: true,
      },
    }),
    { ...receipt(), projectName: "must never enter a durable receipt" },
  ])("fails closed for mismatched, truncated, or unsanitized evidence", (value) => {
    expect(parseProjectPurgeReceipt(value, context)).toEqual({
      ok: false,
      code: "project_purge_receipt_invalid",
    });
  });

  it("makes success copy unreachable without parsed terminal absence evidence", () => {
    const malformed = parseProjectPurgeReceipt(
      receipt({ state: "completed", stage: "absence" }),
      context,
    );
    const malformedPresentation = presentProjectPurge(malformed);
    expect(malformedPresentation.state).toBe("unknown");
    expect(malformedPresentation.title).not.toMatch(/permanently deleted/iu);

    const completed = parseProjectPurgeReceipt(
      receipt({
        state: "completed",
        stage: "absence",
        terminalEvidence: completedEvidence(),
      }),
      context,
    );
    expect(presentProjectPurge(completed)).toMatchObject({
      state: "completed",
      tone: "success",
      terminal: true,
      canRetry: false,
      title: "Project permanently deleted",
    });
  });

  it("renders plain copy without exposing internal failure codes", () => {
    const parsed = parseProjectPurgeReceipt(
      receipt({
        state: "failed",
        stage: "database",
        failureCode: "project_purge_database_release_failed",
        failureRetryable: true,
        terminalEvidence: {
          schema: "project-purge-terminal-v1",
          outcome: "failed",
          stage: "database",
          failureCode: "project_purge_database_release_failed",
          retryable: true,
        },
      }),
      context,
    );
    const presentation = presentProjectPurge(parsed);
    expect(`${presentation.title} ${presentation.message}`).not.toContain("project_purge_");
    expect(presentation).toMatchObject({ terminal: true, canRetry: true });
  });
});
