import {
  PANTRY_CATALOG_SCHEMA_VERSION,
  PANTRY_ERROR_DEFAULTS,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_MAX_REQUEST_BYTES,
  canonicalPantryJson,
  pantryCatalogReferenceRequestSchema,
  pantryCatalogShelfRecordSchema,
  pantryBuildInputSchema,
  pantryPackageIntentSchema,
  pantryErrorStatus,
  pantryPlatformSchema,
  pantryRevisionIsCommittable,
  sha256Hex,
  trustedBuildDependencyIntentHash,
  trustedBuildBeginResponseSchema,
  trustedBuildCancelResponseSchema,
  trustedBuildChunkResponseSchema,
  trustedBuildDiagnosticsResponseSchema,
  trustedBuildGcRequestSchema,
  trustedBuildOutputSchema,
  trustedBuildRequestSchema,
  trustedBuildSourceManifestHash,
  trustedBuildSourceManifestSchema,
  trustedBuildStatusResponseSchema,
  verifyTrustedBuildRequest,
  verifyPantryRevisionRecord,
  type PantryCatalogErrorResponse,
  type PantryCatalogShelfRecord,
  type PantryErrorCode,
  type TrustedBuildOutput,
  type TrustedBuildRequest,
} from "@workspace/tenant-runtime-contracts";
import { memoryUsage } from "node:process";
import {
  CloudflareTrustedBuildCell,
  TrustedBuildCellError,
  trustedBuildSandboxCellId,
} from "./trusted-build-cell";
import type { TrustedBuildDurableObject } from "./trusted-build-durable-object";
import {
  TRUSTED_BUILD_MAX_ATTEMPTS,
  TRUSTED_BUILD_OPERATION_BOUND_MS,
} from "./trusted-build-model";
import type {
  StoredTrustedBuild,
  TrustedBuildCell,
  TrustedBuildCoordinator,
  TrustedBuildFailure,
  TrustedBuildQueueMessage,
  TrustedBuildRequestMetadata,
  TrustedBuildWorkerBindings,
} from "./trusted-build-model";
import { prepareTrustedBuildOutput, TrustedBuildOutputError } from "./trusted-build-output";
import {
  deleteAgedTrustedBuildQuarantine,
  deleteTrustedBuildPrefix,
  listTrustedBuildObjects,
  putTrustedBuildObject,
  readTrustedBuildObject,
  trustedBuildOutputChunkKey,
  trustedBuildOutputMetadataKey,
  trustedBuildRequestObjectKey,
  trustedBuildSourceObjectKey,
} from "./trusted-build-storage";

const INTERNAL_PREFIX = "/internal/v1";
const PRINCIPAL_HEADER = "x-nabuflow-build-principal";
const MAX_JSON_BYTES = TRUSTED_BUILD_MAX_REQUEST_BYTES;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const BUILD_LEASE_MS = 90_000;
const BUILD_LEASE_RENEW_MS = 30_000;
const NEGATIVE_CACHE_MS = 5 * 60 * 1_000;
const LIVE_RECOVERY_BUILD_PREFIX = "pbuild_liveconsumerdeath_";
export const MAX_BUILD_ATTEMPTS = TRUSTED_BUILD_MAX_ATTEMPTS;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

async function recordWorkerMemoryProgress(
  coordinator: TrustedBuildCoordinator,
  buildId: string,
  attempt: number,
  controlledPeakBytes: number,
): Promise<void> {
  let runtimePeakBytes: number | null = null;
  let heapUsedBytes: number | null = null;
  let arrayBuffersBytes: number | null = null;
  try {
    const snapshot = memoryUsage();
    runtimePeakBytes = Number.isSafeInteger(snapshot.rss) ? snapshot.rss : null;
    heapUsedBytes = Number.isSafeInteger(snapshot.heapUsed) ? snapshot.heapUsed : null;
    arrayBuffersBytes = Number.isSafeInteger(snapshot.arrayBuffers) ? snapshot.arrayBuffers : null;
  } catch {
    // Some Worker compatibility revisions do not expose process memory counters.
  }
  await coordinator.recordMemoryProgress(buildId, attempt, {
    pass: null,
    phase: "verification",
    controlledPeakBytes,
    runtimePeakBytes,
    heapUsedBytes,
    arrayBuffersBytes,
    samples: 1,
    recordedAt: new Date().toISOString(),
  });
}

type BuildPrincipal = "build-control" | "build-readonly" | "build-gc";

class TrustedBuildHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | PantryErrorCode
      | "build_not_found"
      | "build_forbidden"
      | "build_invalid_request",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TrustedBuildHttpError";
  }
}

class StagingLiveRecoveryProbeError extends Error {
  constructor() {
    super("Staging trusted-build consumer termination probe");
    this.name = "StagingLiveRecoveryProbeError";
  }
}

function maybeTerminateStagingConsumer(
  env: TrustedBuildWorkerBindings,
  buildId: string,
  attempt: number,
  pass: 1 | 2,
  stage: Parameters<TrustedBuildCoordinator["recordStage"]>[3],
  outcome: Parameters<TrustedBuildCoordinator["recordStage"]>[4],
): void {
  if (
    env.TRUSTED_BUILD_STAGING_LIVE_RECOVERY_PROBE === "enabled" &&
    buildId.startsWith(LIVE_RECOVERY_BUILD_PREFIX) &&
    attempt === 1 &&
    pass === 1 &&
    stage === "install" &&
    outcome === "started"
  ) {
    throw new StagingLiveRecoveryProbeError();
  }
}

export interface TrustedBuildWorkerDependencies {
  coordinator?: TrustedBuildCoordinator;
  cellFactory?: (buildId: string, pass: 1 | 2) => TrustedBuildCell;
  now?: () => Date;
}

function getCoordinator(
  env: TrustedBuildWorkerBindings,
): DurableObjectStub<TrustedBuildDurableObject> {
  return env.TRUSTED_BUILD_COORDINATOR.get(
    env.TRUSTED_BUILD_COORDINATOR.idFromName("trusted-build-v1"),
  );
}

function requirePrincipal(request: Request, allowed: readonly BuildPrincipal[]): BuildPrincipal {
  const principal = request.headers.get(PRINCIPAL_HEADER);
  if (principal === null || !allowed.includes(principal as BuildPrincipal)) {
    throw new TrustedBuildHttpError(403, "build_forbidden", "Trusted build access is denied");
  }
  return principal as BuildPrincipal;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: TrustedBuildHttpError, requestId: string): Response {
  return jsonResponse(error.status, {
    ok: false,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId,
  });
}

async function readCappedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new TrustedBuildHttpError(413, "build_invalid_request", "Build request is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) {
    throw new TrustedBuildHttpError(413, "build_invalid_request", "Build request is too large");
  }
  return bytes;
}

async function readJson(request: Request, limit = MAX_JSON_BYTES): Promise<unknown> {
  const bytes = await readCappedBytes(request, limit);
  if (bytes.byteLength === 0) {
    throw new TrustedBuildHttpError(400, "build_invalid_request", "A JSON body is required");
  }
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new TrustedBuildHttpError(400, "build_invalid_request", "Build JSON is invalid");
  }
}

function parseStrict<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TrustedBuildHttpError(400, "build_invalid_request", "Build request is invalid");
  }
  return result.data;
}

function maxActive(env: TrustedBuildWorkerBindings): number {
  const value = Number(env.TRUSTED_BUILD_MAX_ACTIVE ?? "32");
  if (!Number.isInteger(value) || value < 1 || value > 256) {
    throw new TrustedBuildHttpError(
      503,
      "build_unavailable",
      "Trusted build capacity is not configured",
      true,
    );
  }
  return value;
}

function configuredSigner(env: TrustedBuildWorkerBindings): { kid: string; privateKeyPem: string } {
  if (
    typeof env.TRUSTED_BUILD_SIGNING_KEY_ID !== "string" ||
    env.TRUSTED_BUILD_SIGNING_KEY_ID.length === 0 ||
    typeof env.TRUSTED_BUILD_SIGNING_PRIVATE_KEY !== "string" ||
    !env.TRUSTED_BUILD_SIGNING_PRIVATE_KEY.includes("BEGIN PRIVATE KEY") ||
    typeof env.TRUSTED_BUILD_PUBLIC_KEYS !== "string" ||
    env.TRUSTED_BUILD_PUBLIC_KEYS.length === 0
  ) {
    throw new TrustedBuildHttpError(
      503,
      "build_unavailable",
      "Trusted build attestation is not configured",
      true,
    );
  }
  return {
    kid: env.TRUSTED_BUILD_SIGNING_KEY_ID,
    privateKeyPem: env.TRUSTED_BUILD_SIGNING_PRIVATE_KEY,
  };
}

function configuredPublicKeys(env: TrustedBuildWorkerBindings): Map<string, string> {
  try {
    const parsed = JSON.parse(env.TRUSTED_BUILD_PUBLIC_KEYS) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].includes("BEGIN PUBLIC KEY"),
    );
    if (entries.length === 0 || entries.length !== Object.keys(parsed).length) throw new Error();
    return new Map(entries);
  } catch {
    throw new TrustedBuildHttpError(
      503,
      "build_unavailable",
      "Trusted build verification is not configured",
      true,
    );
  }
}

function assertSourceSecretless(request: TrustedBuildRequest, sourcePayload: Uint8Array): void {
  const patterns = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
    /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/u,
    /\b(?:postgres|postgresql):\/\/[^\s:@/]+:[^\s@/]+@/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
  ];
  for (const file of request.source.manifest.files) {
    if (/(?:^|\/)\.env(?:\.|$)/u.test(file.path)) {
      throw new TrustedBuildHttpError(422, "build_failed", "Build source secret scan failed");
    }
    const bytes = sourcePayload.slice(file.offset, file.offset + file.size);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (patterns.some((pattern) => pattern.test(text))) {
      throw new TrustedBuildHttpError(422, "build_failed", "Build source secret scan failed");
    }
  }
}

async function pantryRequest(
  env: TrustedBuildWorkerBindings,
  path: string,
  init: RequestInit,
  principal: "builder-readonly" | "catalog-admin",
): Promise<Response> {
  if (!env.PANTRY_CATALOG || typeof env.PANTRY_CATALOG.fetch !== "function") {
    throw new TrustedBuildHttpError(
      503,
      "build_unavailable",
      "Pantry is not configured for trusted builds",
      true,
    );
  }
  try {
    const headers = new Headers(init.headers);
    headers.set("x-nabuflow-pantry-principal", principal);
    return await env.PANTRY_CATALOG.fetch(
      new Request(`https://pantry.internal/internal/v1${path}`, {
        ...init,
        headers,
      }),
    );
  } catch {
    throw new TrustedBuildHttpError(
      503,
      "build_unavailable",
      "Pantry is unavailable for trusted builds",
      true,
    );
  }
}

async function pantryError(response: Response): Promise<never> {
  let body: PantryCatalogErrorResponse | null = null;
  try {
    body = (await response.json()) as PantryCatalogErrorResponse;
  } catch {
    // The trusted boundary deliberately replaces malformed dependency-service errors.
  }
  if (response.status === 404) {
    throw new TrustedBuildHttpError(
      409,
      "revision_not_committed",
      "The requested Pantry revision is not committed",
    );
  }
  throw new TrustedBuildHttpError(
    response.status >= 500 ? response.status : 503,
    "build_unavailable",
    "The Pantry could not satisfy the trusted build",
    response.status >= 500 || body?.retryable === true,
  );
}

async function loadShelf(
  env: TrustedBuildWorkerBindings,
  request: TrustedBuildRequestMetadata,
): Promise<PantryCatalogShelfRecord> {
  const response = await pantryRequest(
    env,
    `/revisions/by-root/${request.input.pantryRevisionRootSha256}`,
    { method: "GET" },
    "builder-readonly",
  );
  if (!response.ok) return pantryError(response);
  const body = (await response.json()) as { shelf?: unknown; lifecycle?: { state?: unknown } };
  const parsed = pantryCatalogShelfRecordSchema.safeParse(body.shelf);
  if (!parsed.success || body.lifecycle?.state !== "committed") {
    throw new TrustedBuildHttpError(
      409,
      "revision_not_committed",
      "The requested Pantry revision is not committed",
    );
  }
  const shelf = parsed.data;
  const input = request.input;
  if (
    shelf.revision.content.revisionId !== input.pantryRevisionId ||
    shelf.revision.rootSha256 !== input.pantryRevisionRootSha256 ||
    shelf.revision.content.dependencyClosureSha256 !== input.dependencyClosureSha256 ||
    shelf.lockfileSha256 !== input.lockfileSha256 ||
    canonicalPantryJson(shelf.revision.content.closure.platform) !==
      canonicalPantryJson(pantryPlatformSchema.parse(input.platform))
  ) {
    throw new TrustedBuildHttpError(
      422,
      "build_platform_mismatch",
      "The build input does not match its immutable Pantry shelf",
    );
  }
  const revisionVerification = await verifyPantryRevisionRecord(
    shelf.revision,
    configuredPublicKeys(env),
  );
  if (!revisionVerification.ok || !pantryRevisionIsCommittable(shelf.revision.content)) {
    throw new TrustedBuildHttpError(
      422,
      "attestation_invalid",
      "The Pantry shelf is not eligible for a trusted build",
    );
  }
  return shelf;
}

function packageTarballDescriptors(shelf: PantryCatalogShelfRecord): Array<{
  name: string;
  version: string;
  sha256: string;
  integrity: string;
  bins: Readonly<Record<string, string>>;
  dependencies: PantryCatalogShelfRecord["revision"]["content"]["closure"]["ingredients"][number]["dependencies"];
  lifecycleScripts: "absent" | "disabled" | "isolated-passed" | "isolated-failed";
  bytes: number;
}> {
  const objectAddresses = new Map(
    shelf.objectReferences.map((reference) => [reference.sha256, reference.bytes]),
  );
  const output: Array<{
    name: string;
    version: string;
    sha256: string;
    integrity: string;
    bins: Readonly<Record<string, string>>;
    dependencies: PantryCatalogShelfRecord["revision"]["content"]["closure"]["ingredients"][number]["dependencies"];
    lifecycleScripts: "absent" | "disabled" | "isolated-passed" | "isolated-failed";
    bytes: number;
  }> = [];
  for (const ingredient of shelf.revision.content.closure.ingredients) {
    const bytes = objectAddresses.get(ingredient.tarballSha256);
    if (bytes === undefined || bytes > MAX_OBJECT_BYTES) {
      throw new TrustedBuildHttpError(503, "layer_missing", "A Pantry ingredient is missing", true);
    }
    output.push({
      name: ingredient.package.name,
      version: ingredient.package.version,
      sha256: ingredient.tarballSha256,
      integrity: ingredient.integrity,
      bins: ingredient.bins ?? {},
      dependencies: ingredient.dependencies,
      lifecycleScripts: ingredient.lifecycleScripts,
      bytes,
    });
  }
  return output;
}

async function loadShelfPublicContentHashes(
  env: TrustedBuildWorkerBindings,
  shelf: PantryCatalogShelfRecord,
): Promise<{ hashes: Set<string>; objectReads: number }> {
  const hashes = new Set<string>();
  const addresses = [
    ...new Set(
      shelf.revision.content.closure.ingredients.map(
        (ingredient) => ingredient.normalizedContentSha256,
      ),
    ),
  ];
  const objectAddresses = new Set(shelf.objectReferences.map((reference) => reference.sha256));
  for (const address of addresses) {
    if (!objectAddresses.has(address)) {
      throw new TrustedBuildHttpError(
        503,
        "layer_missing",
        "A Pantry normalized package manifest is missing",
        true,
      );
    }
    const response = await pantryRequest(
      env,
      `/objects/${address}`,
      { method: "GET" },
      "builder-readonly",
    );
    if (!response.ok) return pantryError(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_OBJECT_BYTES || (await sha256Hex(bytes)) !== address) {
      throw new TrustedBuildHttpError(
        422,
        "attestation_invalid",
        "A Pantry normalized package manifest failed verification",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(bytes));
    } catch {
      throw new TrustedBuildHttpError(
        422,
        "attestation_invalid",
        "A Pantry normalized package manifest failed verification",
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).format !== "nabu-pantry-normalized-package/v1" ||
      !Array.isArray((parsed as Record<string, unknown>).entries)
    ) {
      throw new TrustedBuildHttpError(
        422,
        "attestation_invalid",
        "A Pantry normalized package manifest failed verification",
      );
    }
    for (const entry of (parsed as { entries: unknown[] }).entries) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test((entry as { sha256: string }).sha256)
      ) {
        throw new TrustedBuildHttpError(
          422,
          "attestation_invalid",
          "A Pantry normalized package manifest failed verification",
        );
      }
      hashes.add((entry as { sha256: string }).sha256);
    }
  }
  return { hashes, objectReads: addresses.length };
}

function capturedResourceDescriptors(
  shelf: PantryCatalogShelfRecord,
): Array<{ url: string; sha256: string; mediaType: string; bytes: number }> {
  const objectAddresses = new Map(
    shelf.objectReferences.map((reference) => [reference.sha256, reference.bytes]),
  );
  const output: Array<{ url: string; sha256: string; mediaType: string; bytes: number }> = [];
  for (const resource of shelf.revision.content.capturedBuildResources ?? []) {
    const bytes = objectAddresses.get(resource.contentSha256);
    if (bytes === undefined || bytes !== resource.bytes || bytes > MAX_OBJECT_BYTES) {
      throw new TrustedBuildHttpError(
        503,
        "layer_missing",
        "A captured build resource is missing",
        true,
      );
    }
    output.push({
      url: resource.url,
      sha256: resource.contentSha256,
      mediaType: resource.mediaType,
      bytes,
    });
  }
  return output;
}

async function retainShelf(
  env: TrustedBuildWorkerBindings,
  rootSha256: string,
  buildId: string,
): Promise<void> {
  const body = pantryCatalogReferenceRequestSchema.parse({ referenceId: `build:${buildId}` });
  const response = await pantryRequest(
    env,
    `/revisions/${rootSha256}/references`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    "catalog-admin",
  );
  if (!response.ok) await pantryError(response);
}

async function releaseShelf(
  env: TrustedBuildWorkerBindings,
  rootSha256: string,
  buildId: string,
): Promise<void> {
  const body = pantryCatalogReferenceRequestSchema.parse({ referenceId: `build:${buildId}` });
  const response = await pantryRequest(
    env,
    `/revisions/${rootSha256}/references`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    "catalog-admin",
  );
  if (!response.ok && response.status !== 404) await pantryError(response);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readStoredRequestMetadata(
  env: TrustedBuildWorkerBindings,
  build: StoredTrustedBuild,
): Promise<TrustedBuildRequestMetadata> {
  const bytes = await readTrustedBuildObject(
    env.TRUSTED_BUILD_OBJECTS,
    trustedBuildRequestObjectKey(build.requestId, build.requestObjectSha256),
    build.requestObjectSha256,
    MAX_JSON_BYTES,
  );
  try {
    const raw = recordValue(JSON.parse(textDecoder.decode(bytes)));
    const source = recordValue(raw?.source);
    const output = recordValue(raw?.output);
    const input = pantryBuildInputSchema.parse(raw?.input);
    const manifest = trustedBuildSourceManifestSchema.parse(source?.manifest);
    if (
      raw?.format !== TRUSTED_BUILD_REQUEST_FORMAT ||
      raw.schemaVersion !== TRUSTED_BUILD_SCHEMA_VERSION ||
      raw.requestId !== build.requestId ||
      !Array.isArray(raw.dependencyIntents) ||
      raw.dependencyIntents.length < 1 ||
      raw.dependencyIntents.length > 1_000 ||
      output?.strategy !== "bundle-first" ||
      (output.dependencyPackaging !== "bundle" && output.dependencyPackaging !== "layer") ||
      typeof output.appDirectory !== "string" ||
      output.dependencyLayerMountPath !== "node_modules"
    ) {
      throw new Error("metadata shape");
    }
    const dependencyIntents = raw.dependencyIntents.map((intent) =>
      pantryPackageIntentSchema.parse(intent),
    );
    if (
      (await trustedBuildSourceManifestHash(manifest)) !== input.sourceArtifactSha256 ||
      (await trustedBuildDependencyIntentHash(dependencyIntents)) !== input.dependencyIntentSha256
    ) {
      throw new Error("metadata integrity");
    }
    return {
      format: TRUSTED_BUILD_REQUEST_FORMAT,
      schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
      requestId: build.requestId,
      input,
      source: { manifest },
      dependencyIntents,
      output: {
        strategy: "bundle-first",
        dependencyPackaging: output.dependencyPackaging,
        appDirectory: output.appDirectory,
        dependencyLayerMountPath: "node_modules",
      },
    };
  } catch {
    throw new TrustedBuildHttpError(422, "attestation_invalid", "Stored build input is invalid");
  }
}

async function readStoredOutput(
  env: TrustedBuildWorkerBindings,
  build: StoredTrustedBuild,
): Promise<TrustedBuildOutput | null> {
  if (build.outputObjectSha256 === null) return null;
  const bytes = await readTrustedBuildObject(
    env.TRUSTED_BUILD_OBJECTS,
    trustedBuildOutputMetadataKey(build.buildId, build.outputObjectSha256),
    build.outputObjectSha256,
    4 * 1024 * 1024,
  );
  return trustedBuildOutputSchema.parse(JSON.parse(textDecoder.decode(bytes)));
}

async function storePreparedOutput(
  env: TrustedBuildWorkerBindings,
  prepared: Awaited<ReturnType<typeof prepareTrustedBuildOutput>>,
): Promise<{ metadataSha256: string }> {
  const buildId = prepared.output.buildId;
  const appContentSha256 = await sha256Hex(canonicalPantryJson(prepared.output.app.content));
  const stagingKeys: string[] = [];
  for (const chunk of prepared.appChunks) {
    const bytes = await readTrustedBuildObject(
      env.TRUSTED_BUILD_OBJECTS,
      chunk.stagingKey,
      chunk.sha256,
      RUNTIME_ARTIFACT_CHUNK_BYTES,
    );
    if (bytes.byteLength !== chunk.bytes)
      throw new Error("Trusted build staging chunk changed size");
    await putTrustedBuildObject(
      env.TRUSTED_BUILD_OBJECTS,
      trustedBuildOutputChunkKey(buildId, "app", appContentSha256, chunk.index),
      bytes,
      chunk.sha256,
    );
    stagingKeys.push(chunk.stagingKey);
  }
  for (const layer of prepared.layerChunks) {
    for (const chunk of layer.chunks) {
      const bytes = await readTrustedBuildObject(
        env.TRUSTED_BUILD_OBJECTS,
        chunk.stagingKey,
        chunk.sha256,
        RUNTIME_ARTIFACT_CHUNK_BYTES,
      );
      if (bytes.byteLength !== chunk.bytes) {
        throw new Error("Trusted build staging chunk changed size");
      }
      await putTrustedBuildObject(
        env.TRUSTED_BUILD_OBJECTS,
        trustedBuildOutputChunkKey(buildId, "layer", layer.contentSha256, chunk.index),
        bytes,
        chunk.sha256,
      );
      stagingKeys.push(chunk.stagingKey);
    }
  }
  const metadata = textEncoder.encode(canonicalPantryJson(prepared.output));
  const metadataSha256 = await sha256Hex(metadata);
  await putTrustedBuildObject(
    env.TRUSTED_BUILD_OBJECTS,
    trustedBuildOutputMetadataKey(buildId, metadataSha256),
    metadata,
    metadataSha256,
  );
  if (stagingKeys.length > 0) await env.TRUSTED_BUILD_OBJECTS.delete(stagingKeys);
  return { metadataSha256 };
}

function typedFailure(error: unknown, now: Date): TrustedBuildFailure {
  let code: PantryErrorCode = "build_unavailable";
  let message = "The trusted build plane is unavailable";
  if (error instanceof TrustedBuildHttpError && error.code in PANTRY_ERROR_DEFAULTS) {
    code = error.code as PantryErrorCode;
    message = error.message;
  } else if (error instanceof TrustedBuildCellError || error instanceof TrustedBuildOutputError) {
    code = error.code;
    message = error.message;
  }
  const retryable = PANTRY_ERROR_DEFAULTS[code].retryable;
  return {
    code,
    message,
    retryable,
    status: pantryErrorStatus(code),
    failedAt: now.toISOString(),
    negativeCacheUntil: new Date(now.getTime() + NEGATIVE_CACHE_MS).toISOString(),
  };
}

async function executeBuild(
  env: TrustedBuildWorkerBindings,
  coordinator: TrustedBuildCoordinator,
  build: StoredTrustedBuild,
  dependencies: TrustedBuildWorkerDependencies,
): Promise<void> {
  const request = await readStoredRequestMetadata(env, build);
  const shelf = await loadShelf(env, request);
  const tarballs = packageTarballDescriptors(shelf);
  const capturedResources = capturedResourceDescriptors(shelf);
  const shelfPublicContent = await loadShelfPublicContentHashes(env, shelf);
  const transitioned = await coordinator.transition(
    build.buildId,
    build.attempt,
    "resolving",
    "building",
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );
  if (transitioned !== "updated") return;
  await deleteTrustedBuildPrefix(env.TRUSTED_BUILD_OBJECTS, `outputs/${build.buildId}/staging/`);
  const createCell =
    dependencies.cellFactory ??
    ((_cellId: string, pass: 1 | 2) =>
      new CloudflareTrustedBuildCell(env, build.buildId, build.attempt, pass));
  const input = {
    request,
    source: {
      objectKey: trustedBuildSourceObjectKey(build.requestId, build.sourceObjectSha256),
      sha256: build.sourceObjectSha256,
      bytes: build.sourceBytes,
    },
    attempt: build.attempt,
    roots: shelf.revision.content.closure.roots.map((root) => ({
      name: root.name,
      version: root.version,
    })),
    packageTarballs: tarballs,
    capturedResources,
    shelfContentSha256: shelfPublicContent.hashes,
  };
  let firstCell: TrustedBuildCell | null = null;
  let secondCell: TrustedBuildCell | null = null;
  try {
    const firstCellId = trustedBuildSandboxCellId(build.buildId, build.attempt, 1);
    if ((await coordinator.bindCell(build.buildId, build.attempt, firstCellId)) !== "updated")
      return;
    firstCell = createCell(firstCellId, 1);
    const first = await firstCell.build(
      input,
      1,
      async (stage, outcome) => {
        await coordinator.recordStage(build.buildId, build.attempt, 1, stage, outcome);
        maybeTerminateStagingConsumer(env, build.buildId, build.attempt, 1, stage, outcome);
      },
      async (progress) => {
        await coordinator.recordCollectionProgress(build.buildId, build.attempt, progress);
      },
      async (progress) => {
        await coordinator.recordMemoryProgress(build.buildId, build.attempt, progress);
      },
    );
    await Promise.all(
      (["app", "dependencies"] as const).map((root) => {
        const collection = first[root];
        return coordinator.recordSecretScanSummary(build.buildId, build.attempt, {
          pass: 1,
          root,
          scannedFiles: collection.scannedFiles,
          shelfExemptFiles: collection.shelfExemptFiles,
          bytesScanned: collection.bytesScanned,
          peakBufferedBytes: collection.peakBufferedBytes,
          recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        });
      }),
    );
    await firstCell.destroy();
    firstCell = null;
    if ((await coordinator.bindCell(build.buildId, build.attempt, null)) !== "updated") return;
    const secondCellId = trustedBuildSandboxCellId(build.buildId, build.attempt, 2);
    if ((await coordinator.bindCell(build.buildId, build.attempt, secondCellId)) !== "updated")
      return;
    secondCell = createCell(secondCellId, 2);
    const second = await secondCell.build(
      input,
      2,
      async (stage, outcome) => {
        await coordinator.recordStage(build.buildId, build.attempt, 2, stage, outcome);
      },
      async (progress) => {
        await coordinator.recordCollectionProgress(build.buildId, build.attempt, progress);
      },
      async (progress) => {
        await coordinator.recordMemoryProgress(build.buildId, build.attempt, progress);
      },
    );
    await Promise.all(
      (["app", "dependencies"] as const).map((root) => {
        const collection = second[root];
        return coordinator.recordSecretScanSummary(build.buildId, build.attempt, {
          pass: 2,
          root,
          scannedFiles: collection.scannedFiles,
          shelfExemptFiles: collection.shelfExemptFiles,
          bytesScanned: collection.bytesScanned,
          peakBufferedBytes: collection.peakBufferedBytes,
          recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        });
      }),
    );
    await secondCell.destroy();
    secondCell = null;
    if ((await coordinator.bindCell(build.buildId, build.attempt, null)) !== "updated") return;
    const verificationControlledBytes = textEncoder.encode(
      canonicalPantryJson({
        first: { app: first.app.files, dependencies: first.dependencies.files },
        second: { app: second.app.files, dependencies: second.dependencies.files },
      }),
    ).byteLength;
    await recordWorkerMemoryProgress(
      coordinator,
      build.buildId,
      build.attempt,
      verificationControlledBytes,
    );
    const verificationBoundaryStartedAt = Date.now();
    const recordVerificationProgress = async (
      phase: Parameters<TrustedBuildCoordinator["recordVerificationProgress"]>[2]["phase"],
    ): Promise<void> => {
      const progress = {
        phase,
        mechanism: "same-queue-consumer-direct-call" as const,
        elapsedMs: Date.now() - verificationBoundaryStartedAt,
        recordedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      };
      // Metadata-only boundary telemetry. No package, path, source, command, or content values.
      // eslint-disable-next-line no-console -- trusted build verification boundary audit
      console.log(
        JSON.stringify({
          event: "trusted_build_verification_progress",
          buildId: build.buildId,
          attempt: build.attempt,
          ...progress,
        }),
      );
      try {
        await coordinator.recordVerificationProgress(build.buildId, build.attempt, progress);
      } catch {
        // Diagnostic persistence must never replace or alter the build result.
        // eslint-disable-next-line no-console -- trusted build verification diagnostic
        console.error(
          JSON.stringify({
            event: "trusted_build_verification_progress_persist_failed",
            buildId: build.buildId,
            attempt: build.attempt,
            phase,
          }),
        );
      }
    };
    await recordVerificationProgress("collection-complete");
    await recordVerificationProgress("transition-requested");
    const verifying = await coordinator.transition(
      build.buildId,
      build.attempt,
      "building",
      "verifying",
      (dependencies.now ?? (() => new Date()))().toISOString(),
    );
    if (verifying !== "updated") return;
    await recordVerificationProgress("transition-completed");
    const completedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const verificationHeartbeat = setInterval(() => {
      void recordVerificationProgress("heartbeat");
    }, 5_000);
    let prepared: Awaited<ReturnType<typeof prepareTrustedBuildOutput>>;
    try {
      await recordVerificationProgress("verification-start-invoked");
      await coordinator.recordStage(
        build.buildId,
        build.attempt,
        null,
        "output-verification",
        "started",
      );
      await recordVerificationProgress("verification-start-received");
      prepared = await prepareTrustedBuildOutput({
        request,
        shelf,
        first,
        second,
        signer: configuredSigner(env),
        coldBuild: true,
        upstreamRequests: 0,
        pantryObjectReads:
          tarballs.length + capturedResources.length + shelfPublicContent.objectReads,
        completedAt,
      });
      await recordWorkerMemoryProgress(
        coordinator,
        build.buildId,
        build.attempt,
        verificationControlledBytes,
      );
      await recordVerificationProgress("preparation-completed");
      await coordinator.recordStage(
        build.buildId,
        build.attempt,
        null,
        "output-verification",
        "succeeded",
      );
    } catch (error) {
      await coordinator.recordStage(
        build.buildId,
        build.attempt,
        null,
        "output-verification",
        "failed",
      );
      throw error;
    } finally {
      clearInterval(verificationHeartbeat);
    }
    await coordinator.recordStage(build.buildId, build.attempt, null, "output-persist", "started");
    let stored: Awaited<ReturnType<typeof storePreparedOutput>>;
    try {
      stored = await storePreparedOutput(env, prepared);
      await coordinator.recordStage(
        build.buildId,
        build.attempt,
        null,
        "output-persist",
        "succeeded",
      );
    } catch (error) {
      await coordinator.recordStage(build.buildId, build.attempt, null, "output-persist", "failed");
      throw error;
    }
    await retainShelf(env, shelf.revision.rootSha256, build.buildId);
    const completed = await coordinator.succeed(
      build.buildId,
      build.attempt,
      stored.metadataSha256,
      completedAt,
    );
    if (completed !== "updated") {
      await deleteTrustedBuildPrefix(env.TRUSTED_BUILD_OBJECTS, `outputs/${build.buildId}/`);
      await releaseShelf(env, shelf.revision.rootSha256, build.buildId);
      return;
    }
    await deleteTrustedBuildPrefix(
      env.TRUSTED_BUILD_OBJECTS,
      `quarantine/requests/${build.requestId}/`,
    );
  } finally {
    await Promise.allSettled([firstCell?.destroy(), secondCell?.destroy()]);
    await deleteTrustedBuildPrefix(
      env.TRUSTED_BUILD_OBJECTS,
      `outputs/${build.buildId}/staging/attempt-${build.attempt}/`,
    );
  }
}

async function handleBegin(
  request: Request,
  env: TrustedBuildWorkerBindings,
  coordinator: TrustedBuildCoordinator,
  now: Date,
): Promise<Response> {
  requirePrincipal(request, ["build-control"]);
  if (env.TRUSTED_BUILD_QUEUE === undefined) {
    throw new TrustedBuildHttpError(503, "build_unavailable", "Build queue is unavailable", true);
  }
  const parsed = parseStrict(trustedBuildRequestSchema, await readJson(request));
  const verified = await verifyTrustedBuildRequest(parsed);
  if (!verified.ok) {
    throw new TrustedBuildHttpError(422, "attestation_invalid", "Build request integrity failed");
  }
  assertSourceSecretless(parsed, verified.sourcePayload);
  configuredSigner(env);
  const metadata: TrustedBuildRequestMetadata = {
    ...parsed,
    source: { manifest: parsed.source.manifest },
  };
  const canonicalBytes = textEncoder.encode(canonicalPantryJson(metadata));
  const requestObjectSha256 = await sha256Hex(canonicalBytes);
  const sourceObjectSha256 = await sha256Hex(verified.sourcePayload);
  await putTrustedBuildObject(
    env.TRUSTED_BUILD_OBJECTS,
    trustedBuildRequestObjectKey(parsed.requestId, requestObjectSha256),
    canonicalBytes,
    requestObjectSha256,
  );
  await putTrustedBuildObject(
    env.TRUSTED_BUILD_OBJECTS,
    trustedBuildSourceObjectKey(parsed.requestId, sourceObjectSha256),
    verified.sourcePayload,
    sourceObjectSha256,
  );
  const begun = await coordinator.begin(
    {
      buildId: parsed.input.buildId,
      requestId: parsed.requestId,
      requestSha256: verified.requestSha256,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      requestObjectSha256,
      sourceObjectSha256,
      sourceBytes: verified.sourcePayload.byteLength,
    },
    maxActive(env),
  );
  if (begun.state === "backpressure") {
    await deleteTrustedBuildPrefix(
      env.TRUSTED_BUILD_OBJECTS,
      `quarantine/requests/${parsed.requestId}/`,
    );
    throw new TrustedBuildHttpError(503, "build_unavailable", "Build queue is at capacity", true);
  }
  if (begun.state === "created") {
    await env.TRUSTED_BUILD_QUEUE.send({
      schemaVersion: 1,
      buildId: parsed.input.buildId,
      requestId: parsed.requestId,
      requestSha256: verified.requestSha256,
    });
  }
  return jsonResponse(
    begun.state === "created" ? 201 : 200,
    trustedBuildBeginResponseSchema.parse({
      ok: true,
      buildId: begun.build.buildId,
      requestId: begun.build.requestId,
      state: begun.state,
    }),
  );
}

async function handleStatus(
  request: Request,
  env: TrustedBuildWorkerBindings,
  coordinator: TrustedBuildCoordinator,
  buildId: string,
): Promise<Response> {
  requirePrincipal(request, ["build-control", "build-readonly"]);
  const build = await coordinator.get(buildId);
  if (build === null) {
    throw new TrustedBuildHttpError(404, "build_not_found", "Build was not found");
  }
  const output = build.state === "succeeded" ? await readStoredOutput(env, build) : null;
  return jsonResponse(
    200,
    trustedBuildStatusResponseSchema.parse({
      ok: true,
      buildId: build.buildId,
      requestId: build.requestId,
      state: build.state,
      attempt: build.attempt,
      attempts: (build.attempts ?? []).map((attempt) => ({
        ...attempt,
        diagnostics: attempt.diagnostics ?? null,
      })),
      output,
      error:
        build.failure === null
          ? null
          : {
              code: build.failure.code,
              message: build.failure.message,
              retryable: build.failure.retryable,
              status: build.failure.status,
            },
      createdAt: build.createdAt,
      deadlineAt:
        build.deadlineAt ??
        new Date(Date.parse(build.createdAt) + TRUSTED_BUILD_OPERATION_BOUND_MS).toISOString(),
      updatedAt: build.updatedAt,
    }),
  );
}

async function handleChunk(
  request: Request,
  env: TrustedBuildWorkerBindings,
  coordinator: TrustedBuildCoordinator,
  buildId: string,
  scope: "app" | "layer",
  contentSha256: string,
  chunkIndex: number,
): Promise<Response> {
  requirePrincipal(request, ["build-control", "build-readonly"]);
  const build = await coordinator.get(buildId);
  if (build?.state !== "succeeded") {
    throw new TrustedBuildHttpError(404, "build_not_found", "Build output was not found");
  }
  const output = await readStoredOutput(env, build);
  if (output === null)
    throw new TrustedBuildHttpError(404, "build_not_found", "Build output was not found");
  const expectedContentSha256 =
    scope === "app"
      ? await sha256Hex(canonicalPantryJson(output.app.content))
      : output.layers.find((layer) => layer.content.descriptor.contentSha256 === contentSha256)
          ?.content.descriptor.contentSha256;
  const descriptors =
    scope === "app"
      ? output.app.chunks
      : output.layers.find((layer) => layer.content.descriptor.contentSha256 === contentSha256)
          ?.chunks;
  const descriptor = descriptors?.[chunkIndex];
  if (expectedContentSha256 !== contentSha256 || descriptor === undefined) {
    throw new TrustedBuildHttpError(404, "build_not_found", "Build output was not found");
  }
  const bytes = await readTrustedBuildObject(
    env.TRUSTED_BUILD_OBJECTS,
    trustedBuildOutputChunkKey(buildId, scope, contentSha256, chunkIndex),
    descriptor.sha256,
    RUNTIME_ARTIFACT_CHUNK_BYTES,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return jsonResponse(
    200,
    trustedBuildChunkResponseSchema.parse({
      ok: true,
      buildId,
      scope,
      contentSha256,
      chunkIndex,
      chunkSha256: descriptor.sha256,
      payloadBase64: btoa(binary),
    }),
  );
}

async function handleCancel(
  request: Request,
  coordinator: TrustedBuildCoordinator,
  buildId: string,
  now: Date,
): Promise<Response> {
  requirePrincipal(request, ["build-control"]);
  const state = await coordinator.cancel(buildId, now.toISOString());
  if (state === "not_found") {
    throw new TrustedBuildHttpError(404, "build_not_found", "Build was not found");
  }
  return jsonResponse(200, trustedBuildCancelResponseSchema.parse({ ok: true, buildId, state }));
}

async function handleGc(
  request: Request,
  env: TrustedBuildWorkerBindings,
  coordinator: TrustedBuildCoordinator,
): Promise<Response> {
  requirePrincipal(request, ["build-gc"]);
  const input = parseStrict(trustedBuildGcRequestSchema, await readJson(request, 64 * 1024));
  const removed = await coordinator.cleanup(
    Date.parse(input.olderThan),
    input.maxDeletes,
    input.scope === "all-test-data",
  );
  for (const build of removed) {
    let output: TrustedBuildOutput | null = null;
    if (build.outputObjectSha256 !== null) {
      try {
        output = await readStoredOutput(env, build);
      } catch {
        // Cleanup remains authoritative; catalog GC surfaces a stale retention reference.
      }
    }
    await deleteTrustedBuildPrefix(
      env.TRUSTED_BUILD_OBJECTS,
      `quarantine/requests/${build.requestId}/`,
    );
    await deleteTrustedBuildPrefix(env.TRUSTED_BUILD_OBJECTS, `outputs/${build.buildId}/`);
    if (output !== null) {
      try {
        await releaseShelf(env, output.pantryShelf.pantryRevisionRootSha256, build.buildId);
      } catch {
        // Output deletion is authoritative; a stale retention reference is surfaced by catalog GC.
      }
    }
  }
  const diagnostics = await coordinator.diagnostics();
  const remainingDeletes = Math.max(0, input.maxDeletes - removed.length);
  // Quarantine bytes can precede the atomic coordinator registration. Sweep them only while
  // the plane is quiescent, so no live request can lose its sealed input, and retain the GC's
  // existing bounded-invocation budget.
  const deletedOrphanObjects =
    remainingDeletes > 0 && diagnostics.queued === 0 && diagnostics.running === 0
      ? await deleteAgedTrustedBuildQuarantine(
          env.TRUSTED_BUILD_OBJECTS,
          Date.parse(input.olderThan),
          remainingDeletes,
        )
      : 0;
  return jsonResponse(200, {
    ok: true,
    deletedBuildIds: removed.map((build) => build.buildId),
    deletedOrphanObjects,
  });
}

export async function handleTrustedBuildWorkerRequest(
  request: Request,
  env: TrustedBuildWorkerBindings,
  dependencies: TrustedBuildWorkerDependencies = {},
): Promise<Response> {
  const coordinator = dependencies.coordinator ?? getCoordinator(env);
  const requestId = crypto.randomUUID();
  const now = (dependencies.now ?? (() => new Date()))();
  try {
    const url = new URL(request.url);
    if (url.search !== "") {
      throw new TrustedBuildHttpError(
        400,
        "build_invalid_request",
        "Build query parameters are not supported",
      );
    }
    if (request.method === "GET" && url.pathname === `${INTERNAL_PREFIX}/health`) {
      requirePrincipal(request, ["build-control", "build-readonly"]);
      configuredSigner(env);
      return jsonResponse(200, {
        ok: true,
        service: "trusted-build-plane",
        schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
        secretlessCells: true,
        directRegistryAccess: false,
      });
    }
    if (request.method === "POST" && url.pathname === `${INTERNAL_PREFIX}/builds`) {
      return await handleBegin(request, env, coordinator, now);
    }
    const statusMatch = new RegExp(
      `^${INTERNAL_PREFIX}/builds/(pbuild_[A-Za-z0-9_-]{22,128})$`,
    ).exec(url.pathname);
    if (statusMatch !== null) {
      if (request.method === "GET")
        return await handleStatus(request, env, coordinator, statusMatch[1]);
      if (request.method === "DELETE")
        return await handleCancel(request, coordinator, statusMatch[1], now);
      throw new TrustedBuildHttpError(405, "build_invalid_request", "Build method is not allowed");
    }
    const chunkMatch = new RegExp(
      `^${INTERNAL_PREFIX}/builds/(pbuild_[A-Za-z0-9_-]{22,128})/outputs/(app|layer)/([0-9a-f]{64})/chunks/([0-9]+)$`,
    ).exec(url.pathname);
    if (chunkMatch !== null) {
      if (request.method !== "GET") {
        throw new TrustedBuildHttpError(
          405,
          "build_invalid_request",
          "Build method is not allowed",
        );
      }
      return await handleChunk(
        request,
        env,
        coordinator,
        chunkMatch[1],
        chunkMatch[2] as "app" | "layer",
        chunkMatch[3],
        Number(chunkMatch[4]),
      );
    }
    if (request.method === "POST" && url.pathname === `${INTERNAL_PREFIX}/gc`) {
      return await handleGc(request, env, coordinator);
    }
    if (request.method === "GET" && url.pathname === `${INTERNAL_PREFIX}/diagnostics`) {
      requirePrincipal(request, ["build-control", "build-gc"]);
      const ledger = await coordinator.diagnostics();
      return jsonResponse(
        200,
        trustedBuildDiagnosticsResponseSchema.parse({
          ok: true,
          ledger,
          r2: await listTrustedBuildObjects(env.TRUSTED_BUILD_OBJECTS),
          activeCells: ledger.running,
        }),
      );
    }
    throw new TrustedBuildHttpError(404, "build_not_found", "Build endpoint was not found");
  } catch (error) {
    if (error instanceof TrustedBuildHttpError) return errorResponse(error, requestId);
    // Metadata only: source, package names, commands, provider values, and stderr never enter logs.
    // eslint-disable-next-line no-console -- trusted-service top-level boundary
    console.error(
      JSON.stringify({
        event: "trusted_build_unexpected_error",
        requestId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return errorResponse(
      new TrustedBuildHttpError(500, "build_unavailable", "Trusted build failed internally", true),
      requestId,
    );
  }
}

export async function handleTrustedBuildQueue(
  batch: MessageBatch<TrustedBuildQueueMessage>,
  env: TrustedBuildWorkerBindings,
  dependencies: TrustedBuildWorkerDependencies = {},
): Promise<void> {
  const coordinator = dependencies.coordinator ?? getCoordinator(env);
  for (const message of batch.messages) {
    const body = message.body;
    if (
      body?.schemaVersion !== 1 ||
      !/^pbuild_[A-Za-z0-9_-]{22,128}$/u.test(body.buildId) ||
      !/^pbuildreq_[0-9a-f]{64}$/u.test(body.requestId) ||
      !/^[0-9a-f]{64}$/u.test(body.requestSha256)
    ) {
      message.ack();
      continue;
    }
    await coordinator.recordQueueDelivery(body.buildId);
    const now = (dependencies.now ?? (() => new Date()))();
    const claim = await coordinator.claim(
      body.buildId,
      now.toISOString(),
      new Date(now.getTime() + BUILD_LEASE_MS).toISOString(),
    );
    if (claim.state === "busy") {
      // Use a fresh logical delivery rather than consuming the queue's transport retry budget.
      // The coordinator alarm remains the independent fallback if this send is unavailable.
      try {
        await env.TRUSTED_BUILD_QUEUE?.send(body, { delaySeconds: 30 });
      } catch {
        // The lease alarm owns recovery and typed terminal fallback.
      }
      message.ack();
      continue;
    }
    if (claim.state !== "claimed") {
      message.ack();
      continue;
    }
    const renewLease = async (): Promise<void> => {
      const leaseNow = (dependencies.now ?? (() => new Date()))();
      await coordinator.renewLease(
        body.buildId,
        claim.build.attempt,
        leaseNow.toISOString(),
        new Date(leaseNow.getTime() + BUILD_LEASE_MS).toISOString(),
      );
    };
    const leaseHeartbeat = setInterval(() => {
      void renewLease().catch(() => {
        // The Durable Object alarm remains authoritative when renewal is unavailable.
      });
    }, BUILD_LEASE_RENEW_MS);
    try {
      try {
        await executeBuild(env, coordinator, claim.build, dependencies);
      } finally {
        clearInterval(leaseHeartbeat);
      }
      message.ack();
    } catch (error) {
      if (error instanceof StagingLiveRecoveryProbeError) {
        // This staging-only probe deliberately terminates the queue event after durable stage
        // evidence and a live lease exist. It must remain unhandled so Cloudflare redelivers the
        // message and the coordinator alarm—not this consumer—owns recovery.
        // eslint-disable-next-line no-console -- metadata-only staging fault evidence
        console.error(
          JSON.stringify({
            event: "trusted_build_staging_consumer_terminated",
            buildId: body.buildId,
            attempt: claim.build.attempt,
            stage: "install",
          }),
        );
        throw error;
      }
      const current = await coordinator.get(body.buildId);
      if (current === null || current.attempt !== claim.build.attempt) {
        message.ack();
        continue;
      }
      const failure = typedFailure(error, (dependencies.now ?? (() => new Date()))());
      const failingStage = error instanceof TrustedBuildCellError ? error.stage : "orchestration";
      if (error instanceof TrustedBuildCellError && error.scanFindings.length > 0) {
        await coordinator.recordSecretScanFindings(
          body.buildId,
          claim.build.attempt,
          error.scanFindings,
        );
      }
      await coordinator.recordAttemptFailure(
        body.buildId,
        claim.build.attempt,
        null,
        failingStage,
        failure,
        error instanceof TrustedBuildCellError ? error.diagnostics : null,
      );
      // Metadata-only observability: never include source, commands, package names, stdout,
      // stderr, environment values, or the error message/object.
      // eslint-disable-next-line no-console -- trusted build attempt audit
      console.error(
        JSON.stringify({
          event: "trusted_build_attempt_failed",
          buildId: body.buildId,
          attempt: claim.build.attempt,
          category: failure.code,
          retryable: failure.retryable,
          stage: failingStage,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      if (failure.retryable && claim.build.attempt < MAX_BUILD_ATTEMPTS) {
        const requeued = await coordinator.requeue(
          body.buildId,
          claim.build.attempt,
          (await coordinator.get(body.buildId))?.state ?? "resolving",
          failure.failedAt,
        );
        if (requeued !== "updated") {
          message.ack();
          continue;
        }
        let retryEnqueued = false;
        if (env.TRUSTED_BUILD_QUEUE !== undefined) {
          try {
            await env.TRUSTED_BUILD_QUEUE.send(body, {
              delaySeconds: Math.min(30, 2 ** claim.build.attempt),
            });
            retryEnqueued = true;
          } catch {
            // The terminal typed failure below preserves the original client-safe category.
          }
        }
        if (!retryEnqueued) {
          await coordinator.fail(body.buildId, claim.build.attempt, {
            ...failure,
            code: "build_unavailable",
            message: "Build retry queue is unavailable",
            retryable: true,
            status: pantryErrorStatus("build_unavailable"),
          });
        }
        // Each logical retry is a fresh queue delivery. This keeps Cloudflare's transport-level
        // retry/DLQ budget independent from the coordinator's three-attempt build policy.
        message.ack();
      } else {
        await coordinator.fail(body.buildId, claim.build.attempt, failure);
        message.ack();
      }
    }
  }
}
