import {
  productionDatabaseAllocationRecordSchema,
  type ProductionDatabaseAllocationRecord,
  type ProductionDatabaseAdmissionReceipt,
} from "@workspace/tenant-runtime-contracts";

export type ProductionDatabaseProviderScope = {
  providerOrganizationId: string;
  regionId: string;
  historyRetentionSeconds: number;
};

export type ProductionDatabaseEnsureInput = {
  projectId: number;
  allocationIdentity: string;
  beforeCreate?: (scope: ProductionDatabaseProviderScope) => Promise<void>;
  onProjectResolved?: (
    project: ProductionDatabaseProviderScope & { providerProjectId: string },
  ) => Promise<void>;
};

export type ProductionDatabaseIntentOwner = {
  projectId: number;
  allocationIdentity: string;
};

export type ProductionDatabaseNegativeReleaseEvidence = {
  version: 1;
  kind: "sealed-birth-no-dispatch";
  registrationEpoch: string;
  birthToken: string;
  receiptId: string;
  verifiedAt: string;
};

export type ProductionDatabaseIntent = ProductionDatabaseIntentOwner & {
  version: 1 | 2;
  state: "dispatched" | "provider-known" | "releasing" | "released";
  scope: ProductionDatabaseProviderScope | null;
  providerProjectId: string | null;
  createdAt: string;
  updatedAt: string;
  completionEvidence?:
    | {
        version: 1;
        kind: "exact-provider-id-get-404";
        verifiedAt: string;
      }
    | ProductionDatabaseNegativeReleaseEvidence;
};

// This key is independent of job/idempotency TTLs and the ready allocation record.
export const PRODUCTION_DATABASE_INTENT_STORAGE_KEY = "intent:production:neon-postgres";

export interface ProductionDatabaseIntentVault {
  getProductionDatabaseIntent(
    input: ProductionDatabaseIntentOwner,
  ): Promise<ProductionDatabaseIntent | null>;
  claimProductionDatabaseDispatch(
    input: ProductionDatabaseIntentOwner & {
      scope: ProductionDatabaseProviderScope;
      expiresAtMs: number;
    },
  ): Promise<void>;
  recordProductionDatabaseProject(
    input: ProductionDatabaseIntentOwner & {
      scope: ProductionDatabaseProviderScope;
      providerProjectId: string;
      expiresAtMs?: number;
    },
  ): Promise<ProductionDatabaseIntent>;
}

const INTENT_ERROR_CODES = [
  "production_database_allocation_uncertain",
  "production_database_release_in_progress",
  "production_database_intent_conflict",
  "production_database_authority_lost",
] as const;
type IntentErrorCode = (typeof INTENT_ERROR_CODES)[number];

export class ProductionDatabaseIntentError extends Error {
  constructor(readonly code: IntentErrorCode) {
    super(code);
    this.name = "ProductionDatabaseIntentError";
  }
}

// Durable Object RPC may preserve only the Error message, not its subclass.
export function productionDatabaseIntentErrorCode(error: unknown): IntentErrorCode | null {
  return error instanceof Error && INTENT_ERROR_CODES.includes(error.message as IntentErrorCode)
    ? (error.message as IntentErrorCode)
    : null;
}

function conflict(): never {
  throw new ProductionDatabaseIntentError("production_database_intent_conflict");
}

const ADMISSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function isAdmissionUuid(value: unknown): value is string {
  return typeof value === "string" && ADMISSION_UUID.test(value);
}

function isNegativeReleaseEvidence(
  value: unknown,
): value is ProductionDatabaseNegativeReleaseEvidence {
  return (
    isRecord(value) &&
    hasExactFields(value, [
      "version",
      "kind",
      "registrationEpoch",
      "birthToken",
      "receiptId",
      "verifiedAt",
    ]) &&
    value.version === 1 &&
    value.kind === "sealed-birth-no-dispatch" &&
    isAdmissionUuid(value.registrationEpoch) &&
    isAdmissionUuid(value.birthToken) &&
    isAdmissionUuid(value.receiptId) &&
    typeof value.verifiedAt === "string" &&
    Number.isFinite(Date.parse(value.verifiedAt))
  );
}

function assertSealedBirthReceipt(
  value: unknown,
  owner: ProductionDatabaseIntentOwner,
): asserts value is ProductionDatabaseAdmissionReceipt {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "format",
      "issuer",
      "audience",
      "projectId",
      "allocationIdentity",
      "registrationEpoch",
      "birthToken",
      "assertion",
      "receiptId",
      "birthRegistered",
    ]) ||
    value.format !== "nabuflow.production-database-admission/v1" ||
    value.issuer !== "nabuflow-api" ||
    value.audience !== "production" ||
    typeof value.projectId !== "number" ||
    !Number.isSafeInteger(value.projectId) ||
    value.projectId < 1 ||
    typeof value.allocationIdentity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.allocationIdentity) ||
    value.projectId !== owner.projectId ||
    value.allocationIdentity !== owner.allocationIdentity ||
    !isAdmissionUuid(value.registrationEpoch) ||
    !isAdmissionUuid(value.birthToken) ||
    !isAdmissionUuid(value.receiptId) ||
    (value.assertion !== "authorized" && value.assertion !== "sealed") ||
    typeof value.birthRegistered !== "boolean"
  ) {
    return conflict();
  }
  if (value.assertion !== "sealed" || !value.birthRegistered) {
    throw new ProductionDatabaseIntentError("production_database_allocation_uncertain");
  }
}

export function productionDatabaseScope(
  input: ProductionDatabaseProviderScope,
): ProductionDatabaseProviderScope {
  return {
    providerOrganizationId: input.providerOrganizationId,
    regionId: input.regionId,
    historyRetentionSeconds: input.historyRetentionSeconds,
  };
}

export function assertProductionDatabaseIntentAuthority(
  expiresAtMs: number | undefined,
  nowMs: number,
): void {
  if (expiresAtMs !== undefined && (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs)) {
    throw new ProductionDatabaseIntentError("production_database_authority_lost");
  }
}

export function parseProductionDatabaseIntent(
  value: unknown,
  owner: ProductionDatabaseIntentOwner,
): ProductionDatabaseIntent | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return conflict();
  const intent = value as ProductionDatabaseIntent;
  if (
    (intent.version !== 1 && intent.version !== 2) ||
    intent.projectId !== owner.projectId ||
    intent.allocationIdentity !== owner.allocationIdentity ||
    !Number.isSafeInteger(intent.projectId) ||
    intent.projectId < 1 ||
    !/^[0-9a-f]{64}$/u.test(intent.allocationIdentity) ||
    !["dispatched", "provider-known", "releasing", "released"].includes(intent.state) ||
    typeof intent.createdAt !== "string" ||
    typeof intent.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(intent.createdAt)) ||
    !Number.isFinite(Date.parse(intent.updatedAt))
  )
    return conflict();
  if (intent.state === "released") {
    if (intent.scope !== null || intent.providerProjectId !== null) return conflict();
  } else if (intent.scope === null) {
    // Missing legacy ownership is unresolved, not evidence that nothing existed.
    if (intent.state !== "releasing" || intent.providerProjectId !== null) return conflict();
  } else {
    if (typeof intent.scope !== "object" || intent.scope === null) return conflict();
    if (
      (intent.state === "dispatched" && intent.providerProjectId !== null) ||
      (intent.state === "provider-known" && intent.providerProjectId === null) ||
      (intent.providerProjectId !== null &&
        (typeof intent.providerProjectId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(intent.providerProjectId)))
    )
      return conflict();
    productionDatabaseAllocationRecordSchema.parse({
      format: "nabuflow.production-database-allocation/v1",
      projectId: owner.projectId,
      allocationIdentity: owner.allocationIdentity,
      provider: "neon-postgres",
      ...productionDatabaseScope(intent.scope),
      providerProjectId: intent.providerProjectId ?? "unresolved",
      revision: "production-database-" + owner.allocationIdentity.slice(0, 48),
      state: "releasing",
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    });
  }
  const evidence = intent.completionEvidence;
  if (intent.version === 2) {
    if (intent.state !== "released" || !isNegativeReleaseEvidence(evidence)) return conflict();
  } else if (
    evidence !== undefined &&
    (intent.state !== "released" ||
      evidence === null ||
      typeof evidence !== "object" ||
      evidence.version !== 1 ||
      evidence.kind !== "exact-provider-id-get-404" ||
      typeof evidence.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(evidence.verifiedAt)))
  )
    return conflict();
  return {
    version: intent.version,
    projectId: owner.projectId,
    allocationIdentity: owner.allocationIdentity,
    state: intent.state,
    scope: intent.scope === null ? null : productionDatabaseScope(intent.scope),
    providerProjectId: intent.providerProjectId,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    ...(evidence === undefined
      ? {}
      : {
          completionEvidence:
            evidence.kind === "sealed-birth-no-dispatch"
              ? {
                  version: 1 as const,
                  kind: "sealed-birth-no-dispatch" as const,
                  registrationEpoch: evidence.registrationEpoch,
                  birthToken: evidence.birthToken,
                  receiptId: evidence.receiptId,
                  verifiedAt: evidence.verifiedAt,
                }
              : {
                  version: 1 as const,
                  kind: "exact-provider-id-get-404" as const,
                  verifiedAt: evidence.verifiedAt,
                },
        }),
  };
}

export function hasVerifiedProductionDatabaseRelease(
  intent: ProductionDatabaseIntent | null,
): boolean {
  if (intent?.state !== "released" || intent.scope !== null || intent.providerProjectId !== null) {
    return false;
  }
  if (intent.version === 2) {
    return (
      Number.isSafeInteger(intent.projectId) &&
      intent.projectId > 0 &&
      typeof intent.allocationIdentity === "string" &&
      /^[0-9a-f]{64}$/u.test(intent.allocationIdentity) &&
      typeof intent.createdAt === "string" &&
      typeof intent.updatedAt === "string" &&
      Number.isFinite(Date.parse(intent.createdAt)) &&
      Number.isFinite(Date.parse(intent.updatedAt)) &&
      isNegativeReleaseEvidence(intent.completionEvidence)
    );
  }
  return (
    intent.version === 1 &&
    intent.completionEvidence?.version === 1 &&
    intent.completionEvidence.kind === "exact-provider-id-get-404" &&
    Number.isFinite(Date.parse(intent.completionEvidence.verifiedAt))
  );
}

function sameScope(
  a: ProductionDatabaseProviderScope,
  b: ProductionDatabaseProviderScope,
): boolean {
  return (
    a.providerOrganizationId === b.providerOrganizationId &&
    a.regionId === b.regionId &&
    a.historyRetentionSeconds === b.historyRetentionSeconds
  );
}

function makeIntent(
  owner: ProductionDatabaseIntentOwner,
  state: ProductionDatabaseIntent["state"],
  scope: ProductionDatabaseProviderScope | null,
  providerProjectId: string | null,
  nowMs: number,
  createdAt = new Date(nowMs).toISOString(),
  completionEvidence?: ProductionDatabaseIntent["completionEvidence"],
): ProductionDatabaseIntent {
  return parseProductionDatabaseIntent(
    {
      version: completionEvidence?.kind === "sealed-birth-no-dispatch" ? 2 : 1,
      projectId: owner.projectId,
      allocationIdentity: owner.allocationIdentity,
      state,
      scope,
      providerProjectId,
      createdAt,
      updatedAt: new Date(nowMs).toISOString(),
      ...(completionEvidence === undefined ? {} : { completionEvidence }),
    },
    owner,
  )!;
}

export function claimProductionDatabaseDispatchIntent(
  current: ProductionDatabaseIntent | null,
  owner: ProductionDatabaseIntentOwner,
  scope: ProductionDatabaseProviderScope,
  nowMs: number,
): ProductionDatabaseIntent {
  if (current !== null) {
    parseProductionDatabaseIntent(current, owner);
    throw new ProductionDatabaseIntentError(
      current.state === "releasing" || current.state === "released"
        ? "production_database_release_in_progress"
        : "production_database_allocation_uncertain",
    );
  }
  return makeIntent(owner, "dispatched", scope, null, nowMs);
}

/** The vault must additionally compare allocation and capability records atomically. */
export function completeNeverDispatchedProductionDatabaseReleaseIntent(
  current: ProductionDatabaseIntent | null,
  owner: ProductionDatabaseIntentOwner,
  receipt: ProductionDatabaseAdmissionReceipt,
  nowMs: number,
): ProductionDatabaseIntent {
  // Epoch activation and signed-request authentication belong to the worker.
  // A seal closes authorization; only the vault's empty-state comparison proves no dispatch.
  assertSealedBirthReceipt(receipt, owner);
  if (current !== null) {
    const parsed = parseProductionDatabaseIntent(current, owner)!;
    const evidence = parsed.completionEvidence;
    if (
      parsed.version === 2 &&
      hasVerifiedProductionDatabaseRelease(parsed) &&
      evidence?.kind === "sealed-birth-no-dispatch" &&
      evidence.registrationEpoch === receipt.registrationEpoch &&
      evidence.birthToken === receipt.birthToken &&
      evidence.receiptId === receipt.receiptId
    ) {
      return parsed;
    }
    return conflict();
  }
  return makeIntent(owner, "released", null, null, nowMs, undefined, {
    version: 1,
    kind: "sealed-birth-no-dispatch",
    registrationEpoch: receipt.registrationEpoch,
    birthToken: receipt.birthToken,
    receiptId: receipt.receiptId,
    verifiedAt: new Date(nowMs).toISOString(),
  });
}

export function observeProductionDatabaseProjectIntent(
  current: ProductionDatabaseIntent | null,
  owner: ProductionDatabaseIntentOwner,
  scope: ProductionDatabaseProviderScope,
  providerProjectId: string,
  nowMs: number,
): ProductionDatabaseIntent {
  if (current !== null) {
    parseProductionDatabaseIntent(current, owner);
    if (current.state === "released") {
      throw new ProductionDatabaseIntentError("production_database_release_in_progress");
    }
    if (
      current.scope === null ||
      !sameScope(current.scope, scope) ||
      (current.providerProjectId !== null && current.providerProjectId !== providerProjectId)
    )
      return conflict();
  }
  // A late response may supply cleanup evidence, but never reopen a releasing intent.
  return makeIntent(
    owner,
    current?.state === "releasing" ? "releasing" : "provider-known",
    scope,
    providerProjectId,
    nowMs,
    current?.createdAt,
  );
}

export function productionDatabaseHandoffIntent(
  current: ProductionDatabaseIntent | null,
  allocation: ProductionDatabaseAllocationRecord,
  nowMs: number,
): ProductionDatabaseIntent {
  const next = observeProductionDatabaseProjectIntent(
    current,
    allocation,
    productionDatabaseScope(allocation),
    allocation.providerProjectId,
    nowMs,
  );
  if (next.state === "releasing") {
    throw new ProductionDatabaseIntentError("production_database_release_in_progress");
  }
  return next;
}

export function beginProductionDatabaseReleaseIntent(
  current: ProductionDatabaseIntent | null,
  owner: ProductionDatabaseIntentOwner,
  allocation: ProductionDatabaseAllocationRecord | null,
  nowMs: number,
): ProductionDatabaseIntent {
  if (current !== null) parseProductionDatabaseIntent(current, owner);
  if (allocation !== null) {
    const parsed = productionDatabaseAllocationRecordSchema.parse(allocation);
    if (
      parsed.projectId !== owner.projectId ||
      parsed.allocationIdentity !== owner.allocationIdentity
    )
      return conflict();
    current = observeProductionDatabaseProjectIntent(
      current,
      owner,
      productionDatabaseScope(parsed),
      parsed.providerProjectId,
      nowMs,
    );
  }
  if (current === null) return makeIntent(owner, "releasing", null, null, nowMs);
  if (current.state === "released") {
    return hasVerifiedProductionDatabaseRelease(current)
      ? current
      : makeIntent(owner, "releasing", null, null, nowMs, current.createdAt);
  }
  return makeIntent(
    owner,
    "releasing",
    current.scope,
    current.providerProjectId,
    nowMs,
    current.createdAt,
  );
}

export function productionDatabaseIntentReleaseAllocation(
  intent: ProductionDatabaseIntent,
): ProductionDatabaseAllocationRecord | null {
  if (intent.state !== "releasing" || intent.scope === null || intent.providerProjectId === null) {
    return null;
  }
  return productionDatabaseAllocationRecordSchema.parse({
    format: "nabuflow.production-database-allocation/v1",
    projectId: intent.projectId,
    allocationIdentity: intent.allocationIdentity,
    provider: "neon-postgres",
    ...intent.scope,
    providerProjectId: intent.providerProjectId,
    revision: "production-database-" + intent.allocationIdentity.slice(0, 48),
    state: "releasing",
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  });
}

export function completeProductionDatabaseReleaseIntent(
  current: ProductionDatabaseIntent | null,
  owner: ProductionDatabaseIntentOwner,
  expectedProviderProjectId: string | undefined,
  nowMs: number,
): ProductionDatabaseIntent {
  if (current === null) return conflict();
  parseProductionDatabaseIntent(current, owner);
  if (current.state === "released") {
    if (hasVerifiedProductionDatabaseRelease(current)) return current;
    throw new ProductionDatabaseIntentError("production_database_allocation_uncertain");
  }
  if (current.state !== "releasing" || current.providerProjectId === null) {
    throw new ProductionDatabaseIntentError("production_database_allocation_uncertain");
  }
  if (expectedProviderProjectId === undefined) {
    throw new ProductionDatabaseIntentError("production_database_allocation_uncertain");
  }
  if (current.providerProjectId !== expectedProviderProjectId) return conflict();
  // Keep the lifecycle fence, but not provider identifiers after verified deletion.
  // Only the worker's verified exact-ID path supplies expectedProviderProjectId.
  // The versioned receipt survives removal of provider identifiers and credentials.
  return makeIntent(owner, "released", null, null, nowMs, current.createdAt, {
    version: 1,
    kind: "exact-provider-id-get-404",
    verifiedAt: new Date(nowMs).toISOString(),
  });
}
