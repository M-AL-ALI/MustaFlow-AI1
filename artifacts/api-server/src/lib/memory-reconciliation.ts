import { createHash } from "node:crypto";
import { MEMORY_SURFACE_IDS, type MemorySurfaceId, type MemoryTruthRecord } from "./memory-truth";

export const MEMORY_RECONCILIATION_SEMANTICS = "zero-memory-reconciliation-v1" as const;
export const MEMORY_RECONCILIATION_SCOPE = "structural-binding" as const;

export const MEMORY_RECONCILIATION_CHECK_IDS = [
  "observation-available",
  "record-exists",
  "project-binding",
  "source-exists",
  "source-project-binding",
  "content-hash",
  "version-binding",
  "current-project-version",
  "provenance-complete",
  "semantic-verification",
] as const;
export const MEMORY_RECONCILIATION_CHECK_OUTCOMES = [
  "confirmed",
  "contradicted",
  "missing",
  "unsupported",
  "unavailable",
] as const;

export type MemoryReconciliationCheckId = (typeof MEMORY_RECONCILIATION_CHECK_IDS)[number];
export type MemoryReconciliationCheckOutcome =
  (typeof MEMORY_RECONCILIATION_CHECK_OUTCOMES)[number];
export type MemoryReconciliationVerdict = "confirmed" | "stale" | "unverifiable";
export type MemoryReconciliationReason =
  | "authoritative_binding_confirmed"
  | "content_hash_confirmed"
  | "content_hash_mismatch"
  | "current_project_version_advanced"
  | "source_project_mismatch"
  | "binding_contradicted"
  | "record_missing"
  | "source_missing"
  | "provenance_incomplete"
  | "version_binding_missing"
  | "semantic_claim_not_machine_verifiable"
  | "non_project_scope_not_supported"
  | "observation_unavailable";

export type MemoryReconciliationCheck = {
  identity: MemoryReconciliationCheckId;
  outcome: MemoryReconciliationCheckOutcome;
};

export type MemoryReconciliationObservation = {
  observationIdentitySha256: string;
  observedAt: Date | string;
  checks: readonly MemoryReconciliationCheck[];
};

export type MemoryReconciliationResult = {
  semantics: typeof MEMORY_RECONCILIATION_SEMANTICS;
  surfaceId: MemorySurfaceId;
  memoryRecordIdentitySha256: string;
  verdict: MemoryReconciliationVerdict;
  reason: MemoryReconciliationReason;
  verificationScope: typeof MEMORY_RECONCILIATION_SCOPE;
  checks: readonly MemoryReconciliationCheck[];
  observedAt: string;
  evidenceIdentitySha256: string;
};

export class MemoryReconciliationContractError extends Error {
  readonly name = "MemoryReconciliationContractError";

  constructor(
    readonly code:
      | "memory_reconciliation_surface_unknown"
      | "memory_reconciliation_observation_malformed"
      | "memory_reconciliation_observation_duplicate"
      | "memory_reconciliation_result_invalid",
    message: string,
  ) {
    super(message);
  }
}

const VERDICT_REASONS: Readonly<
  Record<MemoryReconciliationVerdict, readonly MemoryReconciliationReason[]>
> = {
  confirmed: ["authoritative_binding_confirmed", "content_hash_confirmed"],
  stale: [
    "content_hash_mismatch",
    "current_project_version_advanced",
    "source_project_mismatch",
    "binding_contradicted",
  ],
  unverifiable: [
    "record_missing",
    "source_missing",
    "provenance_incomplete",
    "version_binding_missing",
    "semantic_claim_not_machine_verifiable",
    "non_project_scope_not_supported",
    "observation_unavailable",
  ],
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizedObservedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MemoryReconciliationContractError(
      "memory_reconciliation_observation_malformed",
      "Memory reconciliation observation time is invalid",
    );
  }
  return date.toISOString();
}

function validateObservation(
  record: MemoryTruthRecord,
  observation: MemoryReconciliationObservation,
): readonly MemoryReconciliationCheck[] {
  if (!MEMORY_SURFACE_IDS.includes(record.surfaceId)) {
    throw new MemoryReconciliationContractError(
      "memory_reconciliation_surface_unknown",
      `Unknown memory reconciliation surface: ${String(record.surfaceId)}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(observation.observationIdentitySha256)) {
    throw new MemoryReconciliationContractError(
      "memory_reconciliation_observation_malformed",
      "Memory reconciliation observation identity must be an opaque SHA-256 value",
    );
  }
  normalizedObservedAt(observation.observedAt);
  const knownChecks = new Set<string>(MEMORY_RECONCILIATION_CHECK_IDS);
  const knownOutcomes = new Set<string>(MEMORY_RECONCILIATION_CHECK_OUTCOMES);
  const seen = new Set<string>();
  for (const check of observation.checks) {
    if (
      !knownChecks.has(check.identity) ||
      !knownOutcomes.has(check.outcome) ||
      seen.has(check.identity)
    ) {
      throw new MemoryReconciliationContractError(
        "memory_reconciliation_observation_malformed",
        `Memory reconciliation observation contains an invalid check: ${String(check.identity)}`,
      );
    }
    seen.add(check.identity);
  }
  if (!seen.has("record-exists") || !seen.has("observation-available")) {
    throw new MemoryReconciliationContractError(
      "memory_reconciliation_observation_malformed",
      "Memory reconciliation observation lacks required availability checks",
    );
  }
  return [...observation.checks].sort((left, right) => left.identity.localeCompare(right.identity));
}

function outcomeFor(
  checks: readonly MemoryReconciliationCheck[],
  identity: MemoryReconciliationCheckId,
): MemoryReconciliationCheckOutcome | undefined {
  return checks.find((check) => check.identity === identity)?.outcome;
}

function decide(
  record: MemoryTruthRecord,
  checks: readonly MemoryReconciliationCheck[],
): { verdict: MemoryReconciliationVerdict; reason: MemoryReconciliationReason } {
  if (record.scope !== "project") {
    return { verdict: "unverifiable", reason: "non_project_scope_not_supported" };
  }
  if (outcomeFor(checks, "observation-available") !== "confirmed") {
    return { verdict: "unverifiable", reason: "observation_unavailable" };
  }
  if (outcomeFor(checks, "record-exists") !== "confirmed") {
    return { verdict: "unverifiable", reason: "record_missing" };
  }
  if (outcomeFor(checks, "content-hash") === "contradicted") {
    return { verdict: "stale", reason: "content_hash_mismatch" };
  }
  if (outcomeFor(checks, "current-project-version") === "contradicted") {
    return { verdict: "stale", reason: "current_project_version_advanced" };
  }
  if (outcomeFor(checks, "source-project-binding") === "contradicted") {
    return { verdict: "stale", reason: "source_project_mismatch" };
  }
  if (
    outcomeFor(checks, "project-binding") === "contradicted" ||
    outcomeFor(checks, "version-binding") === "contradicted"
  ) {
    return { verdict: "stale", reason: "binding_contradicted" };
  }
  if (outcomeFor(checks, "source-exists") === "missing") {
    return { verdict: "unverifiable", reason: "source_missing" };
  }
  if (outcomeFor(checks, "version-binding") === "missing") {
    return { verdict: "unverifiable", reason: "version_binding_missing" };
  }
  if (outcomeFor(checks, "provenance-complete") !== "confirmed") {
    return { verdict: "unverifiable", reason: "provenance_incomplete" };
  }
  if (outcomeFor(checks, "semantic-verification") === "unsupported") {
    return { verdict: "unverifiable", reason: "semantic_claim_not_machine_verifiable" };
  }
  if (outcomeFor(checks, "content-hash") === "confirmed") {
    return { verdict: "confirmed", reason: "content_hash_confirmed" };
  }
  return { verdict: "confirmed", reason: "authoritative_binding_confirmed" };
}

export function assertMemoryReconciliationResult(result: MemoryReconciliationResult): void {
  if (!VERDICT_REASONS[result.verdict].includes(result.reason)) {
    throw new MemoryReconciliationContractError(
      "memory_reconciliation_result_invalid",
      `Memory reconciliation reason ${result.reason} is invalid for ${result.verdict}`,
    );
  }
}

export function reconcileMemoryRecord(
  record: MemoryTruthRecord,
  observation: MemoryReconciliationObservation,
): MemoryReconciliationResult {
  const checks = validateObservation(record, observation);
  const observedAt = normalizedObservedAt(observation.observedAt);
  const decision = decide(record, checks);
  const evidenceFields = {
    semantics: MEMORY_RECONCILIATION_SEMANTICS,
    surfaceId: record.surfaceId,
    memoryRecordIdentitySha256: record.recordIdentitySha256,
    verdict: decision.verdict,
    reason: decision.reason,
    verificationScope: MEMORY_RECONCILIATION_SCOPE,
    observationIdentitySha256: observation.observationIdentitySha256,
    checks,
  };
  const result: MemoryReconciliationResult = {
    ...evidenceFields,
    observedAt,
    evidenceIdentitySha256: sha256(evidenceFields),
  };
  assertMemoryReconciliationResult(result);
  return result;
}

export function reconcileMemoryRecords(
  inputs: readonly {
    record: MemoryTruthRecord;
    observation: MemoryReconciliationObservation;
  }[],
): readonly MemoryReconciliationResult[] {
  const identities = new Set<string>();
  for (const { observation } of inputs) {
    if (identities.has(observation.observationIdentitySha256)) {
      throw new MemoryReconciliationContractError(
        "memory_reconciliation_observation_duplicate",
        "Memory reconciliation observation identity is duplicated",
      );
    }
    identities.add(observation.observationIdentitySha256);
  }
  return inputs
    .map(({ record, observation }) => reconcileMemoryRecord(record, observation))
    .sort((left, right) =>
      `${left.surfaceId}:${left.memoryRecordIdentitySha256}`.localeCompare(
        `${right.surfaceId}:${right.memoryRecordIdentitySha256}`,
      ),
    );
}
