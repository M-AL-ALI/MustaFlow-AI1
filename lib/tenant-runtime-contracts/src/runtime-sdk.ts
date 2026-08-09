import { z } from "zod";
import {
  capabilityDatabaseResponseSchema,
  capabilityIntentSchema,
  databaseCapabilityInputSchema,
} from "./capability-request";
import { controlErrorResponseSchema } from "./control-schemas";
export {
  DATABASE_BATCH_MAX_STATEMENTS,
  DATABASE_OPERATION_DEFAULT_TIMEOUT_MS,
  DATABASE_OPERATION_MAX_TIMEOUT_MS,
  DATABASE_PARAMETER_MAX_COUNT,
  DATABASE_RESULT_MAX_BYTES,
  DATABASE_RESULT_MAX_ROWS,
  DATABASE_SQL_MAX_CHARS,
} from "./runtime-sdk-limits";

export const TENANT_RUNTIME_MODE_ENV = "NABUFLOW_RUNTIME_MODE" as const;
export const TENANT_DATABASE_URL_ENV = "DATABASE_URL" as const;

export const TENANT_RUNTIME_MODES = ["fly-direct-v1", "cloudflare-capability-v1"] as const;
export const tenantRuntimeModeSchema = z.enum(TENANT_RUNTIME_MODES);
export type TenantRuntimeMode = z.infer<typeof tenantRuntimeModeSchema>;

export const CAPABILITY_DOORMAN_PROTOCOL = "http:" as const;
export const CAPABILITY_DOORMAN_HOST = "doorman.staging.nabuflow.internal" as const;
export const CAPABILITY_INTENT_PATH = "/v1/invoke" as const;
export const CAPABILITY_INTENT_URL =
  `${CAPABILITY_DOORMAN_PROTOCOL}//${CAPABILITY_DOORMAN_HOST}${CAPABILITY_INTENT_PATH}` as const;

export const DATABASE_CAPABILITY_PROVIDER = "neon-postgres" as const;
export const DATABASE_CAPABILITY_NAME = "database" as const;
export const DATABASE_CAPABILITY_ACTION = "query" as const;

const runtimeSdkRequestIdSchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[\x21-\x7e]+$/u, "Expected a printable request token");

export const runtimeDatabaseCapabilityIntentSchema = z
  .object({
    v: z.literal(1),
    capability: z
      .object({
        provider: z.literal(DATABASE_CAPABILITY_PROVIDER),
        name: z.literal(DATABASE_CAPABILITY_NAME),
      })
      .strict(),
    action: z.literal(DATABASE_CAPABILITY_ACTION),
    requestId: runtimeSdkRequestIdSchema,
    input: databaseCapabilityInputSchema,
  })
  .strict();

export const runtimeDatabaseCapabilityResponseSchema = capabilityDatabaseResponseSchema;
export const runtimeDatabaseCapabilityErrorResponseSchema = controlErrorResponseSchema;

export const RUNTIME_DATABASE_ERROR_CODES = [
  "configuration",
  "invalid_query",
  "conflict",
  "timeout",
  "cancelled",
  "unavailable",
  "policy_rejected",
  "internal",
] as const;
export const runtimeDatabaseErrorCodeSchema = z.enum(RUNTIME_DATABASE_ERROR_CODES);
export type RuntimeDatabaseErrorCode = z.infer<typeof runtimeDatabaseErrorCodeSchema>;

export const DATABASE_CAPABILITY_ERROR_MAP: Readonly<Record<string, RuntimeDatabaseErrorCode>> =
  Object.freeze({
    invalid_capability_intent: "invalid_query",
    invalid_capability_request: "invalid_query",
    database_invalid_query: "invalid_query",
    database_constraint_violation: "conflict",
    database_conflict: "conflict",
    capability_idempotency_conflict: "conflict",
    capability_request_in_progress: "conflict",
    database_timeout: "timeout",
    capability_policy_rejected: "policy_rejected",
    capability_request_too_large: "policy_rejected",
    database_response_too_large: "policy_rejected",
    capability_not_available: "unavailable",
    capability_runtime_unbound: "unavailable",
    capability_tenant_mismatch: "unavailable",
    capability_service_unavailable: "unavailable",
    database_unavailable: "unavailable",
  });

export function mapCapabilityDatabaseError(
  providerCode: string,
  status: number,
): RuntimeDatabaseErrorCode {
  const mapped = DATABASE_CAPABILITY_ERROR_MAP[providerCode];
  if (mapped !== undefined) return mapped;
  if (status === 408 || status === 504) return "timeout";
  if (status === 409) return "conflict";
  if (status === 413 || status === 422) return "policy_rejected";
  if (status === 429 || status === 502 || status === 503) return "unavailable";
  return "internal";
}

export function makeRuntimeDatabaseCapabilityIntent(input: {
  requestId: string;
  operation: z.input<typeof databaseCapabilityInputSchema>;
}): z.infer<typeof runtimeDatabaseCapabilityIntentSchema> {
  const intent = runtimeDatabaseCapabilityIntentSchema.parse({
    v: 1,
    capability: {
      provider: DATABASE_CAPABILITY_PROVIDER,
      name: DATABASE_CAPABILITY_NAME,
    },
    action: DATABASE_CAPABILITY_ACTION,
    requestId: input.requestId,
    input: input.operation,
  });
  capabilityIntentSchema.parse(intent);
  return intent;
}

export function serializeRuntimeDatabaseCapabilityIntent(input: {
  requestId: string;
  operation: z.input<typeof databaseCapabilityInputSchema>;
}): string {
  return JSON.stringify(makeRuntimeDatabaseCapabilityIntent(input));
}
