import { z } from "zod";
import { canonicalPantryJson } from "./pantry";
import { sha256Hex } from "./request-signing";

export const ACCEPTANCE_PROVISIONER_FORMAT = "nabuflow-acceptance-provisioner/v1" as const;
export const ACCEPTANCE_PROVISIONER_SCHEMA_VERSION = 1 as const;
export const ACCEPTANCE_PROVISIONER_IDENTITY_DOMAIN = "NABUFLOW_ACCEPTANCE_PROVISIONER_V1" as const;

export const ACCEPTANCE_LEASE_MIN_TTL_SECONDS = 5 * 60;
export const ACCEPTANCE_LEASE_MAX_TTL_SECONDS = 2 * 60 * 60;
export const ACCEPTANCE_LEASE_DEFAULT_TTL_SECONDS = 60 * 60;
export const ACCEPTANCE_LEASE_MAX_COST_MINOR_UNITS = 1_000;
export const ACCEPTANCE_JANITOR_BATCH_LIMIT = 50;
export const ACCEPTANCE_OPERATION_PROVIDER_BOUND_MS = 5 * 60_000;
export const ACCEPTANCE_OPERATION_OBSERVATION_MARGIN_MS = 30_000;
export const ACCEPTANCE_OPERATION_EXECUTION_DEADLINE_MS =
  ACCEPTANCE_OPERATION_PROVIDER_BOUND_MS - ACCEPTANCE_OPERATION_OBSERVATION_MARGIN_MS;

export const acceptanceProviderSchema = z.enum(["neon", "stripe", "fly"]);
export const acceptanceLeaseStateSchema = z.enum([
  "pending",
  "active",
  "provisioned",
  "destroying",
  "destroyed",
  "expired",
  "failed",
]);
export const acceptanceLeaseOperationSchema = z.enum([
  "create",
  "provision-capability",
  "provision-fly-secret",
  "destroy",
  "verify-gone",
]);

export const acceptanceLeaseScopeSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("neon"),
      organizationId: z.string().min(2).max(120),
    })
    .strict(),
  z
    .object({
      provider: z.literal("stripe"),
      sandboxId: z.string().min(2).max(120),
      mode: z.literal("test"),
    })
    .strict(),
  z
    .object({
      provider: z.literal("fly"),
      organizationSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
      disposable: z.literal(true),
    })
    .strict(),
]);

export const acceptanceLeaseCreateRequestSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_PROVISIONER_SCHEMA_VERSION),
    projectId: z.number().int().positive().safe(),
    scope: acceptanceLeaseScopeSchema,
    ttlSeconds: z
      .number()
      .int()
      .min(ACCEPTANCE_LEASE_MIN_TTL_SECONDS)
      .max(ACCEPTANCE_LEASE_MAX_TTL_SECONDS)
      .default(ACCEPTANCE_LEASE_DEFAULT_TTL_SECONDS),
    costCeilingMinorUnits: z
      .number()
      .int()
      .nonnegative()
      .max(ACCEPTANCE_LEASE_MAX_COST_MINOR_UNITS),
  })
  .strict();

export const acceptanceProvisionCapabilityRequestSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_PROVISIONER_SCHEMA_VERSION),
    revision: z.string().min(1).max(200),
    stripePolicy: z
      .object({
        allowedCurrencies: z
          .array(z.string().regex(/^[a-z]{3}$/u))
          .min(1)
          .max(20),
        maxAmount: z.number().int().positive().max(99_999_999),
      })
      .strict()
      .optional(),
  })
  .strict();

export const acceptanceProvisionFlySecretRequestSchema = z
  .object({
    schemaVersion: z.literal(ACCEPTANCE_PROVISIONER_SCHEMA_VERSION),
    databaseLeaseId: z.string().regex(/^nal_[A-Za-z0-9_-]{22,80}$/u),
  })
  .strict();

export const acceptanceLeaseMutationRequestSchema = z
  .object({ schemaVersion: z.literal(ACCEPTANCE_PROVISIONER_SCHEMA_VERSION) })
  .strict();

export const acceptanceSanitizedCostSchema = z
  .object({
    currency: z.literal("USD"),
    amountMinorUnits: z.number().int().nonnegative(),
    ceilingMinorUnits: z.number().int().nonnegative(),
  })
  .strict();

export const ACCEPTANCE_ERROR_CODES = [
  "acceptance_unauthorized",
  "acceptance_invalid_request",
  "acceptance_scope_mismatch",
  "acceptance_lease_not_found",
  "acceptance_idempotency_conflict",
  "acceptance_cost_ceiling_exceeded",
  "acceptance_live_target_forbidden",
  "acceptance_operation_pending",
  "acceptance_operation_timeout",
  "acceptance_deployment_version_unavailable",
  "acceptance_provider_unavailable",
  "acceptance_provider_rejected",
  "acceptance_cleanup_incomplete",
  "acceptance_cleanup_disabled",
  "acceptance_internal_error",
] as const;

export const acceptanceErrorCodeSchema = z.enum(ACCEPTANCE_ERROR_CODES);

export const acceptanceLeaseResponseSchema = z
  .object({
    ok: z.literal(true),
    schemaVersion: z.literal(ACCEPTANCE_PROVISIONER_SCHEMA_VERSION),
    leaseId: z.string().regex(/^nal_[A-Za-z0-9_-]{22,80}$/u),
    provider: acceptanceProviderSchema,
    resourceIds: z.array(z.string().min(1).max(200)).max(8),
    state: acceptanceLeaseStateSchema,
    terminalCode: acceptanceErrorCodeSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    cost: acceptanceSanitizedCostSchema,
  })
  .strict();

export const acceptanceVerifyGoneResponseSchema = z
  .object({
    ok: z.literal(true),
    schemaVersion: z.literal(ACCEPTANCE_PROVISIONER_SCHEMA_VERSION),
    leaseId: z.string().regex(/^nal_[A-Za-z0-9_-]{22,80}$/u),
    state: z.literal("destroyed"),
    resourcesGone: z.literal(true),
    configurationGone: z.boolean(),
    verifiedAt: z.string().datetime({ offset: true }),
    cost: acceptanceSanitizedCostSchema,
  })
  .strict();

export const acceptanceErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    code: acceptanceErrorCodeSchema,
    message: z.string().min(1).max(200),
    retryable: z.boolean(),
    requestId: z.string().uuid(),
  })
  .strict();

export const acceptanceWorkloadClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    sub: z.string().min(1).max(300),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().min(16).max(200),
  })
  .passthrough()
  .superRefine((claims, context) => {
    if (claims.exp <= claims.iat || claims.exp - claims.iat > 10 * 60) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exp"],
        message: "Workload identity lifetime exceeds the acceptance bound",
      });
    }
  });

export const acceptanceLeaseJobRequestSchema = z
  .object({
    leaseId: z.string().regex(/^nal_[A-Za-z0-9_-]{22,80}$/u),
    operation: acceptanceLeaseOperationSchema,
    ownerSubjectHash: z.string().regex(/^[0-9a-f]{64}$/u),
    databaseLeaseId: z
      .string()
      .regex(/^nal_[A-Za-z0-9_-]{22,80}$/u)
      .optional(),
    revision: z.string().min(1).max(200).optional(),
    cleanupGeneration: z.number().int().positive().optional(),
    stripePolicy: acceptanceProvisionCapabilityRequestSchema.shape.stripePolicy,
  })
  .strict();

export const acceptanceLeaseCheckpointSchema = z.enum([
  "initialized",
  "scope-verified",
  "provider-complete",
  "vault-complete",
  "verified-gone",
  "finalized",
]);

export async function acceptanceLeaseIdentity(
  request: z.input<typeof acceptanceLeaseCreateRequestSchema>,
): Promise<string> {
  const parsed = acceptanceLeaseCreateRequestSchema.parse(request);
  return sha256Hex(
    `${ACCEPTANCE_PROVISIONER_IDENTITY_DOMAIN}\nlease\n${canonicalPantryJson(parsed)}`,
  );
}

export async function acceptanceOperationIdentity(input: {
  leaseId: string;
  operation: z.input<typeof acceptanceLeaseOperationSchema>;
  body: unknown;
}): Promise<string> {
  return sha256Hex(
    `${ACCEPTANCE_PROVISIONER_IDENTITY_DOMAIN}\noperation\n${canonicalPantryJson({
      leaseId: input.leaseId,
      operation: acceptanceLeaseOperationSchema.parse(input.operation),
      body: input.body,
    })}`,
  );
}

export type AcceptanceProvider = z.infer<typeof acceptanceProviderSchema>;
export type AcceptanceLeaseState = z.infer<typeof acceptanceLeaseStateSchema>;
export type AcceptanceLeaseOperation = z.infer<typeof acceptanceLeaseOperationSchema>;
export type AcceptanceLeaseScope = z.infer<typeof acceptanceLeaseScopeSchema>;
export type AcceptanceLeaseCreateRequest = z.infer<typeof acceptanceLeaseCreateRequestSchema>;
export type AcceptanceProvisionCapabilityRequest = z.infer<
  typeof acceptanceProvisionCapabilityRequestSchema
>;
export type AcceptanceProvisionFlySecretRequest = z.infer<
  typeof acceptanceProvisionFlySecretRequestSchema
>;
export type AcceptanceLeaseResponse = z.infer<typeof acceptanceLeaseResponseSchema>;
export type AcceptanceVerifyGoneResponse = z.infer<typeof acceptanceVerifyGoneResponseSchema>;
export type AcceptanceErrorCode = z.infer<typeof acceptanceErrorCodeSchema>;
export type AcceptanceWorkloadClaims = z.infer<typeof acceptanceWorkloadClaimsSchema>;
export type AcceptanceLeaseJobRequest = z.infer<typeof acceptanceLeaseJobRequestSchema>;
export type AcceptanceLeaseCheckpoint = z.infer<typeof acceptanceLeaseCheckpointSchema>;
