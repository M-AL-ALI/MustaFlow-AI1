import {
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_ARTIFACT_FILE_BYTES,
  MAX_RUNTIME_ARTIFACT_FILES,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_FORMAT,
  compareUtf8,
  runtimeArtifactContentHash,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactEnvelopeSchema,
  runtimeArtifactSealedHash,
  sha256Hex,
  validateRuntimeArtifactPath,
  type RuntimeArtifactEnvelope,
} from "@workspace/tenant-runtime-contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

const FORBIDDEN_ARTIFACT_PATHS = [
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u,
  /(?:^|\/)credentials(?:\.|$)/u,
] as const;

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/u,
  /\b(?:postgres|postgresql):\/\/[^\s:@/]+:[^\s@/]+@/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
] as const;

export interface RuntimeArtifactSourceFile {
  path: string;
  content: string | Uint8Array;
  executable?: boolean;
}

export interface SealedRuntimeArtifact {
  envelope: RuntimeArtifactEnvelope;
  chunks: Uint8Array[];
}

export class RuntimeArtifactSealError extends Error {
  constructor(
    readonly code:
      | "artifact_invalid_path"
      | "artifact_duplicate_path"
      | "artifact_too_large"
      | "artifact_secret_detected",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeArtifactSealError";
  }
}

export async function sealRuntimeArtifact(input: {
  targetRuntimeIdentity: string;
  manifestRevision: string;
  artifactRevision: string;
  sourceRevision: string;
  files: RuntimeArtifactSourceFile[];
  scanPolicyVersion?: string;
}): Promise<SealedRuntimeArtifact> {
  if (input.files.length > MAX_RUNTIME_ARTIFACT_FILES) {
    throw new RuntimeArtifactSealError("artifact_too_large", "Artifact contains too many files");
  }

  const normalized = input.files
    .map((file) => {
      if (
        validateRuntimeArtifactPath(file.path) === null ||
        FORBIDDEN_ARTIFACT_PATHS.some((pattern) => pattern.test(file.path))
      ) {
        throw new RuntimeArtifactSealError(
          "artifact_invalid_path",
          "Artifact contains an invalid or forbidden path",
        );
      }
      const bytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
      if (bytes.byteLength > MAX_RUNTIME_ARTIFACT_FILE_BYTES) {
        throw new RuntimeArtifactSealError("artifact_too_large", "Artifact file is too large");
      }
      if (containsSecret(bytes)) {
        throw new RuntimeArtifactSealError(
          "artifact_secret_detected",
          "Artifact secret scan did not pass",
        );
      }
      return {
        path: file.path,
        bytes: new Uint8Array(bytes),
        mode: file.executable ? 0o755 : 0o644,
      };
    })
    .sort((left, right) => compareUtf8(left.path, right.path));

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new RuntimeArtifactSealError(
        "artifact_duplicate_path",
        "Artifact contains duplicate normalized paths",
      );
    }
  }

  const payloadBytes = normalized.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (payloadBytes > MAX_RUNTIME_ARTIFACT_BYTES) {
    throw new RuntimeArtifactSealError("artifact_too_large", "Artifact payload is too large");
  }

  const payload = new Uint8Array(payloadBytes);
  const files: Array<{
    path: string;
    mode: 420 | 493;
    offset: number;
    size: number;
    sha256: string;
  }> = [];
  let offset = 0;
  for (const file of normalized) {
    payload.set(file.bytes, offset);
    files.push({
      path: file.path,
      mode: file.mode as 420 | 493,
      offset,
      size: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes),
    });
    offset += file.bytes.byteLength;
  }

  const chunks: Uint8Array[] = [];
  const chunkHashes: string[] = [];
  for (let start = 0; start < payload.byteLength; start += RUNTIME_ARTIFACT_CHUNK_BYTES) {
    const chunk = payload.slice(start, start + RUNTIME_ARTIFACT_CHUNK_BYTES);
    chunks.push(chunk);
    chunkHashes.push(await sha256Hex(chunk));
  }

  const content = runtimeArtifactContentManifestSchema.parse({
    format: RUNTIME_ARTIFACT_FORMAT,
    payloadBytes,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: chunkHashes,
    files,
  });
  const contentSha256 = await runtimeArtifactContentHash(content);
  const unsigned = {
    content,
    contentSha256,
    targetRuntimeIdentity: input.targetRuntimeIdentity,
    manifestRevision: input.manifestRevision,
    artifactRevision: input.artifactRevision,
    sourceRevision: input.sourceRevision,
    scan: {
      policyVersion: input.scanPolicyVersion ?? "nabu-secret-scan/v1",
      zeroMatches: true as const,
    },
  };
  const envelope = runtimeArtifactEnvelopeSchema.parse({
    ...unsigned,
    sealedArtifactSha256: await runtimeArtifactSealedHash(unsigned),
  });
  return { envelope, chunks };
}

function containsSecret(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const text = decoder.decode(bytes);
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
