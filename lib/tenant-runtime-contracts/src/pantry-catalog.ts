import { z } from "zod";
import {
  canonicalPantryJson,
  pantryPackageIntentSchema,
  pantryPlatformSchema,
  pantryRevisionRecordSchema,
  pantryRevisionStateSchema,
  pantrySha256Schema,
} from "./pantry";
import { compareUtf8 } from "./runtime-artifact";
import { sha256Hex } from "./request-signing";

export const PANTRY_CATALOG_SCHEMA_VERSION = 1 as const;
export const PANTRY_CATALOG_SHELF_FORMAT = "nabu-pantry-catalog-shelf/v1" as const;
export const PANTRY_CATALOG_STAMP_FORMAT = "nabu-pantry-catalog-stamp/v1" as const;
export const PANTRY_CATALOG_HASH_DOMAIN = "NABUFLOW_PANTRY_CATALOG_V1" as const;

const ASCII_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const ASSEMBLY_ID_PATTERN = /^passembly_[0-9a-f]{64}$/u;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export const pantryCatalogAssemblyIdSchema = z.string().regex(ASSEMBLY_ID_PATTERN);

export const pantryCatalogObjectKindSchema = z.enum([
  "registry-metadata",
  "package-tarball",
  "normalized-package",
  "provenance-attestation",
  "dependency-layer",
  "layer-manifest",
  "lockfile",
  "sbom",
  "toolchain-attestation",
]);

export const pantryCatalogObjectReferenceSchema = z
  .object({
    kind: pantryCatalogObjectKindSchema,
    sha256: pantrySha256Schema,
    bytes: z.number().int().nonnegative().safe(),
  })
  .strict();

const pantryCatalogStockIdentitySchema = z
  .object({
    intents: z.array(pantryPackageIntentSchema).min(1).max(1_000),
    platform: pantryPlatformSchema,
  })
  .strict();

export const pantryCatalogStockRequestSchema = pantryCatalogStockIdentitySchema
  .extend({
    schemaVersion: z.literal(PANTRY_CATALOG_SCHEMA_VERSION),
    requestSha256: pantrySha256Schema,
    requestedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((request, context) => {
    let previous: string | null = null;
    for (let index = 0; index < request.intents.length; index += 1) {
      const intent = request.intents[index];
      const key = `${intent.ecosystem}:${intent.name}\0${intent.selector}`;
      if (previous !== null && compareUtf8(previous, key) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intents", index],
          message: "Pantry stock intents must be unique and sorted by UTF-8 bytes",
        });
      }
      previous = key;
    }
    if (Date.parse(request.expiresAt) <= Date.parse(request.requestedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Pantry stock requests must expire after they are created",
      });
    }
  });

export async function pantryCatalogStockRequestHash(
  input: Pick<PantryCatalogStockRequest, "intents" | "platform">,
): Promise<string> {
  const parsed = pantryCatalogStockIdentitySchema.parse({
    intents: input.intents,
    platform: input.platform,
  });
  return sha256Hex(`${PANTRY_CATALOG_HASH_DOMAIN}\nstock-request\n${canonicalPantryJson(parsed)}`);
}

export const pantryCatalogRetentionSchema = z
  .object({
    namespace: z.string().min(1).max(128).regex(ASCII_TOKEN_PATTERN),
    retainUntil: z.string().datetime({ offset: true }),
  })
  .strict();

function requiredShelfDigests(input: {
  revision: z.infer<typeof pantryRevisionRecordSchema>;
  lockfileSha256: string;
  sbomSha256: string;
  toolchainAttestationSha256: string;
}): Set<string> {
  const required = new Set([
    input.lockfileSha256,
    input.sbomSha256,
    input.toolchainAttestationSha256,
  ]);
  for (const ingredient of input.revision.content.closure.ingredients) {
    required.add(ingredient.registryMetadataSha256);
    required.add(ingredient.tarballSha256);
    required.add(ingredient.normalizedContentSha256);
    if (ingredient.provenance.attestationSha256 !== null) {
      required.add(ingredient.provenance.attestationSha256);
    }
  }
  for (const layer of input.revision.content.layers) {
    required.add(layer.contentSha256);
    required.add(layer.unpackedManifestSha256);
  }
  return required;
}

function validateShelfObjectReferences(
  input: {
    revision: z.infer<typeof pantryRevisionRecordSchema>;
    objectReferences: z.infer<typeof pantryCatalogObjectReferenceSchema>[];
    lockfileSha256: string;
    sbomSha256: string;
    toolchainAttestationSha256: string;
  },
  context: z.RefinementCtx,
): void {
  let previous: string | null = null;
  const present = new Set<string>();
  for (let index = 0; index < input.objectReferences.length; index += 1) {
    const reference = input.objectReferences[index];
    const key = `${reference.sha256}\0${reference.kind}`;
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectReferences", index],
        message: "Catalog object references must be unique and sorted by digest and kind",
      });
    }
    previous = key;
    present.add(reference.sha256);
  }
  for (const digest of requiredShelfDigests(input)) {
    if (!present.has(digest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectReferences"],
        message: `Catalog shelf is missing required digest ${digest}`,
      });
    }
  }
}

const pantryCatalogShelfCoreSchema = z
  .object({
    format: z.literal(PANTRY_CATALOG_SHELF_FORMAT),
    schemaVersion: z.literal(PANTRY_CATALOG_SCHEMA_VERSION),
    revision: pantryRevisionRecordSchema,
    state: pantryRevisionStateSchema,
    objectReferences: z.array(pantryCatalogObjectReferenceSchema).min(1).max(100_000),
    lockfileSha256: pantrySha256Schema,
    sbomSha256: pantrySha256Schema,
    toolchainAttestationSha256: pantrySha256Schema,
    retention: pantryCatalogRetentionSchema,
  })
  .strict();

export const pantryCatalogCommitRequestSchema = pantryCatalogShelfCoreSchema
  .extend({
    assemblyId: pantryCatalogAssemblyIdSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.state.state !== "assembling" ||
      request.state.stateRevision !== 0 ||
      request.state.revisionId !== request.revision.content.revisionId ||
      request.state.rootSha256 !== request.revision.rootSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "Catalog commits require the matching initial assembling state",
      });
    }
    validateShelfObjectReferences(request, context);
  });

const pantryCatalogShelfManifestSchema = pantryCatalogShelfCoreSchema
  .extend({
    committedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.state.state === "assembling" ||
      record.state.revisionId !== record.revision.content.revisionId ||
      record.state.rootSha256 !== record.revision.rootSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "Committed catalog shelves require a matching terminal lifecycle record",
      });
    }
    validateShelfObjectReferences(record, context);
  });

export const pantryCatalogShelfRecordSchema = z
  .object({
    ...pantryCatalogShelfCoreSchema.shape,
    committedAt: z.string().datetime({ offset: true }),
    manifestSha256: pantrySha256Schema,
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.state.state !== "committed" ||
      record.state.revisionId !== record.revision.content.revisionId ||
      record.state.rootSha256 !== record.revision.rootSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "Committed catalog shelves require a matching terminal lifecycle record",
      });
    }
    validateShelfObjectReferences(record, context);
  });

export async function pantryCatalogShelfManifestHash(
  input: Omit<PantryCatalogShelfRecord, "manifestSha256">,
): Promise<string> {
  const parsed = pantryCatalogShelfManifestSchema.parse(input);
  return sha256Hex(`${PANTRY_CATALOG_HASH_DOMAIN}\nshelf-manifest\n${canonicalPantryJson(parsed)}`);
}

export const pantryCatalogStateTransitionRequestSchema = z
  .object({
    expectedStateRevision: z.number().int().nonnegative().safe(),
    nextState: z.enum(["quarantined", "retired"]),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const pantryCatalogReferenceRequestSchema = z
  .object({
    referenceId: z.string().min(1).max(256).regex(REFERENCE_ID_PATTERN),
  })
  .strict();

export const pantryCatalogGcRequestSchema = z
  .object({
    scope: z.enum(["expired-uncommitted", "retired-unreferenced"]),
    now: z.string().datetime({ offset: true }),
    maxDeletes: z.number().int().positive().max(1_000),
    retentionNamespace: z.string().min(1).max(128).regex(ASCII_TOKEN_PATTERN).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.scope === "retired-unreferenced" && request.retentionNamespace === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionNamespace"],
        message: "Committed-object GC requires an exact retention namespace",
      });
    }
  });

export const pantryCatalogShelfStampSchema = z
  .object({
    format: z.literal(PANTRY_CATALOG_STAMP_FORMAT),
    schemaVersion: z.literal(PANTRY_CATALOG_SCHEMA_VERSION),
    pantryRevisionId: z.string().regex(/^pantry-\d{4}-\d{2}-\d{2}\.[1-9]\d*$/u),
    pantryRevisionRootSha256: pantrySha256Schema,
    dependencyClosureSha256: pantrySha256Schema,
    lockfileSha256: pantrySha256Schema,
    sbomSha256: pantrySha256Schema,
    toolchainImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    toolchainAttestationSha256: pantrySha256Schema,
  })
  .strict();

export function pantryCatalogShelfMatchesStamp(
  shelf: PantryCatalogShelfRecord,
  stamp: PantryCatalogShelfStamp,
): boolean {
  const parsedShelf = pantryCatalogShelfRecordSchema.safeParse(shelf);
  const parsedStamp = pantryCatalogShelfStampSchema.safeParse(stamp);
  if (!parsedShelf.success || !parsedStamp.success) return false;
  return (
    parsedShelf.data.state.state === "committed" &&
    parsedShelf.data.revision.content.revisionId === parsedStamp.data.pantryRevisionId &&
    parsedShelf.data.revision.rootSha256 === parsedStamp.data.pantryRevisionRootSha256 &&
    parsedShelf.data.revision.content.dependencyClosureSha256 ===
      parsedStamp.data.dependencyClosureSha256 &&
    parsedShelf.data.lockfileSha256 === parsedStamp.data.lockfileSha256 &&
    parsedShelf.data.sbomSha256 === parsedStamp.data.sbomSha256 &&
    parsedShelf.data.revision.content.closure.platform.toolchainImageDigest ===
      parsedStamp.data.toolchainImageDigest &&
    parsedShelf.data.toolchainAttestationSha256 === parsedStamp.data.toolchainAttestationSha256
  );
}

export const pantryCatalogErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum([
      "catalog_forbidden",
      "catalog_not_found",
      "catalog_conflict",
      "catalog_incomplete",
      "catalog_integrity_mismatch",
      "catalog_invalid_request",
      "catalog_method_not_allowed",
      "catalog_revision_not_committed",
      "catalog_stamp_mismatch",
      "catalog_infrastructure_unavailable",
      "catalog_internal_error",
    ]),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
  })
  .strict();

export type PantryCatalogObjectKind = z.infer<typeof pantryCatalogObjectKindSchema>;
export type PantryCatalogObjectReference = z.infer<typeof pantryCatalogObjectReferenceSchema>;
export type PantryCatalogStockRequest = z.infer<typeof pantryCatalogStockRequestSchema>;
export type PantryCatalogCommitRequest = z.infer<typeof pantryCatalogCommitRequestSchema>;
export type PantryCatalogShelfRecord = z.infer<typeof pantryCatalogShelfRecordSchema>;
export type PantryCatalogStateTransitionRequest = z.infer<
  typeof pantryCatalogStateTransitionRequestSchema
>;
export type PantryCatalogReferenceRequest = z.infer<typeof pantryCatalogReferenceRequestSchema>;
export type PantryCatalogGcRequest = z.infer<typeof pantryCatalogGcRequestSchema>;
export type PantryCatalogShelfStamp = z.infer<typeof pantryCatalogShelfStampSchema>;
export type PantryCatalogErrorResponse = z.infer<typeof pantryCatalogErrorResponseSchema>;
