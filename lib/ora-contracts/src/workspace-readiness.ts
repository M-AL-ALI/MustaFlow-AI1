import type { ZeroTerminalDiffRef } from "./zero-terminal";

export const WORKSPACE_READINESS_SEMANTICS = "workspace-readiness-v1" as const;

export type WorkspaceReadinessSubject = {
  versionId: number;
  taskId: number;
  revision: ZeroTerminalDiffRef["revision"];
};

export type WorkspaceReadinessContext = {
  projectId: number;
  subject: WorkspaceReadinessSubject;
};

const workspaceReadinessBrand: unique symbol = Symbol("WorkspaceReadiness");
type WorkspaceReadinessBrand = { readonly [workspaceReadinessBrand]: true };

type WorkspaceReadinessCommon = WorkspaceReadinessContext &
  WorkspaceReadinessBrand & {
    schema: typeof WORKSPACE_READINESS_SEMANTICS;
  };

export type WorkspaceReadinessReady = WorkspaceReadinessCommon & {
  state: "ready";
  evidence: {
    terminalRef: {
      kind: "zero_terminal";
      schema: "zero-terminal-v1";
      taskId: number;
    };
    versionId: number;
    diffRef: ZeroTerminalDiffRef;
    architect: { state: "pass"; reviewedAt: string; receiptId: string };
    validation: { state: "passed"; receiptId: string };
    preview: { state: "ready"; receiptId: string };
    publish: { env: string; canPublish: true; receiptId: string };
  };
};

export const WORKSPACE_READINESS_BLOCKED_CAUSES = [
  "architect_failed",
  "unresolved_findings",
  "validation_failed",
  "validation_partial",
  "preview_pending",
  "preview_broken",
  "staged_changes_pending",
  "test_approval_required",
  "publish_gate_failed",
] as const;

export type WorkspaceReadinessBlockedCause = (typeof WORKSPACE_READINESS_BLOCKED_CAUSES)[number];

type BlockedCauseContract = {
  architect_failed: {
    unblock: "retry_architect";
    evidence: { receiptId: string };
  };
  unresolved_findings: {
    unblock: "resolve_findings";
    evidence: { receiptId: string; findingCount: number };
  };
  validation_failed: {
    unblock: "fix_validation";
    evidence: { receiptId: string };
  };
  validation_partial: {
    unblock: "rerun_validation";
    evidence: { receiptId: string };
  };
  preview_pending: {
    unblock: "wait_or_retry_preview";
    evidence: { receiptId: string };
  };
  preview_broken: {
    unblock: "wait_or_retry_preview";
    evidence: { receiptId: string };
  };
  staged_changes_pending: {
    unblock: "apply_or_discard";
    evidence: { receiptId: string };
  };
  test_approval_required: {
    unblock: "run_or_approve_test";
    evidence: { receiptId: string };
  };
  publish_gate_failed: {
    unblock: "complete_publish_checks";
    evidence: { receiptId: string };
  };
};

export type WorkspaceReadinessBlocked = {
  [Cause in WorkspaceReadinessBlockedCause]: WorkspaceReadinessCommon & {
    state: "blocked";
    cause: Cause;
    unblock: BlockedCauseContract[Cause]["unblock"];
    evidence: BlockedCauseContract[Cause]["evidence"];
  };
}[WorkspaceReadinessBlockedCause];

export type WorkspaceReadinessBlockedInput<Cause extends WorkspaceReadinessBlockedCause> = Omit<
  WorkspaceReadinessCommon,
  typeof workspaceReadinessBrand
> & {
  state: "blocked";
  cause: Cause;
  unblock: BlockedCauseContract[Cause]["unblock"];
  evidence: BlockedCauseContract[Cause]["evidence"];
};

export const WORKSPACE_READINESS_UNKNOWN_CAUSES = [
  "no_version",
  "legacy_evidence",
  "evidence_unavailable",
  "evidence_mismatch",
  "stale_evidence",
] as const;

export type WorkspaceReadinessUnknownCause = (typeof WORKSPACE_READINESS_UNKNOWN_CAUSES)[number];

type UnknownCauseContract = {
  no_version: { unblock: "open_results" };
  legacy_evidence: { unblock: "recheck" };
  evidence_unavailable: { unblock: "recheck" };
  evidence_mismatch: { unblock: "recheck" };
  stale_evidence: { unblock: "recheck" };
};

export type WorkspaceReadinessUnknown = {
  [Cause in WorkspaceReadinessUnknownCause]: WorkspaceReadinessCommon & {
    state: "unknown";
    cause: Cause;
    unblock: UnknownCauseContract[Cause]["unblock"];
  };
}[WorkspaceReadinessUnknownCause];

export type WorkspaceReadinessUnknownInput<Cause extends WorkspaceReadinessUnknownCause> = Omit<
  WorkspaceReadinessCommon,
  typeof workspaceReadinessBrand
> & {
  state: "unknown";
  cause: Cause;
  unblock: UnknownCauseContract[Cause]["unblock"];
};

export type WorkspaceReadiness =
  | WorkspaceReadinessReady
  | WorkspaceReadinessBlocked
  | WorkspaceReadinessUnknown;

type ConstructorInput<T extends WorkspaceReadiness> = T extends WorkspaceReadiness
  ? Omit<T, typeof workspaceReadinessBrand>
  : never;

function branded<T extends WorkspaceReadiness>(value: ConstructorInput<T>): T {
  return { ...value, [workspaceReadinessBrand]: true } as unknown as T;
}

function brandBlocked(
  value: ConstructorInput<WorkspaceReadinessBlocked>,
): WorkspaceReadinessBlocked {
  return { ...value, [workspaceReadinessBrand]: true } as unknown as WorkspaceReadinessBlocked;
}

export function readyWorkspaceReadiness(
  input: ConstructorInput<WorkspaceReadinessReady>,
): WorkspaceReadinessReady {
  return branded(input);
}

export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"architect_failed">,
): Extract<WorkspaceReadinessBlocked, { cause: "architect_failed" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"unresolved_findings">,
): Extract<WorkspaceReadinessBlocked, { cause: "unresolved_findings" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"validation_failed">,
): Extract<WorkspaceReadinessBlocked, { cause: "validation_failed" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"validation_partial">,
): Extract<WorkspaceReadinessBlocked, { cause: "validation_partial" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"preview_pending">,
): Extract<WorkspaceReadinessBlocked, { cause: "preview_pending" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"preview_broken">,
): Extract<WorkspaceReadinessBlocked, { cause: "preview_broken" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"staged_changes_pending">,
): Extract<WorkspaceReadinessBlocked, { cause: "staged_changes_pending" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"test_approval_required">,
): Extract<WorkspaceReadinessBlocked, { cause: "test_approval_required" }>;
export function blockedWorkspaceReadiness(
  input: WorkspaceReadinessBlockedInput<"publish_gate_failed">,
): Extract<WorkspaceReadinessBlocked, { cause: "publish_gate_failed" }>;
export function blockedWorkspaceReadiness(
  input: ConstructorInput<WorkspaceReadinessBlocked>,
): WorkspaceReadinessBlocked {
  return brandBlocked(input);
}

export function unknownWorkspaceReadiness<Cause extends WorkspaceReadinessUnknownCause>(
  input: WorkspaceReadinessUnknownInput<Cause>,
): Extract<WorkspaceReadinessUnknown, { cause: Cause }> {
  return { ...input, [workspaceReadinessBrand]: true } as Extract<
    WorkspaceReadinessUnknown,
    { cause: Cause }
  >;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameSubject(value: unknown, expected: WorkspaceReadinessSubject): boolean {
  const subject = record(value);
  return (
    subject?.versionId === expected.versionId &&
    subject.taskId === expected.taskId &&
    subject.revision === expected.revision
  );
}

function unknownFromContext(
  context: WorkspaceReadinessContext,
  cause: WorkspaceReadinessUnknownCause,
): WorkspaceReadinessUnknown {
  return cause === "no_version"
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
      });
}

function parseReadyEvidence(
  value: unknown,
  subject: WorkspaceReadinessSubject,
): WorkspaceReadinessReady["evidence"] | null {
  const evidence = record(value);
  const terminalRef = record(evidence?.terminalRef);
  const diffRef = record(evidence?.diffRef);
  const architect = record(evidence?.architect);
  const validation = record(evidence?.validation);
  const preview = record(evidence?.preview);
  const publish = record(evidence?.publish);

  if (
    terminalRef?.kind !== "zero_terminal" ||
    terminalRef.schema !== "zero-terminal-v1" ||
    terminalRef.taskId !== subject.taskId ||
    evidence?.versionId !== subject.versionId ||
    diffRef?.kind !== "task_report" ||
    diffRef.taskId !== subject.taskId ||
    diffRef.revision !== subject.revision ||
    architect?.state !== "pass" ||
    !nonEmptyString(architect.reviewedAt) ||
    !nonEmptyString(architect.receiptId) ||
    validation?.state !== "passed" ||
    !nonEmptyString(validation.receiptId) ||
    preview?.state !== "ready" ||
    !nonEmptyString(preview.receiptId) ||
    !nonEmptyString(publish?.env) ||
    publish.canPublish !== true ||
    !nonEmptyString(publish.receiptId)
  ) {
    return null;
  }

  return {
    terminalRef: {
      kind: "zero_terminal",
      schema: "zero-terminal-v1",
      taskId: subject.taskId,
    },
    versionId: subject.versionId,
    diffRef: {
      kind: "task_report",
      taskId: subject.taskId,
      revision: subject.revision,
    },
    architect: {
      state: "pass",
      reviewedAt: architect.reviewedAt,
      receiptId: architect.receiptId,
    },
    validation: { state: "passed", receiptId: validation.receiptId },
    preview: { state: "ready", receiptId: preview.receiptId },
    publish: { env: publish.env, canPublish: true, receiptId: publish.receiptId },
  };
}

function expectedUnblock(
  cause: WorkspaceReadinessBlockedCause,
): WorkspaceReadinessBlocked["unblock"] {
  switch (cause) {
    case "architect_failed":
      return "retry_architect";
    case "unresolved_findings":
      return "resolve_findings";
    case "validation_failed":
      return "fix_validation";
    case "validation_partial":
      return "rerun_validation";
    case "preview_pending":
    case "preview_broken":
      return "wait_or_retry_preview";
    case "staged_changes_pending":
      return "apply_or_discard";
    case "test_approval_required":
      return "run_or_approve_test";
    case "publish_gate_failed":
      return "complete_publish_checks";
  }
}

/** Parse durable readiness evidence at every process boundary. */
export function parseWorkspaceReadiness(
  value: unknown,
  context: WorkspaceReadinessContext,
): WorkspaceReadiness {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schema !== WORKSPACE_READINESS_SEMANTICS ||
    candidate.projectId !== context.projectId ||
    !sameSubject(candidate.subject, context.subject)
  ) {
    return unknownFromContext(context, "evidence_mismatch");
  }

  if (candidate.state === "ready") {
    const evidence = parseReadyEvidence(candidate.evidence, context.subject);
    return evidence
      ? readyWorkspaceReadiness({
          schema: WORKSPACE_READINESS_SEMANTICS,
          ...context,
          state: "ready",
          evidence,
        })
      : unknownFromContext(context, "evidence_mismatch");
  }

  if (
    candidate.state === "blocked" &&
    WORKSPACE_READINESS_BLOCKED_CAUSES.includes(candidate.cause as WorkspaceReadinessBlockedCause)
  ) {
    const cause = candidate.cause as WorkspaceReadinessBlockedCause;
    const evidence = record(candidate.evidence);
    if (
      candidate.unblock !== expectedUnblock(cause) ||
      !nonEmptyString(evidence?.receiptId) ||
      (cause === "unresolved_findings" && !positiveInteger(evidence.findingCount))
    ) {
      return unknownFromContext(context, "evidence_mismatch");
    }
    return brandBlocked(candidate as ConstructorInput<WorkspaceReadinessBlocked>);
  }

  if (
    candidate.state === "unknown" &&
    WORKSPACE_READINESS_UNKNOWN_CAUSES.includes(candidate.cause as WorkspaceReadinessUnknownCause)
  ) {
    const cause = candidate.cause as WorkspaceReadinessUnknownCause;
    const expected = cause === "no_version" ? "open_results" : "recheck";
    return candidate.unblock === expected
      ? ({ ...candidate, [workspaceReadinessBrand]: true } as WorkspaceReadinessUnknown)
      : unknownFromContext(context, "evidence_mismatch");
  }

  return unknownFromContext(context, "evidence_mismatch");
}

export type WorkspaceReadinessSurface = "chat" | "notification" | "preview" | "publish" | "mobile";

export type WorkspaceReadinessPresentation = {
  state: WorkspaceReadiness["state"];
  tone: "success" | "warning" | "unknown";
  title: string;
  message: string;
  canCelebrate: boolean;
  canPublish: boolean;
  unblock: WorkspaceReadinessBlocked["unblock"] | WorkspaceReadinessUnknown["unblock"] | null;
};

const BLOCKED_COPY: Record<WorkspaceReadinessBlockedCause, { title: string; message: string }> = {
  architect_failed: {
    title: "Review needs attention",
    message: "Run the architecture review again after addressing its findings.",
  },
  unresolved_findings: {
    title: "Findings need attention",
    message: "Resolve the open findings, then check this version again.",
  },
  validation_failed: {
    title: "Checks need attention",
    message: "Fix the validation errors and run the checks again.",
  },
  validation_partial: {
    title: "Checks were incomplete",
    message: "Restore the unavailable checks and run validation again.",
  },
  preview_pending: {
    title: "Preview is still preparing",
    message: "Wait for the preview or retry it without losing your work.",
  },
  preview_broken: {
    title: "Preview needs attention",
    message: "Open the preview details, fix the problem, or retry the preview.",
  },
  staged_changes_pending: {
    title: "Changes need a decision",
    message: "Apply or discard the staged changes before continuing.",
  },
  test_approval_required: {
    title: "Testing needs approval",
    message: "Run or approve the test candidate before publishing.",
  },
  publish_gate_failed: {
    title: "Publishing checks need attention",
    message: "Complete the listed publishing checks, then check again.",
  },
};

/** Sole user-facing renderer for workspace readiness. */
export function presentWorkspaceReadiness(
  readiness: WorkspaceReadiness,
  _surface: WorkspaceReadinessSurface,
): WorkspaceReadinessPresentation {
  if (readiness.state === "ready") {
    return {
      state: "ready",
      tone: "success",
      title: "This version is ready",
      message: "The saved version passed review, checks, preview, and publishing checks.",
      canCelebrate: true,
      canPublish: true,
      unblock: null,
    };
  }
  if (readiness.state === "blocked") {
    return {
      state: "blocked",
      tone: "warning",
      ...BLOCKED_COPY[readiness.cause],
      canCelebrate: false,
      canPublish: false,
      unblock: readiness.unblock,
    };
  }
  return {
    state: "unknown",
    tone: "unknown",
    title: "Status could not be verified",
    message: "Check the saved results again before continuing.",
    canCelebrate: false,
    canPublish: false,
    unblock: readiness.unblock,
  };
}
