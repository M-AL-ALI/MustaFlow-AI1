export const PROJECT_PURGE_SEMANTICS = "project-purge-v1" as const;
export const PROJECT_PURGE_TERMINAL_SEMANTICS = "project-purge-terminal-v1" as const;

export const PROJECT_PURGE_TRIGGERS = ["manual", "expiry"] as const;
export type ProjectPurgeTrigger = (typeof PROJECT_PURGE_TRIGGERS)[number];

export const PROJECT_PURGE_STATES = [
  "scheduled",
  "accepted",
  "running",
  "failed",
  "completed",
  "canceled",
] as const;
export type ProjectPurgeState = (typeof PROJECT_PURGE_STATES)[number];

export const PROJECT_PURGE_STAGES = [
  "verify",
  "inventory",
  "assets",
  "snapshots",
  "database",
  "addons",
  "runtime",
  "relational",
  "absence",
] as const;
export type ProjectPurgeStage = (typeof PROJECT_PURGE_STAGES)[number];

export const PROJECT_PURGE_FAILURE_CODES = [
  "project_purge_owner_required",
  "project_purge_reverification_required",
  "project_purge_name_mismatch",
  "project_purge_project_active",
  "project_purge_retirement_incomplete",
  "project_purge_operation_conflict",
  "project_purge_inventory_unavailable",
  "project_purge_asset_release_failed",
  "project_purge_snapshot_release_failed",
  "project_purge_database_release_failed",
  "project_purge_addon_release_failed",
  "project_purge_runtime_release_failed",
  "project_purge_relational_delete_failed",
  "project_purge_absence_unverified",
  "project_purge_attempts_exhausted",
  "project_purge_operation_unavailable",
] as const;
export type ProjectPurgeFailureCode = (typeof PROJECT_PURGE_FAILURE_CODES)[number];

export const PROJECT_PURGE_CANCELLATION_REASONS = [
  "project_restored",
  "owner_canceled_before_start",
] as const;
export type ProjectPurgeCancellationReason = (typeof PROJECT_PURGE_CANCELLATION_REASONS)[number];

export type ProjectPurgeCompletedEvidence = {
  schema: typeof PROJECT_PURGE_TERMINAL_SEMANTICS;
  outcome: "completed";
  inventoryDigestSha256: string;
  absenceDigestSha256: string;
  removedResourceCount: number;
  detachedResourceCount: number;
};

export type ProjectPurgeFailedEvidence = {
  schema: typeof PROJECT_PURGE_TERMINAL_SEMANTICS;
  outcome: "failed";
  stage: ProjectPurgeStage;
  failureCode: ProjectPurgeFailureCode;
  retryable: boolean;
};

export type ProjectPurgeCanceledEvidence = {
  schema: typeof PROJECT_PURGE_TERMINAL_SEMANTICS;
  outcome: "canceled";
  reason: ProjectPurgeCancellationReason;
};

/**
 * Sanitized durable evidence only. Project names, source, secrets, provider
 * payloads, object keys, hostnames, and raw user identifiers never belong here.
 */
export type ProjectPurgeTerminalEvidence =
  | ProjectPurgeCompletedEvidence
  | ProjectPurgeFailedEvidence
  | ProjectPurgeCanceledEvidence;

export type ProjectPurgeReceiptContext = {
  operationId: string;
  projectId: number;
};

const projectPurgeReceiptBrand: unique symbol = Symbol("ProjectPurgeReceipt");
type ProjectPurgeReceiptBrand = { readonly [projectPurgeReceiptBrand]: true };

type ProjectPurgeReceiptBase = ProjectPurgeReceiptBrand & {
  schema: typeof PROJECT_PURGE_SEMANTICS;
  operationId: string;
  projectId: number;
  retirementOperationIdHash: string;
  trigger: ProjectPurgeTrigger;
  stage: ProjectPurgeStage;
  attemptCount: number;
  dueAt: string;
};

export type ProjectPurgeScheduledReceipt = ProjectPurgeReceiptBase & {
  state: "scheduled";
  stage: "verify";
  failureCode: null;
  failureRetryable: null;
  terminalEvidence: null;
};

export type ProjectPurgeAcceptedReceipt = ProjectPurgeReceiptBase & {
  state: "accepted";
  stage: "verify";
  failureCode: null;
  failureRetryable: null;
  terminalEvidence: null;
};

export type ProjectPurgeRunningReceipt = ProjectPurgeReceiptBase & {
  state: "running";
  failureCode: null;
  failureRetryable: null;
  terminalEvidence: null;
};

export type ProjectPurgeFailedReceipt = ProjectPurgeReceiptBase & {
  state: "failed";
  failureCode: ProjectPurgeFailureCode;
  failureRetryable: boolean;
  terminalEvidence: ProjectPurgeFailedEvidence;
};

export type ProjectPurgeCompletedReceipt = ProjectPurgeReceiptBase & {
  state: "completed";
  stage: "absence";
  failureCode: null;
  failureRetryable: null;
  terminalEvidence: ProjectPurgeCompletedEvidence;
};

export type ProjectPurgeCanceledReceipt = ProjectPurgeReceiptBase & {
  state: "canceled";
  stage: "verify";
  failureCode: null;
  failureRetryable: null;
  terminalEvidence: ProjectPurgeCanceledEvidence;
};

export type ProjectPurgeReceipt =
  | ProjectPurgeScheduledReceipt
  | ProjectPurgeAcceptedReceipt
  | ProjectPurgeRunningReceipt
  | ProjectPurgeFailedReceipt
  | ProjectPurgeCompletedReceipt
  | ProjectPurgeCanceledReceipt;

type ProjectPurgeReceiptInput<T extends ProjectPurgeReceipt> = Omit<
  T,
  typeof projectPurgeReceiptBrand
>;

function brandProjectPurgeReceipt<T extends ProjectPurgeReceipt>(
  value: ProjectPurgeReceiptInput<T>,
): T {
  return { ...value, [projectPurgeReceiptBrand]: true } as unknown as T;
}

export function scheduledProjectPurgeReceipt(
  input: ProjectPurgeReceiptInput<ProjectPurgeScheduledReceipt>,
): ProjectPurgeScheduledReceipt {
  return brandProjectPurgeReceipt(input);
}

export function acceptedProjectPurgeReceipt(
  input: ProjectPurgeReceiptInput<ProjectPurgeAcceptedReceipt>,
): ProjectPurgeAcceptedReceipt {
  return brandProjectPurgeReceipt(input);
}

export function runningProjectPurgeReceipt(
  input: ProjectPurgeReceiptInput<ProjectPurgeRunningReceipt>,
): ProjectPurgeRunningReceipt {
  return brandProjectPurgeReceipt(input);
}

export function failedProjectPurgeReceipt(
  input: ProjectPurgeReceiptInput<ProjectPurgeFailedReceipt>,
): ProjectPurgeFailedReceipt {
  return brandProjectPurgeReceipt(input);
}

export function completedProjectPurgeReceipt(
  input: ProjectPurgeReceiptInput<ProjectPurgeCompletedReceipt>,
): ProjectPurgeCompletedReceipt {
  return brandProjectPurgeReceipt(input);
}

export function canceledProjectPurgeReceipt(
  input: ProjectPurgeReceiptInput<ProjectPurgeCanceledReceipt>,
): ProjectPurgeCanceledReceipt {
  return brandProjectPurgeReceipt(input);
}

export type ProjectPurgeParseResult =
  | { ok: true; value: ProjectPurgeReceipt }
  | { ok: false; code: "project_purge_receipt_invalid" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

const RECEIPT_KEYS = [
  "schema",
  "operationId",
  "projectId",
  "retirementOperationIdHash",
  "trigger",
  "state",
  "stage",
  "attemptCount",
  "dueAt",
  "failureCode",
  "failureRetryable",
  "terminalEvidence",
] as const;

function parseTerminalEvidence(value: unknown): ProjectPurgeTerminalEvidence | null {
  const evidence = record(value);
  if (!evidence || evidence.schema !== PROJECT_PURGE_TERMINAL_SEMANTICS) return null;

  if (evidence.outcome === "completed") {
    if (
      !hasOnlyKeys(evidence, [
        "schema",
        "outcome",
        "inventoryDigestSha256",
        "absenceDigestSha256",
        "removedResourceCount",
        "detachedResourceCount",
      ]) ||
      !isSha256(evidence.inventoryDigestSha256) ||
      !isSha256(evidence.absenceDigestSha256) ||
      !isNonnegativeInteger(evidence.removedResourceCount) ||
      !isNonnegativeInteger(evidence.detachedResourceCount)
    ) {
      return null;
    }
    return evidence as ProjectPurgeCompletedEvidence;
  }

  if (evidence.outcome === "failed") {
    if (
      !hasOnlyKeys(evidence, ["schema", "outcome", "stage", "failureCode", "retryable"]) ||
      !includes(PROJECT_PURGE_STAGES, evidence.stage) ||
      !includes(PROJECT_PURGE_FAILURE_CODES, evidence.failureCode) ||
      typeof evidence.retryable !== "boolean"
    ) {
      return null;
    }
    return evidence as ProjectPurgeFailedEvidence;
  }

  if (evidence.outcome === "canceled") {
    if (
      !hasOnlyKeys(evidence, ["schema", "outcome", "reason"]) ||
      !includes(PROJECT_PURGE_CANCELLATION_REASONS, evidence.reason)
    ) {
      return null;
    }
    return evidence as ProjectPurgeCanceledEvidence;
  }

  return null;
}

/**
 * Parse at every durable/process boundary. Any mismatch fails closed and can
 * never be presented as a completed deletion.
 */
export function parseProjectPurgeReceipt(
  value: unknown,
  context: ProjectPurgeReceiptContext,
): ProjectPurgeParseResult {
  const candidate = record(value);
  if (
    !candidate ||
    !hasOnlyKeys(candidate, RECEIPT_KEYS) ||
    candidate.schema !== PROJECT_PURGE_SEMANTICS ||
    candidate.operationId !== context.operationId ||
    candidate.projectId !== context.projectId ||
    typeof candidate.operationId !== "string" ||
    candidate.operationId.length === 0 ||
    candidate.operationId.length > 200 ||
    !isPositiveInteger(candidate.projectId) ||
    !isSha256(candidate.retirementOperationIdHash) ||
    !includes(PROJECT_PURGE_TRIGGERS, candidate.trigger) ||
    !includes(PROJECT_PURGE_STATES, candidate.state) ||
    !includes(PROJECT_PURGE_STAGES, candidate.stage) ||
    !isNonnegativeInteger(candidate.attemptCount) ||
    !isIsoTimestamp(candidate.dueAt)
  ) {
    return { ok: false, code: "project_purge_receipt_invalid" };
  }

  const evidence = parseTerminalEvidence(candidate.terminalEvidence);
  const common = candidate as unknown as ProjectPurgeReceiptInput<ProjectPurgeReceipt>;

  if (
    candidate.state === "scheduled" &&
    candidate.stage === "verify" &&
    candidate.failureCode === null &&
    candidate.failureRetryable === null &&
    candidate.terminalEvidence === null
  ) {
    return {
      ok: true,
      value: scheduledProjectPurgeReceipt(
        common as ProjectPurgeReceiptInput<ProjectPurgeScheduledReceipt>,
      ),
    };
  }

  if (
    candidate.state === "accepted" &&
    candidate.stage === "verify" &&
    candidate.failureCode === null &&
    candidate.failureRetryable === null &&
    candidate.terminalEvidence === null
  ) {
    return {
      ok: true,
      value: acceptedProjectPurgeReceipt(
        common as ProjectPurgeReceiptInput<ProjectPurgeAcceptedReceipt>,
      ),
    };
  }

  if (
    candidate.state === "running" &&
    candidate.failureCode === null &&
    candidate.failureRetryable === null &&
    candidate.terminalEvidence === null
  ) {
    return {
      ok: true,
      value: runningProjectPurgeReceipt(
        common as ProjectPurgeReceiptInput<ProjectPurgeRunningReceipt>,
      ),
    };
  }

  if (
    candidate.state === "failed" &&
    includes(PROJECT_PURGE_FAILURE_CODES, candidate.failureCode) &&
    typeof candidate.failureRetryable === "boolean" &&
    evidence?.outcome === "failed" &&
    evidence.stage === candidate.stage &&
    evidence.failureCode === candidate.failureCode &&
    evidence.retryable === candidate.failureRetryable
  ) {
    return {
      ok: true,
      value: failedProjectPurgeReceipt({
        ...common,
        state: "failed",
        failureCode: candidate.failureCode,
        failureRetryable: candidate.failureRetryable,
        terminalEvidence: evidence,
      } as ProjectPurgeReceiptInput<ProjectPurgeFailedReceipt>),
    };
  }

  if (
    candidate.state === "completed" &&
    candidate.stage === "absence" &&
    candidate.failureCode === null &&
    candidate.failureRetryable === null &&
    evidence?.outcome === "completed"
  ) {
    return {
      ok: true,
      value: completedProjectPurgeReceipt({
        ...common,
        state: "completed",
        stage: "absence",
        failureCode: null,
        failureRetryable: null,
        terminalEvidence: evidence,
      } as ProjectPurgeReceiptInput<ProjectPurgeCompletedReceipt>),
    };
  }

  if (
    candidate.state === "canceled" &&
    candidate.stage === "verify" &&
    candidate.failureCode === null &&
    candidate.failureRetryable === null &&
    evidence?.outcome === "canceled"
  ) {
    return {
      ok: true,
      value: canceledProjectPurgeReceipt({
        ...common,
        state: "canceled",
        stage: "verify",
        failureCode: null,
        failureRetryable: null,
        terminalEvidence: evidence,
      } as ProjectPurgeReceiptInput<ProjectPurgeCanceledReceipt>),
    };
  }

  return { ok: false, code: "project_purge_receipt_invalid" };
}

export type ProjectPurgePresentation = {
  state: ProjectPurgeState | "unknown";
  tone: "neutral" | "progress" | "warning" | "success" | "unknown";
  title: string;
  message: string;
  terminal: boolean;
  canRetry: boolean;
};

const RUNNING_COPY: Readonly<Record<ProjectPurgeStage, string>> = {
  verify: "Confirming that this project can be deleted safely.",
  inventory: "Finding everything that belongs to this project.",
  assets: "Removing files that only this project uses.",
  snapshots: "Removing saved runtime copies owned by this project.",
  database: "Removing databases owned by this project.",
  addons: "Removing add-ons owned by this project.",
  runtime: "Removing previews, published services, and routes.",
  relational: "Removing the project's remaining NabuFlow records.",
  absence: "Checking that nothing owned by this project remains.",
};

/** The sole plain-language renderer for durable purge receipts. */
export function presentProjectPurge(result: ProjectPurgeParseResult): ProjectPurgePresentation {
  if (!result.ok) {
    return {
      state: "unknown",
      tone: "unknown",
      title: "Deletion status could not be verified",
      message: "Check again before taking another action.",
      terminal: false,
      canRetry: true,
    };
  }

  const receipt = result.value;
  switch (receipt.state) {
    case "scheduled":
      return {
        state: receipt.state,
        tone: "neutral",
        title: "Permanent deletion is scheduled",
        message: "This project stays recoverable until its Trash recovery period ends.",
        terminal: false,
        canRetry: false,
      };
    case "accepted":
      return {
        state: receipt.state,
        tone: "progress",
        title: "Permanent deletion is starting",
        message: "The project is locked while deletion begins.",
        terminal: false,
        canRetry: false,
      };
    case "running":
      return {
        state: receipt.state,
        tone: "progress",
        title: "Permanent deletion is in progress",
        message: RUNNING_COPY[receipt.stage],
        terminal: false,
        canRetry: false,
      };
    case "failed":
      return receipt.failureRetryable
        ? {
            state: receipt.state,
            tone: "warning",
            title: "Permanent deletion paused safely",
            message: "Nothing is reported deleted until every required check succeeds. Try again.",
            terminal: true,
            canRetry: true,
          }
        : {
            state: receipt.state,
            tone: "warning",
            title: "Permanent deletion needs attention",
            message: "The project was not reported deleted. Contact support for help continuing.",
            terminal: true,
            canRetry: false,
          };
    case "completed":
      return {
        state: receipt.state,
        tone: "success",
        title: "Project permanently deleted",
        message: "NabuFlow verified that the project's owned data and resources are gone.",
        terminal: true,
        canRetry: false,
      };
    case "canceled":
      return {
        state: receipt.state,
        tone: "neutral",
        title: "Permanent deletion was canceled",
        message: "No permanent deletion will run for this Trash cycle.",
        terminal: true,
        canRetry: false,
      };
  }
}
