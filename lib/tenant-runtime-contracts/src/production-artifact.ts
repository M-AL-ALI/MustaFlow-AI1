import { z } from "zod";
import { runtimeLocatorSchema, runtimeManifestContractSchema } from "./control-schemas";
import { pantryBuildIdSchema, pantryRevisionIdSchema } from "./pantry";
import { canonicalJson } from "./runtime-artifact";
import { sha256Hex } from "./request-signing";
import { runtimeLayeredArtifactEnvelopeSchema } from "./runtime-artifact-layers";
import { zeroSealedCapabilitySchema } from "./zero-eligibility";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const productionArtifactPromotionIdentityEnvelopeSchema = z
  .object({
    format: z.literal("nabuflow.production-promotion-identity/v1"),
    projectId: z.number().int().positive(),
    sourceVersionId: z.number().int().positive(),
    sourceSealedArtifactSha256: sha256Schema,
    targetSlot: z.enum(["blue", "green"]),
    hostname: z
      .string()
      .min(1)
      .max(253)
      .transform((value) => value.toLowerCase()),
  })
  .strict();

/** One canonical, content-derived identity for publish, transport idempotency, and diagnostics. */
export async function productionArtifactPromotionIdentity(
  input: z.input<typeof productionArtifactPromotionIdentityEnvelopeSchema>,
): Promise<string> {
  return sha256Hex(canonicalJson(productionArtifactPromotionIdentityEnvelopeSchema.parse(input)));
}

/**
 * Durable application-level record written only after the trusted kitchen has
 * accepted and sealed a dependency-complete release. It deliberately contains
 * identities and attestations, never artifact bytes or credentials.
 */
export const acceptedSealedReleaseSchema = z
  .object({
    format: z.literal("nabuflow.accepted-sealed-release/v1"),
    state: z.literal("accepted"),
    acceptedAt: z.string().datetime({ offset: true }),
    sourceRuntimeIdentity: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    manifest: runtimeManifestContractSchema,
    shelfRevisionId: pantryRevisionIdSchema,
    shelfRootSha256: sha256Schema,
    shelfStateRevision: z.number().int().nonnegative().safe(),
    dependencyClosureSha256: sha256Schema,
    buildId: pantryBuildIdSchema,
    buildAttestationSha256: sha256Schema,
    artifactRevision: z.string().min(1).max(200),
    sealedArtifactSha256: sha256Schema,
    contentSha256: sha256Schema,
    appArtifactSha256: sha256Schema,
    layerContentSha256s: z.array(sha256Schema).min(1).max(64),
    declaredCapabilities: z.array(zeroSealedCapabilitySchema).max(2).default([]),
  })
  .strict();

export const promoteRuntimeLayeredArtifactRequestSchema = z
  .object({
    sourceLocator: runtimeLocatorSchema,
    targetLocator: runtimeLocatorSchema,
    expectedDeploymentVersion: z.string().min(1).max(200),
    sourceSealedArtifactSha256: sha256Schema,
    targetManifest: runtimeManifestContractSchema,
    targetArtifactRevision: z.string().min(1).max(200),
    promotionIdentity: sha256Schema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.sourceLocator.role !== "preview" || request.sourceLocator.slot !== "primary") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceLocator"],
        message: "Production promotion source must be preview/primary",
      });
    }
    if (
      request.targetLocator.role !== "production" ||
      (request.targetLocator.slot !== "blue" && request.targetLocator.slot !== "green")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetLocator"],
        message: "Production promotion target must be production/blue or production/green",
      });
    }
    if (request.sourceLocator.projectId !== request.targetLocator.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetLocator", "projectId"],
        message: "Production promotion cannot cross project boundaries",
      });
    }
    if (!request.targetManifest.public) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetManifest", "public"],
        message: "Production promotion requires a public runtime manifest",
      });
    }
  });

export const promoteRuntimeLayeredArtifactResponseSchema = z
  .object({
    ok: z.literal(true),
    promotionIdentity: sha256Schema,
    sourceSealedArtifactSha256: sha256Schema,
    targetSealedArtifactSha256: sha256Schema,
    targetContentSha256: sha256Schema,
    artifactRevision: z.string().min(1).max(200),
    appChunksCopied: z.number().int().nonnegative(),
    layersReused: z.number().int().positive(),
    envelope: runtimeLayeredArtifactEnvelopeSchema,
  })
  .strict();

export const productionArtifactReleaseSchema = z
  .object({
    format: z.literal("nabuflow.production-artifact-release/v1"),
    state: z.enum(["promoted", "active"]),
    promotionIdentity: sha256Schema,
    sourceVersionId: z.number().int().positive(),
    sourceSealedArtifactSha256: sha256Schema,
    targetSealedArtifactSha256: sha256Schema,
    targetContentSha256: sha256Schema,
    targetRuntimeIdentity: z.string().min(1).max(200),
    targetSlot: z.enum(["blue", "green"]),
    targetManifest: runtimeManifestContractSchema,
    hostname: z.string().min(1).max(253),
    promotedAt: z.string().datetime({ offset: true }),
    activatedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type AcceptedSealedRelease = z.infer<typeof acceptedSealedReleaseSchema>;
export type PromoteRuntimeLayeredArtifactRequest = z.infer<
  typeof promoteRuntimeLayeredArtifactRequestSchema
>;
export type PromoteRuntimeLayeredArtifactResponse = z.infer<
  typeof promoteRuntimeLayeredArtifactResponseSchema
>;
export type ProductionArtifactRelease = z.infer<typeof productionArtifactReleaseSchema>;
