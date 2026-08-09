import { z } from "zod";
import {
  canonicalPantryJson,
  pantryBuildAttestationSchema,
  pantryBuildIdSchema,
  pantryBuildInputSchema,
  pantryCatalogShelfStampSchema,
  pantryErrorCodeSchema,
  pantryErrorStatus,
  pantryPackageIntentSchema,
  pantrySha256Schema,
} from "./index-internal";
import {
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  compareUtf8,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactSha256Schema,
  validateRuntimeArtifactPath,
} from "./runtime-artifact";
import { runtimeArtifactLayerContentSchema } from "./runtime-artifact-layers";
import { sha256Hex } from "./request-signing";

export const TRUSTED_BUILD_SCHEMA_VERSION = 1 as const;
export const TRUSTED_BUILD_REQUEST_FORMAT = "nabu-trusted-build-request/v1" as const;
export const TRUSTED_BUILD_SOURCE_FORMAT = "nabu-trusted-build-source/v1" as const;
export const TRUSTED_BUILD_OUTPUT_FORMAT = "nabu-trusted-build-output/v1" as const;
export const TRUSTED_BUILD_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const TRUSTED_BUILD_MAX_SOURCE_FILES = 5_000;
export const TRUSTED_BUILD_MAX_REQUEST_BYTES = 24 * 1024 * 1024;
export const TRUSTED_BUILD_MAX_OUTPUT_LAYERS = 32;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BUILD_REQUEST_ID_PATTERN = /^pbuildreq_[0-9a-f]{64}$/u;
const ASCII_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

function decodeBase64Bytes(value: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export const trustedBuildRequestIdSchema = z.string().regex(BUILD_REQUEST_ID_PATTERN);

export const trustedBuildSourceManifestSchema = z
  .object({
    format: z.literal(TRUSTED_BUILD_SOURCE_FORMAT),
    schemaVersion: z.literal(TRUSTED_BUILD_SCHEMA_VERSION),
    payloadBytes: z.number().int().nonnegative().max(TRUSTED_BUILD_MAX_SOURCE_BYTES),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .refine(
                (path) => validateRuntimeArtifactPath(path) !== null,
                "Invalid trusted-build source path",
              ),
            mode: z.union([z.literal(0o644), z.literal(0o755)]),
            offset: z.number().int().nonnegative().max(TRUSTED_BUILD_MAX_SOURCE_BYTES),
            size: z.number().int().nonnegative().max(TRUSTED_BUILD_MAX_SOURCE_BYTES),
            sha256: pantrySha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(TRUSTED_BUILD_MAX_SOURCE_FILES),
  })
  .strict()
  .superRefine((manifest, context) => {
    let offset = 0;
    let previousPath: string | null = null;
    for (let index = 0; index < manifest.files.length; index += 1) {
      const file = manifest.files[index];
      if (file.offset !== offset) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "offset"],
          message: "Trusted-build source files must form one contiguous payload",
        });
      }
      if (previousPath !== null && compareUtf8(previousPath, file.path) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "Trusted-build source paths must be unique and sorted",
        });
      }
      offset += file.size;
      previousPath = file.path;
    }
    if (offset !== manifest.payloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadBytes"],
        message: "Trusted-build source sizes do not match the payload",
      });
    }
  });

export async function trustedBuildSourceManifestHash(
  input: TrustedBuildSourceManifest,
): Promise<string> {
  return sha256Hex(
    `NABUFLOW_TRUSTED_BUILD_V1\nsource-manifest\n${canonicalPantryJson(
      trustedBuildSourceManifestSchema.parse(input),
    )}`,
  );
}

export async function trustedBuildDependencyIntentHash(
  input: readonly z.infer<typeof pantryPackageIntentSchema>[],
): Promise<string> {
  const intents = z.array(pantryPackageIntentSchema).min(1).max(1_000).parse(input);
  return sha256Hex(`NABUFLOW_TRUSTED_BUILD_V1\ndependency-intent\n${canonicalPantryJson(intents)}`);
}

export const trustedBuildRequestSchema = z
  .object({
    format: z.literal(TRUSTED_BUILD_REQUEST_FORMAT),
    schemaVersion: z.literal(TRUSTED_BUILD_SCHEMA_VERSION),
    requestId: trustedBuildRequestIdSchema,
    input: pantryBuildInputSchema,
    source: z
      .object({
        manifest: trustedBuildSourceManifestSchema,
        payloadBase64: z
          .string()
          .max(Math.ceil((TRUSTED_BUILD_MAX_SOURCE_BYTES * 4) / 3) + 4)
          .refine((value) => decodeBase64Bytes(value) !== null, "Source payload is not base64"),
      })
      .strict(),
    dependencyIntents: z.array(pantryPackageIntentSchema).min(1).max(1_000),
    output: z
      .object({
        strategy: z.literal("bundle-first"),
        dependencyPackaging: z.enum(["bundle", "layer"]),
        appDirectory: z
          .string()
          .refine(
            (path) => validateRuntimeArtifactPath(path) !== null,
            "Invalid build app directory",
          ),
        dependencyLayerMountPath: z.literal("node_modules"),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const decoded = decodeBase64Bytes(request.source.payloadBase64);
    if (decoded?.byteLength !== request.source.manifest.payloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "payloadBase64"],
        message: "Source payload byte count does not match its manifest",
      });
    }
    let previous: string | null = null;
    for (let index = 0; index < request.dependencyIntents.length; index += 1) {
      const intent = request.dependencyIntents[index];
      const key = `${intent.ecosystem}:${intent.name}\0${intent.selector}`;
      if (previous !== null && compareUtf8(previous, key) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependencyIntents", index],
          message: "Dependency intents must be unique and sorted",
        });
      }
      previous = key;
    }
  });

export async function trustedBuildRequestHash(
  input: Omit<TrustedBuildRequest, "requestId">,
): Promise<string> {
  return sha256Hex(`NABUFLOW_TRUSTED_BUILD_V1\nrequest\n${canonicalPantryJson(input)}`);
}

export async function verifyTrustedBuildRequest(
  input: TrustedBuildRequest,
): Promise<
  | { ok: true; sourcePayload: Uint8Array; requestSha256: string }
  | { ok: false; reason: "invalid_source" | "invalid_dependency_intent" }
> {
  const parsed = trustedBuildRequestSchema.parse(input);
  const sourcePayload = decodeBase64Bytes(parsed.source.payloadBase64);
  if (sourcePayload === null) return { ok: false, reason: "invalid_source" };
  for (const file of parsed.source.manifest.files) {
    const bytes = sourcePayload.slice(file.offset, file.offset + file.size);
    if ((await sha256Hex(bytes)) !== file.sha256) return { ok: false, reason: "invalid_source" };
  }
  if (
    (await trustedBuildSourceManifestHash(parsed.source.manifest)) !==
    parsed.input.sourceArtifactSha256
  ) {
    return { ok: false, reason: "invalid_source" };
  }
  if (
    (await trustedBuildDependencyIntentHash(parsed.dependencyIntents)) !==
    parsed.input.dependencyIntentSha256
  ) {
    return { ok: false, reason: "invalid_dependency_intent" };
  }
  const { requestId: _requestId, ...unsignedRequest } = parsed;
  const requestSha256 = await trustedBuildRequestHash(unsignedRequest);
  if (parsed.requestId !== `pbuildreq_${requestSha256}`) {
    return { ok: false, reason: "invalid_source" };
  }
  return { ok: true, sourcePayload, requestSha256 };
}

const trustedBuildChunkDescriptorSchema = z
  .object({
    index: z.number().int().nonnegative(),
    sha256: runtimeArtifactSha256Schema,
    bytes: z.number().int().positive().max(RUNTIME_ARTIFACT_CHUNK_BYTES),
  })
  .strict();

export const trustedBuildOutputSchema = z
  .object({
    format: z.literal(TRUSTED_BUILD_OUTPUT_FORMAT),
    schemaVersion: z.literal(TRUSTED_BUILD_SCHEMA_VERSION),
    buildId: pantryBuildIdSchema,
    requestSha256: pantrySha256Schema,
    pantryShelf: pantryCatalogShelfStampSchema,
    app: z
      .object({
        content: runtimeArtifactContentManifestSchema,
        chunks: z.array(trustedBuildChunkDescriptorSchema),
      })
      .strict(),
    layers: z
      .array(
        z
          .object({
            content: runtimeArtifactLayerContentSchema,
            chunks: z.array(trustedBuildChunkDescriptorSchema),
          })
          .strict(),
      )
      .max(TRUSTED_BUILD_MAX_OUTPUT_LAYERS),
    buildAttestation: pantryBuildAttestationSchema,
    outputSha256: pantrySha256Schema,
    coldBuild: z.boolean(),
    upstreamRequests: z.number().int().nonnegative().safe(),
    pantryObjectReads: z.number().int().nonnegative().safe(),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((output, context) => {
    const expectedAppChunks = Math.ceil(
      output.app.content.payloadBytes / RUNTIME_ARTIFACT_CHUNK_BYTES,
    );
    if (output.app.chunks.length !== expectedAppChunks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["app", "chunks"],
        message: "Build app chunk descriptors do not match the app payload",
      });
    }
    for (const [layerIndex, layer] of output.layers.entries()) {
      if (layer.chunks.length !== layer.content.chunks.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", layerIndex, "chunks"],
          message: "Build layer chunk descriptors do not match the layer payload",
        });
      }
    }
  });

export async function trustedBuildOutputHash(
  input: Omit<TrustedBuildOutput, "outputSha256">,
): Promise<string> {
  return sha256Hex(`NABUFLOW_TRUSTED_BUILD_V1\noutput\n${canonicalPantryJson(input)}`);
}

export const trustedBuildStateSchema = z.enum([
  "queued",
  "resolving",
  "building",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);

export const TRUSTED_BUILD_STAGE_VALUES = [
  "orchestration",
  "initialize",
  "keepalive",
  "filesystem-initialize",
  "source-transfer",
  "pantry-transfer",
  "resource-transfer",
  "registry-start",
  "registry-ready",
  "toolchain-resolve",
  "install",
  "bin-materialization",
  "rebuild",
  "post-rebuild-bin-materialization",
  "build-command",
  "post-build-bin-materialization",
  "output-collection",
  "output-verification",
  "output-persist",
  "unknown",
] as const;

export const trustedBuildStageSchema = z.enum(TRUSTED_BUILD_STAGE_VALUES);

export const trustedBuildCommandDiagnosticsSchema = z
  .object({
    commandLine: z.string().min(1).max(8_192),
    exitCode: z.number().int().min(-1).max(255).nullable(),
    resolvedPath: z.string().min(1).max(2_048),
    resolvedExecutable: z.string().min(1).max(2_048).nullable(),
    stdoutTail: z.string().max(4_096),
    stderrTail: z.string().max(4_096),
  })
  .strict();

const trustedBuildPublicErrorSchema = z
  .object({
    code: pantryErrorCodeSchema,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    status: z.number().int().min(400).max(599),
  })
  .strict();

export const trustedBuildCollectionProgressSchema = z
  .object({
    pass: z.union([z.literal(1), z.literal(2)]),
    root: z.enum(["app", "dependencies"]),
    phase: z.enum(["enumerated", "batch", "heartbeat", "completed"]),
    filesEnumerated: z.number().int().nonnegative().max(25_000),
    filesCollected: z.number().int().nonnegative().max(25_000),
    bytesMoved: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    peakBufferedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024)
      .default(0),
    batchFiles: z.number().int().nonnegative().max(25_000),
    batchBytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    batchElapsedMs: z
      .number()
      .nonnegative()
      .max(90 * 60_000),
    elapsedMs: z
      .number()
      .nonnegative()
      .max(90 * 60_000),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const trustedBuildSecretScanFindingSchema = z
  .object({
    scope: z.enum(["app", "dependency"]),
    path: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (path) => path === "[redacted-path]" || validateRuntimeArtifactPath(path) !== null,
        "Invalid sanitized scan path",
      ),
    ruleId: z.enum([
      "private-key",
      "stripe-secret-key",
      "postgres-credential-url",
      "aws-access-key",
    ]),
    contentSha256Prefix: z.string().regex(/^[0-9a-f]{16}$/u),
    byteOffset: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    provenance: z.enum(["shelf-byte-identical", "not-shelf-byte-identical"]),
  })
  .strict();

export const trustedBuildSecretScanSummarySchema = z
  .object({
    pass: z.union([z.literal(1), z.literal(2)]),
    root: z.enum(["app", "dependencies"]),
    scannedFiles: z.number().int().nonnegative().max(25_000),
    shelfExemptFiles: z.number().int().nonnegative().max(25_000),
    bytesScanned: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    peakBufferedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const trustedBuildMemoryProgressSchema = z
  .object({
    pass: z.union([z.literal(1), z.literal(2)]).nullable(),
    phase: z.enum(["transfer", "install", "rebuild", "build", "collection", "verification"]),
    controlledPeakBytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    // Runtime counters describe the host/isolate and may legitimately include memory outside the
    // controlled build buffers. They are telemetry, not the enforcement boundary; the platform's
    // 128 MiB limit and controlledPeakBytes remain the authoritative bounds.
    runtimePeakBytes: z.number().int().nonnegative().safe().nullable(),
    heapUsedBytes: z.number().int().nonnegative().safe().nullable(),
    arrayBuffersBytes: z.number().int().nonnegative().safe().nullable(),
    samples: z.number().int().positive().max(10_000),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const trustedBuildVerificationProgressSchema = z
  .object({
    phase: z.enum([
      "collection-complete",
      "transition-requested",
      "transition-completed",
      "verification-start-invoked",
      "verification-start-received",
      "heartbeat",
      "preparation-completed",
    ]),
    mechanism: z.literal("same-queue-consumer-direct-call"),
    elapsedMs: z
      .number()
      .int()
      .nonnegative()
      .max(90 * 60_000),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const trustedBuildAttemptEvidenceSchema = z
  .object({
    attempt: z.number().int().positive().max(10),
    progression: z
      .array(
        z
          .object({
            pass: z.union([z.literal(1), z.literal(2)]).nullable(),
            stage: trustedBuildStageSchema,
            outcome: z.enum(["started", "succeeded", "failed"]),
          })
          .strict(),
      )
      .max(100),
    collectionProgress: z.array(trustedBuildCollectionProgressSchema).max(2_000).default([]),
    secretScanFindings: z.array(trustedBuildSecretScanFindingSchema).max(100).default([]),
    secretScanSummaries: z.array(trustedBuildSecretScanSummarySchema).max(10).default([]),
    memoryProgress: z.array(trustedBuildMemoryProgressSchema).max(20).default([]),
    verificationProgress: z.array(trustedBuildVerificationProgressSchema).max(200).default([]),
    lastSuccessfulStage: z
      .object({
        pass: z.union([z.literal(1), z.literal(2)]).nullable(),
        stage: trustedBuildStageSchema,
      })
      .strict()
      .nullable(),
    failingStage: z
      .object({
        pass: z.union([z.literal(1), z.literal(2)]).nullable(),
        stage: trustedBuildStageSchema,
      })
      .strict()
      .nullable(),
    error: trustedBuildPublicErrorSchema.nullable(),
    diagnostics: trustedBuildCommandDiagnosticsSchema.nullable(),
  })
  .strict();

export const trustedBuildStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    buildId: pantryBuildIdSchema,
    requestId: trustedBuildRequestIdSchema,
    state: trustedBuildStateSchema,
    attempt: z.number().int().nonnegative().safe(),
    attempts: z.array(trustedBuildAttemptEvidenceSchema).max(10),
    output: trustedBuildOutputSchema.nullable(),
    error: trustedBuildPublicErrorSchema.nullable(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((status, context) => {
    if (status.error !== null && pantryErrorStatus(status.error.code) !== status.error.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error", "status"],
        message: "Build error status is fixed by its typed code",
      });
    }
    if ((status.state === "succeeded") !== (status.output !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output"],
        message: "Only successful builds contain an output",
      });
    }
    if ((status.state === "failed") !== (status.error !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "Only failed builds contain an error",
      });
    }
  });

export const trustedBuildBeginResponseSchema = z
  .object({
    ok: z.literal(true),
    buildId: pantryBuildIdSchema,
    requestId: trustedBuildRequestIdSchema,
    state: z.enum(["created", "coalesced", "succeeded"]),
  })
  .strict();

export const trustedBuildChunkResponseSchema = z
  .object({
    ok: z.literal(true),
    buildId: pantryBuildIdSchema,
    scope: z.enum(["app", "layer"]),
    contentSha256: pantrySha256Schema,
    chunkIndex: z.number().int().nonnegative(),
    chunkSha256: pantrySha256Schema,
    payloadBase64: z.string().regex(BASE64_PATTERN),
  })
  .strict();

export const trustedBuildCancelResponseSchema = z
  .object({
    ok: z.literal(true),
    buildId: pantryBuildIdSchema,
    state: z.enum(["cancelled", "already-terminal"]),
  })
  .strict();

export const trustedBuildGcRequestSchema = z
  .object({
    scope: z.enum(["quarantine", "all-test-data"]),
    olderThan: z.string().datetime({ offset: true }),
    maxDeletes: z.number().int().positive().max(1_000),
  })
  .strict();

export const trustedBuildDiagnosticsResponseSchema = z
  .object({
    ok: z.literal(true),
    ledger: z
      .object({
        queued: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
        queueDeliveries: z.number().int().nonnegative(),
        coalescedRequests: z.number().int().nonnegative(),
      })
      .strict(),
    r2: z
      .object({
        objects: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
        quarantineObjects: z.number().int().nonnegative(),
      })
      .strict(),
    activeCells: z.number().int().nonnegative(),
  })
  .strict();

export function trustedBuildResultReference(value: {
  buildId: string;
  scope: "app" | "layer";
  contentSha256: string;
  chunkIndex: number;
}): string {
  const buildId = pantryBuildIdSchema.parse(value.buildId);
  const contentSha256 = pantrySha256Schema.parse(value.contentSha256);
  if (!Number.isSafeInteger(value.chunkIndex) || value.chunkIndex < 0) {
    throw new Error("Build chunk index is invalid");
  }
  return `${buildId}:${value.scope}:${contentSha256}:${value.chunkIndex}`;
}

export const trustedBuildTelemetryLabelSchema = z.string().regex(ASCII_TOKEN_PATTERN);

export type TrustedBuildSourceManifest = z.infer<typeof trustedBuildSourceManifestSchema>;
export type TrustedBuildRequest = z.infer<typeof trustedBuildRequestSchema>;
export type TrustedBuildOutput = z.infer<typeof trustedBuildOutputSchema>;
export type TrustedBuildState = z.infer<typeof trustedBuildStateSchema>;
export type TrustedBuildStage = z.infer<typeof trustedBuildStageSchema>;
export type TrustedBuildCommandDiagnostics = z.infer<typeof trustedBuildCommandDiagnosticsSchema>;
export type TrustedBuildCollectionProgress = z.infer<typeof trustedBuildCollectionProgressSchema>;
export type TrustedBuildSecretScanFinding = z.infer<typeof trustedBuildSecretScanFindingSchema>;
export type TrustedBuildSecretScanSummary = z.infer<typeof trustedBuildSecretScanSummarySchema>;
export type TrustedBuildMemoryProgress = z.infer<typeof trustedBuildMemoryProgressSchema>;
export type TrustedBuildVerificationProgress = z.infer<
  typeof trustedBuildVerificationProgressSchema
>;
export type TrustedBuildAttemptEvidence = z.infer<typeof trustedBuildAttemptEvidenceSchema>;
export type TrustedBuildStatusResponse = z.infer<typeof trustedBuildStatusResponseSchema>;
