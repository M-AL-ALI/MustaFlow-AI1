import { PROJECT_RETIREMENT_FAILURE_CODES } from "./project-retirement-contract";

type UnknownRecord = Record<string, unknown>;

const FAILURE_CODES = new Set<string>(PROJECT_RETIREMENT_FAILURE_CODES);
const ROUTE_STATES = ["pending", "deactivating", "verified_absent", "failed"] as const;
const LEGACY_ROUTE_STATES = ["not_configured", "verified_absent", "failed"] as const;
const HOSTNAME_STATES = ["absent", "present", "unavailable"] as const;
const HOSTNAME_STAGES = ["delete", "read"] as const;
const RUNTIME_ROUTE_STATES = ["releasing", "verified_absent", "present", "unavailable"] as const;
const CACHE_STATES = ["pending", "purged", "failed"] as const;
const LEGACY_R2_STATES = [
  "pending",
  "deleting",
  "not_configured",
  "verified_absent",
  "failed",
] as const;
const RESOURCE_STATES = ["pending", "releasing", "verified_absent", "failed"] as const;
const PURCHASED_DOMAIN_STATES = ["pending", "retained"] as const;
const RUNTIME_STATES = ["pending", "destroying", "verified_absent", "failed"] as const;
const RUNTIME_ROLES = ["preview", "production"] as const;
const RUNTIME_SLOTS = ["primary", "blue", "green"] as const;
const SECURITY_KINDS = [
  "ruleset_rule",
  "firewall_rule",
  "firewall_filter",
  "rate_limit",
  "mtls_certificate",
] as const;
const POINTERS = ["containerId", "prodContainerId", "testContainerId"] as const;
const POINTER_REASONS = [
  "runtime_identity_malformed",
  "runtime_namespace_mismatch",
  "runtime_project_mismatch",
  "runtime_role_slot_mismatch",
  "legacy_runtime_provider",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closedValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function sanitizeProjectRetirementState(
  value: unknown,
): "accepted" | "running" | "failed" | "completed" | "canceled" | null {
  return closedValue(value, ["accepted", "running", "failed", "completed", "canceled"]);
}

export function sanitizeProjectRetirementFailureCode(value: unknown): string | null {
  return typeof value === "string" && FAILURE_CODES.has(value) ? value : null;
}

export function sanitizeProjectRetirementFailureTarget(value: unknown): {
  role: "preview" | "production";
  slot: "primary" | "blue" | "green";
} | null {
  if (!isRecord(value)) return null;
  const role = closedValue(value.role, RUNTIME_ROLES);
  const slot = closedValue(value.slot, RUNTIME_SLOTS);
  if (!role || !slot) return null;
  if ((role === "preview" && slot !== "primary") || (role === "production" && slot === "primary")) {
    return null;
  }
  return { role, slot };
}

type ReceiptSummary = {
  total: number;
  unrecognized: number;
  states: Record<string, number>;
  causes: Record<string, number>;
};

function summarizeReceipts(
  value: unknown,
  allowedStates: readonly string[],
  options?: {
    allowedKinds?: readonly string[];
    kindField?: string;
    includeStages?: readonly string[];
  },
): ReceiptSummary & { kinds?: Record<string, number>; stages?: Record<string, number> } {
  const receipts = Array.isArray(value) ? value : [];
  const summary: ReceiptSummary & {
    kinds?: Record<string, number>;
    stages?: Record<string, number>;
  } = {
    total: receipts.length,
    unrecognized: 0,
    states: {},
    causes: {},
  };
  if (options?.allowedKinds) summary.kinds = {};
  if (options?.includeStages) summary.stages = {};

  for (const receipt of receipts) {
    if (!isRecord(receipt)) {
      summary.unrecognized += 1;
      continue;
    }
    let unrecognized = false;
    const state = closedValue(receipt.state, allowedStates);
    if (state) summary.states[state] = (summary.states[state] ?? 0) + 1;
    else unrecognized = true;

    const cause = sanitizeProjectRetirementFailureCode(receipt.failureCode);
    if (cause) summary.causes[cause] = (summary.causes[cause] ?? 0) + 1;
    else if (receipt.failureCode !== null && receipt.failureCode !== undefined) unrecognized = true;

    if (options?.allowedKinds && summary.kinds) {
      const kind = closedValue(receipt[options.kindField ?? "kind"], options.allowedKinds);
      if (kind) summary.kinds[kind] = (summary.kinds[kind] ?? 0) + 1;
      else unrecognized = true;
    }
    if (options?.includeStages && summary.stages) {
      const stage = closedValue(receipt.stage, options.includeStages);
      if (stage) summary.stages[stage] = (summary.stages[stage] ?? 0) + 1;
      if (
        (state === "unavailable" && !stage) ||
        (state !== "unavailable" && receipt.stage != null)
      ) {
        unrecognized = true;
      }
    }
    if (unrecognized) summary.unrecognized += 1;
  }
  return summary;
}

function sanitizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function summarizeRetainedRuntimePointers(value: unknown): {
  total: number;
  unrecognized: number;
  pointers: Record<string, number>;
  reasons: Record<string, number>;
} {
  const receipts = Array.isArray(value) ? value : [];
  const summary = {
    total: receipts.length,
    unrecognized: 0,
    pointers: {} as Record<string, number>,
    reasons: {} as Record<string, number>,
  };
  for (const receipt of receipts) {
    if (!isRecord(receipt)) {
      summary.unrecognized += 1;
      continue;
    }
    const pointer = closedValue(receipt.pointer, POINTERS);
    const reason = closedValue(receipt.reason, POINTER_REASONS);
    if (!pointer || !reason) {
      summary.unrecognized += 1;
      continue;
    }
    summary.pointers[pointer] = (summary.pointers[pointer] ?? 0) + 1;
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
  }
  return summary;
}

function sanitizeRuntimeReceipts(value: unknown): {
  total: number;
  unrecognized: number;
  receipts: Array<{
    role: "preview" | "production";
    slot: "primary" | "blue" | "green";
    state: (typeof RUNTIME_STATES)[number];
    attempts: number;
    failureCode: string | null;
  }>;
} {
  const source = Array.isArray(value) ? value : [];
  const summary = {
    total: source.length,
    unrecognized: 0,
    receipts: [] as Array<{
      role: "preview" | "production";
      slot: "primary" | "blue" | "green";
      state: (typeof RUNTIME_STATES)[number];
      attempts: number;
      failureCode: string | null;
    }>,
  };
  for (const receipt of source) {
    if (!isRecord(receipt)) {
      summary.unrecognized += 1;
      continue;
    }
    const role = closedValue(receipt.role, RUNTIME_ROLES);
    const slot = closedValue(receipt.slot, RUNTIME_SLOTS);
    const state = closedValue(receipt.state, RUNTIME_STATES);
    const attempts = safeCount(receipt.attempts);
    const failureCode = sanitizeProjectRetirementFailureCode(receipt.failureCode);
    if (
      !role ||
      !slot ||
      !state ||
      attempts === null ||
      (receipt.failureCode !== null && failureCode === null) ||
      (role === "preview" && slot !== "primary") ||
      (role === "production" && slot === "primary")
    ) {
      summary.unrecognized += 1;
      continue;
    }
    summary.receipts.push({ role, slot, state, attempts, failureCode });
  }
  return summary;
}

/**
 * A terminal-safe projection of the persisted JSONB trail. It preserves the
 * governed stage/state/count/cause evidence while excluding user-controlled
 * hostnames and internal provider, runtime, actor, and resource identifiers.
 */
export function sanitizeProjectRetirementProgress(value: unknown): Record<string, unknown> {
  const progress = isRecord(value) ? value : {};
  const route = isRecord(progress.route) ? progress.route : {};
  const legacyHostnameKv = isRecord(route.legacyHostnameKv) ? route.legacyHostnameKv : null;
  const tasks = isRecord(progress.tasks) ? progress.tasks : {};
  const access = isRecord(progress.access) ? progress.access : {};
  const legacyR2 = isRecord(progress.legacyR2) ? progress.legacyR2 : {};
  const reconciliation = isRecord(progress.reconciliation) ? progress.reconciliation : null;
  const restore = isRecord(progress.restore) ? progress.restore : null;

  return {
    semantics: progress.semantics === "project-retirement-v2" ? "project-retirement-v2" : null,
    reconciliation: reconciliation
      ? {
          generation: safeCount(reconciliation.generation),
          reason: closedValue(reconciliation.reason, [
            "retryable_terminal",
            "legacy_admin_reconciliation",
          ]),
          hasParent: typeof reconciliation.parentOperationId === "string",
        }
      : null,
    restore:
      restore?.state === "restored"
        ? { state: "restored", restoredAt: sanitizedTimestamp(restore.restoredAt) }
        : null,
    route: {
      state: closedValue(route.state, ROUTE_STATES),
      failureCode: sanitizeProjectRetirementFailureCode(route.failureCode),
      legacyHostnameKv: legacyHostnameKv
        ? {
            state: closedValue(legacyHostnameKv.state, LEGACY_ROUTE_STATES),
            failureCode: sanitizeProjectRetirementFailureCode(legacyHostnameKv.failureCode),
          }
        : null,
      hostnames: summarizeReceipts(route.hostnames, HOSTNAME_STATES, {
        includeStages: HOSTNAME_STAGES,
      }),
      runtimeRoutes: summarizeReceipts(route.runtimeRoutes, RUNTIME_ROUTE_STATES),
      cache: {
        state: closedValue(isRecord(route.cache) ? route.cache.state : null, CACHE_STATES),
      },
    },
    tasks: {
      state: closedValue(tasks.state, ["pending", "canceled"]),
      count: safeCount(tasks.count),
      terminalized: safeCount(tasks.terminalized),
      creditsRefunded: safeCount(tasks.creditsRefunded),
      telemetryFlushed: safeCount(tasks.telemetryFlushed),
    },
    access: {
      state: closedValue(access.state, ["pending", "revoked"]),
      shareLinksRevoked: safeCount(access.shareLinksRevoked),
      previewSessionsRevoked: safeCount(access.previewSessionsRevoked),
      supportGrantsRevoked: safeCount(access.supportGrantsRevoked),
      supportSessionsInterrupted: safeCount(access.supportSessionsInterrupted),
      canvasShareTokensCleared: safeCount(access.canvasShareTokensCleared),
      canvasAbTestsEnded: safeCount(access.canvasAbTestsEnded),
    },
    legacyR2: {
      state: closedValue(legacyR2.state, LEGACY_R2_STATES),
      discoveredCount: safeCount(legacyR2.discoveredCount),
      deletedCount: safeCount(legacyR2.deletedCount),
      failureCode: sanitizeProjectRetirementFailureCode(legacyR2.failureCode),
    },
    domains: summarizeReceipts(progress.domains, RESOURCE_STATES),
    hostnameCertificates: summarizeReceipts(progress.hostnameCertificates, RESOURCE_STATES),
    securityResources: summarizeReceipts(progress.securityResources, RESOURCE_STATES, {
      allowedKinds: SECURITY_KINDS,
    }),
    purchasedDomains: summarizeReceipts(progress.purchasedDomains, PURCHASED_DOMAIN_STATES),
    retainedLegacyRuntimePointers: summarizeRetainedRuntimePointers(
      progress.retainedLegacyRuntimePointers,
    ),
    runtimes: sanitizeRuntimeReceipts(progress.runtimes),
  };
}
