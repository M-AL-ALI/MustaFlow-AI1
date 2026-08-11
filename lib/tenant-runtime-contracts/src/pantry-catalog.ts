import { z } from "zod";
import {
  PANTRY_ERROR_DEFAULTS,
  canonicalPantryJson,
  pantryPackageIntentSchema,
  pantryPlatformSchema,
  pantryRevisionIdSchema,
  pantryRevisionRecordSchema,
  pantryRevisionStateSchema,
  pantryErrorCodeSchema,
  pantrySha256Schema,
  pantrySignedDigestSchema,
} from "./pantry";
import { compareUtf8, validateRuntimeArtifactPath } from "./runtime-artifact";
import { sha256Hex } from "./request-signing";

export const PANTRY_CATALOG_SCHEMA_VERSION = 1 as const;
export const PANTRY_CATALOG_SHELF_FORMAT = "nabu-pantry-catalog-shelf/v1" as const;
export const PANTRY_CATALOG_STAMP_FORMAT = "nabu-pantry-catalog-stamp/v1" as const;
export const PANTRY_CATALOG_HASH_DOMAIN = "NABUFLOW_PANTRY_CATALOG_V1" as const;
export const PANTRY_SHELF_CONTENT_HASHES_FORMAT = "nabu-pantry-shelf-content-hashes/v1" as const;
export const MAX_PANTRY_SHELF_CONTENT_HASHES = 20_000;

const ASCII_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const ASSEMBLY_ID_PATTERN = /^passembly_[0-9a-f]{64}$/u;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export const pantryCatalogAssemblyIdSchema = z.string().regex(ASSEMBLY_ID_PATTERN);

export const pantryNormalizedPackageManifestSchema = z
  .object({
    format: z.literal("nabu-pantry-normalized-package/v1"),
    entries: z
      .array(
        z
          .object({
            path: z.string().refine((path) => validateRuntimeArtifactPath(path) !== null),
            mode: z.number().int().min(0).max(0o777),
            bytes: z.number().int().nonnegative().safe(),
            sha256: pantrySha256Schema,
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (let index = 1; index < manifest.entries.length; index += 1) {
      if (compareUtf8(manifest.entries[index - 1].path, manifest.entries[index].path) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "path"],
          message: "Normalized Pantry paths must be unique and sorted by UTF-8 bytes",
        });
      }
    }
  });

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
  "captured-build-resource",
]);

export const pantryCaptureBuildResourceRequestSchema = z
  .object({
    schemaVersion: z.literal(PANTRY_CATALOG_SCHEMA_VERSION),
    parentRevisionRootSha256: pantrySha256Schema,
    url: z
      .string()
      .url()
      .max(2_000)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.username === "" && url.password === "";
      }, "Captured build resources require credential-free HTTPS"),
    expectedSha256: pantrySha256Schema.nullable(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    requestedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const pantryCatalogObjectReferenceSchema = z
  .object({
    kind: pantryCatalogObjectKindSchema,
    sha256: pantrySha256Schema,
    bytes: z.number().int().nonnegative().safe(),
  })
  .strict();

const pantryCatalogStockIdentityCoreSchema = z
  .object({
    intents: z.array(pantryPackageIntentSchema).min(1).max(1_000),
    platform: pantryPlatformSchema,
  })
  .strict();

function validatePantryCatalogStockIdentity(
  identity: z.infer<typeof pantryCatalogStockIdentityCoreSchema>,
  context: z.RefinementCtx,
): void {
  let previous: string | null = null;
  for (let index = 0; index < identity.intents.length; index += 1) {
    const intent = identity.intents[index];
    const key = `${intent.ecosystem}:${intent.name}\0${intent.selector}`;
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intents", index],
        message: "Pantry stock identity intents must be unique and canonically ordered",
      });
    }
    previous = key;
  }
}

export const pantryCatalogStockIdentitySchema = pantryCatalogStockIdentityCoreSchema.superRefine(
  validatePantryCatalogStockIdentity,
);

export function canonicalPantryCatalogStockIdentity(
  input: z.input<typeof pantryCatalogStockIdentitySchema>,
): PantryCatalogStockIdentity {
  return pantryCatalogStockIdentitySchema.parse({
    intents: [...input.intents].sort((left, right) => {
      const leftKey = `${left.ecosystem}:${left.name}\0${left.selector}`;
      const rightKey = `${right.ecosystem}:${right.name}\0${right.selector}`;
      return compareUtf8(leftKey, rightKey);
    }),
    platform: input.platform,
  });
}

export function pantryCatalogStockIdentityEquals(
  left: z.input<typeof pantryCatalogStockIdentitySchema>,
  right: z.input<typeof pantryCatalogStockIdentitySchema>,
): boolean {
  return (
    canonicalPantryJson(canonicalPantryCatalogStockIdentity(left)) ===
    canonicalPantryJson(canonicalPantryCatalogStockIdentity(right))
  );
}

export const pantryCatalogStockRequestSchema = pantryCatalogStockIdentityCoreSchema
  .extend({
    schemaVersion: z.literal(PANTRY_CATALOG_SCHEMA_VERSION),
    requestSha256: pantrySha256Schema,
    requestedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((request, context) => {
    validatePantryCatalogStockIdentity(request, context);
    if (Date.parse(request.expiresAt) <= Date.parse(request.requestedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Pantry stock requests must expire after they are created",
      });
    }
  });

export const pantryCatalogStockResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      ok: z.literal(true),
      state: z.enum(["created", "assembling"]),
      assemblyId: pantryCatalogAssemblyIdSchema,
      revisionRootSha256: z.null(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      state: z.literal("committed"),
      assemblyId: pantryCatalogAssemblyIdSchema,
      revisionRootSha256: pantrySha256Schema,
    })
    .strict(),
]);

export const pantryCatalogIngestFailureStageSchema = z.enum([
  "registry-ingest",
  "stage-object",
  "commit-shelf",
  "lease-renewal",
  "assembly-deadline",
]);

export const pantryCatalogIngestFailureCauseSchema = z.enum([
  "registry-upstream",
  "catalog-storage-limit",
  "catalog-storage-rate-limited",
  "catalog-storage-quota",
  "catalog-storage-unavailable",
  "catalog-binding-missing",
  "catalog-owner-fenced",
  "catalog-rejected",
  "catalog-internal",
  "executor-internal",
  "executor-subrequest-limit",
  "deadline-exceeded",
]);

export const pantryCatalogIngestFailureOperationSchema = z.enum([
  "registry-ingest",
  "catalog-read-assembly",
  "catalog-stage-object",
  "catalog-record-object",
  "catalog-build-shelf",
  "catalog-read-existing-shelf",
  "catalog-verify-existing-shelf",
  "catalog-verify-quarantine",
  "catalog-promote-cas",
  "catalog-write-manifest",
  "catalog-commit-ledger",
  "catalog-delete-quarantine",
  "lease-renewal",
  "assembly-deadline",
]);

export const pantryCatalogSanitizedErrorClassSchema = z
  .enum(["Error", "TypeError", "RangeError", "DOMException", "PantryHttpError", "UnknownError"])
  .nullable();

export const pantryCatalogIngestFailureSchema = z
  .object({
    code: pantryErrorCodeSchema,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    failedAt: z.string().datetime({ offset: true }),
    negativeCacheUntil: z.string().datetime({ offset: true }),
    stage: pantryCatalogIngestFailureStageSchema,
    operation: pantryCatalogIngestFailureOperationSchema,
    cause: pantryCatalogIngestFailureCauseSchema,
    errorClass: pantryCatalogSanitizedErrorClassSchema,
    errorCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/u)
      .nullable(),
    errorFingerprint: z
      .string()
      .regex(/^[0-9a-f]{16}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((failure, context) => {
    if (failure.retryable !== PANTRY_ERROR_DEFAULTS[failure.code].retryable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryable"],
        message: "Pantry ingest retryability is fixed by the typed error code",
      });
    }
  });

const pantryCatalogIngestProgressBaseSchema = z.object({
  attempt: z.number().int().nonnegative().safe(),
  updatedAt: z.string().datetime({ offset: true }),
});

export const pantryCatalogIngestProgressSchema = z.discriminatedUnion("state", [
  pantryCatalogIngestProgressBaseSchema
    .extend({
      state: z.literal("queued"),
      leaseUntil: z.null(),
      failure: z.null(),
    })
    .strict(),
  pantryCatalogIngestProgressBaseSchema
    .extend({
      state: z.literal("running"),
      leaseUntil: z.string().datetime({ offset: true }),
      failure: z.null(),
    })
    .strict(),
  pantryCatalogIngestProgressBaseSchema
    .extend({
      state: z.literal("failed"),
      leaseUntil: z.null(),
      failure: pantryCatalogIngestFailureSchema,
    })
    .strict(),
]);

export const pantryCatalogAssemblyStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    assemblyId: pantryCatalogAssemblyIdSchema,
    ingest: pantryCatalogIngestProgressSchema,
    stagedObjects: z.number().int().nonnegative().safe(),
  })
  .strict();

export const PANTRY_ASSEMBLY_EVENT_TRAIL_LIMIT = 256;
export const PANTRY_ORPHAN_CAS_SAFETY_WINDOW_MS = 60 * 60_000;

/**
 * The staging exhibit spent 186,890 ms in object staging and crossed the former
 * 180,000 ms lease.  A 2x safety factor, rounded up to the next 30-second
 * boundary, leaves a deterministic 390-second lease while the 30-second
 * heartbeat makes healthy execution independent of stage duration.
 */
export const PANTRY_ASSEMBLY_LONG_STAGE_EXHIBIT_MS = 186_890;
export const PANTRY_ASSEMBLY_LEASE_SAFETY_FACTOR = 2;
export const PANTRY_ASSEMBLY_LEASE_ROUNDING_MS = 30_000;
export const PANTRY_ASSEMBLY_LEASE_MS =
  Math.ceil(
    (PANTRY_ASSEMBLY_LONG_STAGE_EXHIBIT_MS * PANTRY_ASSEMBLY_LEASE_SAFETY_FACTOR) /
      PANTRY_ASSEMBLY_LEASE_ROUNDING_MS,
  ) * PANTRY_ASSEMBLY_LEASE_ROUNDING_MS;
export const PANTRY_ASSEMBLY_HEARTBEAT_MS = 30_000;
export const PANTRY_ASSEMBLY_QUEUE_WATCHDOG_MS = 15_000;
export const PANTRY_ASSEMBLY_PRODUCT_BOUND_MS = 20 * 60_000;
export const PANTRY_ASSEMBLY_OBSERVATION_MARGIN_MS = 2 * 60_000;
export const PANTRY_ASSEMBLY_SERVER_EXECUTION_DEADLINE_MS =
  PANTRY_ASSEMBLY_PRODUCT_BOUND_MS - PANTRY_ASSEMBLY_OBSERVATION_MARGIN_MS;

export const pantryCatalogAssemblyStageSchema = z.enum([
  "queued",
  "resolving-metadata",
  "fetching-tarball",
  "verifying-integrity",
  "extracting-tarball",
  "assembling-closure",
  "staging-objects",
  "committing-shelf",
  "committed",
  "failed",
]);

export const pantryCatalogAssemblyEventKindSchema = z.enum([
  "assembly-created",
  "stock-attached",
  "stock-adopted",
  "queue-enqueued",
  "queue-delivered",
  "generation-claimed",
  "generation-busy",
  "lease-renewed",
  "lease-expired",
  "alarm-reenqueued",
  "deadline-terminal",
  "ingest-claimed",
  "ingest-busy",
  "ingest-progress",
  "object-staged",
  "object-resume-verified",
  "ingest-failed",
  "objects-reclaimed",
  "shelf-committed",
]);

export const pantryCatalogAssemblyProgressMetricsSchema = z
  .object({
    resolvedPackages: z.number().int().nonnegative().safe(),
    fetchedTarballs: z.number().int().nonnegative().safe(),
    verifiedTarballs: z.number().int().nonnegative().safe(),
    extractedTarballs: z.number().int().nonnegative().safe(),
    dependencyEdges: z.number().int().nonnegative().safe(),
    tarballBytes: z.number().int().nonnegative().safe(),
    unpackedBytes: z.number().int().nonnegative().safe(),
  })
  .strict();

export const pantryCatalogAssemblyEventSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    at: z.string().datetime({ offset: true }),
    kind: pantryCatalogAssemblyEventKindSchema,
    stage: pantryCatalogAssemblyStageSchema,
    generation: z.number().int().positive().safe(),
    attempt: z.number().int().nonnegative().safe(),
    queueDeliveries: z.number().int().nonnegative().safe(),
    stagedObjects: z.number().int().nonnegative().safe(),
    metrics: pantryCatalogAssemblyProgressMetricsSchema,
    failureCode: pantryErrorCodeSchema.nullable(),
    failureStage: pantryCatalogIngestFailureStageSchema.nullable(),
    failureOperation: pantryCatalogIngestFailureOperationSchema.nullable(),
    failureCause: pantryCatalogIngestFailureCauseSchema.nullable(),
    failureErrorClass: pantryCatalogSanitizedErrorClassSchema,
    failureErrorCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/u)
      .nullable(),
    failureErrorFingerprint: z
      .string()
      .regex(/^[0-9a-f]{16}$/u)
      .nullable(),
    reclaimedObjects: z.number().int().nonnegative().safe(),
    reclaimedBytes: z.number().int().nonnegative().safe(),
  })
  .strict();

export const pantryCatalogAssemblyStageTransitionSchema = z
  .object({
    stage: pantryCatalogAssemblyStageSchema,
    firstAt: z.string().datetime({ offset: true }),
    lastAt: z.string().datetime({ offset: true }),
    transitions: z.number().int().positive().safe(),
  })
  .strict();

export const pantryCatalogAssemblyDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    assemblyId: pantryCatalogAssemblyIdSchema,
    requestSha256: pantrySha256Schema,
    currentStage: pantryCatalogAssemblyStageSchema,
    lastTransitionAt: z.string().datetime({ offset: true }),
    queueEnqueues: z.number().int().nonnegative().safe(),
    queueDeliveries: z.number().int().nonnegative().safe(),
    generation: z.number().int().positive().safe(),
    leaseRenewals: z.number().int().nonnegative().safe(),
    alarmReenqueues: z.number().int().nonnegative().safe(),
    ingestAttempts: z.number().int().nonnegative().safe(),
    stagedObjects: z.number().int().nonnegative().safe(),
    metrics: pantryCatalogAssemblyProgressMetricsSchema,
    stageTransitions: z.array(pantryCatalogAssemblyStageTransitionSchema).max(10),
    events: z.array(pantryCatalogAssemblyEventSchema).max(PANTRY_ASSEMBLY_EVENT_TRAIL_LIMIT),
    truncatedBeforeSequence: z.number().int().nonnegative().safe(),
  })
  .strict();

export const pantryCatalogObjectInventoryResponseSchema = z
  .object({
    ok: z.literal(true),
    objects: z
      .array(
        z
          .object({
            key: z.string().min(1).max(512),
            size: z.number().int().nonnegative().safe(),
            uploadedAt: z.string().datetime({ offset: true }),
            sha256: pantrySha256Schema,
          })
          .strict(),
      )
      .max(5_000),
    totalBytes: z.number().int().nonnegative().safe(),
  })
  .strict();

export async function pantryCatalogStockRequestHash(
  input: Pick<PantryCatalogStockRequest, "intents" | "platform">,
): Promise<string> {
  const identity = canonicalPantryCatalogStockIdentity({
    intents: input.intents,
    platform: input.platform,
  });
  return sha256Hex(
    `${PANTRY_CATALOG_HASH_DOMAIN}\nstock-request\n${canonicalPantryJson(identity)}`,
  );
}

export const pantryCatalogStockIdentityHash = pantryCatalogStockRequestHash;

export const pantryCatalogStockIdentityStatusResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      ok: z.literal(true),
      state: z.literal("assembling"),
      identitySha256: pantrySha256Schema,
      assemblyId: pantryCatalogAssemblyIdSchema,
      revisionRootSha256: z.null(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      state: z.literal("committed"),
      identitySha256: pantrySha256Schema,
      assemblyId: pantryCatalogAssemblyIdSchema,
      revisionRootSha256: pantrySha256Schema,
    })
    .strict(),
]);

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
  for (const resource of input.revision.content.capturedBuildResources ?? []) {
    required.add(resource.contentSha256);
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
    scope: z.enum([
      "expired-uncommitted",
      "retired-unreferenced",
      "orphan-cas-sweep",
      "targeted-orphan-cas",
    ]),
    now: z.string().datetime({ offset: true }),
    maxDeletes: z.number().int().positive().max(1_000),
    retentionNamespace: z.string().min(1).max(128).regex(ASCII_TOKEN_PATTERN).optional(),
    objectSha256: z.array(pantrySha256Schema).max(1_000).optional(),
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
    if (
      request.scope === "targeted-orphan-cas" &&
      (request.objectSha256 === undefined || request.objectSha256.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectSha256"],
        message: "Targeted orphan reclamation requires exact content addresses",
      });
    }
    if (request.scope !== "targeted-orphan-cas" && request.objectSha256 !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objectSha256"],
        message: "Exact content addresses are valid only for targeted orphan reclamation",
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

export const pantryShelfContentHashesStatementSchema = z
  .object({
    format: z.literal(PANTRY_SHELF_CONTENT_HASHES_FORMAT),
    schemaVersion: z.literal(PANTRY_CATALOG_SCHEMA_VERSION),
    pantryRevisionId: pantryRevisionIdSchema,
    pantryRevisionRootSha256: pantrySha256Schema,
    shelfManifestSha256: pantrySha256Schema,
    contentHashes: z.array(pantrySha256Schema).max(MAX_PANTRY_SHELF_CONTENT_HASHES),
  })
  .strict()
  .superRefine((statement, context) => {
    for (let index = 1; index < statement.contentHashes.length; index += 1) {
      if (compareUtf8(statement.contentHashes[index - 1], statement.contentHashes[index]) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contentHashes", index],
          message: "Shelf content hashes must be unique and sorted",
        });
      }
    }
  });

export async function pantryShelfContentHashesHash(
  input: PantryShelfContentHashesStatement,
): Promise<string> {
  const statement = pantryShelfContentHashesStatementSchema.parse(input);
  return sha256Hex(
    `${PANTRY_CATALOG_HASH_DOMAIN}\nshelf-content-hashes\n${canonicalPantryJson(statement)}`,
  );
}

export const pantryShelfContentHashesResponseSchema = z
  .object({
    ok: z.literal(true),
    statement: pantryShelfContentHashesStatementSchema,
    statementSha256: pantrySha256Schema,
    signature: pantrySignedDigestSchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.signature.kind !== "shelf-content-hashes" ||
      response.signature.payloadSha256 !== response.statementSha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signature"],
        message: "Shelf content hashes require a matching attestation signature",
      });
    }
  });

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
export type PantryCatalogStockIdentity = z.infer<typeof pantryCatalogStockIdentitySchema>;
export type PantryCatalogStockResponse = z.infer<typeof pantryCatalogStockResponseSchema>;
export type PantryCatalogStockIdentityStatusResponse = z.infer<
  typeof pantryCatalogStockIdentityStatusResponseSchema
>;
export type PantryCatalogIngestFailure = z.infer<typeof pantryCatalogIngestFailureSchema>;
export type PantryCatalogIngestProgress = z.infer<typeof pantryCatalogIngestProgressSchema>;
export type PantryCatalogAssemblyStatusResponse = z.infer<
  typeof pantryCatalogAssemblyStatusResponseSchema
>;
export type PantryCatalogAssemblyStage = z.infer<typeof pantryCatalogAssemblyStageSchema>;
export type PantryCatalogAssemblyEventKind = z.infer<typeof pantryCatalogAssemblyEventKindSchema>;
export type PantryCatalogAssemblyProgressMetrics = z.infer<
  typeof pantryCatalogAssemblyProgressMetricsSchema
>;
export type PantryCatalogAssemblyEvent = z.infer<typeof pantryCatalogAssemblyEventSchema>;
export type PantryCatalogAssemblyDiagnosticsResponse = z.infer<
  typeof pantryCatalogAssemblyDiagnosticsResponseSchema
>;
export type PantryCatalogObjectInventoryResponse = z.infer<
  typeof pantryCatalogObjectInventoryResponseSchema
>;
export type PantryCatalogCommitRequest = z.infer<typeof pantryCatalogCommitRequestSchema>;
export type PantryCatalogShelfRecord = z.infer<typeof pantryCatalogShelfRecordSchema>;
export type PantryCatalogStateTransitionRequest = z.infer<
  typeof pantryCatalogStateTransitionRequestSchema
>;
export type PantryCatalogReferenceRequest = z.infer<typeof pantryCatalogReferenceRequestSchema>;
export type PantryCatalogGcRequest = z.infer<typeof pantryCatalogGcRequestSchema>;
export type PantryCaptureBuildResourceRequest = z.infer<
  typeof pantryCaptureBuildResourceRequestSchema
>;
export type PantryCatalogShelfStamp = z.infer<typeof pantryCatalogShelfStampSchema>;
export type PantryNormalizedPackageManifest = z.infer<typeof pantryNormalizedPackageManifestSchema>;
export type PantryShelfContentHashesStatement = z.infer<
  typeof pantryShelfContentHashesStatementSchema
>;
export type PantryShelfContentHashesResponse = z.infer<
  typeof pantryShelfContentHashesResponseSchema
>;
export type PantryCatalogErrorResponse = z.infer<typeof pantryCatalogErrorResponseSchema>;
