import { z } from "zod";
import {
  pantryLayerDescriptorSchema,
  pantryPlatformSchema,
  pantryRevisionStateSchema,
  pantrySha256Schema,
} from "./pantry";
import { runtimeLocatorSchema } from "./control-schemas";
import {
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  canonicalJson,
  compareUtf8,
  runtimeArtifactEnvelopeSchema,
  runtimeArtifactSha256Schema,
  validateRuntimeArtifactPath,
  verifyRuntimeArtifactEnvelope,
} from "./runtime-artifact";
import { parseRuntimeIdentity } from "./runtime-identity";
import { sha256Hex } from "./request-signing";

export const RUNTIME_ARTIFACT_LAYERS_FORMAT = "nabu-artifact-layers/v1" as const;
export const MAX_RUNTIME_ARTIFACT_LAYERS = 32;
export const MAX_RUNTIME_ARTIFACT_LAYER_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_LAYER_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_LAYER_FILES = 20_000;
export const MAX_RUNTIME_ARTIFACT_LAYERED_BYTES = 512 * 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_LAYERED_MANIFEST_BYTES = 4 * 1024 * 1024;

const runtimeArtifactLayerFileSchema = z
  .object({
    path: z
      .string()
      .refine((path) => validateRuntimeArtifactPath(path) !== null, "Invalid layer file path"),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
    offset: z.number().int().nonnegative().max(MAX_RUNTIME_ARTIFACT_LAYER_BYTES),
    size: z.number().int().nonnegative().max(MAX_RUNTIME_ARTIFACT_LAYER_FILE_BYTES),
    sha256: runtimeArtifactSha256Schema,
  })
  .strict();

export const runtimeArtifactLayerContentSchema = z
  .object({
    descriptor: pantryLayerDescriptorSchema,
    payloadBytes: z.number().int().nonnegative().max(MAX_RUNTIME_ARTIFACT_LAYER_BYTES),
    chunkBytes: z.literal(RUNTIME_ARTIFACT_CHUNK_BYTES),
    chunks: z
      .array(runtimeArtifactSha256Schema)
      .max(Math.ceil(MAX_RUNTIME_ARTIFACT_LAYER_BYTES / RUNTIME_ARTIFACT_CHUNK_BYTES)),
    files: z.array(runtimeArtifactLayerFileSchema).max(MAX_RUNTIME_ARTIFACT_LAYER_FILES),
  })
  .strict()
  .superRefine((layer, context) => {
    const expectedChunks = Math.ceil(layer.payloadBytes / RUNTIME_ARTIFACT_CHUNK_BYTES);
    if (layer.chunks.length !== expectedChunks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks"],
        message: "Layer chunk count does not match payload size",
      });
    }
    if (
      layer.descriptor.contentBytes !== layer.payloadBytes ||
      layer.descriptor.fileCount !== layer.files.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["descriptor"],
        message: "Layer descriptor does not match its payload manifest",
      });
    }
    if (
      layer.descriptor.compression === "none" &&
      layer.descriptor.unpackedBytes !== layer.payloadBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["descriptor", "unpackedBytes"],
        message: "Uncompressed layer byte counts must match",
      });
    }
    let offset = 0;
    let previousPath: string | null = null;
    for (let index = 0; index < layer.files.length; index += 1) {
      const file = layer.files[index];
      if (file.offset !== offset) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "offset"],
          message: "Layer files must form one contiguous payload",
        });
      }
      if (previousPath !== null && compareUtf8(previousPath, file.path) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "Layer file paths must be unique and sorted by UTF-8 bytes",
        });
      }
      previousPath = file.path;
      offset += file.size;
    }
    if (offset !== layer.payloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadBytes"],
        message: "Layer file sizes do not match payload size",
      });
    }
  });

export const runtimeLayeredArtifactContentSchema = z
  .object({
    format: z.literal(RUNTIME_ARTIFACT_LAYERS_FORMAT),
    appArtifact: runtimeArtifactEnvelopeSchema,
    pantryRevision: pantryRevisionStateSchema.superRefine((revision, context) => {
      if (revision.state !== "committed") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message: "Layered artifacts require a committed Pantry revision",
        });
      }
    }),
    dependencyClosureSha256: pantrySha256Schema,
    buildAttestationSha256: pantrySha256Schema,
    toolchainImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    platform: pantryPlatformSchema,
    layers: z.array(runtimeArtifactLayerContentSchema).min(1).max(MAX_RUNTIME_ARTIFACT_LAYERS),
    finalMergedReleaseSha256: runtimeArtifactSha256Schema,
  })
  .strict()
  .superRefine((content, context) => {
    if (content.toolchainImageDigest !== content.platform.toolchainImageDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolchainImageDigest"],
        message: "Layered artifact toolchain digest does not match its platform",
      });
    }
    let totalBytes = content.appArtifact.content.payloadBytes;
    const layerHashes = new Set<string>();
    const releasePaths = new Set(content.appArtifact.content.files.map((file) => file.path));
    for (let index = 0; index < content.layers.length; index += 1) {
      const layer = content.layers[index];
      totalBytes += layer.payloadBytes;
      if (layerHashes.has(layer.descriptor.contentSha256)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", index, "descriptor", "contentSha256"],
          message: "Layer content addresses must be unique",
        });
      }
      layerHashes.add(layer.descriptor.contentSha256);
      if (canonicalJson(layer.descriptor.platform) !== canonicalJson(content.platform)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", index, "descriptor", "platform"],
          message: "Every layer must target the sealed platform tuple",
        });
      }
      for (let fileIndex = 0; fileIndex < layer.files.length; fileIndex += 1) {
        const path = `${layer.descriptor.mountPath}/${layer.files[fileIndex].path}`;
        if (validateRuntimeArtifactPath(path) === null || releasePaths.has(path)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["layers", index, "files", fileIndex, "path"],
            message: "Layer overlay paths must be valid and collision-free",
          });
        }
        releasePaths.add(path);
      }
    }
    if (totalBytes > MAX_RUNTIME_ARTIFACT_LAYERED_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layers"],
        message: "Layered artifact exceeds the aggregate byte limit",
      });
    }
  });

export const runtimeLayeredArtifactEnvelopeSchema = z
  .object({
    content: runtimeLayeredArtifactContentSchema,
    contentSha256: runtimeArtifactSha256Schema,
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    targetRuntimeIdentity: z.string().min(1).max(200),
    manifestRevision: z.string().min(1).max(200),
    artifactRevision: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    scan: z
      .object({ policyVersion: z.string().min(1).max(100), zeroMatches: z.literal(true) })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    try {
      parseRuntimeIdentity(envelope.targetRuntimeIdentity);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetRuntimeIdentity"],
        message: "Malformed target runtime identity",
      });
    }
    if (
      envelope.content.appArtifact.targetRuntimeIdentity !== envelope.targetRuntimeIdentity ||
      envelope.content.appArtifact.manifestRevision !== envelope.manifestRevision ||
      envelope.content.appArtifact.sourceRevision !== envelope.sourceRevision
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content", "appArtifact"],
        message: "App artifact binding must match the layered envelope",
      });
    }
  });

export const beginRuntimeLayeredArtifactRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: z.string().min(1).max(200),
    envelope: runtimeLayeredArtifactEnvelopeSchema,
  })
  .strict();

export const beginRuntimeLayeredArtifactResponseSchema = z
  .object({
    ok: z.literal(true),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    appChunksExpected: z.number().int().nonnegative(),
    layersExpected: z.number().int().positive(),
    layerContentSha256ToUpload: z.array(runtimeArtifactSha256Schema),
  })
  .strict();

export const uploadRuntimeLayeredArtifactChunkResponseSchema = z
  .object({
    ok: z.literal(true),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    contentSha256: runtimeArtifactSha256Schema,
    chunkIndex: z.number().int().nonnegative(),
  })
  .strict();

export const commitRuntimeLayeredArtifactRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: z.string().min(1).max(200),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
  })
  .strict();

export const commitRuntimeLayeredArtifactResponseSchema = z
  .object({
    ok: z.literal(true),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    contentSha256: runtimeArtifactSha256Schema,
    filesWritten: z.number().int().nonnegative(),
    layersMaterialized: z.number().int().nonnegative(),
    materialized: z.boolean(),
  })
  .strict();

export const removeRuntimeLayeredArtifactRequestSchema = z
  .object({ locator: runtimeLocatorSchema, sealedArtifactSha256: runtimeArtifactSha256Schema })
  .strict();

export const removeRuntimeLayeredArtifactResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export async function runtimeArtifactLayerUnpackedManifestHash(
  files: ReadonlyArray<z.infer<typeof runtimeArtifactLayerFileSchema>>,
): Promise<string> {
  return sha256Hex(canonicalJson({ files }));
}

export async function runtimeLayeredArtifactMergedReleaseHash(
  content: Pick<RuntimeLayeredArtifactContent, "appArtifact" | "layers">,
): Promise<string> {
  const files = [
    ...content.appArtifact.content.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      size: file.size,
      sha256: file.sha256,
    })),
    ...content.layers.flatMap((layer) =>
      layer.files.map((file) => ({
        path: `${layer.descriptor.mountPath}/${file.path}`,
        mode: file.mode,
        size: file.size,
        sha256: file.sha256,
      })),
    ),
  ].sort((left, right) => compareUtf8(left.path, right.path));
  return sha256Hex(canonicalJson({ files }));
}

export async function runtimeLayeredArtifactContentHash(
  content: RuntimeLayeredArtifactContent,
): Promise<string> {
  return sha256Hex(canonicalJson(runtimeLayeredArtifactContentSchema.parse(content)));
}

export async function runtimeLayeredArtifactSealedHash(
  envelope: Omit<RuntimeLayeredArtifactEnvelope, "sealedArtifactSha256">,
): Promise<string> {
  return sha256Hex(canonicalJson(envelope));
}

export async function verifyRuntimeLayeredArtifactEnvelope(
  envelope: RuntimeLayeredArtifactEnvelope,
): Promise<boolean> {
  const parsed = runtimeLayeredArtifactEnvelopeSchema.parse(envelope);
  if (!(await verifyRuntimeArtifactEnvelope(parsed.content.appArtifact))) return false;
  for (const layer of parsed.content.layers) {
    if (
      (await runtimeArtifactLayerUnpackedManifestHash(layer.files)) !==
      layer.descriptor.unpackedManifestSha256
    ) {
      return false;
    }
  }
  if (
    (await runtimeLayeredArtifactMergedReleaseHash(parsed.content)) !==
    parsed.content.finalMergedReleaseSha256
  ) {
    return false;
  }
  if ((await runtimeLayeredArtifactContentHash(parsed.content)) !== parsed.contentSha256)
    return false;
  const { sealedArtifactSha256: _sealed, ...unsigned } = parsed;
  return (await runtimeLayeredArtifactSealedHash(unsigned)) === parsed.sealedArtifactSha256;
}

export type RuntimeArtifactLayerFile = z.infer<typeof runtimeArtifactLayerFileSchema>;
export type RuntimeArtifactLayerContent = z.infer<typeof runtimeArtifactLayerContentSchema>;
export type RuntimeLayeredArtifactContent = z.infer<typeof runtimeLayeredArtifactContentSchema>;
export type RuntimeLayeredArtifactEnvelope = z.infer<typeof runtimeLayeredArtifactEnvelopeSchema>;
export type BeginRuntimeLayeredArtifactRequest = z.infer<
  typeof beginRuntimeLayeredArtifactRequestSchema
>;
export type CommitRuntimeLayeredArtifactRequest = z.infer<
  typeof commitRuntimeLayeredArtifactRequestSchema
>;
export type RemoveRuntimeLayeredArtifactRequest = z.infer<
  typeof removeRuntimeLayeredArtifactRequestSchema
>;
