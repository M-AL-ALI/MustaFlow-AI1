import { z } from "zod";
import { capabilityDefinitionSchema } from "./route-capability";

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
    return JSON.stringify(value).length <= 32 * 1024;
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

export const capabilityIntentSchema = z
  .object({
    v: z.literal(1),
    capability: capabilityReferenceSchema,
    action: capabilityComponentSchema,
    requestId: requestTokenSchema,
    requestedProjectId: z.number().int().positive().safe().optional(),
    input: boundedInputSchema,
  })
  .strict();

export const capabilityInvocationSchema = capabilityIntentSchema
  .extend({
    caller: z
      .object({
        containerId: z.string().min(16).max(200),
        runtimeIdentity: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();

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
export type CapabilityProvisionResponse = z.infer<typeof capabilityProvisionResponseSchema>;
export type CapabilityRevokeResponse = z.infer<typeof capabilityRevokeResponseSchema>;
export type CapabilityEchoResponse = z.infer<typeof capabilityEchoResponseSchema>;
export type CapabilityBindingResponse = z.infer<typeof capabilityBindingResponseSchema>;
