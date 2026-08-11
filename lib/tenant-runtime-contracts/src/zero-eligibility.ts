import { z } from "zod";
import { canonicalPantryJson } from "./pantry";
import { sha256Hex } from "./request-signing";
import { runtimeManifestContractSchema } from "./control-schemas";
import { zeroGeneratedDependencyPlanSchema } from "./zero-generation";

export const ZERO_ELIGIBILITY_FORMAT = "nabu-zero-capability-eligibility/v1" as const;
export const ZERO_ELIGIBILITY_SCHEMA_VERSION = 1 as const;
export const ZERO_ELIGIBILITY_HASH_DOMAIN = "NABUFLOW_ZERO_ELIGIBILITY_V1" as const;

export const ZERO_ELIGIBILITY_REASON_CODES = [
  "undeclared_dependency",
  "pantry_unresolvable_dependency",
  "credential_assumption",
  "port_manifest_incompatible",
  "unsupported_toolchain",
  "raw_database_client",
  "raw_payment_client",
  "arbitrary_runtime_fetch",
  "tenant_package_install",
  "undeclared_capability",
  "dependency_output_unattested",
  "unclassified_integration",
] as const;

export const ZERO_SEALED_CAPABILITIES = ["database", "stripe-payments"] as const;
export const ZERO_SUPPORTED_TOOLCHAINS = ["node-api"] as const;

export const zeroEligibilityReasonCodeSchema = z.enum(ZERO_ELIGIBILITY_REASON_CODES);
export const zeroSealedCapabilitySchema = z.enum(ZERO_SEALED_CAPABILITIES);
export const zeroSupportedToolchainSchema = z.enum(ZERO_SUPPORTED_TOOLCHAINS);

export const zeroEligibilityReasonSchema = z
  .object({
    code: zeroEligibilityReasonCodeSchema,
    path: z.string().min(1).max(512).optional(),
  })
  .strict();

const zeroEligibilityCommonSchema = z
  .object({
    format: z.literal(ZERO_ELIGIBILITY_FORMAT),
    schemaVersion: z.literal(ZERO_ELIGIBILITY_SCHEMA_VERSION),
    kind: z.enum(["blueprint", "skill"]),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/u),
    legacy: z
      .object({
        mode: z.literal("direct"),
        behavior: z.literal("preserve"),
      })
      .strict(),
    build: z
      .object({
        toolchains: z.array(zeroSupportedToolchainSchema).max(1),
        pantryPolicy: z.literal("dynamic-demand-driven"),
        attestationRequired: z.literal(true),
      })
      .strict(),
  })
  .strict();

const zeroEligibleMetadataSchema = zeroEligibilityCommonSchema.extend({
  cloudflare: z
    .object({
      status: z.literal("eligible"),
      resolution: z.enum(["native", "capability"]),
      capabilities: z.array(zeroSealedCapabilitySchema).max(2),
      reasons: z.tuple([]),
      sealedGuidance: z.string().min(1).max(4_096),
    })
    .strict(),
});

const zeroIneligibleMetadataSchema = zeroEligibilityCommonSchema.extend({
  cloudflare: z
    .object({
      status: z.literal("ineligible"),
      resolution: z.literal("refuse"),
      capabilities: z.tuple([]),
      reasons: z.array(zeroEligibilityReasonSchema).min(1).max(16),
    })
    .strict(),
});

export const zeroCapabilityEligibilityMetadataContractSchema = z
  .union([zeroEligibleMetadataSchema, zeroIneligibleMetadataSchema])
  .superRefine((metadata, context) => {
    if (metadata.cloudflare.status === "eligible") {
      if (metadata.build.toolchains.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["build", "toolchains"],
          message: "Eligible sealed integrations require a supported toolchain",
        });
      }
      const unique = new Set(metadata.cloudflare.capabilities);
      if (unique.size !== metadata.cloudflare.capabilities.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cloudflare", "capabilities"],
          message: "Capabilities must be unique",
        });
      }
      if (
        metadata.cloudflare.resolution === "capability" &&
        metadata.cloudflare.capabilities.length === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cloudflare", "capabilities"],
          message: "Capability resolution requires at least one declared capability",
        });
      }
    }
  });

export const zeroGeneratedFileIdentitySchema = z
  .object({
    path: z.string().min(1).max(512),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export const zeroEligibilityEnvelopeSchema = z
  .object({
    target: z.literal("cloudflare-sealed-staging-v1"),
    toolchain: z.string().min(1).max(80),
    files: z.array(zeroGeneratedFileIdentitySchema).min(1).max(20_000),
    dependencyPlan: zeroGeneratedDependencyPlanSchema,
    runtimeManifest: runtimeManifestContractSchema,
    declaredCapabilities: z.array(zeroSealedCapabilitySchema).max(2),
    pantryClosureVerified: z.boolean(),
    dependencyOutputAttested: z.boolean(),
  })
  .strict()
  .superRefine((envelope, context) => {
    let prior: string | null = null;
    for (const [index, file] of envelope.files.entries()) {
      if (prior !== null && prior >= file.path) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "Generated file identities must be unique and canonically sorted",
        });
      }
      prior = file.path;
    }
    const capabilities = [...envelope.declaredCapabilities].sort();
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declaredCapabilities"],
        message: "Declared capabilities must be unique",
      });
    }
  });

export const zeroEligibilitySuccessSchema = z
  .object({
    ok: z.literal(true),
    code: z.literal("zero_generation_eligible"),
    identitySha256: z.string().regex(/^[0-9a-f]{64}$/u),
    capabilities: z.array(zeroSealedCapabilitySchema).max(2),
  })
  .strict();

export const zeroCapabilityGapSchema = z
  .object({
    ok: z.literal(false),
    code: z.literal("zero_capability_gap"),
    retryable: z.literal(false),
    identitySha256: z.string().regex(/^[0-9a-f]{64}$/u),
    reasons: z.array(zeroEligibilityReasonSchema).min(1).max(64),
  })
  .strict();

export const zeroEligibilityResultSchema = z.discriminatedUnion("ok", [
  zeroEligibilitySuccessSchema,
  zeroCapabilityGapSchema,
]);

export type ZeroCapabilityEligibilityMetadata = z.infer<
  typeof zeroCapabilityEligibilityMetadataContractSchema
>;
export type ZeroEligibilityEnvelope = z.infer<typeof zeroEligibilityEnvelopeSchema>;
export type ZeroEligibilityReason = z.infer<typeof zeroEligibilityReasonSchema>;
export type ZeroEligibilityResult = z.infer<typeof zeroEligibilityResultSchema>;

export async function deriveZeroEligibilityIdentity(
  input: ZeroEligibilityEnvelope,
): Promise<string> {
  const envelope = zeroEligibilityEnvelopeSchema.parse(input);
  return sha256Hex(`${ZERO_ELIGIBILITY_HASH_DOMAIN}\nenvelope\n${canonicalPantryJson(envelope)}`);
}

export async function deriveZeroIntegrationEligibilityIdentity(
  input: ZeroCapabilityEligibilityMetadata,
): Promise<string> {
  const metadata = zeroCapabilityEligibilityMetadataContractSchema.parse(input);
  return sha256Hex(
    `${ZERO_ELIGIBILITY_HASH_DOMAIN}\nintegration-metadata\n${canonicalPantryJson(metadata)}`,
  );
}
