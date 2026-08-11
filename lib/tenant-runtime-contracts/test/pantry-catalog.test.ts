import { describe, expect, it } from "vitest";
import {
  PANTRY_CATALOG_SCHEMA_VERSION,
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_CATALOG_STAMP_FORMAT,
  canonicalPantryCatalogStockIdentity,
  pantryCatalogAssemblyDiagnosticsResponseSchema,
  pantryCatalogCommitRequestSchema,
  pantryCatalogAssemblyStatusResponseSchema,
  pantryCatalogGcRequestSchema,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfMatchesStamp,
  pantryCatalogShelfRecordSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryCatalogStockResponseSchema,
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

  it("defines stock identity once from canonical semantic fields and excludes timestamps", async () => {
    const unsorted = {
      intents: [
        { ecosystem: "npm" as const, name: "zod", selector: "^4.1.5" },
        { ecosystem: "npm" as const, name: "express", selector: "^5.1.0" },
      ],
      platform: PANTRY_COMPATIBILITY_PLATFORM,
    };
    const canonical = canonicalPantryCatalogStockIdentity(unsorted);
    expect(canonical.intents.map((intent) => intent.name)).toEqual(["express", "zod"]);
    const firstEnvelope = {
      ...canonical,
      requestedAt: "2026-08-09T16:00:00.000Z",
      expiresAt: "2026-08-09T17:00:00.000Z",
    };
    const resumedEnvelope = {
      ...canonical,
      requestedAt: "2026-08-09T16:20:00.000Z",
      expiresAt: "2026-08-09T17:20:00.000Z",
    };
    const first = await pantryCatalogStockRequestHash(firstEnvelope);
    const resumed = await pantryCatalogStockRequestHash(resumedEnvelope);
    expect(resumed).toBe(first);
    expect(await pantryCatalogStockRequestHash(unsorted)).toBe(first);
  });

  it("contracts the explicit stock and assembly-progress lifecycle", () => {
    const assemblyId = `passembly_${"e".repeat(64)}`;
    expect(
      pantryCatalogStockResponseSchema.parse({
        ok: true,
        state: "assembling",
        assemblyId,
        revisionRootSha256: null,
      }).state,
    ).toBe("assembling");
    expect(
      pantryCatalogAssemblyStatusResponseSchema.parse({
        ok: true,
        assemblyId,
        ingest: {
          state: "running",
          attempt: 2,
          updatedAt: "2026-08-09T16:00:00.000Z",
          leaseUntil: "2026-08-09T16:03:00.000Z",
          failure: null,
        },
        stagedObjects: 17,
      }).ingest.state,
    ).toBe("running");
    expect(
      pantryCatalogAssemblyStatusResponseSchema.safeParse({
        ok: true,
        assemblyId,
        ingest: { state: "failed", attempt: 2, failure: null },
        stagedObjects: 17,
      }).success,
    ).toBe(false);
    expect(
      pantryCatalogAssemblyDiagnosticsResponseSchema.parse({
        ok: true,
        assemblyId,
        requestSha256: "f".repeat(64),
        currentStage: "fetching-tarball",
        lastTransitionAt: "2026-08-09T16:01:00.000Z",
        queueEnqueues: 2,
        queueDeliveries: 3,
        generation: 2,
        leaseRenewals: 4,
        alarmReenqueues: 1,
        ingestAttempts: 2,
        stagedObjects: 0,
        metrics: {
          resolvedPackages: 4,
          fetchedTarballs: 3,
          verifiedTarballs: 2,
          extractedTarballs: 2,
          dependencyEdges: 8,
          tarballBytes: 1_024,
          unpackedBytes: 4_096,
        },
        stageTransitions: [
          {
            stage: "fetching-tarball",
            firstAt: "2026-08-09T16:00:30.000Z",
            lastAt: "2026-08-09T16:01:00.000Z",
            transitions: 3,
          },
        ],
        events: [
          {
            sequence: 7,
            at: "2026-08-09T16:01:00.000Z",
            kind: "ingest-progress",
            stage: "fetching-tarball",
            generation: 2,
            attempt: 2,
            queueDeliveries: 3,
            stagedObjects: 0,
            metrics: {
              resolvedPackages: 4,
              fetchedTarballs: 3,
              verifiedTarballs: 2,
              extractedTarballs: 2,
              dependencyEdges: 8,
              tarballBytes: 1_024,
              unpackedBytes: 4_096,
            },
            failureCode: null,
            failureStage: null,
            failureOperation: null,
            failureCause: null,
            failureErrorClass: null,
            failureErrorCode: null,
            failureErrorFingerprint: null,
            reclaimedObjects: 0,
            reclaimedBytes: 0,
          },
        ],
        truncatedBeforeSequence: 0,
      }).currentStage,
    ).toBe("fetching-tarball");
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

  it("requires exact hashes for targeted orphan reclamation and forbids them on broad sweeps", () => {
    const base = {
      now: "2026-08-10T02:00:00.000Z",
      maxDeletes: 100,
    };
    expect(
      pantryCatalogGcRequestSchema.safeParse({ ...base, scope: "targeted-orphan-cas" }).success,
    ).toBe(false);
    expect(
      pantryCatalogGcRequestSchema.safeParse({
        ...base,
        scope: "targeted-orphan-cas",
        objectSha256: ["a".repeat(64)],
      }).success,
    ).toBe(true);
    expect(
      pantryCatalogGcRequestSchema.safeParse({
        ...base,
        scope: "orphan-cas-sweep",
        objectSha256: ["a".repeat(64)],
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
