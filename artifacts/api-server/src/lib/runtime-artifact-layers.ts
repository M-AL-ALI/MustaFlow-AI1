import {
  MAX_RUNTIME_ARTIFACT_LAYER_BYTES,
  MAX_RUNTIME_ARTIFACT_LAYER_FILE_BYTES,
  MAX_RUNTIME_ARTIFACT_LAYER_FILES,
  PANTRY_LAYER_FORMAT,
  PANTRY_SCHEMA_VERSION,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_LAYERS_FORMAT,
  compareUtf8,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfMatchesStamp,
  pantryCatalogShelfRecordSchema,
  pantryPlatformSchema,
  pantryShelfContentHashesHash,
  pantryShelfContentHashesResponseSchema,
  sha256Hex,
  runtimeArtifactLayerContentSchema,
  runtimeArtifactLayerUnpackedManifestHash,
  runtimeLayeredArtifactContentHash,
  runtimeLayeredArtifactContentSchema,
  runtimeLayeredArtifactEnvelopeSchema,
  runtimeLayeredArtifactMergedReleaseHash,
  runtimeLayeredArtifactSealedHash,
  verifyPantryDigestSignature,
  verifyPantryRevisionRecord,
  validateRuntimeArtifactPath,
  type PantryCatalogShelfRecord,
  type PantryCatalogShelfStamp,
  type PantryShelfContentHashesResponse,
  type PantryPlatform,
  type PantryRevisionState,
  type RuntimeArtifactLayerContent,
  type RuntimeLayeredArtifactEnvelope,
} from "@workspace/tenant-runtime-contracts";
import type { RuntimeArtifactSourceFile, SealedRuntimeArtifact } from "./runtime-artifact";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

const FORBIDDEN_LAYER_PATHS = [
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

export interface SealedRuntimeArtifactLayer {
  content: RuntimeArtifactLayerContent;
  chunks: Uint8Array[];
  scanSummary: {
    policyVersion: "nabu-secret-scan/v1";
    scannedFiles: number;
    shelfExemptFiles: number;
  };
}

export interface SealedLayeredRuntimeArtifact {
  envelope: RuntimeLayeredArtifactEnvelope;
  appChunks: Uint8Array[];
  layers: SealedRuntimeArtifactLayer[];
}

export class RuntimeArtifactLayerSealError extends Error {
  constructor(
    readonly code:
      | "artifact_invalid_path"
      | "artifact_duplicate_path"
      | "artifact_too_large"
      | "artifact_secret_detected"
      | "artifact_invalid_provenance",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeArtifactLayerSealError";
  }
}

export interface TrustedPantryLayerSealProvenance {
  readonly pantryRevisionRootSha256: string;
}

const trustedPantryContentHashes = new WeakMap<
  TrustedPantryLayerSealProvenance,
  ReadonlySet<string>
>();

function invalidProvenance(): RuntimeArtifactLayerSealError {
  return new RuntimeArtifactLayerSealError(
    "artifact_invalid_provenance",
    "Layer provenance did not verify",
  );
}

export async function resolveTrustedPantryLayerSealProvenance(input: {
  shelf: PantryCatalogShelfRecord;
  expectedShelf: PantryCatalogShelfStamp;
  attestation: PantryShelfContentHashesResponse;
  publicKeys: ReadonlyMap<string, string>;
}): Promise<TrustedPantryLayerSealProvenance> {
  const parsedShelf = pantryCatalogShelfRecordSchema.safeParse(input.shelf);
  const parsedAttestation = pantryShelfContentHashesResponseSchema.safeParse(input.attestation);
  if (
    !parsedShelf.success ||
    !parsedAttestation.success ||
    !pantryCatalogShelfMatchesStamp(parsedShelf.data, input.expectedShelf)
  ) {
    throw invalidProvenance();
  }
  const { manifestSha256, ...manifest } = parsedShelf.data;
  if (
    (await pantryCatalogShelfManifestHash(manifest)) !== manifestSha256 ||
    !(await verifyPantryRevisionRecord(parsedShelf.data.revision, input.publicKeys)).ok ||
    parsedAttestation.data.statement.pantryRevisionId !==
      parsedShelf.data.revision.content.revisionId ||
    parsedAttestation.data.statement.pantryRevisionRootSha256 !==
      parsedShelf.data.revision.rootSha256 ||
    parsedAttestation.data.statement.shelfManifestSha256 !== manifestSha256 ||
    (await pantryShelfContentHashesHash(parsedAttestation.data.statement)) !==
      parsedAttestation.data.statementSha256 ||
    !(await verifyPantryDigestSignature(input.publicKeys, parsedAttestation.data.signature)).ok
  ) {
    throw invalidProvenance();
  }
  const provenance = Object.freeze({
    pantryRevisionRootSha256: parsedShelf.data.revision.rootSha256,
  });
  trustedPantryContentHashes.set(
    provenance,
    new Set(parsedAttestation.data.statement.contentHashes),
  );
  return provenance;
}

export async function sealRuntimeArtifactLayer(input: {
  mountPath: string;
  platform: PantryPlatform;
  files: RuntimeArtifactSourceFile[];
  provenance?: TrustedPantryLayerSealProvenance;
}): Promise<SealedRuntimeArtifactLayer> {
  if (validateRuntimeArtifactPath(input.mountPath) === null) {
    throw new RuntimeArtifactLayerSealError("artifact_invalid_path", "Layer mount path is invalid");
  }
  if (input.files.length > MAX_RUNTIME_ARTIFACT_LAYER_FILES) {
    throw new RuntimeArtifactLayerSealError("artifact_too_large", "Layer contains too many files");
  }
  const platform = pantryPlatformSchema.parse(input.platform);
  const publicContentHashes =
    input.provenance === undefined ? null : trustedPantryContentHashes.get(input.provenance);
  if (input.provenance !== undefined && publicContentHashes === undefined)
    throw invalidProvenance();
  let scannedFiles = 0;
  let shelfExemptFiles = 0;
  const normalized = (
    await Promise.all(
      input.files.map(async (file) => {
        if (
          validateRuntimeArtifactPath(file.path) === null ||
          FORBIDDEN_LAYER_PATHS.some((pattern) => pattern.test(file.path))
        ) {
          throw new RuntimeArtifactLayerSealError(
            "artifact_invalid_path",
            "Layer contains an invalid or forbidden path",
          );
        }
        const bytes =
          typeof file.content === "string" ? encoder.encode(file.content) : file.content;
        if (bytes.byteLength > MAX_RUNTIME_ARTIFACT_LAYER_FILE_BYTES) {
          throw new RuntimeArtifactLayerSealError("artifact_too_large", "Layer file is too large");
        }
        const publicContent = publicContentHashes?.has(await sha256Hex(bytes)) === true;
        if (publicContent) shelfExemptFiles += 1;
        else scannedFiles += 1;
        if (!publicContent && containsSecret(bytes)) {
          throw new RuntimeArtifactLayerSealError(
            "artifact_secret_detected",
            "Layer secret scan did not pass",
          );
        }
        return {
          path: file.path,
          bytes: new Uint8Array(bytes),
          mode: file.executable ? (0o755 as const) : (0o644 as const),
        };
      }),
    )
  ).sort((left, right) => compareUtf8(left.path, right.path));

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new RuntimeArtifactLayerSealError(
        "artifact_duplicate_path",
        "Layer contains duplicate normalized paths",
      );
    }
  }
  const payloadBytes = normalized.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (payloadBytes > MAX_RUNTIME_ARTIFACT_LAYER_BYTES) {
    throw new RuntimeArtifactLayerSealError("artifact_too_large", "Layer payload is too large");
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
      mode: file.mode,
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
  const content = runtimeArtifactLayerContentSchema.parse({
    descriptor: {
      format: PANTRY_LAYER_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      contentSha256: await sha256Hex(payload),
      unpackedManifestSha256: await runtimeArtifactLayerUnpackedManifestHash(files),
      compression: "none",
      contentBytes: payloadBytes,
      unpackedBytes: payloadBytes,
      fileCount: files.length,
      mountPath: input.mountPath,
      platform,
    },
    payloadBytes,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: chunkHashes,
    files,
  });
  return {
    content,
    chunks,
    scanSummary: {
      policyVersion: "nabu-secret-scan/v1",
      scannedFiles,
      shelfExemptFiles,
    },
  };
}

export async function sealLayeredRuntimeArtifact(input: {
  app: SealedRuntimeArtifact;
  layers: SealedRuntimeArtifactLayer[];
  pantryRevision: PantryRevisionState;
  dependencyClosureSha256: string;
  buildAttestationSha256: string;
  platform: PantryPlatform;
  artifactRevision: string;
  scanPolicyVersion?: string;
}): Promise<SealedLayeredRuntimeArtifact> {
  const app = structuredClone(input.app.envelope);
  const platform = pantryPlatformSchema.parse(input.platform);
  const contentWithoutMergedHash = {
    format: RUNTIME_ARTIFACT_LAYERS_FORMAT,
    appArtifact: app,
    pantryRevision: input.pantryRevision,
    dependencyClosureSha256: input.dependencyClosureSha256,
    buildAttestationSha256: input.buildAttestationSha256,
    toolchainImageDigest: platform.toolchainImageDigest,
    platform,
    layers: input.layers.map((layer) => structuredClone(layer.content)),
  };
  const content = runtimeLayeredArtifactContentSchema.parse({
    ...contentWithoutMergedHash,
    finalMergedReleaseSha256: await runtimeLayeredArtifactMergedReleaseHash({
      appArtifact: app,
      layers: contentWithoutMergedHash.layers,
    }),
  });
  const contentSha256 = await runtimeLayeredArtifactContentHash(content);
  const unsigned = {
    content,
    contentSha256,
    targetRuntimeIdentity: app.targetRuntimeIdentity,
    manifestRevision: app.manifestRevision,
    artifactRevision: input.artifactRevision,
    sourceRevision: app.sourceRevision,
    scan: {
      policyVersion: input.scanPolicyVersion ?? "nabu-secret-scan/v1",
      zeroMatches: true as const,
    },
  };
  const envelope = runtimeLayeredArtifactEnvelopeSchema.parse({
    ...unsigned,
    sealedArtifactSha256: await runtimeLayeredArtifactSealedHash(unsigned),
  });
  return {
    envelope,
    appChunks: input.app.chunks.map((chunk) => chunk.slice()),
    layers: input.layers.map((layer) => ({
      content: structuredClone(layer.content),
      chunks: layer.chunks.map((chunk) => chunk.slice()),
      scanSummary: structuredClone(layer.scanSummary),
    })),
  };
}

function containsSecret(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const text = decoder.decode(bytes);
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
