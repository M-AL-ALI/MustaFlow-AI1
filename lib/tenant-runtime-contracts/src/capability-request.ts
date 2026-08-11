import { z } from "zod";
import { capabilityDefinitionSchema } from "./route-capability";
import {
  DATABASE_BATCH_MAX_STATEMENTS,
  DATABASE_PARAMETER_MAX_COUNT,
  DATABASE_RESULT_MAX_ROWS,
  DATABASE_SQL_MAX_CHARS,
} from "./runtime-sdk-limits";

const capabilityComponentSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9-]*$/);

const requestTokenSchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "Expected a printable request token");

const boundedInputSchema = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    return JSON.stringify(value).length <= 64 * 1024;
  } catch {
    return false;
  }
}, "Capability input is too large or is not JSON serializable");

export const capabilityReferenceSchema = z
  .object({
    provider: capabilityComponentSchema,
    name: capabilityComponentSchema,
  })
  .strict();

function enforceCapabilityInputLimit(
  intent: { capability: { provider: string; name: string }; input: Record<string, unknown> },
  context: z.RefinementCtx,
): void {
  if (
    intent.capability.provider === "nabuflow-harness" &&
    intent.capability.name === "echo" &&
    JSON.stringify(intent.input).length > 32 * 1024
  ) {
    context.addIssue({
      code: "custom",
      path: ["input"],
      message: "Echo capability input is too large",
    });
  }
  if (
    intent.capability.provider === "stripe" &&
    intent.capability.name === "payments" &&
    JSON.stringify(intent.input).length > 8 * 1024
  ) {
    context.addIssue({
      code: "custom",
      path: ["input"],
      message: "Stripe capability input is too large",
    });
  }
}

const capabilityIntentObjectSchema = z
  .object({
    v: z.literal(1),
    capability: capabilityReferenceSchema,
    action: capabilityComponentSchema,
    requestId: requestTokenSchema,
    requestedProjectId: z.number().int().positive().safe().optional(),
    input: boundedInputSchema,
  })
  .strict();

export const capabilityIntentSchema = capabilityIntentObjectSchema.superRefine(
  enforceCapabilityInputLimit,
);

export const capabilityInvocationSchema = capabilityIntentObjectSchema
  .extend({
    caller: z
      .object({
        containerId: z.string().min(16).max(200),
        runtimeIdentity: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict()
  .superRefine(enforceCapabilityInputLimit);

export const provisionEchoCapabilityRequestSchema = z
  .object({
    projectId: z.number().int().positive().safe(),
    revision: z.string().min(1).max(200),
    definition: capabilityDefinitionSchema,
  })
  .strict();

export const revokeEchoCapabilityRequestSchema = z
  .object({
    projectId: z.number().int().positive().safe(),
    expectedRevision: z.string().min(1).max(200),
  })
  .strict();

export const provisionDatabaseCapabilityRequestSchema = z
  .object({
    projectId: z.number().int().positive().safe(),
    revision: z.string().min(1).max(200),
    definition: capabilityDefinitionSchema,
    credential: z
      .object({
        kind: z.literal("neon-connection-string"),
        value: z.string().min(1).max(4_096),
      })
      .strict(),
  })
  .strict();

export const revokeDatabaseCapabilityRequestSchema = revokeEchoCapabilityRequestSchema;

export const stripeCurrencySchema = z.string().regex(/^[a-z]{3}$/u);

export const stripeCapabilityPolicySchema = z
  .object({
    allowedCurrencies: z
      .array(stripeCurrencySchema)
      .min(1)
      .max(20)
      .refine((currencies) => new Set(currencies).size === currencies.length, {
        message: "Allowed Stripe currencies must be unique",
      }),
    maxAmount: z.number().int().positive().max(99_999_999),
  })
  .strict();

export const provisionStripeCapabilityRequestSchema = z
  .object({
    projectId: z.number().int().positive().safe(),
    revision: z.string().min(1).max(200),
    definition: capabilityDefinitionSchema,
    policy: stripeCapabilityPolicySchema,
    credential: z
      .object({
        kind: z.literal("stripe-test-secret-key"),
        value: z
          .string()
          .min(16)
          .max(4_096)
          .regex(/^(?:sk|rk)_test_[A-Za-z0-9]+$/u),
      })
      .strict(),
  })
  .strict();

export const revokeStripeCapabilityRequestSchema = revokeEchoCapabilityRequestSchema;

const stripeIdempotencyKeySchema = z
  .string()
  .min(16)
  .max(200)
  .regex(/^[\x21-\x7e]+$/u, "Expected a printable Stripe idempotency key");

export const stripePaymentIntentIdSchema = z
  .string()
  .min(4)
  .max(200)
  .regex(/^pi_[A-Za-z0-9]+$/u);

export const stripeCapabilityInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create-payment-intent"),
      idempotencyKey: stripeIdempotencyKeySchema,
      amount: z.number().int().positive().max(99_999_999),
      currency: stripeCurrencySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("retrieve-payment-intent"),
      paymentIntentId: stripePaymentIntentIdSchema,
    })
    .strict(),
]);

const databaseParameterSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const databaseStatementSchema = z
  .object({
    sql: z
      .string()
      .min(1)
      .max(DATABASE_SQL_MAX_CHARS)
      .refine((value) => !value.includes("\0"), {
        message: "SQL cannot contain NUL bytes",
      }),
    params: z.array(databaseParameterSchema).max(DATABASE_PARAMETER_MAX_COUNT),
  })
  .strict();

export const databaseCapabilityInputSchema = z.discriminatedUnion("kind", [
  databaseStatementSchema.extend({ kind: z.literal("statement") }).strict(),
  z
    .object({
      kind: z.literal("atomic-batch"),
      statements: z.array(databaseStatementSchema).min(1).max(DATABASE_BATCH_MAX_STATEMENTS),
    })
    .strict(),
]);

const databaseRowSchema = z.record(z.string(), z.unknown());

export const databaseStatementResultSchema = z
  .object({
    command: z.string().min(1).max(40),
    rowCount: z.number().int().nonnegative(),
    rows: z.array(databaseRowSchema).max(DATABASE_RESULT_MAX_ROWS),
  })
  .strict();

const databaseResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("statement"),
      result: databaseStatementResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("atomic-batch"),
      results: z.array(databaseStatementResultSchema).min(1).max(20),
    })
    .strict(),
]);

export const stripePaymentIntentSchema = z
  .object({
    id: stripePaymentIntentIdSchema,
    status: z.string().min(1).max(100),
    amount: z.number().int().nonnegative().max(99_999_999),
    amountReceived: z.number().int().nonnegative().max(99_999_999),
    currency: stripeCurrencySchema,
    created: z.number().int().nonnegative().safe(),
    livemode: z.literal(false),
  })
  .strict();

export const capabilityProvisionResponseSchema = z
  .object({
    ok: z.literal(true),
    projectId: z.number().int().positive().safe(),
    capability: capabilityReferenceSchema,
    revision: z.string().min(1).max(200),
    keyId: z.string().min(1).max(40),
  })
  .strict();

export const capabilityRevokeResponseSchema = z
  .object({
    ok: z.literal(true),
    projectId: z.number().int().positive().safe(),
    capability: capabilityReferenceSchema,
  })
  .strict();

export const capabilityEchoResponseSchema = z
  .object({
    ok: z.literal(true),
    capability: capabilityReferenceSchema,
    requestId: requestTokenSchema,
    runtimeIdentity: z.string().min(1).max(200),
    actedBy: z.literal("capability-vault"),
    proof: z.string().regex(/^[0-9a-f]{64}$/),
    echo: boundedInputSchema,
  })
  .strict();

export const capabilityDatabaseResponseSchema = z
  .object({
    ok: z.literal(true),
    capability: capabilityReferenceSchema,
    requestId: requestTokenSchema,
    runtimeIdentity: z.string().min(1).max(200),
    actedBy: z.literal("database-broker"),
    result: databaseResultSchema,
  })
  .strict()
  .refine(
    (value) => {
      try {
        return JSON.stringify(value).length <= 256 * 1024;
      } catch {
        return false;
      }
    },
    { message: "Database response is too large or is not JSON serializable" },
  );

export const capabilityStripeResponseSchema = z
  .object({
    ok: z.literal(true),
    capability: capabilityReferenceSchema,
    requestId: requestTokenSchema,
    runtimeIdentity: z.string().min(1).max(200),
    actedBy: z.literal("stripe-broker"),
    operation: z.enum(["create-payment-intent", "retrieve-payment-intent"]),
    idempotentReplay: z.boolean(),
    paymentIntent: stripePaymentIntentSchema,
  })
  .strict();

export const capabilitySuccessResponseSchema = z.union([
  capabilityEchoResponseSchema,
  capabilityDatabaseResponseSchema,
  capabilityStripeResponseSchema,
]);

export const capabilityBindingResponseSchema = z
  .object({
    runtimeIdentity: z.string().min(1).max(200),
    active: z.boolean(),
    containerId: z.string().min(16).max(200).nullable(),
  })
  .strict();

export type CapabilityReference = z.infer<typeof capabilityReferenceSchema>;
export type CapabilityIntent = z.infer<typeof capabilityIntentSchema>;
export type CapabilityInvocation = z.infer<typeof capabilityInvocationSchema>;
export type ProvisionEchoCapabilityRequest = z.infer<typeof provisionEchoCapabilityRequestSchema>;
export type RevokeEchoCapabilityRequest = z.infer<typeof revokeEchoCapabilityRequestSchema>;
export type ProvisionDatabaseCapabilityRequest = z.infer<
  typeof provisionDatabaseCapabilityRequestSchema
>;
export type RevokeDatabaseCapabilityRequest = z.infer<typeof revokeDatabaseCapabilityRequestSchema>;
export type StripeCapabilityPolicy = z.infer<typeof stripeCapabilityPolicySchema>;
export type ProvisionStripeCapabilityRequest = z.infer<
  typeof provisionStripeCapabilityRequestSchema
>;
export type RevokeStripeCapabilityRequest = z.infer<typeof revokeStripeCapabilityRequestSchema>;
export type StripeCapabilityInput = z.infer<typeof stripeCapabilityInputSchema>;
export type StripePaymentIntent = z.infer<typeof stripePaymentIntentSchema>;
export type DatabaseStatement = z.infer<typeof databaseStatementSchema>;
export type DatabaseCapabilityInput = z.infer<typeof databaseCapabilityInputSchema>;
export type DatabaseStatementResult = z.infer<typeof databaseStatementResultSchema>;
export type CapabilityProvisionResponse = z.infer<typeof capabilityProvisionResponseSchema>;
export type CapabilityRevokeResponse = z.infer<typeof capabilityRevokeResponseSchema>;
export type CapabilityEchoResponse = z.infer<typeof capabilityEchoResponseSchema>;
export type CapabilityDatabaseResponse = z.infer<typeof capabilityDatabaseResponseSchema>;
export type CapabilityStripeResponse = z.infer<typeof capabilityStripeResponseSchema>;
export type CapabilitySuccessResponse = z.infer<typeof capabilitySuccessResponseSchema>;
export type CapabilityBindingResponse = z.infer<typeof capabilityBindingResponseSchema>;
