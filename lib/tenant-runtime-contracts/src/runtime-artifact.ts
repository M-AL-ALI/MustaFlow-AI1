import { z } from "zod";
import { runtimeManifestContractSchema, runtimeLocatorSchema } from "./control-schemas";
import { parseRuntimeIdentity } from "./runtime-identity";
import { sha256Hex } from "./request-signing";

export const RUNTIME_ARTIFACT_FORMAT = "nabu-artifact/v1" as const;
export const RUNTIME_ARTIFACT_CHUNK_BYTES = 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_FILES = 5_000;
export const MAX_RUNTIME_ARTIFACT_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_PATH_BYTES = 1_000;
export const RUNTIME_ARTIFACT_PENDING_TTL_MS = 10 * 60 * 1_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export const runtimeArtifactSha256Schema = z.string().regex(SHA256_PATTERN);

export function validateRuntimeArtifactPath(path: string): string | null {
  const normalized = path.normalize("NFC");
  if (normalized !== path || encoder.encode(path).byteLength > MAX_RUNTIME_ARTIFACT_PATH_BYTES)
    return null;
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    hasControlCharacter(path) ||
    /^[A-Za-z]:/u.test(path)
  )
    return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return null;
  if (segments[0] === ".nabuflow") return null;
  return path;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const runtimeArtifactPathSchema = z
  .string()
  .refine((path) => validateRuntimeArtifactPath(path) !== null, "Invalid artifact path");

export const runtimeArtifactFileSchema = z
  .object({
    path: runtimeArtifactPathSchema,
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
    offset: z.number().int().nonnegative().max(MAX_RUNTIME_ARTIFACT_BYTES),
    size: z.number().int().nonnegative().max(MAX_RUNTIME_ARTIFACT_FILE_BYTES),
    sha256: runtimeArtifactSha256Schema,
  })
  .strict();

export const runtimeArtifactContentManifestSchema = z
  .object({
    format: z.literal(RUNTIME_ARTIFACT_FORMAT),
    payloadBytes: z.number().int().nonnegative().max(MAX_RUNTIME_ARTIFACT_BYTES),
    chunkBytes: z.literal(RUNTIME_ARTIFACT_CHUNK_BYTES),
    chunks: z
      .array(runtimeArtifactSha256Schema)
      .max(Math.ceil(MAX_RUNTIME_ARTIFACT_BYTES / RUNTIME_ARTIFACT_CHUNK_BYTES)),
    files: z.array(runtimeArtifactFileSchema).max(MAX_RUNTIME_ARTIFACT_FILES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedChunks = Math.ceil(manifest.payloadBytes / RUNTIME_ARTIFACT_CHUNK_BYTES);
    if (manifest.chunks.length !== expectedChunks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks"],
        message: "Artifact chunk count does not match payload size",
      });
    }
    let offset = 0;
    let previousPath: string | null = null;
    for (let index = 0; index < manifest.files.length; index += 1) {
      const file = manifest.files[index];
      if (file.offset !== offset) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "offset"],
          message: "Artifact files must form one contiguous payload",
        });
      }
      if (previousPath !== null && compareUtf8(previousPath, file.path) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "path"],
          message: "Artifact paths must be unique and sorted by UTF-8 bytes",
        });
      }
      previousPath = file.path;
      offset += file.size;
    }
    if (offset !== manifest.payloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadBytes"],
        message: "Artifact file sizes do not match payload size",
      });
    }
  });

export const runtimeArtifactScanAttestationSchema = z
  .object({
    policyVersion: z.string().min(1).max(100),
    zeroMatches: z.literal(true),
  })
  .strict();

export const runtimeArtifactEnvelopeSchema = z
  .object({
    content: runtimeArtifactContentManifestSchema,
    contentSha256: runtimeArtifactSha256Schema,
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    targetRuntimeIdentity: z.string().min(1).max(200),
    manifestRevision: z.string().min(1).max(200),
    artifactRevision: z.string().min(1).max(200),
    sourceRevision: z.string().min(1).max(200),
    scan: runtimeArtifactScanAttestationSchema,
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
  });

export const beginRuntimeArtifactRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: z.string().min(1).max(200),
    envelope: runtimeArtifactEnvelopeSchema,
  })
  .strict();

export const beginRuntimeArtifactResponseSchema = z
  .object({
    ok: z.literal(true),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    chunksExpected: z.number().int().nonnegative(),
  })
  .strict();

export const uploadRuntimeArtifactChunkResponseSchema = z
  .object({
    ok: z.literal(true),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    chunkIndex: z.number().int().nonnegative(),
  })
  .strict();

export const commitRuntimeArtifactRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: z.string().min(1).max(200),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
  })
  .strict();

export const commitRuntimeArtifactResponseSchema = z
  .object({
    ok: z.literal(true),
    sealedArtifactSha256: runtimeArtifactSha256Schema,
    contentSha256: runtimeArtifactSha256Schema,
    filesWritten: z.number().int().nonnegative(),
    materialized: z.boolean(),
  })
  .strict();

export const removeRuntimeArtifactRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    sealedArtifactSha256: runtimeArtifactSha256Schema,
  })
  .strict();

export const removeRuntimeArtifactResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const updateRuntimeManifestRequestSchema = z
  .object({
    locator: runtimeLocatorSchema,
    expectedDeploymentVersion: z.string().min(1).max(200),
    expectedManifestRevision: z.string().min(1).max(200),
    manifest: runtimeManifestContractSchema,
    restart: z.enum(["reject-if-running", "restart"]).default("reject-if-running"),
    sealedArtifactSha256: runtimeArtifactSha256Schema.optional(),
  })
  .strict();

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical JSON received an unsupported value");
}

export async function runtimeArtifactContentHash(
  content: z.infer<typeof runtimeArtifactContentManifestSchema>,
): Promise<string> {
  return sha256Hex(canonicalJson(runtimeArtifactContentManifestSchema.parse(content)));
}

export async function runtimeArtifactSealedHash(
  envelope: Omit<z.infer<typeof runtimeArtifactEnvelopeSchema>, "sealedArtifactSha256">,
): Promise<string> {
  return sha256Hex(canonicalJson(envelope));
}

export async function verifyRuntimeArtifactEnvelope(
  envelope: z.infer<typeof runtimeArtifactEnvelopeSchema>,
): Promise<boolean> {
  const parsed = runtimeArtifactEnvelopeSchema.parse(envelope);
  const contentSha256 = await runtimeArtifactContentHash(parsed.content);
  if (contentSha256 !== parsed.contentSha256) return false;
  const { sealedArtifactSha256: _sealed, ...unsigned } = parsed;
  return (await runtimeArtifactSealedHash(unsigned)) === parsed.sealedArtifactSha256;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

export type RuntimeArtifactContentManifest = z.infer<typeof runtimeArtifactContentManifestSchema>;
export type RuntimeArtifactEnvelope = z.infer<typeof runtimeArtifactEnvelopeSchema>;
export type BeginRuntimeArtifactRequest = z.infer<typeof beginRuntimeArtifactRequestSchema>;
export type CommitRuntimeArtifactRequest = z.infer<typeof commitRuntimeArtifactRequestSchema>;
export type RemoveRuntimeArtifactRequest = z.infer<typeof removeRuntimeArtifactRequestSchema>;
export type UpdateRuntimeManifestRequest = z.infer<typeof updateRuntimeManifestRequestSchema>;
