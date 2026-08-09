import { describe, expect, it } from "vitest";
import {
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_CATALOG_STAMP_FORMAT,
  PANTRY_SHELF_CONTENT_HASHES_FORMAT,
  deriveRuntimeIdentity,
  pantryNormalizedPackageManifestSchema,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfRecordSchema,
  pantryShelfContentHashesHash,
  pantryShelfContentHashesResponseSchema,
  signPantryDigest,
  verifyRuntimeLayeredArtifactEnvelope,
  type PantryCatalogCommitRequest,
  type PantryCatalogObjectKind,
  type PantryCatalogShelfRecord,
  type PantryCatalogShelfStamp,
  type PantryShelfContentHashesResponse,
} from "@workspace/tenant-runtime-contracts";
import { sealRuntimeArtifact } from "./runtime-artifact";
import {
  RuntimeArtifactLayerSealError,
  resolveTrustedPantryLayerSealProvenance,
  sealLayeredRuntimeArtifact,
  sealRuntimeArtifactLayer,
  type TrustedPantryLayerSealProvenance,
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

  it("exempts only exact proven-public shelf bytes from the unchanged secret scan", async () => {
    const publicBytes = new TextEncoder().encode("sk_test_1234567890abcdefghijklmnop");
    const fixture = await trustedProvenanceFixture(publicBytes);
    const layer = await sealRuntimeArtifactLayer({
      mountPath: "node_modules",
      platform,
      files: [{ path: "public-sample/index.js", content: publicBytes }],
      provenance: fixture.provenance,
    });
    expect(layer.scanSummary).toEqual({
      policyVersion: "nabu-secret-scan/v1",
      scannedFiles: 0,
      shelfExemptFiles: 1,
    });

    await expect(
      sealRuntimeArtifactLayer({
        mountPath: "node_modules",
        platform,
        files: [
          {
            path: "public-sample/index.js",
            content: new TextEncoder().encode(
              "sk_test_1234567890abcdefghijklmnop\n// modified after shelving",
            ),
          },
        ],
        provenance: fixture.provenance,
      }),
    ).rejects.toMatchObject({
      code: "artifact_secret_detected",
    } satisfies Partial<RuntimeArtifactLayerSealError>);
  });

  it("rejects tampered ledger objects and cell-supplied provenance handles", async () => {
    const fixture = await trustedProvenanceFixture(new TextEncoder().encode("public sample"));
    const tampered = structuredClone(fixture.attestation);
    tampered.statement.contentHashes[0] = "f".repeat(64);
    await expect(
      resolveTrustedPantryLayerSealProvenance({
        shelf: fixture.shelf,
        expectedShelf: fixture.stamp,
        attestation: tampered,
        publicKeys: fixture.publicKeys,
      }),
    ).rejects.toMatchObject({
      code: "artifact_invalid_provenance",
    } satisfies Partial<RuntimeArtifactLayerSealError>);

    await expect(
      sealRuntimeArtifactLayer({
        mountPath: "node_modules",
        platform,
        files: [{ path: "public-sample/index.js", content: "public sample" }],
        provenance: {
          pantryRevisionRootSha256: fixture.shelf.revision.rootSha256,
        } as TrustedPantryLayerSealProvenance,
      }),
    ).rejects.toMatchObject({
      code: "artifact_invalid_provenance",
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

async function trustedProvenanceFixture(publicBytes: Uint8Array): Promise<{
  shelf: PantryCatalogShelfRecord;
  stamp: PantryCatalogShelfStamp;
  attestation: PantryShelfContentHashesResponse;
  provenance: TrustedPantryLayerSealProvenance;
  publicKeys: ReadonlyMap<string, string>;
}> {
  const fixtureModule = await loadPantryFixtureModule();
  const fixture = await fixtureModule.makePantryFixture({ publicRootBytes: publicBytes });
  const withoutHash = {
    format: PANTRY_CATALOG_SHELF_FORMAT,
    schemaVersion: 1 as const,
    revision: fixture.commit.revision,
    state: {
      ...fixture.commit.state,
      state: "committed" as const,
      stateRevision: 1,
    },
    objectReferences: fixture.commit.objectReferences,
    lockfileSha256: fixture.commit.lockfileSha256,
    sbomSha256: fixture.commit.sbomSha256,
    toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
    retention: fixture.commit.retention,
    committedAt: fixture.commit.state.updatedAt,
  };
  const shelf = pantryCatalogShelfRecordSchema.parse({
    ...withoutHash,
    manifestSha256: await pantryCatalogShelfManifestHash(withoutHash),
  });
  const stamp: PantryCatalogShelfStamp = {
    format: PANTRY_CATALOG_STAMP_FORMAT,
    schemaVersion: 1,
    pantryRevisionId: shelf.revision.content.revisionId,
    pantryRevisionRootSha256: shelf.revision.rootSha256,
    dependencyClosureSha256: shelf.revision.content.dependencyClosureSha256,
    lockfileSha256: shelf.lockfileSha256,
    sbomSha256: shelf.sbomSha256,
    toolchainImageDigest: shelf.revision.content.closure.platform.toolchainImageDigest,
    toolchainAttestationSha256: shelf.toolchainAttestationSha256,
  };
  const normalizedManifests = new Map(
    [...fixture.objects]
      .filter(([, object]) => object.kind === "normalized-package")
      .map(([sha256, object]) => [sha256, object.bytes] as const),
  );
  const publicKeys = new Map([
    [fixtureModule.PANTRY_TEST_KEY.kid, fixtureModule.PANTRY_TEST_KEY.publicKeyPem],
  ]);
  const contentHashes = [
    ...new Set(
      [...normalizedManifests.values()].flatMap((bytes) =>
        pantryNormalizedPackageManifestSchema
          .parse(JSON.parse(new TextDecoder().decode(bytes)))
          .entries.map((entry) => entry.sha256),
      ),
    ),
  ].sort();
  const statement = {
    format: PANTRY_SHELF_CONTENT_HASHES_FORMAT,
    schemaVersion: 1 as const,
    pantryRevisionId: shelf.revision.content.revisionId,
    pantryRevisionRootSha256: shelf.revision.rootSha256,
    shelfManifestSha256: shelf.manifestSha256,
    contentHashes,
  };
  const statementSha256 = await pantryShelfContentHashesHash(statement);
  const attestation = pantryShelfContentHashesResponseSchema.parse({
    ok: true,
    statement,
    statementSha256,
    signature: await signPantryDigest(fixtureModule.PANTRY_TEST_KEY.privateKeyPem, {
      kind: "shelf-content-hashes",
      kid: fixtureModule.PANTRY_TEST_KEY.kid,
      payloadSha256: statementSha256,
    }),
  });
  const provenance = await resolveTrustedPantryLayerSealProvenance({
    shelf,
    expectedShelf: stamp,
    attestation,
    publicKeys,
  });
  return { shelf, stamp, attestation, provenance, publicKeys };
}

interface PantryFixtureModule {
  PANTRY_TEST_KEY: { kid: string; privateKeyPem: string; publicKeyPem: string };
  makePantryFixture(input: { publicRootBytes: Uint8Array }): Promise<{
    commit: PantryCatalogCommitRequest;
    objects: Map<
      string,
      {
        kind: PantryCatalogObjectKind;
        bytes: Uint8Array;
      }
    >;
  }>;
}

async function loadPantryFixtureModule(): Promise<PantryFixtureModule> {
  // Keep the shared deterministic fixture test-only without widening this package's rootDir.
  const fixtureModuleUrl = new URL(
    "../../../nabuflow-runtime-worker/scripts/" + "pantry-catalog-fixture.ts",
    import.meta.url,
  ).href;
  return (await import(fixtureModuleUrl)) as PantryFixtureModule;
}
