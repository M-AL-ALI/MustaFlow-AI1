import { describe, expect, it } from "vitest";
import {
  deriveRuntimeIdentity,
  verifyRuntimeLayeredArtifactEnvelope,
} from "@workspace/tenant-runtime-contracts";
import { sealRuntimeArtifact } from "./runtime-artifact";
import {
  RuntimeArtifactLayerSealError,
  sealLayeredRuntimeArtifact,
  sealRuntimeArtifactLayer,
} from "./runtime-artifact-layers";

const platform = {
  runtime: "node" as const,
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux" as const,
  cpu: "x64" as const,
  libc: "glibc" as const,
  toolchainImageDigest: `sha256:${"1".repeat(64)}`,
};

async function app(withCollision = false) {
  const identity = await deriveRuntimeIdentity({
    namespace: "staging",
    projectId: 42,
    role: "preview",
    slot: "primary",
  });
  return sealRuntimeArtifact({
    targetRuntimeIdentity: identity,
    manifestRevision: "manifest-1",
    artifactRevision: "app-1",
    sourceRevision: "source-1",
    files: [
      { path: "server.mjs", content: "console.log('layered')\n", executable: true },
      ...(withCollision
        ? [{ path: "node_modules/demo/index.js", content: "already present\n" }]
        : []),
    ],
  });
}

describe("layered artifact sealing", () => {
  it("seals binary and executable dependency files into a verified additive envelope", async () => {
    const application = await app();
    const layer = await sealRuntimeArtifactLayer({
      mountPath: "node_modules",
      platform,
      files: [
        { path: "demo/index.js", content: "export default 42;\n" },
        { path: "demo/native.node", content: new Uint8Array([0, 255, 1, 254]), executable: true },
      ],
    });
    const layered = await sealLayeredRuntimeArtifact({
      app: application,
      layers: [layer],
      pantryRevision: committedPantryRevision(),
      dependencyClosureSha256: "2".repeat(64),
      buildAttestationSha256: "3".repeat(64),
      platform,
      artifactRevision: "layered-1",
    });
    expect(await verifyRuntimeLayeredArtifactEnvelope(layered.envelope)).toBe(true);
    expect(layered.envelope.content.appArtifact.content.format).toBe("nabu-artifact/v1");
    expect(layered.envelope.content.layers[0].files).toMatchObject([
      { path: "demo/index.js", mode: 0o644 },
      { path: "demo/native.node", mode: 0o755 },
    ]);
    expect(layered.layers[0].chunks[0]).toEqual(
      new Uint8Array([...new TextEncoder().encode("export default 42;\n"), 0, 255, 1, 254]),
    );
  });

  it("refuses secrets before producing a dependency layer", async () => {
    await expect(
      sealRuntimeArtifactLayer({
        mountPath: "node_modules",
        platform,
        files: [{ path: "demo/config.txt", content: "sk_test_1234567890abcdefghijklmnop" }],
      }),
    ).rejects.toMatchObject({
      code: "artifact_secret_detected",
    } satisfies Partial<RuntimeArtifactLayerSealError>);
  });

  it("refuses app/layer overlay collisions", async () => {
    const application = await app(true);
    const layer = await sealRuntimeArtifactLayer({
      mountPath: "node_modules",
      platform,
      files: [{ path: "demo/index.js", content: "collision" }],
    });
    await expect(
      sealLayeredRuntimeArtifact({
        app: application,
        layers: [layer],
        pantryRevision: committedPantryRevision(),
        dependencyClosureSha256: "2".repeat(64),
        buildAttestationSha256: "3".repeat(64),
        platform,
        artifactRevision: "layered-1",
      }),
    ).rejects.toThrow(/collision-free/u);
  });
});

function committedPantryRevision() {
  return {
    schemaVersion: 1 as const,
    revisionId: "pantry-2026-08-08.1",
    rootSha256: "4".repeat(64),
    state: "committed" as const,
    stateRevision: 1,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}
