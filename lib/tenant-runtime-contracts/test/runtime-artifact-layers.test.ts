import { describe, expect, it } from "vitest";
import {
  PANTRY_LAYER_FORMAT,
  PANTRY_SCHEMA_VERSION,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_FORMAT,
  RUNTIME_ARTIFACT_LAYERS_FORMAT,
  deriveRuntimeIdentity,
  runtimeArtifactContentHash,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactLayerContentSchema,
  runtimeArtifactLayerUnpackedManifestHash,
  runtimeArtifactSealedHash,
  runtimeLayeredArtifactContentHash,
  runtimeLayeredArtifactContentSchema,
  runtimeLayeredArtifactEnvelopeSchema,
  runtimeLayeredArtifactMergedReleaseHash,
  runtimeLayeredArtifactSealedHash,
  sha256Hex,
  verifyRuntimeLayeredArtifactEnvelope,
  type PantryPlatform,
  type RuntimeLayeredArtifactEnvelope,
} from "../src/index";

const platform: PantryPlatform = {
  runtime: "node",
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux",
  cpu: "x64",
  libc: "glibc",
  toolchainImageDigest: `sha256:${"1".repeat(64)}`,
};

async function fixture(): Promise<RuntimeLayeredArtifactEnvelope> {
  const identity = await deriveRuntimeIdentity({
    namespace: "staging",
    projectId: 42,
    role: "preview",
    slot: "primary",
  });
  const appBytes = new TextEncoder().encode("import 'demo-dependency';\n");
  const appContent = runtimeArtifactContentManifestSchema.parse({
    format: RUNTIME_ARTIFACT_FORMAT,
    payloadBytes: appBytes.byteLength,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: [await sha256Hex(appBytes)],
    files: [
      {
        path: "server.mjs",
        mode: 0o755,
        offset: 0,
        size: appBytes.byteLength,
        sha256: await sha256Hex(appBytes),
      },
    ],
  });
  const appUnsigned = {
    content: appContent,
    contentSha256: await runtimeArtifactContentHash(appContent),
    targetRuntimeIdentity: identity,
    manifestRevision: "manifest-1",
    artifactRevision: "app-1",
    sourceRevision: "source-1",
    scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true as const },
  };
  const appArtifact = {
    ...appUnsigned,
    sealedArtifactSha256: await runtimeArtifactSealedHash(appUnsigned),
  };
  const layerBytes = new Uint8Array([0, 1, 2, 3, 255]);
  const files = [
    {
      path: "demo-dependency/index.node",
      mode: 0o755 as const,
      offset: 0,
      size: layerBytes.byteLength,
      sha256: await sha256Hex(layerBytes),
    },
  ];
  const layer = runtimeArtifactLayerContentSchema.parse({
    descriptor: {
      format: PANTRY_LAYER_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      contentSha256: await sha256Hex(layerBytes),
      unpackedManifestSha256: await runtimeArtifactLayerUnpackedManifestHash(files),
      compression: "none",
      contentBytes: layerBytes.byteLength,
      unpackedBytes: layerBytes.byteLength,
      fileCount: 1,
      mountPath: "node_modules",
      platform,
    },
    payloadBytes: layerBytes.byteLength,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: [await sha256Hex(layerBytes)],
    files,
  });
  const secondLayerBytes = new TextEncoder().encode("second-layer");
  const secondFiles = [
    {
      path: "second/index.js",
      mode: 0o644 as const,
      offset: 0,
      size: secondLayerBytes.byteLength,
      sha256: await sha256Hex(secondLayerBytes),
    },
  ];
  const secondLayer = runtimeArtifactLayerContentSchema.parse({
    descriptor: {
      format: PANTRY_LAYER_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      contentSha256: await sha256Hex(secondLayerBytes),
      unpackedManifestSha256: await runtimeArtifactLayerUnpackedManifestHash(secondFiles),
      compression: "none",
      contentBytes: secondLayerBytes.byteLength,
      unpackedBytes: secondLayerBytes.byteLength,
      fileCount: 1,
      mountPath: "vendor",
      platform,
    },
    payloadBytes: secondLayerBytes.byteLength,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: [await sha256Hex(secondLayerBytes)],
    files: secondFiles,
  });
  const partial = {
    format: RUNTIME_ARTIFACT_LAYERS_FORMAT,
    appArtifact,
    pantryRevision: {
      schemaVersion: 1,
      revisionId: "pantry-2026-08-08.1",
      rootSha256: "4".repeat(64),
      state: "committed" as const,
      stateRevision: 1,
      updatedAt: "2026-08-08T00:00:00.000Z",
    },
    dependencyClosureSha256: "2".repeat(64),
    buildAttestationSha256: "3".repeat(64),
    toolchainImageDigest: platform.toolchainImageDigest,
    platform,
    layers: [layer, secondLayer],
  };
  const content = runtimeLayeredArtifactContentSchema.parse({
    ...partial,
    finalMergedReleaseSha256: await runtimeLayeredArtifactMergedReleaseHash(partial),
  });
  const unsigned = {
    content,
    contentSha256: await runtimeLayeredArtifactContentHash(content),
    targetRuntimeIdentity: identity,
    manifestRevision: "manifest-1",
    artifactRevision: "layered-1",
    sourceRevision: "source-1",
    scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true as const },
  };
  return runtimeLayeredArtifactEnvelopeSchema.parse({
    ...unsigned,
    sealedArtifactSha256: await runtimeLayeredArtifactSealedHash(unsigned),
  });
}

describe("additive layered runtime artifacts", () => {
  it("verifies a platform-, manifest-, and target-bound envelope", async () => {
    const envelope = await fixture();
    expect(await verifyRuntimeLayeredArtifactEnvelope(envelope)).toBe(true);
    expect(envelope.content.appArtifact.content.format).toBe("nabu-artifact/v1");
    expect(envelope.content.format).toBe("nabu-artifact-layers/v1");
  });

  it.each([
    ["layer order", (value: RuntimeLayeredArtifactEnvelope) => value.content.layers.reverse()],
    [
      "attestation",
      (value: RuntimeLayeredArtifactEnvelope) =>
        (value.content.buildAttestationSha256 = "4".repeat(64)),
    ],
    [
      "target identity",
      (value: RuntimeLayeredArtifactEnvelope) => (value.targetRuntimeIdentity = "nrf-foreign"),
    ],
    [
      "manifest revision",
      (value: RuntimeLayeredArtifactEnvelope) => (value.manifestRevision = "manifest-foreign"),
    ],
  ])("rejects altered %s metadata", async (_label, mutate) => {
    const envelope = await fixture();
    mutate(envelope);
    const accepted = await verifyRuntimeLayeredArtifactEnvelope(envelope).catch(() => false);
    expect(accepted).toBe(false);
  });

  it("rejects overlay collisions before sealing", async () => {
    const envelope = await fixture();
    envelope.content.layers[1].descriptor.mountPath = "node_modules";
    envelope.content.layers[1].files[0].path = "demo-dependency/index.node";
    expect(runtimeLayeredArtifactContentSchema.safeParse(envelope.content).success).toBe(false);
  });

  it("rejects a layer whose unpacked file manifest was altered", async () => {
    const envelope = await fixture();
    envelope.content.layers[0].files[0].mode = 0o644;
    expect(await verifyRuntimeLayeredArtifactEnvelope(envelope)).toBe(false);
  });

  it("refuses a quarantined Pantry revision before an envelope can be accepted", async () => {
    const envelope = await fixture();
    envelope.content.pantryRevision.state = "quarantined";
    expect(runtimeLayeredArtifactEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});
