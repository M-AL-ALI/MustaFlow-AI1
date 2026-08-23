import {
  WORKSPACE_READINESS_SEMANTICS,
  blockedWorkspaceReadiness,
  parseZeroTerminalV1,
  readyWorkspaceReadiness,
  unknownWorkspaceReadiness,
  ZERO_TERMINAL_UNKNOWN,
  type WorkspaceReadiness,
  type WorkspaceReadinessContext,
  type WorkspaceReadinessSubject,
  type ZeroTerminalV1,
} from "@workspace/ora-contracts";
import type { TaskReport } from "@workspace/db";

export type VersionBoundPublishReadinessInput = {
  subject: WorkspaceReadinessSubject;
  env: string;
  canPublish: boolean;
  receiptId: string;
};

export type ReadinessEvidenceRead<T> = { state: "known"; value: T } | { state: "unknown" };

export async function readReadinessEvidence<T>(
  read: () => Promise<T>,
): Promise<ReadinessEvidenceRead<T>> {
  try {
    return { state: "known", value: await read() };
  } catch {
    return { state: "unknown" };
  }
}

export function bindPublishReadinessToSubject(input: {
  subject: WorkspaceReadinessSubject;
  env: string;
  canPublish: boolean;
  checks: ReadonlyArray<{ id: string; status: string }>;
}): VersionBoundPublishReadinessInput {
  const checkIdentity = input.checks
    .map((check) => `${check.id}=${check.status}`)
    .sort()
    .join(",");
  return {
    subject: input.subject,
    env: input.env,
    canPublish: input.canPublish,
    receiptId: receipt("publish-readiness", [
      input.subject.versionId,
      input.subject.taskId,
      input.subject.revision,
      input.env,
      input.canPublish ? 1 : 0,
      checkIdentity,
    ]),
  };
}

export type WorkspaceReadinessFacts = {
  task: {
    id: number;
    projectId: number;
    status: string;
    terminal: unknown;
    report: TaskReport | null;
    stagedChangesPending: boolean;
  } | null;
  version: {
    id: number;
    projectId: number;
    validationStatus: "passed" | "passed_with_warnings" | "failed" | "completed_with_errors" | null;
  } | null;
  checkRuns: Array<{
    id: number;
    checkName: string;
    status: "pass" | "warning" | "fail" | "skipped";
  }>;
  testing: {
    status: string;
    testedSnapshotId: number | null;
    candidateSnapshotId: number | null;
  } | null;
  publish: VersionBoundPublishReadinessInput | null;
};

export type WorkspaceReadinessSource = {
  loadTask(context: WorkspaceReadinessContext): Promise<WorkspaceReadinessFacts["task"]>;
  loadVersion(context: WorkspaceReadinessContext): Promise<WorkspaceReadinessFacts["version"]>;
  loadCheckRuns(context: WorkspaceReadinessContext): Promise<WorkspaceReadinessFacts["checkRuns"]>;
  loadTesting(context: WorkspaceReadinessContext): Promise<WorkspaceReadinessFacts["testing"]>;
};

function receipt(prefix: string, values: ReadonlyArray<string | number>): string {
  return `${prefix}:${values.join(":")}`;
}

function unknown(
  context: WorkspaceReadinessContext,
  cause: "no_version" | "legacy_evidence" | "evidence_unavailable" | "evidence_mismatch",
): WorkspaceReadiness {
  return unknownWorkspaceReadiness({
    schema: WORKSPACE_READINESS_SEMANTICS,
    ...context,
    state: "unknown",
    cause,
    unblock: cause === "no_version" ? "open_results" : "recheck",
  });
}

function terminalMutationEvidence(
  terminal: ZeroTerminalV1,
):
  | Extract<ZeroTerminalV1, { outcome: "mutation_succeeded" | "changed_with_issues" }>["evidence"]
  | null {
  return terminal.outcome === "mutation_succeeded" || terminal.outcome === "changed_with_issues"
    ? terminal.evidence
    : null;
}

/** Pure readiness judge. It receives facts and persists nothing. */
export function deriveWorkspaceReadiness(
  context: WorkspaceReadinessContext,
  facts: WorkspaceReadinessFacts,
): WorkspaceReadiness {
  if (!facts.task || !facts.version) {
    return unknown(context, facts.version ? "evidence_unavailable" : "no_version");
  }
  if (
    facts.task.id !== context.subject.taskId ||
    facts.task.projectId !== context.projectId ||
    facts.version.id !== context.subject.versionId ||
    facts.version.projectId !== context.projectId
  ) {
    return unknown(context, "evidence_mismatch");
  }

  const terminal = parseZeroTerminalV1(facts.task.terminal);
  if (terminal === ZERO_TERMINAL_UNKNOWN) return unknown(context, "legacy_evidence");
  const mutation = terminalMutationEvidence(terminal);
  if (
    !mutation ||
    terminal.taskId !== context.subject.taskId ||
    mutation.versionId !== context.subject.versionId ||
    mutation.diffRef.taskId !== context.subject.taskId ||
    mutation.diffRef.revision !== context.subject.revision
  ) {
    return unknown(context, "evidence_mismatch");
  }

  const terminalRef = facts.task.report?.terminalRef;
  if (
    terminalRef?.kind !== "zero_terminal" ||
    terminalRef.schema !== "zero-terminal-v1" ||
    terminalRef.taskId !== context.subject.taskId
  ) {
    return unknown(context, "legacy_evidence");
  }

  if (facts.task.stagedChangesPending) {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "staged_changes_pending",
      unblock: "apply_or_discard",
      evidence: { receiptId: receipt("staged", [context.subject.taskId]) },
    });
  }

  const architect = facts.task.report?.architectReview;
  if (!architect || architect.skipped) return unknown(context, "evidence_unavailable");
  const architectReceipt = receipt("architect", [context.subject.taskId, architect.reviewedAt]);
  if (architect.verdict === "fail") {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "architect_failed",
      unblock: "retry_architect",
      evidence: { receiptId: architectReceipt },
    });
  }
  const unresolvedFindings = architect.findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  );
  if (architect.verdict === "partial" || unresolvedFindings.length > 0) {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "unresolved_findings",
      unblock: "resolve_findings",
      evidence: {
        receiptId: architectReceipt,
        findingCount: Math.max(1, unresolvedFindings.length),
      },
    });
  }

  const checkReceipt = receipt("validation", [
    context.subject.versionId,
    facts.version.validationStatus ?? "none",
    ...facts.checkRuns.flatMap((run) => [run.id, run.checkName, run.status]),
  ]);
  if (
    facts.version.validationStatus === "failed" ||
    facts.version.validationStatus === "completed_with_errors" ||
    facts.checkRuns.some((run) => run.status === "fail")
  ) {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "validation_failed",
      unblock: "fix_validation",
      evidence: { receiptId: checkReceipt },
    });
  }
  if (
    facts.version.validationStatus === "passed_with_warnings" ||
    facts.checkRuns.some((run) => run.status === "warning" || run.status === "skipped")
  ) {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "validation_partial",
      unblock: "rerun_validation",
      evidence: { receiptId: checkReceipt },
    });
  }
  if (facts.version.validationStatus !== "passed") {
    return unknown(context, "legacy_evidence");
  }

  if (mutation.preview.state === "queued") {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "preview_pending",
      unblock: "wait_or_retry_preview",
      evidence: { receiptId: mutation.preview.receiptId },
    });
  }
  if (mutation.preview.state === "unavailable") {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "preview_broken",
      unblock: "wait_or_retry_preview",
      evidence: { receiptId: receipt("preview-unavailable", [context.subject.taskId]) },
    });
  }
  if (mutation.preview.state !== "ready") return unknown(context, "evidence_unavailable");

  if (!facts.publish || !sameSubject(facts.publish.subject, context.subject)) {
    return unknown(context, "evidence_mismatch");
  }
  if (
    facts.publish.env === "production" &&
    (facts.testing?.status !== "passed" ||
      facts.testing.testedSnapshotId !== context.subject.versionId)
  ) {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "test_approval_required",
      unblock: "run_or_approve_test",
      evidence: {
        receiptId: receipt("testing", [context.subject.versionId, facts.testing?.status ?? "none"]),
      },
    });
  }
  if (!facts.publish.canPublish) {
    return blockedWorkspaceReadiness({
      schema: WORKSPACE_READINESS_SEMANTICS,
      ...context,
      state: "blocked",
      cause: "publish_gate_failed",
      unblock: "complete_publish_checks",
      evidence: { receiptId: facts.publish.receiptId },
    });
  }

  return readyWorkspaceReadiness({
    schema: WORKSPACE_READINESS_SEMANTICS,
    ...context,
    state: "ready",
    evidence: {
      terminalRef,
      versionId: context.subject.versionId,
      diffRef: mutation.diffRef,
      architect: {
        state: "pass",
        reviewedAt: architect.reviewedAt,
        receiptId: architectReceipt,
      },
      validation: { state: "passed", receiptId: checkReceipt },
      preview: { state: "ready", receiptId: mutation.preview.receiptId },
      publish: {
        env: facts.publish.env,
        canPublish: true,
        receiptId: facts.publish.receiptId,
      },
    },
  });
}

function sameSubject(left: WorkspaceReadinessSubject, right: WorkspaceReadinessSubject): boolean {
  return (
    left.versionId === right.versionId &&
    left.taskId === right.taskId &&
    left.revision === right.revision
  );
}

/** Read existing evidence, then derive. This path performs SELECTs only. */
export async function readWorkspaceReadiness(
  context: WorkspaceReadinessContext,
  publish: VersionBoundPublishReadinessInput | null,
  source: WorkspaceReadinessSource,
): Promise<WorkspaceReadiness> {
  try {
    const [task, version, checkRuns, testing] = await Promise.all([
      source.loadTask(context),
      source.loadVersion(context),
      source.loadCheckRuns(context),
      source.loadTesting(context),
    ]);
    return deriveWorkspaceReadiness(context, { task, version, checkRuns, testing, publish });
  } catch {
    return unknown(context, "evidence_unavailable");
  }
}
