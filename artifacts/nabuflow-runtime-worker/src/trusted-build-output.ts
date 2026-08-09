import {
  PANTRY_BUILD_ATTESTATION_FORMAT,
  PANTRY_CATALOG_STAMP_FORMAT,
  PANTRY_LAYER_FORMAT,
  PANTRY_SCHEMA_VERSION,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_FORMAT,
  canonicalPantryJson,
  compareUtf8,
  pantryBuildAttestationHash,
  pantryBuildAttestationSchema,
  pantryBuildInputHash,
  pantryCatalogShelfStampSchema,
  pantryLayerDescriptorHash,
  pantryScannerPolicySchema,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactLayerContentSchema,
  runtimeArtifactLayerUnpackedManifestHash,
  sha256Hex,
  signPantryDigest,
  trustedBuildOutputHash,
  trustedBuildOutputSchema,
  type PantryCatalogShelfRecord,
  type TrustedBuildOutput,
} from "@workspace/tenant-runtime-contracts";
import type {
  TrustedBuildCellCollection,
  TrustedBuildCellOutputChunk,
  TrustedBuildCellResult,
  TrustedBuildRequestMetadata,
} from "./trusted-build-model";

const MAX_APP_FILES = 5_000;
const MAX_APP_BYTES = 64 * 1024 * 1024;
const MAX_LAYER_FILES = 20_000;
const MAX_LAYER_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_PATHS = [
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u,
  /(?:^|\/)credentials(?:\.|$)/u,
] as const;

export class TrustedBuildOutputError extends Error {
  constructor(
    readonly code: "build_failed" | "build_resource_limit" | "attestation_invalid",
    message: string,
  ) {
    super(message);
    this.name = "TrustedBuildOutputError";
  }
}

function validateCollection(
  collection: TrustedBuildCellCollection,
  limits: { maxFiles: number; maxBytes: number },
): void {
  if (collection.files.length === 0) {
    throw new TrustedBuildOutputError("build_failed", "Build output is empty");
  }
  if (collection.files.length > limits.maxFiles || collection.payloadBytes > limits.maxBytes) {
    throw new TrustedBuildOutputError("build_resource_limit", "Build output exceeded its limit");
  }
  if (collection.files.some((file) => FORBIDDEN_PATHS.some((pattern) => pattern.test(file.path)))) {
    throw new TrustedBuildOutputError("build_failed", "Build output contains an invalid path");
  }
}

export interface PreparedTrustedBuildOutput {
  output: TrustedBuildOutput;
  appChunks: TrustedBuildCellOutputChunk[];
  layerChunks: Array<{ contentSha256: string; chunks: TrustedBuildCellOutputChunk[] }>;
}

export async function prepareTrustedBuildOutput(input: {
  request: TrustedBuildRequestMetadata;
  shelf: PantryCatalogShelfRecord;
  first: TrustedBuildCellResult;
  second: TrustedBuildCellResult;
  signer: { kid: string; privateKeyPem: string };
  coldBuild: boolean;
  upstreamRequests: number;
  pantryObjectReads: number;
  completedAt: string;
}): Promise<PreparedTrustedBuildOutput> {
  validateCollection(input.first.app, { maxFiles: MAX_APP_FILES, maxBytes: MAX_APP_BYTES });
  validateCollection(input.second.app, { maxFiles: MAX_APP_FILES, maxBytes: MAX_APP_BYTES });
  validateCollection(input.first.dependencies, {
    maxFiles: MAX_LAYER_FILES,
    maxBytes: MAX_LAYER_BYTES,
  });
  validateCollection(input.second.dependencies, {
    maxFiles: MAX_LAYER_FILES,
    maxBytes: MAX_LAYER_BYTES,
  });
  if (
    input.first.app.determinismManifestSha256 !== input.second.app.determinismManifestSha256 ||
    input.first.dependencies.determinismManifestSha256 !==
      input.second.dependencies.determinismManifestSha256
  ) {
    throw new TrustedBuildOutputError(
      "attestation_invalid",
      "The offline reproducibility check did not match",
    );
  }

  const appContent = runtimeArtifactContentManifestSchema.parse({
    format: RUNTIME_ARTIFACT_FORMAT,
    payloadBytes: input.second.app.payloadBytes,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: input.second.app.outputChunks.map((chunk) => chunk.sha256),
    files: input.second.app.files,
  });
  const descriptor = {
    format: PANTRY_LAYER_FORMAT,
    schemaVersion: PANTRY_SCHEMA_VERSION,
    contentSha256: input.second.dependencies.payloadSha256,
    unpackedManifestSha256: await runtimeArtifactLayerUnpackedManifestHash(
      input.second.dependencies.files,
    ),
    compression: "none" as const,
    contentBytes: input.second.dependencies.payloadBytes,
    unpackedBytes: input.second.dependencies.payloadBytes,
    fileCount: input.second.dependencies.files.length,
    mountPath: input.request.output.dependencyLayerMountPath,
    platform: input.request.input.platform,
  };
  const layerContent = runtimeArtifactLayerContentSchema.parse({
    descriptor,
    payloadBytes: input.second.dependencies.payloadBytes,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: input.second.dependencies.outputChunks.map((chunk) => chunk.sha256),
    files: input.second.dependencies.files,
  });
  const shelfStamp = pantryCatalogShelfStampSchema.parse({
    format: PANTRY_CATALOG_STAMP_FORMAT,
    schemaVersion: 1,
    pantryRevisionId: input.shelf.revision.content.revisionId,
    pantryRevisionRootSha256: input.shelf.revision.rootSha256,
    dependencyClosureSha256: input.shelf.revision.content.dependencyClosureSha256,
    lockfileSha256: input.shelf.lockfileSha256,
    sbomSha256: input.shelf.sbomSha256,
    toolchainImageDigest: input.shelf.revision.content.closure.platform.toolchainImageDigest,
    toolchainAttestationSha256: input.shelf.toolchainAttestationSha256,
  });
  const scannerPolicy = pantryScannerPolicySchema.parse({
    policyVersion: "nabu-trusted-build-scan/v1",
    secretScan: "passed",
    malwareScan: "passed",
    vulnerabilityScan: input.shelf.revision.content.scannerPolicy.vulnerabilityScan,
    licenseScan: input.shelf.revision.content.scannerPolicy.licenseScan,
  });
  const includeLayer = input.request.output.dependencyPackaging === "layer";
  const layerDescriptorSha256 = includeLayer
    ? [await pantryLayerDescriptorHash(descriptor)].sort(compareUtf8)
    : [];
  const artifactDescriptorSha256 = await sha256Hex(
    canonicalPantryJson({ app: appContent, layers: includeLayer ? [layerContent] : [] }),
  );
  const statement = {
    format: PANTRY_BUILD_ATTESTATION_FORMAT,
    schemaVersion: 1 as const,
    buildId: input.request.input.buildId,
    buildInputSha256: await pantryBuildInputHash(input.request.input),
    pantryRevisionId: shelfStamp.pantryRevisionId,
    pantryRevisionRootSha256: shelfStamp.pantryRevisionRootSha256,
    dependencyClosureSha256: shelfStamp.dependencyClosureSha256,
    lockfileSha256: shelfStamp.lockfileSha256,
    outputArtifactSha256: artifactDescriptorSha256,
    layerDescriptorSha256,
    sbomSha256: shelfStamp.sbomSha256,
    platform: input.request.input.platform,
    scannerPolicy,
    provenanceStatus:
      input.shelf.revision.content.provenanceStatus === "rejected"
        ? ("unavailable" as const)
        : input.shelf.revision.content.provenanceStatus,
    reproducibleOffline: true as const,
    issuedAt: input.completedAt,
  };
  const statementSha256 = await pantryBuildAttestationHash(statement);
  const buildAttestation = pantryBuildAttestationSchema.parse({
    statement,
    statementSha256,
    signature: await signPantryDigest(input.signer.privateKeyPem, {
      kind: "build-attestation",
      kid: input.signer.kid,
      payloadSha256: statementSha256,
    }),
  });
  const appChunkDescriptors = input.second.app.outputChunks.map(({ index, sha256, bytes }) => ({
    index,
    sha256,
    bytes,
  }));
  const dependencyChunkDescriptors = input.second.dependencies.outputChunks.map(
    ({ index, sha256, bytes }) => ({ index, sha256, bytes }),
  );
  const outputWithoutHash = {
    format: "nabu-trusted-build-output/v1" as const,
    schemaVersion: 1 as const,
    buildId: input.request.input.buildId,
    requestSha256: input.request.requestId.slice("pbuildreq_".length),
    pantryShelf: shelfStamp,
    app: { content: appContent, chunks: appChunkDescriptors },
    layers: includeLayer ? [{ content: layerContent, chunks: dependencyChunkDescriptors }] : [],
    buildAttestation,
    coldBuild: input.coldBuild,
    upstreamRequests: input.upstreamRequests,
    pantryObjectReads: input.pantryObjectReads,
    completedAt: input.completedAt,
  };
  const output = trustedBuildOutputSchema.parse({
    ...outputWithoutHash,
    outputSha256: await trustedBuildOutputHash(
      outputWithoutHash as Omit<TrustedBuildOutput, "outputSha256">,
    ),
  });
  return {
    output,
    appChunks: input.second.app.outputChunks,
    layerChunks: includeLayer
      ? [
          {
            contentSha256: descriptor.contentSha256,
            chunks: input.second.dependencies.outputChunks,
          },
        ]
      : [],
  };
}
