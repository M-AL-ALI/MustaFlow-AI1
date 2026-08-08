import { describe, expect, it } from "vitest";
import {
  PANTRY_CATALOG_SCHEMA_VERSION,
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_CATALOG_STAMP_FORMAT,
  pantryCatalogCommitRequestSchema,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfMatchesStamp,
  pantryCatalogShelfRecordSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryDependencyClosureHash,
  pantryIngredientMerkleRoot,
  pantryRevisionRoot,
  signPantryDigest,
  type PantryCatalogCommitRequest,
  type PantryCatalogObjectReference,
} from "../src";
import {
  PANTRY_COMPATIBILITY_CLOSURE,
  PANTRY_COMPATIBILITY_KEY,
  PANTRY_COMPATIBILITY_PLATFORM,
  pantryCompatibilityRevisionContent,
} from "./pantry-vector";

async function fixtureCommit(): Promise<PantryCatalogCommitRequest> {
  const closureSha256 = await pantryDependencyClosureHash(PANTRY_COMPATIBILITY_CLOSURE);
  const merkleSha256 = await pantryIngredientMerkleRoot(PANTRY_COMPATIBILITY_CLOSURE);
  const content = pantryCompatibilityRevisionContent(closureSha256, merkleSha256);
  const rootSha256 = await pantryRevisionRoot(content);
  const revision = {
    content,
    rootSha256,
    signature: await signPantryDigest(PANTRY_COMPATIBILITY_KEY.privateKeyPem, {
      kind: "revision",
      kid: PANTRY_COMPATIBILITY_KEY.kid,
      payloadSha256: rootSha256,
    }),
  };
  const lockfileSha256 = "a".repeat(64);
  const sbomSha256 = "b".repeat(64);
  const toolchainAttestationSha256 = "c".repeat(64);
  const references = new Map<string, PantryCatalogObjectReference>();
  const add = (kind: PantryCatalogObjectReference["kind"], sha256: string): void => {
    references.set(sha256, { kind, sha256, bytes: 42 });
  };
  add("lockfile", lockfileSha256);
  add("sbom", sbomSha256);
  add("toolchain-attestation", toolchainAttestationSha256);
  for (const ingredient of content.closure.ingredients) {
    add("registry-metadata", ingredient.registryMetadataSha256);
    add("package-tarball", ingredient.tarballSha256);
    add("normalized-package", ingredient.normalizedContentSha256);
    if (ingredient.provenance.attestationSha256 !== null) {
      add("provenance-attestation", ingredient.provenance.attestationSha256);
    }
  }
  for (const layer of content.layers) {
    add("dependency-layer", layer.contentSha256);
    add("layer-manifest", layer.unpackedManifestSha256);
  }
  const objectReferences = [...references.values()].sort((left, right) =>
    `${left.sha256}\0${left.kind}`.localeCompare(`${right.sha256}\0${right.kind}`),
  );
  return pantryCatalogCommitRequestSchema.parse({
    format: PANTRY_CATALOG_SHELF_FORMAT,
    schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
    assemblyId: `passembly_${"d".repeat(64)}`,
    revision,
    state: {
      schemaVersion: 1,
      revisionId: content.revisionId,
      rootSha256,
      state: "assembling",
      stateRevision: 0,
      updatedAt: "2026-08-08T16:00:00.000Z",
    },
    objectReferences,
    lockfileSha256,
    sbomSha256,
    toolchainAttestationSha256,
    retention: {
      namespace: "staging-acceptance",
      retainUntil: "2026-08-09T16:00:00.000Z",
    },
  });
}

describe("Pantry catalog contracts", () => {
  it("hashes arbitrary demand-driven package intents without a name allowlist", async () => {
    const identity = {
      intents: [
        { ecosystem: "npm" as const, name: "@future/maps-realtime-image-db", selector: "next" },
      ],
      platform: PANTRY_COMPATIBILITY_PLATFORM,
    };
    const requestSha256 = await pantryCatalogStockRequestHash(identity);
    const request = pantryCatalogStockRequestSchema.parse({
      schemaVersion: 1,
      requestSha256,
      ...identity,
      requestedAt: "2026-08-08T16:00:00.000Z",
      expiresAt: "2026-08-08T17:00:00.000Z",
    });
    expect(await pantryCatalogStockRequestHash(request)).toBe(requestSha256);
    expect(request.intents[0].name).toBe("@future/maps-realtime-image-db");
  });

  it("requires every exact shelf object before a commit can be accepted", async () => {
    const commit = await fixtureCommit();
    expect(pantryCatalogCommitRequestSchema.safeParse(commit).success).toBe(true);
    expect(
      pantryCatalogCommitRequestSchema.safeParse({
        ...commit,
        objectReferences: commit.objectReferences.slice(1),
      }).success,
    ).toBe(false);
    expect(
      pantryCatalogCommitRequestSchema.safeParse({
        ...commit,
        objectReferences: [...commit.objectReferences].reverse(),
      }).success,
    ).toBe(false);
  });

  it("pins an immutable shelf manifest and verifies a build shelf stamp from it alone", async () => {
    const commit = await fixtureCommit();
    const committedAt = "2026-08-08T16:05:00.000Z";
    const withoutHash = {
      ...commit,
      assemblyId: undefined,
      state: {
        ...commit.state,
        state: "committed" as const,
        stateRevision: 1,
        updatedAt: committedAt,
      },
      committedAt,
    };
    const { assemblyId: _assemblyId, ...manifest } = withoutHash;
    const shelf = pantryCatalogShelfRecordSchema.parse({
      ...manifest,
      manifestSha256: await pantryCatalogShelfManifestHash(manifest),
    });
    const stamp = {
      format: PANTRY_CATALOG_STAMP_FORMAT,
      schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
      pantryRevisionId: shelf.revision.content.revisionId,
      pantryRevisionRootSha256: shelf.revision.rootSha256,
      dependencyClosureSha256: shelf.revision.content.dependencyClosureSha256,
      lockfileSha256: shelf.lockfileSha256,
      sbomSha256: shelf.sbomSha256,
      toolchainImageDigest: shelf.revision.content.closure.platform.toolchainImageDigest,
      toolchainAttestationSha256: shelf.toolchainAttestationSha256,
    };
    expect(pantryCatalogShelfMatchesStamp(shelf, stamp)).toBe(true);
    expect(
      pantryCatalogShelfMatchesStamp(shelf, { ...stamp, lockfileSha256: "e".repeat(64) }),
    ).toBe(false);
    expect(await pantryCatalogShelfManifestHash(manifest)).toBe(shelf.manifestSha256);
  });

  it("fails unknown versions, lifecycle states, and fields closed", async () => {
    const commit = await fixtureCommit();
    expect(
      pantryCatalogCommitRequestSchema.safeParse({ ...commit, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      pantryCatalogCommitRequestSchema.safeParse({
        ...commit,
        state: { ...commit.state, state: "committed" },
      }).success,
    ).toBe(false);
    expect(
      pantryCatalogCommitRequestSchema.safeParse({ ...commit, allowedPackages: [] }).success,
    ).toBe(false);
  });
});
