import { z } from "zod";
import { canonicalJson } from "./runtime-artifact";
import { sha256Hex } from "./request-signing";
import { capabilityDefinitionSchema } from "./route-capability";

export const PRODUCTION_DATABASE_ALLOCATION_FORMAT =
  "nabuflow.production-database-allocation/v1" as const;
export const PRODUCTION_DATABASE_ALLOCATION_GATE =
  "NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED" as const;
export const PRODUCTION_DATABASE_NEON_MANAGEMENT_KEY_BINDING =
  "NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY" as const;
export const PRODUCTION_DATABASE_NEON_ORGANIZATION_ID_BINDING =
  "NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID" as const;
export const PRODUCTION_DATABASE_NEON_REGION_ID_BINDING =
  "NABUFLOW_PRODUCTION_NEON_REGION_ID" as const;
export const PRODUCTION_DATABASE_NEON_HISTORY_RETENTION_SECONDS_BINDING =
  "NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS" as const;
export const PRODUCTION_DATABASE_MAX_PROJECTS_BINDING =
  "NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS" as const;
export const PRODUCTION_DATABASE_PROJECT_PREFIX = "nabuflow-production-" as const;
export const PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS = 5 * 60_000;
export const PRODUCTION_DATABASE_ADMISSION_FEATURE = "production-database-admission-v1" as const;
export const PRODUCTION_DATABASE_ADMISSION_EPOCH_BINDING =
  "NABUFLOW_PRODUCTION_DATABASE_ADMISSION_EPOCH" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const neonResourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);

/**
 * Authenticated by the control request HMAC. A sealed admission closes future
 * authorization; it is not, by itself, evidence that no provider call occurred.
 * Only the vault's atomic check of the enforced birth/dispatch history can
 * produce a never-dispatched terminal receipt.
 */
const productionDatabaseAdmissionBaseSchema = z
  .object({
    format: z.literal("nabuflow.production-database-admission/v1"),
    issuer: z.literal("nabuflow-api"),
    audience: z.literal("production"),
    projectId: z.number().int().positive().safe(),
    allocationIdentity: sha256Schema,
    registrationEpoch: z.string().uuid(),
    birthToken: z.string().uuid(),
    receiptId: z.string().uuid(),
    birthRegistered: z.boolean(),
  })
  .strict();

export const productionDatabaseAuthorizedAdmissionSchema =
  productionDatabaseAdmissionBaseSchema.extend({ assertion: z.literal("authorized") });
export const productionDatabaseSealedAdmissionSchema = productionDatabaseAdmissionBaseSchema.extend(
  {
    assertion: z.literal("sealed"),
  },
);
export const productionDatabaseAdmissionReceiptSchema = z.discriminatedUnion("assertion", [
  productionDatabaseAuthorizedAdmissionSchema,
  productionDatabaseSealedAdmissionSchema,
]);
export type ProductionDatabaseAdmissionReceipt = z.infer<
  typeof productionDatabaseAdmissionReceiptSchema
>;

export const productionDatabaseCapabilityDefinition = capabilityDefinitionSchema.parse({
  name: "database",
  provider: "neon-postgres",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/query" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 262_144,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
});

export const productionDatabaseAllocationIdentityEnvelopeSchema = z
  .object({
    format: z.literal(PRODUCTION_DATABASE_ALLOCATION_FORMAT),
    deploymentNamespace: z.literal("production"),
    projectId: z.number().int().positive().safe(),
  })
  .strict();

/** One project owns one production database across releases, slots, and restarts. */
export async function productionDatabaseAllocationIdentity(
  input: z.input<typeof productionDatabaseAllocationIdentityEnvelopeSchema>,
): Promise<string> {
  return sha256Hex(canonicalJson(productionDatabaseAllocationIdentityEnvelopeSchema.parse(input)));
}

const productionDatabaseRequestBase = z
  .object({
    projectId: z.number().int().positive().safe(),
    expectedDeploymentVersion: z.string().min(1).max(200),
    allocationIdentity: sha256Schema,
  })
  .strict();

export const ensureProductionDatabaseRequestSchema = productionDatabaseRequestBase.extend({
  action: z.literal("ensure"),
  // Legacy bodies remain parseable so the Worker can issue a typed admission
  // error and terminalize already queued v1 jobs rather than retrying them.
  admission: productionDatabaseAuthorizedAdmissionSchema.optional(),
});

export const releaseProductionDatabaseRequestSchema = productionDatabaseRequestBase.extend({
  action: z.literal("release"),
  // No admission receipt means positive owned-resource cleanup only. It must
  // never authorize a negative absence proof for missing legacy history.
  admission: productionDatabaseSealedAdmissionSchema.optional(),
});

export const productionDatabaseJobRequestSchema = z.discriminatedUnion("action", [
  ensureProductionDatabaseRequestSchema,
  releaseProductionDatabaseRequestSchema,
]);

export const productionDatabaseAllocationResponseSchema = z
  .object({
    ok: z.literal(true),
    projectId: z.number().int().positive().safe(),
    allocationIdentity: sha256Schema,
    state: z.literal("ready"),
    capability: z
      .object({ provider: z.literal("neon-postgres"), name: z.literal("database") })
      .strict(),
    revision: z.string().min(1).max(200),
    providerProjectId: neonResourceIdSchema,
    reused: z.boolean(),
  })
  .strict();

export const productionDatabaseReleaseResponseSchema = z
  .object({
    ok: z.literal(true),
    projectId: z.number().int().positive().safe(),
    allocationIdentity: sha256Schema,
    state: z.literal("released"),
    providerProjectId: neonResourceIdSchema.nullable(),
    verifiedGone: z.literal(true),
  })
  .strict();

export const productionDatabaseAllocationRecordSchema = z
  .object({
    format: z.literal(PRODUCTION_DATABASE_ALLOCATION_FORMAT),
    projectId: z.number().int().positive().safe(),
    allocationIdentity: sha256Schema,
    provider: z.literal("neon-postgres"),
    providerProjectId: neonResourceIdSchema,
    providerOrganizationId: neonResourceIdSchema,
    regionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
    historyRetentionSeconds: z.number().int().min(86_400).max(2_592_000),
    revision: z.string().min(1).max(200),
    state: z.enum(["ready", "releasing"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const productionDatabaseCheckpointSchema = z.enum([
  "initialized",
  "ownership-verified",
  "provider-complete",
  "provider-verified",
  "vault-complete",
  "finalized",
]);

export type EnsureProductionDatabaseRequest = z.infer<typeof ensureProductionDatabaseRequestSchema>;
export type ReleaseProductionDatabaseRequest = z.infer<
  typeof releaseProductionDatabaseRequestSchema
>;
export type ProductionDatabaseJobRequest = z.infer<typeof productionDatabaseJobRequestSchema>;
export type ProductionDatabaseAllocationRecord = z.infer<
  typeof productionDatabaseAllocationRecordSchema
>;
export type ProductionDatabaseCheckpoint = z.infer<typeof productionDatabaseCheckpointSchema>;
