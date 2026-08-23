import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_READINESS_BLOCKED_CAUSES,
  WORKSPACE_READINESS_SEMANTICS,
  WORKSPACE_READINESS_UNKNOWN_CAUSES,
  blockedWorkspaceReadiness,
  mutationSucceededTerminal,
  parseWorkspaceReadiness,
  presentWorkspaceReadiness,
  readyWorkspaceReadiness,
  unknownWorkspaceReadiness,
  type WorkspaceReadinessBlocked,
  type WorkspaceReadinessContext,
} from "@workspace/ora-contracts";
import {
  bindPublishReadinessToSubject,
  deriveWorkspaceReadiness,
  readReadinessEvidence,
  readWorkspaceReadiness,
  type WorkspaceReadinessFacts,
  type WorkspaceReadinessSource,
} from "./workspace-readiness";

const context: WorkspaceReadinessContext = {
  projectId: 5,
  subject: { versionId: 17, taskId: 41, revision: 1 },
};

const terminal = mutationSucceededTerminal({
  schema: "zero-terminal-v1",
  taskId: 41,
  intent: "mutate",
  intentReceiptId: 9,
  completedAt: "2026-08-22T12:00:00.000Z",
  outcome: "mutation_succeeded",
  runStatus: "completed",
  evidence: {
    versionId: 17,
    diffRef: { kind: "task_report", taskId: 41, revision: 1 },
    preview: { promised: true, state: "ready", receiptId: "preview:41:17" },
  },
});

function validFacts(): WorkspaceReadinessFacts {
  return {
    task: {
      id: 41,
      projectId: 5,
      status: "done",
      terminal,
      stagedChangesPending: false,
      report: {
        userRequest: "Build the requested app.",
        filesCreated: ["src/main.ts"],
        filesChanged: [],
        filesRemoved: [],
        previewUpdated: true,
        warnings: [],
        integrationsNeeded: [],
        terminalRef: { kind: "zero_terminal", schema: "zero-terminal-v1", taskId: 41 },
        architectReview: {
          verdict: "pass",
          summary: "The requested change is complete.",
          findings: [],
          nextActions: [],
          autoFixQueued: false,
          creditsCharged: 0,
          reviewedAt: "2026-08-22T12:00:01.000Z",
          model: "reviewer",
        },
      },
    },
    version: { id: 17, projectId: 5, validationStatus: "passed" },
    checkRuns: [{ id: 81, checkName: "typecheck", status: "pass" }],
    testing: { status: "passed", testedSnapshotId: 17, candidateSnapshotId: 17 },
    publish: bindPublishReadinessToSubject({
      subject: context.subject,
      env: "production",
      canPublish: true,
      checks: [{ id: "has_files", status: "pass" }],
    }),
  };
}

function blockedCases(): WorkspaceReadinessBlocked[] {
  const common = { schema: WORKSPACE_READINESS_SEMANTICS, ...context, state: "blocked" as const };
  return [
    blockedWorkspaceReadiness({
      ...common,
      cause: "architect_failed",
      unblock: "retry_architect",
      evidence: { receiptId: "architect:41" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "unresolved_findings",
      unblock: "resolve_findings",
      evidence: { receiptId: "architect:41", findingCount: 2 },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "validation_failed",
      unblock: "fix_validation",
      evidence: { receiptId: "validation:17" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "validation_partial",
      unblock: "rerun_validation",
      evidence: { receiptId: "validation:17" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "preview_pending",
      unblock: "wait_or_retry_preview",
      evidence: { receiptId: "preview:41" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "preview_broken",
      unblock: "wait_or_retry_preview",
      evidence: { receiptId: "preview:41" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "staged_changes_pending",
      unblock: "apply_or_discard",
      evidence: { receiptId: "staged:41" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "test_approval_required",
      unblock: "run_or_approve_test",
      evidence: { receiptId: "testing:17" },
    }),
    blockedWorkspaceReadiness({
      ...common,
      cause: "publish_gate_failed",
      unblock: "complete_publish_checks",
      evidence: { receiptId: "publish:17" },
    }),
  ];
}

describe("WorkspaceReadiness foundation", () => {
  it("makes ready construction require the complete evidence set", () => {
    function _readyEvidenceIsRequired(): void {
      // @ts-expect-error ready cannot exist without terminal, diff, review, validation, preview, and publish evidence
      readyWorkspaceReadiness({
        schema: WORKSPACE_READINESS_SEMANTICS,
        ...context,
        state: "ready",
      });
      blockedWorkspaceReadiness({
        schema: WORKSPACE_READINESS_SEMANTICS,
        ...context,
        state: "blocked",
        // @ts-expect-error each blocked cause has one matching unblock action
        cause: "architect_failed",
        unblock: "complete_publish_checks",
        evidence: { receiptId: "architect:41" },
      });
    }
    void _readyEvidenceIsRequired;
    expect(true).toBe(true);
  });

  it("constructs all nine causes with their typed unblock paths", () => {
    const values = blockedCases();
    expect(values.map((value) => value.cause)).toEqual(WORKSPACE_READINESS_BLOCKED_CAUSES);
    expect(new Set(values.map((value) => value.unblock))).toEqual(
      new Set([
        "retry_architect",
        "resolve_findings",
        "fix_validation",
        "rerun_validation",
        "wait_or_retry_preview",
        "apply_or_discard",
        "run_or_approve_test",
        "complete_publish_checks",
      ]),
    );
  });

  it("constructs all five unknown causes with their typed unblock paths", () => {
    const values = WORKSPACE_READINESS_UNKNOWN_CAUSES.map((cause) =>
      cause === "no_version"
        ? unknownWorkspaceReadiness({
            schema: WORKSPACE_READINESS_SEMANTICS,
            ...context,
            state: "unknown",
            cause,
            unblock: "open_results",
          })
        : unknownWorkspaceReadiness({
            schema: WORKSPACE_READINESS_SEMANTICS,
            ...context,
            state: "unknown",
            cause,
            unblock: "recheck",
          }),
    );
    expect(values.map((value) => value.cause)).toEqual(WORKSPACE_READINESS_UNKNOWN_CAUSES);

    function _unknownUnblockIsTyped(): void {
      unknownWorkspaceReadiness({
        schema: WORKSPACE_READINESS_SEMANTICS,
        ...context,
        state: "unknown",
        cause: "no_version",
        // @ts-expect-error no_version directs the caller to saved results rather than retrying evidence
        unblock: "recheck",
      });
    }
    void _unknownUnblockIsTyped;
  });

  it("parses complete evidence as ready and mismatch or malformed evidence as unknown", () => {
    const ready = deriveWorkspaceReadiness(context, validFacts());
    if (ready.state !== "ready") throw new Error(`expected ready, received ${ready.state}`);
    expect(parseWorkspaceReadiness(JSON.parse(JSON.stringify(ready)), context).state).toBe("ready");
    expect(
      parseWorkspaceReadiness(
        { ...ready, subject: { ...context.subject, versionId: 99 } },
        context,
      ),
    ).toMatchObject({ state: "unknown", cause: "evidence_mismatch" });
    expect(
      parseWorkspaceReadiness(
        { ...ready, evidence: { ...ready.evidence, preview: null } },
        context,
      ),
    ).toMatchObject({ state: "unknown", cause: "evidence_mismatch" });
  });

  it("never presents forbidden success phrases for blocked or unknown states", () => {
    const forbidden = /\b(?:ready|all good|changes applied|publish now)\b/i;
    for (const readiness of [
      ...blockedCases(),
      unknownWorkspaceReadiness({
        schema: WORKSPACE_READINESS_SEMANTICS,
        ...context,
        state: "unknown",
        cause: "evidence_unavailable",
        unblock: "recheck",
      }),
    ]) {
      for (const surface of ["chat", "notification", "preview", "publish", "mobile"] as const) {
        const presentation = presentWorkspaceReadiness(readiness, surface);
        expect(`${presentation.title} ${presentation.message}`).not.toMatch(forbidden);
        expect(presentation).toMatchObject({ canCelebrate: false, canPublish: false });
      }
    }
  });

  it("derives every captured blocked cause and never treats a broken preview as ready", () => {
    const cases: Array<[string, (facts: WorkspaceReadinessFacts) => void]> = [
      ["staged_changes_pending", (facts) => (facts.task!.stagedChangesPending = true)],
      ["architect_failed", (facts) => (facts.task!.report!.architectReview!.verdict = "fail")],
      [
        "unresolved_findings",
        (facts) => {
          facts.task!.report!.architectReview!.verdict = "partial";
        },
      ],
      ["validation_failed", (facts) => (facts.version!.validationStatus = "failed")],
      ["validation_partial", (facts) => (facts.version!.validationStatus = "passed_with_warnings")],
      [
        "preview_pending",
        (facts) => {
          facts.task!.terminal = {
            ...terminal,
            evidence: {
              ...terminal.evidence,
              preview: { promised: true, state: "queued", receiptId: "preview:queued" },
            },
          };
        },
      ],
      [
        "preview_broken",
        (facts) => {
          facts.task!.terminal = {
            ...terminal,
            evidence: {
              ...terminal.evidence,
              preview: { promised: true, state: "unavailable", cause: "runtime_unavailable" },
            },
          };
        },
      ],
      ["test_approval_required", (facts) => (facts.testing!.testedSnapshotId = 16)],
      ["publish_gate_failed", (facts) => (facts.publish!.canPublish = false)],
    ];
    for (const [cause, mutate] of cases) {
      const facts = validFacts();
      mutate(facts);
      expect(deriveWorkspaceReadiness(context, facts)).toMatchObject({ state: "blocked", cause });
    }

    const staleApproval = validFacts();
    staleApproval.testing!.status = "stale";
    expect(deriveWorkspaceReadiness(context, staleApproval)).toMatchObject({
      state: "blocked",
      cause: "test_approval_required",
    });
  });

  it("reads through a select-only source and persists zero writes on every path", async () => {
    const facts = validFacts();
    const source: WorkspaceReadinessSource = {
      loadTask: vi.fn(async () => facts.task),
      loadVersion: vi.fn(async () => facts.version),
      loadCheckRuns: vi.fn(async () => facts.checkRuns),
      loadTesting: vi.fn(async () => facts.testing),
    };
    await expect(readWorkspaceReadiness(context, facts.publish, source)).resolves.toMatchObject({
      state: "ready",
    });
    expect(Object.keys(source).sort()).toEqual([
      "loadCheckRuns",
      "loadTask",
      "loadTesting",
      "loadVersion",
    ]);
    expect(Object.values(source).every((method) => vi.mocked(method).mock.calls.length === 1)).toBe(
      true,
    );

    const sourceText = readFileSync(new URL("./workspace-readiness.ts", import.meta.url), "utf8");
    const readerText = readFileSync(
      new URL("./workspace-readiness-reader.ts", import.meta.url),
      "utf8",
    );
    expect(`${sourceText}\n${readerText}`).not.toMatch(/\.(?:insert|update|delete)\s*\(/);
    const routeText = readFileSync(new URL("../routes/readiness.ts", import.meta.url), "utf8");
    expect(routeText).toContain("readDatabaseWorkspaceReadiness(");
  });

  it("turns a validation evidence read error into typed unknown", async () => {
    await expect(
      readReadinessEvidence(async () => {
        throw new Error("transport detail must not escape");
      }),
    ).resolves.toEqual({ state: "unknown" });

    const publishSource = readFileSync(new URL("../routes/publish.ts", import.meta.url), "utf8");
    expect(publishSource.match(/code: "workspace_readiness_unknown"/g)).toHaveLength(2);
    expect(publishSource).not.toContain("proceeding with publish");
  });
});
