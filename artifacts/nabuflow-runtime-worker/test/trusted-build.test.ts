import { describe, expect, it, vi } from "vitest";
import {
  PANTRY_BUILD_INPUT_FORMAT,
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_SCHEMA_VERSION,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_SOURCE_FORMAT,
  canonicalPantryJson,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfRecordSchema,
  sha256Hex,
  trustedBuildDependencyIntentHash,
  trustedBuildRequestHash,
  trustedBuildRequestSchema,
  trustedBuildSourceManifestHash,
  verifyPantryBuildAttestation,
  type PantryCatalogShelfRecord,
  type TrustedBuildOutput,
  type TrustedBuildRequest,
} from "@workspace/tenant-runtime-contracts";
import { makePantryFixture, PANTRY_TEST_KEY } from "../scripts/pantry-catalog-fixture";
import type {
  StoredTrustedBuild,
  TrustedBuildBegin,
  TrustedBuildCell,
  TrustedBuildClaim,
  TrustedBuildCoordinator,
  TrustedBuildDiagnostics,
  TrustedBuildFailure,
  TrustedBuildWorkerBindings,
} from "../src/trusted-build-model";
import {
  handleTrustedBuildQueue,
  handleTrustedBuildWorkerRequest,
} from "../src/trusted-build-worker";
import {
  assertTrustedBuildOutputEntries,
  consumeTrustedBuildRpcResult,
  createTrustedBuildCollection,
  TrustedBuildCellError,
  destroyFreshBuildSandbox,
  initializeFreshBuildSandbox,
  sanitizeBuildDiagnosticText,
  scanTrustedBuildFileStream,
  trustedBuildBinShim,
  trustedBuildBinVerificationCommand,
  trustedBuildExecutionCommand,
  trustedBuildRegistryVersion,
  trustedBuildSandboxCellId,
  TrustedBuildPassResourceScope,
  verifiedInputStream,
  verifyTrustedBuildCollection,
} from "../src/trusted-build-cell";
import { ContainerProxy } from "../src/trusted-build-index";
import { trustedBuildStagingChunkKey } from "../src/trusted-build-storage";
import { MemoryR2Bucket } from "./helpers";

const NOW = new Date("2026-08-08T22:00:00.000Z");

class MemoryBuildCoordinator implements TrustedBuildCoordinator {
  readonly builds = new Map<string, StoredTrustedBuild>();
  readonly requests = new Map<string, string>();
  deliveries = 0;
  coalesced = 0;

  async begin(
    input: Pick<
      StoredTrustedBuild,
      | "buildId"
      | "requestId"
      | "requestSha256"
      | "createdAt"
      | "updatedAt"
      | "requestObjectSha256"
      | "sourceObjectSha256"
      | "sourceBytes"
    >,
    maxActive: number,
  ): Promise<TrustedBuildBegin> {
    const existingId = this.requests.get(input.requestId);
    if (existingId !== undefined) {
      const existing = this.builds.get(existingId)!;
      this.coalesced += 1;
      return { state: existing.state === "succeeded" ? "succeeded" : "coalesced", build: existing };
    }
    if (
      [...this.builds.values()].filter(
        (build) => !["succeeded", "failed", "cancelled"].includes(build.state),
      ).length >= maxActive
    ) {
      return { state: "backpressure" };
    }
    const build: StoredTrustedBuild = {
      ...input,
      state: "queued",
      attempt: 0,
      queueDeliveries: 0,
      leaseUntil: null,
      cellId: null,
      outputObjectSha256: null,
      failure: null,
      attempts: [],
    };
    this.builds.set(build.buildId, build);
    this.requests.set(build.requestId, build.buildId);
    return { state: "created", build };
  }

  async recordQueueDelivery(buildId: string) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    build.queueDeliveries += 1;
    this.deliveries += 1;
    return "recorded" as const;
  }

  async recordStage(
    buildId: string,
    attempt: number,
    pass: 1 | 2 | null,
    stage: Parameters<TrustedBuildCoordinator["recordStage"]>[3],
    outcome: Parameters<TrustedBuildCoordinator["recordStage"]>[4],
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    let evidence = build.attempts.find((item) => item.attempt === attempt);
    if (evidence === undefined) {
      evidence = {
        attempt,
        progression: [],
        collectionProgress: [],
        secretScanFindings: [],
        secretScanSummaries: [],
        memoryProgress: [],
        verificationProgress: [],
        lastSuccessfulStage: null,
        failingStage: null,
        error: null,
        diagnostics: null,
      };
      build.attempts.push(evidence);
    }
    evidence.progression.push({ pass, stage, outcome });
    if (outcome === "succeeded") evidence.lastSuccessfulStage = { pass, stage };
    if (outcome === "failed") evidence.failingStage = { pass, stage };
    return "recorded" as const;
  }

  async recordCollectionProgress(
    buildId: string,
    attempt: number,
    progress: Parameters<TrustedBuildCoordinator["recordCollectionProgress"]>[2],
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    const evidence = build.attempts.find((item) => item.attempt === attempt);
    if (evidence === undefined) return "not_found" as const;
    evidence.collectionProgress.push(progress);
    return "recorded" as const;
  }

  async recordSecretScanFindings(
    buildId: string,
    attempt: number,
    findings: Parameters<TrustedBuildCoordinator["recordSecretScanFindings"]>[2],
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    const evidence = build.attempts.find((item) => item.attempt === attempt);
    if (evidence === undefined) return "not_found" as const;
    evidence.secretScanFindings = [...findings];
    return "recorded" as const;
  }

  async recordSecretScanSummary(
    buildId: string,
    attempt: number,
    summary: Parameters<TrustedBuildCoordinator["recordSecretScanSummary"]>[2],
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    const evidence = build.attempts.find((item) => item.attempt === attempt);
    if (evidence === undefined) return "not_found" as const;
    evidence.secretScanSummaries.push(summary);
    return "recorded" as const;
  }

  async recordMemoryProgress(
    buildId: string,
    attempt: number,
    progress: Parameters<TrustedBuildCoordinator["recordMemoryProgress"]>[2],
  ) {
    const evidence = this.builds.get(buildId)?.attempts.find((item) => item.attempt === attempt);
    if (evidence === undefined) return "not_found" as const;
    evidence.memoryProgress.push(progress);
    return "recorded" as const;
  }

  async recordVerificationProgress(
    buildId: string,
    attempt: number,
    progress: Parameters<TrustedBuildCoordinator["recordVerificationProgress"]>[2],
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    const evidence = build.attempts.find((item) => item.attempt === attempt);
    if (evidence === undefined) return "not_found" as const;
    evidence.verificationProgress.push(progress);
    return "recorded" as const;
  }

  async recordAttemptFailure(
    buildId: string,
    attempt: number,
    pass: 1 | 2 | null,
    stage: Parameters<TrustedBuildCoordinator["recordAttemptFailure"]>[3],
    failure: Parameters<TrustedBuildCoordinator["recordAttemptFailure"]>[4],
    diagnostics: Parameters<TrustedBuildCoordinator["recordAttemptFailure"]>[5],
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    const evidenceBefore = build.attempts.find((item) => item.attempt === attempt);
    const lastRecordedFailure = [...(evidenceBefore?.progression ?? [])]
      .reverse()
      .find((item) => item.outcome === "failed");
    const matchingRecordedFailure = [...(evidenceBefore?.progression ?? [])]
      .reverse()
      .find((item) => item.outcome === "failed" && item.stage === stage);
    const effectivePass =
      pass ?? matchingRecordedFailure?.pass ?? lastRecordedFailure?.pass ?? null;
    const effectiveStage =
      (stage === "orchestration" || stage === "unknown") && lastRecordedFailure !== undefined
        ? lastRecordedFailure.stage
        : stage;
    if (
      !evidenceBefore?.progression.some(
        (item) =>
          item.pass === effectivePass && item.stage === effectiveStage && item.outcome === "failed",
      )
    ) {
      await this.recordStage(buildId, attempt, effectivePass, effectiveStage, "failed");
    }
    const evidence = build.attempts.find((item) => item.attempt === attempt)!;
    evidence.error = {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      status: failure.status,
    };
    evidence.diagnostics = diagnostics;
    return "recorded" as const;
  }

  async claim(buildId: string, now: string, leaseUntil: string): Promise<TrustedBuildClaim> {
    const build = this.builds.get(buildId);
    if (build === undefined) return { state: "not_found" };
    if (["succeeded", "failed", "cancelled"].includes(build.state))
      return { state: "terminal", build };
    if (
      build.state !== "queued" &&
      build.leaseUntil !== null &&
      Date.parse(build.leaseUntil) > Date.parse(now)
    ) {
      return { state: "busy", build };
    }
    build.state = "resolving";
    build.attempt += 1;
    build.attempts.push({
      attempt: build.attempt,
      progression: [],
      collectionProgress: [],
      secretScanFindings: [],
      secretScanSummaries: [],
      memoryProgress: [],
      verificationProgress: [],
      lastSuccessfulStage: null,
      failingStage: null,
      error: null,
      diagnostics: null,
    });
    build.updatedAt = now;
    build.leaseUntil = leaseUntil;
    build.cellId = null;
    return { state: "claimed", build };
  }

  async renewLease(buildId: string, attempt: number, now: string, leaseUntil: string) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (["succeeded", "failed", "cancelled"].includes(build.state)) return "terminal" as const;
    if (build.attempt !== attempt) return "stale" as const;
    build.updatedAt = now;
    build.leaseUntil = leaseUntil;
    return "updated" as const;
  }

  async bindCell(buildId: string, attempt: number, cellId: string | null) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (["succeeded", "failed", "cancelled"].includes(build.state)) return "terminal" as const;
    if (build.attempt !== attempt) return "stale" as const;
    build.cellId = cellId;
    return "updated" as const;
  }

  async transition(
    buildId: string,
    attempt: number,
    expected: StoredTrustedBuild["state"],
    next: "resolving" | "building" | "verifying",
    now: string,
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (build.state === "cancelled") return "cancelled" as const;
    if (build.attempt !== attempt || build.state !== expected) return "conflict" as const;
    build.state = next;
    build.updatedAt = now;
    return "updated" as const;
  }

  async succeed(buildId: string, attempt: number, outputObjectSha256: string, now: string) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (build.state === "cancelled") return "cancelled" as const;
    if (build.attempt !== attempt || build.state !== "verifying") return "conflict" as const;
    build.state = "succeeded";
    build.outputObjectSha256 = outputObjectSha256;
    build.updatedAt = now;
    return "updated" as const;
  }

  async requeue(
    buildId: string,
    attempt: number,
    expected: StoredTrustedBuild["state"],
    now: string,
  ) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (build.state === "cancelled") return "cancelled" as const;
    if (build.attempt !== attempt || build.state !== expected) return "conflict" as const;
    build.state = "queued";
    build.updatedAt = now;
    return "updated" as const;
  }

  async fail(buildId: string, attempt: number, failure: TrustedBuildFailure) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (build.state === "cancelled") return "cancelled" as const;
    if (build.attempt !== attempt) return "stale" as const;
    build.state = "failed";
    build.failure = failure;
    build.updatedAt = failure.failedAt;
    return "updated" as const;
  }

  async cancel(buildId: string, now: string) {
    const build = this.builds.get(buildId);
    if (build === undefined) return "not_found" as const;
    if (["succeeded", "failed", "cancelled"].includes(build.state))
      return "already-terminal" as const;
    build.state = "cancelled";
    build.updatedAt = now;
    return "cancelled" as const;
  }

  async get(buildId: string) {
    return this.builds.get(buildId) ?? null;
  }

  async cleanup(olderThanMs: number, maxDeletes: number, includeSucceeded: boolean) {
    const removed = [...this.builds.values()]
      .filter(
        (build) =>
          ["failed", "cancelled", ...(includeSucceeded ? ["succeeded"] : [])].includes(
            build.state,
          ) && Date.parse(build.updatedAt) < olderThanMs,
      )
      .slice(0, maxDeletes);
    for (const build of removed) {
      this.builds.delete(build.buildId);
      this.requests.delete(build.requestId);
    }
    return removed;
  }

  async diagnostics(): Promise<TrustedBuildDiagnostics> {
    const builds = [...this.builds.values()];
    return {
      queued: builds.filter((build) => build.state === "queued").length,
      running: builds.filter((build) =>
        ["resolving", "building", "verifying"].includes(build.state),
      ).length,
      succeeded: builds.filter((build) => build.state === "succeeded").length,
      failed: builds.filter((build) => build.state === "failed").length,
      cancelled: builds.filter((build) => build.state === "cancelled").length,
      queueDeliveries: this.deliveries,
      coalescedRequests: this.coalesced,
    };
  }
}

async function committedShelf(): Promise<{
  shelf: PantryCatalogShelfRecord;
  objects: Map<string, Uint8Array>;
}> {
  const fixture = await makePantryFixture();
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
  return {
    shelf,
    objects: new Map([...fixture.objects].map(([sha, value]) => [sha, value.bytes])),
  };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function buildRequest(
  shelf: PantryCatalogShelfRecord,
  marker = "a",
): Promise<TrustedBuildRequest> {
  const sources = [
    {
      path: "build.mjs",
      mode: 0o644 as const,
      bytes: new TextEncoder().encode("// fixture build"),
    },
    {
      path: "package.json",
      mode: 0o644 as const,
      bytes: new TextEncoder().encode('{"name":"fixture","private":true}'),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const payload = new Uint8Array(sources.reduce((sum, file) => sum + file.bytes.length, 0));
  let offset = 0;
  const files = [];
  for (const source of sources) {
    payload.set(source.bytes, offset);
    files.push({
      path: source.path,
      mode: source.mode,
      offset,
      size: source.bytes.byteLength,
      sha256: await sha256Hex(source.bytes),
    });
    offset += source.bytes.byteLength;
  }
  const manifest = {
    format: TRUSTED_BUILD_SOURCE_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    payloadBytes: payload.byteLength,
    files,
  };
  const dependencyIntents = [
    { ecosystem: "npm" as const, name: "@fixture/heavy-app", selector: "^1.0.0" },
  ];
  const unsigned = {
    format: TRUSTED_BUILD_REQUEST_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    input: {
      format: PANTRY_BUILD_INPUT_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      buildId: `pbuild_${marker.repeat(22)}`,
      sourceArtifactSha256: await trustedBuildSourceManifestHash(manifest),
      dependencyIntentSha256: await trustedBuildDependencyIntentHash(dependencyIntents),
      lockfileSha256: shelf.lockfileSha256,
      pantryRevisionId: shelf.revision.content.revisionId,
      pantryRevisionRootSha256: shelf.revision.rootSha256,
      dependencyClosureSha256: shelf.revision.content.dependencyClosureSha256,
      platform: shelf.revision.content.closure.platform,
      buildCommand: ["node", "build.mjs"],
      createdAt: NOW.toISOString(),
    },
    source: { manifest, payloadBase64: base64(payload) },
    dependencyIntents,
    output: {
      strategy: "bundle-first" as const,
      dependencyPackaging: marker === "a" ? ("layer" as const) : ("bundle" as const),
      appDirectory: "dist",
      dependencyLayerMountPath: "node_modules" as const,
    },
  };
  return trustedBuildRequestSchema.parse({
    ...unsigned,
    requestId: `pbuildreq_${await trustedBuildRequestHash(unsigned)}`,
  });
}

function fakeCell(
  input?: {
    mismatch?: boolean;
    secret?: boolean;
    fail?: boolean;
  },
  bucket?: R2Bucket,
): TrustedBuildCell {
  return {
    async build(request, pass, onStage) {
      await onStage?.("initialize", "started");
      if (input?.fail) {
        await onStage?.("initialize", "failed");
        throw new Error("fixture internal detail");
      }
      await onStage?.("initialize", "succeeded");
      if (input?.secret) {
        throw new TrustedBuildCellError(
          "build_failed",
          "Build output secret scan failed",
          "output-collection",
          null,
          [
            {
              scope: "dependency",
              path: "@fixture/heavy-app/index.js",
              ruleId: "stripe-secret-key",
              contentSha256Prefix: "a".repeat(16),
              byteOffset: 11,
              provenance: "not-shelf-byte-identical",
            },
          ],
        );
      }
      const collect = async (
        root: "app" | "dependencies",
        files: Array<{ path: string; mode: 0o644 | 0o755; bytes: Uint8Array }>,
      ) => {
        const sealed = await createTrustedBuildCollection(files);
        const manifest = JSON.parse(new TextDecoder().decode(sealed.manifestBytes)) as {
          payloadBytes: number;
          payloadSha256: string;
          files: Array<{
            path: string;
            mode: 0o644 | 0o755;
            size: number;
            offset: number;
            sha256: string;
          }>;
        };
        const outputChunks = [];
        let index = 0;
        if (pass === 2) {
          for (const [name, bytes] of sealed.chunks) {
            const sha256 = name.slice(0, -4);
            const stagingKey = trustedBuildStagingChunkKey(
              request.request.input.buildId,
              request.attempt,
              pass,
              root,
              index,
              sha256,
            );
            await bucket?.put(stagingKey, bytes);
            outputChunks.push({ index, sha256, bytes: bytes.byteLength, stagingKey });
            index += 1;
          }
        }
        const shelfExemptFiles = manifest.files.filter((file) =>
          request.shelfContentSha256.has(file.sha256),
        ).length;
        return {
          payloadBytes: manifest.payloadBytes,
          payloadSha256: manifest.payloadSha256,
          determinismManifestSha256: await sha256Hex(
            canonicalPantryJson({
              files: manifest.files.map(({ path, mode, size, sha256 }) => ({
                path,
                mode,
                size,
                sha256,
              })),
            }),
          ),
          files: manifest.files,
          outputChunks,
          scannedFiles: manifest.files.length - shelfExemptFiles,
          shelfExemptFiles,
          bytesScanned: manifest.files
            .filter((file) => !request.shelfContentSha256.has(file.sha256))
            .reduce((sum, file) => sum + file.size, 0),
          peakBufferedBytes: Math.max(
            sealed.manifestBytes.byteLength,
            ...[...sealed.chunks.values()].map((bytes) => bytes.byteLength),
          ),
        };
      };
      const appBytes = new TextEncoder().encode(
        input?.mismatch && pass === 2 ? "export default 2" : "export default 1",
      );
      const dependencyBytes = new TextEncoder().encode("module.exports=1");
      return {
        app: await collect("app", [{ path: "server.mjs", mode: 0o755, bytes: appBytes }]),
        dependencies: await collect("dependencies", [
          { path: "@fixture/heavy-app/index.js", mode: 0o644, bytes: dependencyBytes },
        ]),
        lifecycleScriptsExecuted: 1,
        processPeak: 1,
        elapsedMs: 10,
      };
    },
    async destroy() {},
  };
}

async function fixtureEnv() {
  const { shelf, objects } = await committedShelf();
  const bucket = new MemoryR2Bucket();
  const queued: unknown[] = [];
  const env = {
    TRUSTED_BUILD_OBJECTS: bucket as unknown as R2Bucket,
    TRUSTED_BUILD_QUEUE: {
      async send(message: unknown) {
        queued.push(message);
      },
    },
    TRUSTED_BUILD_MAX_ACTIVE: "32",
    TRUSTED_BUILD_PLATFORM: JSON.stringify(shelf.revision.content.closure.platform),
    TRUSTED_BUILD_SIGNING_KEY_ID: PANTRY_TEST_KEY.kid,
    TRUSTED_BUILD_SIGNING_PRIVATE_KEY: PANTRY_TEST_KEY.privateKeyPem,
    TRUSTED_BUILD_PUBLIC_KEYS: JSON.stringify({
      [PANTRY_TEST_KEY.kid]: PANTRY_TEST_KEY.publicKeyPem,
    }),
    PANTRY_CATALOG: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === `/internal/v1/revisions/by-root/${shelf.revision.rootSha256}`) {
          return Response.json({ ok: true, shelf, lifecycle: shelf.state, externalReferences: 0 });
        }
        const object = /^\/internal\/v1\/objects\/([0-9a-f]{64})$/u.exec(url.pathname);
        if (object !== null) {
          const bytes = objects.get(object[1]);
          return bytes === undefined
            ? Response.json(
                { ok: false, code: "catalog_not_found", message: "not found", retryable: false },
                { status: 404 },
              )
            : new Response(bytes.slice().buffer, {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
              });
        }
        if (/\/internal\/v1\/revisions\/[0-9a-f]{64}\/references$/u.test(url.pathname)) {
          return Response.json({ ok: true, state: "retained" });
        }
        return Response.json(
          { ok: false, code: "catalog_not_found", message: "not found", retryable: false },
          { status: 404 },
        );
      },
    } as unknown as Fetcher,
  } as unknown as TrustedBuildWorkerBindings;
  return { env, shelf, bucket, queued };
}

describe("trusted secretless build plane", () => {
  it("maps every contract-valid build tuple to a deterministic 192-bit Sandbox identifier", () => {
    const maximumBuildId = `pbuild_${"Z".repeat(128)}`;
    const first = trustedBuildSandboxCellId(maximumBuildId, 1, 1);
    expect(trustedBuildSandboxCellId(maximumBuildId, 1, 1)).toBe(first);
    expect(first).toMatch(/^nbb-[0-9a-f]{48}$/u);
    expect(first).toHaveLength(52);
    expect(first.length).toBeLessThan(63);

    const tuples = [
      trustedBuildSandboxCellId(maximumBuildId, 1, 1),
      trustedBuildSandboxCellId(maximumBuildId, 1, 2),
      trustedBuildSandboxCellId(maximumBuildId, 2, 1),
      trustedBuildSandboxCellId(`pbuild_${"Y".repeat(128)}`, 1, 1),
    ];
    expect(new Set(tuples).size).toBe(tuples.length);
  });

  it("streams Pantry inputs through a bounded pass scope and disposes every owned RPC resource", async () => {
    const input = new Uint8Array(2 * 1024 * 1024 + 257);
    for (let index = 0; index < input.byteLength; index += 1) input[index] = index % 251;
    const expectedSha256 = await sha256Hex(input);
    const progress: Array<Parameters<TrustedBuildCoordinator["recordMemoryProgress"]>[2]> = [];
    const disposed: string[] = [];
    const scope = new TrustedBuildPassResourceScope(1, async (sample) => {
      progress.push(sample);
    });
    scope.trackRpc({ [Symbol.dispose]: () => disposed.push("sandbox") });
    scope.trackRpc({ [Symbol.dispose]: () => disposed.push("process") });
    const ranges: Array<{ offset: number; length: number }> = [];
    const stream = verifiedInputStream(
      input.byteLength,
      expectedSha256,
      scope,
      async (offset, length, signal) => {
        expect(signal.aborted).toBe(false);
        expect(length).toBeLessThanOrEqual(1024 * 1024);
        ranges.push({ offset, length });
        return input.slice(offset, offset + length);
      },
    );
    const received = new Uint8Array(input.byteLength);
    let receivedBytes = 0;
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received.set(next.value, receivedBytes);
      receivedBytes += next.value.byteLength;
    }
    await scope.sample("transfer");
    await scope.close();
    await scope.close();

    expect(received).toEqual(input);
    expect(ranges).toEqual([
      { offset: 0, length: 1024 * 1024 },
      { offset: 1024 * 1024, length: 1024 * 1024 },
      { offset: 2 * 1024 * 1024, length: 257 },
    ]);
    expect(progress.at(-1)?.controlledPeakBytes).toBe(1024 * 1024);
    expect(disposed).toEqual(["process", "sandbox"]);
  });

  it("disposes transient Sandbox RPC results immediately on success and failure", async () => {
    const disposed: string[] = [];
    const scope = new TrustedBuildPassResourceScope(1);
    const success = await consumeTrustedBuildRpcResult(
      scope,
      Promise.resolve({ value: "ok", [Symbol.dispose]: () => disposed.push("success") }),
      (result) => result.value,
    );
    expect(success).toBe("ok");
    expect(disposed).toEqual(["success"]);

    await expect(
      consumeTrustedBuildRpcResult(
        scope,
        Promise.resolve({ [Symbol.dispose]: () => disposed.push("failure") }),
        () => {
          throw new Error("simulated attempt termination");
        },
      ),
    ).rejects.toThrow("simulated attempt termination");
    expect(disposed).toEqual(["success", "failure"]);
    await scope.close();
    expect(disposed).toEqual(["success", "failure"]);
  });

  it("initializes and destroys unique build cells without process-wide kill RPCs", async () => {
    const calls: string[] = [];
    const sandbox = {
      async setKeepAlive(value: boolean) {
        calls.push(`keepalive:${value}`);
      },
      async exec() {
        calls.push("filesystem-initialize");
        return { success: true };
      },
      async killAllProcesses() {
        throw new Error("fresh cells must not invoke process-wide cleanup");
      },
      async destroy() {
        calls.push("destroy");
      },
    };
    const stages: string[] = [];
    await initializeFreshBuildSandbox(
      sandbox as unknown as Parameters<typeof initializeFreshBuildSandbox>[0],
      "/workspace/.nabuflow-build/pbuild_fixture/pass-1",
      async (stage, outcome) => {
        stages.push(`${stage}:${outcome}`);
      },
    );
    await destroyFreshBuildSandbox(
      sandbox as unknown as Parameters<typeof destroyFreshBuildSandbox>[0],
    );
    expect(calls).toEqual(["keepalive:true", "filesystem-initialize", "destroy"]);
    expect(stages).toEqual([
      "keepalive:started",
      "keepalive:succeeded",
      "filesystem-initialize:started",
      "filesystem-initialize:succeeded",
    ]);
    expect(ContainerProxy).toBeTypeOf("function");
  });

  it("preserves the precise initialization stage when the container transport is unavailable", async () => {
    const sandbox = {
      async setKeepAlive() {},
      async exec() {
        const error = new Error("provider transport detail");
        error.name = "OperationInterruptedError";
        throw error;
      },
    };
    const stages: string[] = [];
    await expect(
      initializeFreshBuildSandbox(
        sandbox as unknown as Parameters<typeof initializeFreshBuildSandbox>[0],
        "/workspace/.nabuflow-build/pbuild_fixture/pass-1",
        async (stage, outcome) => {
          stages.push(`${stage}:${outcome}`);
        },
      ),
    ).rejects.toMatchObject({
      name: TrustedBuildCellError.name,
      code: "build_unavailable",
      stage: "filesystem-initialize",
    });
    expect(stages).toEqual([
      "keepalive:started",
      "keepalive:succeeded",
      "filesystem-initialize:started",
      "filesystem-initialize:failed",
    ]);
  });

  it("bounds and scrubs persisted command-output evidence", () => {
    const diagnostic = sanitizeBuildDiagnosticText(
      `${"prefix".repeat(1_000)}\nsk_test_ABCDEFGHIJKLMNOPQRST\npostgresql://user:password@db.example/test`,
      256,
    );
    expect(diagnostic.length).toBeLessThanOrEqual(256);
    expect(diagnostic).toContain("[REDACTED_STRIPE_KEY]");
    expect(diagnostic).toContain("postgresql://[REDACTED]@");
    expect(diagnostic).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(diagnostic).not.toContain("password");
  });

  it("runs the pipeline through a shell instead of execing its first builtin", () => {
    const command = trustedBuildExecutionCommand(
      "set -eu; printf install; npm install --offline",
      "/workspace/captured/resources.json",
    );
    expect(command).not.toContain("exec set -eu");
    expect(command).toContain("set -eu; printf install; npm install --offline");
    expect(command).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(command).toContain("NABUFLOW_BUILD_SECRETLESS=1");
  });

  it("retains package bins in the sealed registry and verifies every executable on PATH", () => {
    const version = trustedBuildRegistryVersion({
      name: "node-gyp-build",
      version: "4.8.4",
      sha256: "a".repeat(64),
      integrity: "sha512-fixture",
      bins: { "node-gyp-build": "bin.js", "node-gyp-build-test": "build-test.js" },
      dependencies: [],
      lifecycleScripts: "absent",
      bytes: 0,
    });
    expect(version.bin).toEqual({
      "node-gyp-build": "bin.js",
      "node-gyp-build-test": "build-test.js",
    });

    const command = trustedBuildBinVerificationCommand("/workspace/source/node_modules/.bin", [
      "node-gyp-build-test",
      "node-gyp-build",
      "node-gyp-build",
    ]);
    expect(command.match(/test -x/g)).toHaveLength(2);
    expect(command.match(/command -v/g)).toHaveLength(2);
    expect(command.indexOf("command -v 'node-gyp-build' >/dev/null")).toBeLessThan(
      command.indexOf("command -v 'node-gyp-build-test' >/dev/null"),
    );
    expect(command).toContain(
      "PATH='/workspace/source/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
    );
  });

  it("emits byte-deterministic executable bin shims with relative target and process passthrough", () => {
    const first = trustedBuildBinShim("../node-gyp-build/bin.js");
    const second = trustedBuildBinShim("../node-gyp-build/bin.js");
    const text = new TextDecoder().decode(first.bytes);
    expect(first.mode).toBe(0o755);
    expect(first.bytes).toEqual(second.bytes);
    expect(text).toBe(
      "#!/bin/sh\n" +
        "set -eu\n" +
        'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n' +
        "target='../node-gyp-build/bin.js'\n" +
        'exec "$basedir/$target" "$@"\n',
    );
    expect(text).not.toMatch(/\/workspace|[A-Z]:\\/u);
  });

  it("keeps the output collector fail-closed for symlinks and every other non-regular entry", () => {
    expect(() =>
      assertTrustedBuildOutputEntries([{ type: "file", relativePath: "node_modules/.bin/tool" }]),
    ).not.toThrow();
    for (const type of ["symlink", "socket", "fifo", "block-device", "character-device"]) {
      expect(() =>
        assertTrustedBuildOutputEntries([{ type, relativePath: "node_modules/.bin/tool" }]),
      ).toThrow(
        expect.objectContaining({
          name: TrustedBuildCellError.name,
          code: "build_failed",
          message: "Build output contains a forbidden entry",
        }),
      );
    }
  });

  it("aggregates output deterministically and authoritatively reconstructs every file", async () => {
    const files = [
      { path: "z.bin", mode: 0o644 as const, bytes: new Uint8Array([0, 255, 1]) },
      { path: "a/run.mjs", mode: 0o755 as const, bytes: new TextEncoder().encode("ok") },
    ];
    const first = await createTrustedBuildCollection(files);
    const second = await createTrustedBuildCollection([...files].reverse());
    expect(first.manifestBytes).toEqual(second.manifestBytes);
    expect([...first.chunks]).toEqual([...second.chunks]);
    await expect(verifyTrustedBuildCollection(first)).resolves.toEqual([files[1], files[0]]);
  });

  it("rejects any aggregate tamper and re-enforces trusted-side path, mode, and entry posture", async () => {
    const sealed = await createTrustedBuildCollection([
      { path: "app.mjs", mode: 0o644, bytes: new TextEncoder().encode("safe") },
    ]);
    const tamperedChunks = new Map(sealed.chunks);
    const [name, original] = [...tamperedChunks][0];
    const modified = new Uint8Array(original);
    modified[0] ^= 1;
    tamperedChunks.set(name, modified);
    await expect(
      verifyTrustedBuildCollection({ ...sealed, chunks: tamperedChunks }),
    ).rejects.toMatchObject({ code: "build_failed", stage: "output-collection" });

    const originalManifest = JSON.parse(new TextDecoder().decode(sealed.manifestBytes)) as {
      files: Array<Record<string, unknown>>;
    };
    for (const mutation of [{ path: "../escape" }, { mode: 0o600 }, { type: "symlink" }]) {
      const manifest = structuredClone(originalManifest);
      Object.assign(manifest.files[0], mutation);
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      await expect(
        verifyTrustedBuildCollection({
          manifestBytes,
          manifestSha256: await sha256Hex(manifestBytes),
          chunks: sealed.chunks,
        }),
      ).rejects.toMatchObject({ code: "build_failed" });
    }
  });

  it("skips byte-identical shelf content but catches a cross-chunk marker after modification", async () => {
    const publicBytes = new TextEncoder().encode("public registry package bytes");
    const publicSha256 = await sha256Hex(publicBytes);
    expect(
      scanTrustedBuildFileStream({
        path: "node_modules/public/index.js",
        sha256: publicSha256,
        scope: "dependency",
        chunks: [publicBytes],
        shelfContentSha256: new Set([publicSha256]),
      }),
    ).toEqual({ findings: [], scannedBytes: 0, shelfExempt: true });

    const modified = new TextEncoder().encode("prefix sk_test_ABCDEFGHIJKLMNOP suffix");
    const modifiedSha256 = await sha256Hex(modified);
    const result = scanTrustedBuildFileStream({
      path: "node_modules/public/index.js",
      sha256: modifiedSha256,
      scope: "dependency",
      chunks: [modified.slice(0, 13), modified.slice(13)],
      shelfContentSha256: new Set([publicSha256]),
    });
    expect(result.shelfExempt).toBe(false);
    expect(result.scannedBytes).toBe(modified.byteLength);
    expect(result.findings).toEqual([
      expect.objectContaining({
        ruleId: "stripe-secret-key",
        byteOffset: 7,
        provenance: "not-shelf-byte-identical",
      }),
    ]);
    expect(JSON.stringify(result.findings)).not.toContain("sk_test_");
  });

  it("coalesces requests, executes two offline passes, attests, and serves verified chunks", async () => {
    const { env, shelf, queued } = await fixtureEnv();
    const coordinator = new MemoryBuildCoordinator();
    const request = await buildRequest(shelf);
    const begin = () =>
      handleTrustedBuildWorkerRequest(
        new Request("https://build.internal/internal/v1/builds", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-nabuflow-build-principal": "build-control",
          },
          body: JSON.stringify(request),
        }),
        env,
        { coordinator, now: () => new Date(NOW) },
      );
    expect((await begin()).status).toBe(201);
    expect((await begin()).status).toBe(200);
    expect(queued).toHaveLength(1);

    let acked = 0;
    await handleTrustedBuildQueue(
      {
        messages: [
          {
            body: queued[0],
            ack() {
              acked += 1;
            },
            retry() {
              throw new Error("unexpected retry");
            },
          },
        ],
      } as unknown as MessageBatch<never>,
      env,
      {
        coordinator,
        cellFactory: () => fakeCell(undefined, env.TRUSTED_BUILD_OBJECTS),
        now: () => new Date(NOW),
      },
    );
    expect(acked).toBe(1);
    const status = await handleTrustedBuildWorkerRequest(
      new Request(`https://build.internal/internal/v1/builds/${request.input.buildId}`, {
        headers: { "x-nabuflow-build-principal": "build-readonly" },
      }),
      env,
      { coordinator },
    );
    const statusText = await status.text();
    expect(status.status, statusText).toBe(200);
    const body = JSON.parse(statusText) as { state: string; output: TrustedBuildOutput };
    expect(body.state).toBe("succeeded");
    expect(body.output.coldBuild).toBe(true);
    expect(body.output.upstreamRequests).toBe(0);
    expect(body.output.layers).toHaveLength(1);
    const completedRecord = await coordinator.get(request.input.buildId);
    expect(
      completedRecord?.attempts[0].verificationProgress.map((progress) => progress.phase),
    ).toEqual([
      "collection-complete",
      "transition-requested",
      "transition-completed",
      "verification-start-invoked",
      "verification-start-received",
      "preparation-completed",
    ]);
    expect(completedRecord?.attempts[0].progression).toContainEqual({
      pass: null,
      stage: "output-verification",
      outcome: "started",
    });
    await expect(
      verifyPantryBuildAttestation(
        body.output.buildAttestation,
        new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
        shelf.revision.content.closure.platform,
      ),
    ).resolves.toEqual({ ok: true });

    const contentSha256 = await sha256Hex(canonicalPantryJson(body.output.app.content));
    const chunk = await handleTrustedBuildWorkerRequest(
      new Request(
        `https://build.internal/internal/v1/builds/${request.input.buildId}/outputs/app/${contentSha256}/chunks/0`,
        { headers: { "x-nabuflow-build-principal": "build-readonly" } },
      ),
      env,
      { coordinator },
    );
    expect(chunk.status).toBe(200);
    await expect(chunk.json()).resolves.toMatchObject({ ok: true, scope: "app", chunkIndex: 0 });
    expect((await coordinator.diagnostics()).coalescedRequests).toBe(1);
  });

  it("fails reproducibility mismatch and secret-bearing output with typed sanitized errors", async () => {
    for (const [marker, cell] of [
      ["b", fakeCell({ mismatch: true })],
      ["c", fakeCell({ secret: true })],
    ] as const) {
      const { env, shelf, queued } = await fixtureEnv();
      const coordinator = new MemoryBuildCoordinator();
      const request = await buildRequest(shelf, marker);
      await handleTrustedBuildWorkerRequest(
        new Request("https://build.internal/internal/v1/builds", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-nabuflow-build-principal": "build-control",
          },
          body: JSON.stringify(request),
        }),
        env,
        { coordinator, now: () => new Date(NOW) },
      );
      await handleTrustedBuildQueue(
        {
          messages: [
            {
              body: queued[0],
              ack() {},
              retry() {
                throw new Error("unexpected retry");
              },
            },
          ],
        } as unknown as MessageBatch<never>,
        env,
        { coordinator, cellFactory: () => cell, now: () => new Date(NOW) },
      );
      const record = await coordinator.get(request.input.buildId);
      expect(record?.state).toBe("failed");
      expect(record?.failure?.code).toBe(marker === "b" ? "attestation_invalid" : "build_failed");
      expect(JSON.stringify(record?.failure)).not.toContain("sk_test_");
      if (marker === "c") {
        expect(record?.attempts[0].secretScanFindings).toEqual([
          expect.objectContaining({
            scope: "dependency",
            path: "@fixture/heavy-app/index.js",
            ruleId: "stripe-secret-key",
            contentSha256Prefix: expect.stringMatching(/^[0-9a-f]{16}$/u),
            byteOffset: 11,
            provenance: "not-shelf-byte-identical",
          }),
        ]);
        expect(JSON.stringify(record?.attempts[0].secretScanFindings)).not.toContain("sk_test_");
      }
    }
  });

  it("rejects unsigned principals, wrong platform, source secrets, and queue backpressure", async () => {
    const { env, shelf } = await fixtureEnv();
    const coordinator = new MemoryBuildCoordinator();
    const request = await buildRequest(shelf, "d");
    const noPrincipal = await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
      env,
      { coordinator },
    );
    expect(noPrincipal.status).toBe(403);

    const wrongPlatform = structuredClone(request);
    wrongPlatform.input.platform.nodeAbi = "999";
    const wrong = await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nabuflow-build-principal": "build-control",
        },
        body: JSON.stringify(wrongPlatform),
      }),
      env,
      { coordinator },
    );
    expect(wrong.status).toBe(422);

    const sourceSecret = structuredClone(request);
    const secretBytes = new TextEncoder().encode("sk_test_ABCDEFGHIJKLMNOP");
    sourceSecret.source.payloadBase64 = base64(secretBytes);
    sourceSecret.source.manifest = {
      ...sourceSecret.source.manifest,
      payloadBytes: secretBytes.length,
      files: [
        {
          path: "index.js",
          mode: 0o644,
          offset: 0,
          size: secretBytes.length,
          sha256: await sha256Hex(secretBytes),
        },
      ],
    };
    sourceSecret.input.sourceArtifactSha256 = await trustedBuildSourceManifestHash(
      sourceSecret.source.manifest,
    );
    sourceSecret.requestId = `pbuildreq_${await trustedBuildRequestHash((({ requestId: _id, ...rest }) => rest)(sourceSecret))}`;
    const secretResponse = await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nabuflow-build-principal": "build-control",
        },
        body: JSON.stringify(sourceSecret),
      }),
      env,
      { coordinator },
    );
    expect(secretResponse.status).toBe(422);
    expect(JSON.stringify(await secretResponse.json())).not.toContain("sk_test_");

    env.TRUSTED_BUILD_MAX_ACTIVE = "1";
    const first = await buildRequest(shelf, "e");
    const second = await buildRequest(shelf, "f");
    const send = (body: TrustedBuildRequest) =>
      handleTrustedBuildWorkerRequest(
        new Request("https://build.internal/internal/v1/builds", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-nabuflow-build-principal": "build-control",
          },
          body: JSON.stringify(body),
        }),
        env,
        { coordinator, now: () => new Date(NOW) },
      );
    expect((await send(first)).status).toBe(201);
    expect((await send(second)).status).toBe(503);
  });

  it("cancels queued work and reports metadata-only diagnostics", async () => {
    const { env, shelf } = await fixtureEnv();
    const coordinator = new MemoryBuildCoordinator();
    const request = await buildRequest(shelf, "g");
    await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nabuflow-build-principal": "build-control",
        },
        body: JSON.stringify(request),
      }),
      env,
      { coordinator, now: () => new Date(NOW) },
    );
    const cancelled = await handleTrustedBuildWorkerRequest(
      new Request(`https://build.internal/internal/v1/builds/${request.input.buildId}`, {
        method: "DELETE",
        headers: { "x-nabuflow-build-principal": "build-control" },
      }),
      env,
      { coordinator, now: () => new Date(NOW) },
    );
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ state: "cancelled" });
    const diagnostics = await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/diagnostics", {
        headers: { "x-nabuflow-build-principal": "build-control" },
      }),
      env,
      { coordinator },
    );
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      ledger: { cancelled: 1, running: 0 },
      activeCells: 0,
    });
  });

  it("uses fresh queue messages for logical retries and never orphans queued work", async () => {
    const { env, shelf, queued } = await fixtureEnv();
    const coordinator = new MemoryBuildCoordinator();
    const request = await buildRequest(shelf, "h");
    await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nabuflow-build-principal": "build-control",
        },
        body: JSON.stringify(request),
      }),
      env,
      { coordinator, now: () => new Date(NOW) },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let acked = 0;
        let transportRetried = false;
        await handleTrustedBuildQueue(
          {
            messages: [
              {
                body: queued[attempt],
                ack() {
                  acked += 1;
                },
                retry() {
                  transportRetried = true;
                },
              },
            ],
          } as unknown as MessageBatch<never>,
          env,
          {
            coordinator,
            cellFactory: () => fakeCell({ fail: true }),
            now: () => new Date(NOW),
          },
        );
        expect(acked).toBe(1);
        expect(transportRetried).toBe(false);
      }
    } finally {
      error.mockRestore();
    }
    expect(queued).toHaveLength(3);
    await expect(coordinator.get(request.input.buildId)).resolves.toMatchObject({
      state: "failed",
      attempt: 3,
      failure: { code: "build_unavailable" },
      attempts: [
        {
          attempt: 1,
          lastSuccessfulStage: null,
          failingStage: { pass: 1, stage: "initialize" },
          error: { code: "build_unavailable", status: 503 },
        },
        {
          attempt: 2,
          lastSuccessfulStage: null,
          failingStage: { pass: 1, stage: "initialize" },
          error: { code: "build_unavailable", status: 503 },
        },
        {
          attempt: 3,
          lastSuccessfulStage: null,
          failingStage: { pass: 1, stage: "initialize" },
          error: { code: "build_unavailable", status: 503 },
        },
      ],
    });
    const status = await handleTrustedBuildWorkerRequest(
      new Request(`https://build.internal/internal/v1/builds/${request.input.buildId}`, {
        headers: { "x-nabuflow-build-principal": "build-readonly" },
      }),
      env,
      { coordinator },
    );
    // Keep the response contract assertion explicit: durable attempt evidence must remain parseable.
    expect(
      status.status,
      JSON.stringify((await coordinator.get(request.input.buildId))?.attempts),
    ).toBe(200);
    const body = (await status.json()) as { attempts: unknown[] };
    expect(body.attempts).toHaveLength(3);
    expect(JSON.stringify(body.attempts)).not.toContain("fixture internal detail");
  });

  it("retains a redelivered message through a live lease and recovers after consumer death", async () => {
    const { env, shelf, queued } = await fixtureEnv();
    const coordinator = new MemoryBuildCoordinator();
    const request = await buildRequest(shelf, "r");
    await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nabuflow-build-principal": "build-control",
        },
        body: JSON.stringify(request),
      }),
      env,
      { coordinator, now: () => new Date(NOW) },
    );
    const leaseUntil = new Date(NOW.getTime() + 60_000).toISOString();
    const claimed = await coordinator.claim(request.input.buildId, NOW.toISOString(), leaseUntil);
    expect(claimed.state).toBe("claimed");
    await coordinator.transition(
      request.input.buildId,
      1,
      "resolving",
      "building",
      NOW.toISOString(),
    );
    await coordinator.transition(
      request.input.buildId,
      1,
      "building",
      "verifying",
      NOW.toISOString(),
    );
    let retries = 0;
    let acknowledgements = 0;
    const delivery = () =>
      ({
        body: queued[0],
        ack() {
          acknowledgements += 1;
        },
        retry() {
          retries += 1;
        },
      }) as unknown as Message<never>;
    await handleTrustedBuildQueue(
      { messages: [delivery()] } as unknown as MessageBatch<never>,
      env,
      { coordinator, now: () => new Date(NOW.getTime() + 1_000) },
    );
    expect(retries).toBe(0);
    expect(acknowledgements).toBe(1);
    expect(queued).toHaveLength(2);
    expect((await coordinator.get(request.input.buildId))?.state).toBe("verifying");

    await handleTrustedBuildQueue(
      {
        messages: [
          {
            ...delivery(),
            body: queued[1],
          },
        ],
      } as unknown as MessageBatch<never>,
      env,
      {
        coordinator,
        cellFactory: () => fakeCell(undefined, env.TRUSTED_BUILD_OBJECTS),
        now: () => new Date(NOW.getTime() + 61_000),
      },
    );
    const recovered = await coordinator.get(request.input.buildId);
    expect(recovered?.state).toBe("succeeded");
    expect(recovered?.attempt).toBe(2);
    expect(acknowledgements).toBe(2);
  });

  it("leaves a staging consumer-death probe unacknowledged and recovers on a later attempt", async () => {
    const { env, shelf, queued } = await fixtureEnv();
    const coordinator = new MemoryBuildCoordinator();
    const request = await buildRequest(shelf, "l");
    request.input.buildId = `pbuild_liveconsumerdeath_${"x".repeat(22)}`;
    const { requestId: _oldRequestId, ...unsigned } = request;
    request.requestId = `pbuildreq_${await trustedBuildRequestHash(unsigned)}`;
    env.TRUSTED_BUILD_STAGING_LIVE_RECOVERY_PROBE = "enabled";
    const begin = await handleTrustedBuildWorkerRequest(
      new Request("https://build.internal/internal/v1/builds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nabuflow-build-principal": "build-control",
        },
        body: JSON.stringify(request),
      }),
      env,
      { coordinator, now: () => new Date(NOW) },
    );
    expect(begin.status).toBe(201);
    let acknowledgements = 0;
    const delivery = {
      body: queued[0],
      ack() {
        acknowledgements += 1;
      },
      retry() {
        throw new Error("logical recovery must not spend transport retries");
      },
    } as unknown as Message<never>;
    const interruptedCell: TrustedBuildCell = {
      async build(_input, _pass, onStage) {
        await onStage?.("initialize", "started");
        await onStage?.("initialize", "succeeded");
        await onStage?.("install", "started");
        throw new Error("fault probe callback should have terminated the event");
      },
      async destroy() {},
    };
    await expect(
      handleTrustedBuildQueue({ messages: [delivery] } as unknown as MessageBatch<never>, env, {
        coordinator,
        cellFactory: () => interruptedCell,
        now: () => new Date(NOW),
      }),
    ).rejects.toMatchObject({ name: "StagingLiveRecoveryProbeError" });
    expect(acknowledgements).toBe(0);
    expect((await coordinator.get(request.input.buildId))?.state).toBe("building");
    expect((await coordinator.get(request.input.buildId))?.attempt).toBe(1);

    env.TRUSTED_BUILD_STAGING_LIVE_RECOVERY_PROBE = undefined;
    await handleTrustedBuildQueue(
      {
        messages: [
          {
            ...delivery,
            body: queued[0],
          },
        ],
      } as unknown as MessageBatch<never>,
      env,
      {
        coordinator,
        cellFactory: () => fakeCell(undefined, env.TRUSTED_BUILD_OBJECTS),
        now: () => new Date(NOW.getTime() + 91_000),
      },
    );
    const recovered = await coordinator.get(request.input.buildId);
    expect(recovered?.state).toBe("succeeded");
    expect(recovered?.attempt).toBe(2);
    expect(acknowledgements).toBe(1);
  });
});
