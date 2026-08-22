import type { ZeroIntent } from "./zero-intent";

export const ZERO_TERMINAL_SEMANTICS = "zero-terminal-v1" as const;
export const ZERO_TERMINAL_UNKNOWN = "UNKNOWN" as const;

export const ZERO_TERMINAL_OUTCOMES = [
  "mutation_succeeded",
  "response_succeeded",
  "plan_succeeded",
  "changed_with_issues",
  "interrupted",
  "failed",
] as const;

export type ZeroTerminalOutcome = (typeof ZERO_TERMINAL_OUTCOMES)[number];

export type ZeroTerminalPreview =
  | { promised: false; state: "not_promised" }
  | { promised: true; state: "ready"; receiptId: string }
  | { promised: true; state: "queued"; receiptId: string }
  | { promised: true; state: "unavailable"; cause: string };

export type ZeroTerminalDiffRef = {
  kind: "task_report";
  taskId: number;
  revision: 1;
};

type ZeroTerminalCommon = {
  schema: typeof ZERO_TERMINAL_SEMANTICS;
  taskId: number;
  intent: ZeroIntent;
  intentReceiptId: number;
  completedAt: string;
};

const zeroTerminalBrand: unique symbol = Symbol("ZeroTerminalV1");
type ZeroTerminalBrand = { readonly [zeroTerminalBrand]: true };

export type MutationSucceededTerminal = ZeroTerminalCommon &
  ZeroTerminalBrand & {
    outcome: "mutation_succeeded";
    runStatus: "completed";
    evidence: {
      versionId: number;
      diffRef: ZeroTerminalDiffRef;
      preview: ZeroTerminalPreview;
    };
  };

export type ResponseSucceededTerminal = ZeroTerminalCommon &
  ZeroTerminalBrand & {
    outcome: "response_succeeded";
    runStatus: "completed";
    evidence: { assistantMessageId: number };
  };

export type PlanSucceededTerminal = ZeroTerminalCommon &
  ZeroTerminalBrand & {
    outcome: "plan_succeeded";
    runStatus: "completed";
    evidence: {
      assistantMessageId: number;
      planRef: { kind: "chat_message_plan"; messageId: number };
    };
  };

export type ChangedWithIssuesTerminal = ZeroTerminalCommon &
  ZeroTerminalBrand & {
    outcome: "changed_with_issues";
    runStatus: "completed";
    cause: { code: string; stage: string };
    evidence: {
      versionId: number;
      diffRef: ZeroTerminalDiffRef;
      preview: ZeroTerminalPreview;
    };
  };

export type InterruptedTerminal = ZeroTerminalCommon &
  ZeroTerminalBrand & {
    outcome: "interrupted";
    runStatus: "interrupted";
    cause: "user_stop" | "client_disconnect" | "superseded";
    evidence: { lastPhase: string | null; changedPaths: string[] };
  };

export type FailedTerminal = ZeroTerminalCommon &
  ZeroTerminalBrand & {
    outcome: "failed";
    runStatus: "failed";
    cause: { code: string; stage: string };
    evidence: { summary: string };
  };

export type ZeroTerminalV1 =
  | MutationSucceededTerminal
  | ResponseSucceededTerminal
  | PlanSucceededTerminal
  | ChangedWithIssuesTerminal
  | InterruptedTerminal
  | FailedTerminal;

type ConstructorInput<T extends ZeroTerminalV1> = Omit<T, typeof zeroTerminalBrand>;

function branded<T extends ZeroTerminalV1>(value: ConstructorInput<T>): T {
  return { ...value, [zeroTerminalBrand]: true } as T;
}

export function mutationSucceededTerminal(
  input: ConstructorInput<MutationSucceededTerminal>,
): MutationSucceededTerminal {
  return branded(input);
}

export function responseSucceededTerminal(
  input: ConstructorInput<ResponseSucceededTerminal>,
): ResponseSucceededTerminal {
  return branded(input);
}

export function planSucceededTerminal(
  input: ConstructorInput<PlanSucceededTerminal>,
): PlanSucceededTerminal {
  return branded(input);
}

export function changedWithIssuesTerminal(
  input: ConstructorInput<ChangedWithIssuesTerminal>,
): ChangedWithIssuesTerminal {
  return branded(input);
}

export function interruptedTerminal(
  input: ConstructorInput<InterruptedTerminal>,
): InterruptedTerminal {
  return branded(input);
}

export function failedTerminal(input: ConstructorInput<FailedTerminal>): FailedTerminal {
  return branded(input);
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

function validCommon(value: Record<string, unknown>): boolean {
  return (
    value.schema === ZERO_TERMINAL_SEMANTICS &&
    positiveInteger(value.taskId) &&
    ["answer", "clarify", "plan", "mutate", "observe"].includes(String(value.intent)) &&
    positiveInteger(value.intentReceiptId) &&
    nonEmptyString(value.completedAt)
  );
}

function parsePreview(value: unknown): ZeroTerminalPreview | null {
  const candidate = record(value);
  if (!candidate) return null;
  if (candidate.promised === false && candidate.state === "not_promised") {
    return { promised: false, state: "not_promised" };
  }
  if (
    candidate.promised === true &&
    (candidate.state === "ready" || candidate.state === "queued") &&
    nonEmptyString(candidate.receiptId)
  ) {
    return {
      promised: true,
      state: candidate.state,
      receiptId: candidate.receiptId,
    };
  }
  if (
    candidate.promised === true &&
    candidate.state === "unavailable" &&
    nonEmptyString(candidate.cause)
  ) {
    return { promised: true, state: "unavailable", cause: candidate.cause };
  }
  return null;
}

function parseDiffRef(value: unknown, taskId: number): ZeroTerminalDiffRef | null {
  const candidate = record(value);
  if (
    candidate?.kind !== "task_report" ||
    candidate.taskId !== taskId ||
    candidate.revision !== 1
  ) {
    return null;
  }
  return { kind: "task_report", taskId, revision: 1 };
}

function parseCause(value: unknown): { code: string; stage: string } | null {
  const candidate = record(value);
  return candidate && nonEmptyString(candidate.code) && nonEmptyString(candidate.stage)
    ? { code: candidate.code, stage: candidate.stage }
    : null;
}

/** Parse durable JSON. Missing or malformed records are UNKNOWN, never success. */
export function parseZeroTerminalV1(value: unknown): ZeroTerminalV1 | typeof ZERO_TERMINAL_UNKNOWN {
  const candidate = record(value);
  if (!candidate || !validCommon(candidate) || !nonEmptyString(candidate.outcome)) {
    return ZERO_TERMINAL_UNKNOWN;
  }
  const common = {
    schema: ZERO_TERMINAL_SEMANTICS,
    taskId: candidate.taskId as number,
    intent: candidate.intent as ZeroIntent,
    intentReceiptId: candidate.intentReceiptId as number,
    completedAt: candidate.completedAt as string,
  };
  const evidence = record(candidate.evidence);

  if (candidate.outcome === "mutation_succeeded" && candidate.runStatus === "completed") {
    const versionId = evidence?.versionId;
    const diffRef = parseDiffRef(evidence?.diffRef, common.taskId);
    const preview = parsePreview(evidence?.preview);
    if (positiveInteger(versionId) && diffRef && preview) {
      return mutationSucceededTerminal({
        ...common,
        outcome: "mutation_succeeded",
        runStatus: "completed",
        evidence: { versionId, diffRef, preview },
      });
    }
  }

  if (candidate.outcome === "response_succeeded" && candidate.runStatus === "completed") {
    if (positiveInteger(evidence?.assistantMessageId)) {
      return responseSucceededTerminal({
        ...common,
        outcome: "response_succeeded",
        runStatus: "completed",
        evidence: { assistantMessageId: evidence.assistantMessageId },
      });
    }
  }

  if (candidate.outcome === "plan_succeeded" && candidate.runStatus === "completed") {
    const planRef = record(evidence?.planRef);
    if (
      positiveInteger(evidence?.assistantMessageId) &&
      planRef?.kind === "chat_message_plan" &&
      planRef.messageId === evidence.assistantMessageId
    ) {
      return planSucceededTerminal({
        ...common,
        outcome: "plan_succeeded",
        runStatus: "completed",
        evidence: {
          assistantMessageId: evidence.assistantMessageId,
          planRef: { kind: "chat_message_plan", messageId: evidence.assistantMessageId },
        },
      });
    }
  }

  if (candidate.outcome === "changed_with_issues" && candidate.runStatus === "completed") {
    const cause = parseCause(candidate.cause);
    const versionId = evidence?.versionId;
    const diffRef = parseDiffRef(evidence?.diffRef, common.taskId);
    const preview = parsePreview(evidence?.preview);
    if (cause && positiveInteger(versionId) && diffRef && preview) {
      return changedWithIssuesTerminal({
        ...common,
        outcome: "changed_with_issues",
        runStatus: "completed",
        cause,
        evidence: { versionId, diffRef, preview },
      });
    }
  }

  if (candidate.outcome === "interrupted" && candidate.runStatus === "interrupted") {
    const changedPaths = evidence?.changedPaths;
    if (
      ["user_stop", "client_disconnect", "superseded"].includes(String(candidate.cause)) &&
      (evidence?.lastPhase === null || nonEmptyString(evidence?.lastPhase)) &&
      Array.isArray(changedPaths) &&
      changedPaths.every((path) => typeof path === "string")
    ) {
      return interruptedTerminal({
        ...common,
        outcome: "interrupted",
        runStatus: "interrupted",
        cause: candidate.cause as InterruptedTerminal["cause"],
        evidence: { lastPhase: evidence?.lastPhase as string | null, changedPaths },
      });
    }
  }

  if (candidate.outcome === "failed" && candidate.runStatus === "failed") {
    const cause = parseCause(candidate.cause);
    if (cause && nonEmptyString(evidence?.summary)) {
      return failedTerminal({
        ...common,
        outcome: "failed",
        runStatus: "failed",
        cause,
        evidence: { summary: evidence.summary },
      });
    }
  }

  return ZERO_TERMINAL_UNKNOWN;
}

export type ZeroTerminalPresentation = {
  outcome: ZeroTerminalOutcome | "unknown";
  tone: "success" | "warning" | "interrupted" | "failure" | "unknown";
  taskStatus: "completed" | "failed" | "canceled";
  title: string;
  message: string;
  previewState: ZeroTerminalPreview["state"] | "unknown";
  shouldRefreshPreview: boolean;
};

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").trim();
}

function previewMessage(preview: ZeroTerminalPreview): string {
  switch (preview.state) {
    case "not_promised":
      return "Preview was not promised.";
    case "ready":
      return "Preview is ready.";
    case "queued":
      return "Preview is still getting ready.";
    case "unavailable":
      return `Preview is unavailable: ${humanize(preview.cause)}.`;
  }
}

/** The one user-facing renderer for terminal truth. */
export function presentZeroTerminalV1(
  terminal: ZeroTerminalV1 | typeof ZERO_TERMINAL_UNKNOWN,
): ZeroTerminalPresentation {
  if (terminal === ZERO_TERMINAL_UNKNOWN) {
    return {
      outcome: "unknown",
      tone: "unknown",
      taskStatus: "failed",
      title: "Outcome unavailable",
      message: "Outcome unavailable for this older run",
      previewState: "unknown",
      shouldRefreshPreview: false,
    };
  }
  switch (terminal.outcome) {
    case "mutation_succeeded":
      return {
        outcome: terminal.outcome,
        tone: "success",
        taskStatus: "completed",
        title: "Changes applied",
        message: `Changes applied. ${previewMessage(terminal.evidence.preview)}`,
        previewState: terminal.evidence.preview.state,
        shouldRefreshPreview: terminal.evidence.preview.state === "ready",
      };
    case "response_succeeded":
      return {
        outcome: terminal.outcome,
        tone: "success",
        taskStatus: "completed",
        title: "Response sent",
        message: "Response sent.",
        previewState: "not_promised",
        shouldRefreshPreview: false,
      };
    case "plan_succeeded":
      return {
        outcome: terminal.outcome,
        tone: "success",
        taskStatus: "completed",
        title: "Plan ready",
        message: "Plan ready.",
        previewState: "not_promised",
        shouldRefreshPreview: false,
      };
    case "changed_with_issues":
      return {
        outcome: terminal.outcome,
        tone: "warning",
        taskStatus: "completed",
        title: "Changes saved with issues",
        message: `Changes were saved, but ${humanize(terminal.cause.code)} during ${humanize(terminal.cause.stage)}. ${previewMessage(terminal.evidence.preview)}`,
        previewState: terminal.evidence.preview.state,
        shouldRefreshPreview: terminal.evidence.preview.state === "ready",
      };
    case "interrupted":
      return {
        outcome: terminal.outcome,
        tone: "interrupted",
        taskStatus: "canceled",
        title: "Run interrupted",
        message: "This run was interrupted.",
        previewState: "not_promised",
        shouldRefreshPreview: false,
      };
    case "failed":
      return {
        outcome: terminal.outcome,
        tone: "failure",
        taskStatus: "failed",
        title: "Run failed",
        message: terminal.evidence.summary,
        previewState: "not_promised",
        shouldRefreshPreview: false,
      };
  }
}

/**
 * Reader staging helper. Null means legacy and deliberately preserves the old
 * rendering path. A present malformed value renders UNKNOWN, never success.
 */
export function presentPersistedZeroTerminal(persisted: unknown): ZeroTerminalPresentation | null {
  return persisted === null || persisted === undefined
    ? null
    : presentZeroTerminalV1(parseZeroTerminalV1(persisted));
}
