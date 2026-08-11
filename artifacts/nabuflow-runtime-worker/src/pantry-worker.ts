import {
  PANTRY_CATALOG_SCHEMA_VERSION,
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_SHELF_CONTENT_HASHES_FORMAT,
  PANTRY_REVISION_FORMAT,
  MAX_PANTRY_SHELF_CONTENT_HASHES,
  canonicalPantryJson,
  compareUtf8,
  pantryCatalogCommitRequestSchema,
  pantryCatalogAssemblyDiagnosticsResponseSchema,
  pantryCatalogAssemblyStatusResponseSchema,
  pantryCaptureBuildResourceRequestSchema,
  pantryCatalogGcRequestSchema,
  pantryCatalogObjectKindSchema,
  pantryCatalogObjectReferenceSchema,
  pantryCatalogObjectInventoryResponseSchema,
  pantryCatalogReferenceRequestSchema,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfMatchesStamp,
  pantryCatalogShelfRecordSchema,
  pantryCatalogShelfStampSchema,
  pantryCatalogStateTransitionRequestSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryCatalogStockIdentityStatusResponseSchema,
  pantryCatalogStockResponseSchema,
  pantryNormalizedPackageManifestSchema,
  pantryShelfContentHashesHash,
  pantryShelfContentHashesResponseSchema,
  pantryDependencyClosureHash,
  pantryIngredientMerkleRoot,
  PANTRY_ASSEMBLY_HEARTBEAT_MS,
  PANTRY_ORPHAN_CAS_SAFETY_WINDOW_MS,
  pantryErrorStatus,
  pantryRevisionRoot,
  pantryRevisionIsCommittable,
  signPantryDigest,
  verifyPantryRevisionRecord,
  sha256Hex,
  type PantryCatalogCommitRequest,
  type PantryCatalogErrorResponse,
  type PantryCatalogShelfRecord,
} from "@workspace/tenant-runtime-contracts";
import { capturePantryBuildResource } from "./pantry-build-resource";
import { ingestErrorDefaults, ingestPantryStockRequest } from "./pantry-ingest";
import { NpmRegistryClient } from "./pantry-registry-client";
import type {
  PantryCatalogCoordinator,
  PantryGenerationResourceEvidence,
  PantryIngestFailureRecord,
  PantryStockQueueMessage,
  PantryWorkerBindings,
} from "./pantry-catalog-model";
import type { PantryCatalogDurableObject } from "./pantry-catalog-durable-object";

const INTERNAL_PREFIX = "/internal/v1";
const PRINCIPAL_HEADER = "x-nabuflow-pantry-principal";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_OBJECT_BYTES = 32 * 1024 * 1024;
const NEGATIVE_CACHE_MS = 5 * 60 * 1_000;
const PANTRY_CATALOG_TRANSIENT_RETRY_BASE_MS = 5_000;
const PANTRY_CATALOG_TRANSIENT_RETRY_MAX_MS = 60_000;
const PANTRY_CATALOG_TRANSIENT_MAX_ATTEMPTS = 5;
const PANTRY_CATALOG_BINDING_RETRY_BASE_MS = 250;
const PANTRY_CATALOG_BINDING_RETRY_MAX_MS = 2_000;
const PANTRY_CATALOG_BINDING_MAX_ATTEMPTS = 5;
const PANTRY_RESOURCE_EVIDENCE_OBJECT_INTERVAL = 16;

type PantryPrincipal = "catalog-admin" | "builder-readonly" | "catalog-gc";

interface PantryInvocationCounters {
  startedAt: string;
  phase: string;
  trustedFetches: number;
  internalPantryCalls: number;
  durableObjectCalls: number;
  durableObjectCallsByMethod: Record<string, number>;
  r2Calls: number;
  r2CallsByMethod: Record<string, number>;
  r2Active: number;
  r2MaxConcurrency: number;
  verifiedResumedObjects: number;
  evidenceWrites: number;
}

function newInvocationCounters(): PantryInvocationCounters {
  return {
    startedAt: new Date().toISOString(),
    phase: "claiming",
    trustedFetches: 0,
    internalPantryCalls: 0,
    durableObjectCalls: 0,
    durableObjectCallsByMethod: {},
    r2Calls: 0,
    r2CallsByMethod: {},
    r2Active: 0,
    r2MaxConcurrency: 0,
    verifiedResumedObjects: 0,
    evidenceWrites: 0,
  };
}

function countedCoordinator(
  coordinator: PantryCatalogCoordinator,
  counters: PantryInvocationCounters,
): PantryCatalogCoordinator {
  return new Proxy(coordinator, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        counters.durableObjectCalls += 1;
        counters.durableObjectCallsByMethod[property] =
          (counters.durableObjectCallsByMethod[property] ?? 0) + 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function countedR2(bucket: R2Bucket, counters: PantryInvocationCounters): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      return async (...args: unknown[]) => {
        counters.r2Calls += 1;
        counters.r2CallsByMethod[property] = (counters.r2CallsByMethod[property] ?? 0) + 1;
        counters.r2Active += 1;
        counters.r2MaxConcurrency = Math.max(counters.r2MaxConcurrency, counters.r2Active);
        try {
          return await Reflect.apply(value, target, args);
        } finally {
          counters.r2Active -= 1;
        }
      };
    },
  }) as R2Bucket;
}

function resourceEvidence(
  assemblyId: string,
  generation: number,
  attempt: number,
  counters: PantryInvocationCounters,
  outcome: PantryGenerationResourceEvidence["outcome"],
): PantryGenerationResourceEvidence {
  return {
    assemblyId,
    generation,
    attempt,
    startedAt: counters.startedAt,
    updatedAt: new Date().toISOString(),
    outcome,
    phase: counters.phase,
    trustedFetches: counters.trustedFetches,
    internalPantryCalls: counters.internalPantryCalls,
    durableObjectCalls: counters.durableObjectCalls,
    durableObjectCallsByMethod: { ...counters.durableObjectCallsByMethod },
    r2Calls: counters.r2Calls,
    r2CallsByMethod: { ...counters.r2CallsByMethod },
    r2Active: counters.r2Active,
    r2MaxConcurrency: counters.r2MaxConcurrency,
    verifiedResumedObjects: counters.verifiedResumedObjects,
    estimatedPlatformSubrequests:
      counters.trustedFetches + counters.durableObjectCalls + counters.r2Calls,
    evidenceWrites: counters.evidenceWrites,
  };
}

class PantryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: PantryCatalogErrorResponse["code"],
    message: string,
    readonly retryable = false,
    readonly diagnosticHeaders?: HeadersInit,
  ) {
    super(message);
  }
}

type PantryInternalCallStage = Extract<
  PantryIngestFailureRecord["stage"],
  "stage-object" | "commit-shelf"
>;

class PantryInternalCallError extends Error {
  constructor(
    readonly stage: PantryInternalCallStage,
    readonly operation: PantryIngestFailureRecord["operation"],
    readonly cause: PantryIngestFailureRecord["cause"],
    readonly errorClass: PantryIngestFailureRecord["errorClass"],
    readonly errorCode: string | null,
    readonly errorFingerprint: string | null,
    readonly status: number,
    readonly catalogCode: string,
  ) {
    super("A trusted Pantry catalog operation failed");
    this.name = "PantryInternalCallError";
  }
}

class PantryCatalogOperationError extends Error {
  constructor(
    readonly operation: PantryIngestFailureRecord["operation"],
    readonly originalError: unknown,
  ) {
    super("A Pantry catalog operation failed");
    this.name = "PantryCatalogOperationError";
  }
}

class PantryExecutionOwnershipError extends Error {
  constructor() {
    super("Pantry assembly execution ownership was lost");
    this.name = "PantryExecutionOwnershipError";
  }
}

function sanitizedErrorClass(error: unknown): NonNullable<PantryIngestFailureRecord["errorClass"]> {
  if (error instanceof PantryCatalogOperationError) return sanitizedErrorClass(error.originalError);
  const name = error instanceof Error ? error.name : "UnknownError";
  return name === "Error" ||
    name === "TypeError" ||
    name === "RangeError" ||
    name === "DOMException" ||
    name === "PantryHttpError"
    ? name
    : "UnknownError";
}

function classifyUnexpectedCatalogCause(error: unknown): PantryIngestFailureRecord["cause"] {
  if (error instanceof PantryCatalogOperationError) {
    return classifyUnexpectedCatalogCause(error.originalError);
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const providerCode = sanitizedErrorCode(error);
  if (providerCode === "10058") return "catalog-storage-rate-limited";
  if (providerCode === "10001" || providerCode === "10043" || providerCode === "10054") {
    return "catalog-storage-unavailable";
  }
  if (
    message.includes("subrequest") ||
    message.includes("too many api") ||
    message.includes("too many calls")
  ) {
    return "executor-subrequest-limit";
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("status 429") ||
    message.includes("reduce your request rate")
  ) {
    return "catalog-storage-rate-limited";
  }
  if (message.includes("quota") || message.includes("daily limit")) {
    return "catalog-storage-quota";
  }
  if (
    message.includes("too many") ||
    message.includes("maximum number") ||
    (message.includes("transaction") && (message.includes("limit") || message.includes("key")))
  ) {
    return "catalog-storage-limit";
  }
  if (message.includes("binding") || message.includes("undefined is not an object")) {
    return "catalog-binding-missing";
  }
  if (message.includes("owner") && (message.includes("inactive") || message.includes("lost"))) {
    return "catalog-owner-fenced";
  }
  if (error instanceof TypeError) return "catalog-binding-missing";
  if (
    message.includes("internal error") ||
    message.includes("unavailable") ||
    message.includes("network connection lost") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("connection reset")
  ) {
    return "catalog-storage-unavailable";
  }
  return "catalog-internal";
}

function sanitizedErrorCode(error: unknown): string | null {
  if (error instanceof PantryCatalogOperationError) return sanitizedErrorCode(error.originalError);
  if (typeof error === "object" && error !== null && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    const value = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
    if (/^[A-Za-z0-9_.-]{1,64}$/u.test(value)) return value;
  }
  const message = error instanceof Error ? error.message : "";
  return /\(([0-9]{5,6})\)\s*$/u.exec(message)?.[1] ?? null;
}

async function sanitizedErrorFingerprint(error: unknown): Promise<string | null> {
  if (error instanceof PantryCatalogOperationError) {
    return sanitizedErrorFingerprint(error.originalError);
  }
  if (!(error instanceof Error) || error.message.length === 0) return null;
  return (await sha256Hex(error.message)).slice(0, 16);
}

async function catalogOperation<T>(
  operation: PantryIngestFailureRecord["operation"],
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof PantryHttpError || error instanceof PantryCatalogOperationError)
      throw error;
    throw new PantryCatalogOperationError(operation, error);
  }
}

async function catalogBindingOperation<T>(callback: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PANTRY_CATALOG_BINDING_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      const cause = classifyUnexpectedCatalogCause(error);
      if (
        (cause !== "catalog-storage-unavailable" && cause !== "catalog-storage-rate-limited") ||
        attempt === PANTRY_CATALOG_BINDING_MAX_ATTEMPTS
      ) {
        throw error;
      }
      const delayMs = Math.min(
        PANTRY_CATALOG_BINDING_RETRY_MAX_MS,
        PANTRY_CATALOG_BINDING_RETRY_BASE_MS * 2 ** (attempt - 1),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw lastError;
}

function getCoordinator(env: PantryWorkerBindings): DurableObjectStub<PantryCatalogDurableObject> {
  return env.PANTRY_CATALOG_COORDINATOR.get(
    env.PANTRY_CATALOG_COORDINATOR.idFromName("catalog-v1"),
  );
}

function requirePrincipal(request: Request, allowed: readonly PantryPrincipal[]): PantryPrincipal {
  const principal = request.headers.get(PRINCIPAL_HEADER);
  if (principal === null || !allowed.includes(principal as PantryPrincipal)) {
    throw new PantryHttpError(403, "catalog_forbidden", "Pantry catalog access is denied");
  }
  return principal as PantryPrincipal;
}

async function readCappedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PantryHttpError(413, "catalog_invalid_request", "Pantry request is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) {
    throw new PantryHttpError(413, "catalog_invalid_request", "Pantry request is too large");
  }
  return bytes;
}

async function readJson(request: Request): Promise<unknown> {
  const bytes = await readCappedBytes(request, MAX_JSON_BYTES);
  if (bytes.byteLength === 0) {
    throw new PantryHttpError(400, "catalog_invalid_request", "A JSON request body is required");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PantryHttpError(400, "catalog_invalid_request", "The JSON request body is invalid");
  }
}

async function inventoryPantryObjects(bucket: R2Bucket): Promise<unknown> {
  const listedObjects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1_000, ...(cursor === undefined ? {} : { cursor }) });
    listedObjects.push(...page.objects);
    if (listedObjects.length > 5_000) {
      throw new PantryHttpError(
        503,
        "catalog_infrastructure_unavailable",
        "Pantry object inventory exceeds its diagnostic bound",
      );
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  const objects = [];
  for (const listed of listedObjects.sort((left, right) => compareUtf8(left.key, right.key))) {
    const object = await bucket.get(listed.key);
    if (object === null) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    objects.push({
      key: listed.key,
      size: bytes.byteLength,
      uploadedAt: listed.uploaded.toISOString(),
      sha256: await sha256Hex(bytes),
    });
  }
  return pantryCatalogObjectInventoryResponseSchema.parse({
    ok: true,
    objects,
    totalBytes: objects.reduce((total, object) => total + object.size, 0),
  });
}

function strictParse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PantryHttpError(400, "catalog_invalid_request", "The Pantry request is invalid");
  }
  return result.data;
}

function jsonResponse(status: number, body: unknown, additionalHeaders?: HeadersInit): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function errorResponse(error: PantryHttpError, diagnosticHeaders?: HeadersInit): Response {
  const headers = new Headers(error.diagnosticHeaders);
  new Headers(diagnosticHeaders).forEach((value, name) => headers.set(name, value));
  return jsonResponse(
    error.status,
    {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    } satisfies PantryCatalogErrorResponse,
    headers,
  );
}

function quarantineObjectKey(assemblyId: string, sha256: string): string {
  return `quarantine/${assemblyId}/objects/${sha256}`;
}

function committedObjectKey(sha256: string): string {
  return `cas/sha256/${sha256}`;
}

const PANTRY_BUILD_STREAM_CHUNK_BYTES = 1024 * 1024;

async function readCommittedObjectRange(
  bucket: R2Bucket,
  sha256: string,
  rangeHeader: string,
): Promise<Response> {
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(rangeHeader);
  const head = await bucket.head(committedObjectKey(sha256));
  if (match === null || head === null) {
    throw new PantryHttpError(400, "catalog_invalid_request", "Pantry object range is invalid");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const length = end - start + 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= head.size ||
    length > PANTRY_BUILD_STREAM_CHUNK_BYTES
  ) {
    throw new PantryHttpError(400, "catalog_invalid_request", "Pantry object range is invalid");
  }
  const object = await bucket.get(committedObjectKey(sha256), {
    range: { offset: start, length },
  });
  if (object === null) {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry catalog object is missing");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry catalog integrity verification failed",
    );
  }
  return new Response(bytes, {
    status: 206,
    headers: {
      "cache-control": "no-store",
      "content-length": String(bytes.byteLength),
      "content-range": `bytes ${start}-${end}/${head.size}`,
      "content-type": "application/octet-stream",
      "x-nabuflow-content-sha256": sha256,
    },
  });
}

function revisionManifestKey(shelf: PantryCatalogShelfRecord): string {
  return `revisions/${shelf.revision.content.revisionId}/${shelf.revision.rootSha256}.json`;
}

async function readAndVerifyObject(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  expectedBytes?: number,
  operation: PantryIngestFailureRecord["operation"] = "catalog-verify-existing-shelf",
): Promise<Uint8Array> {
  const object = await catalogBindingOperation(() => bucket.get(key));
  if (object === null) {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry catalog object is missing");
  }
  return verifyImmutableObjectBytes(object, expectedSha256, expectedBytes, operation);
}

async function immutableIntegrityError(
  expectedSha256: string,
  actualSha256: string,
  expectedBytes: number | undefined,
  actualBytes: number,
  operation: PantryIngestFailureRecord["operation"],
): Promise<PantryHttpError> {
  const mismatchCode = `hash-mismatch-${expectedSha256.slice(0, 8)}-${actualSha256.slice(0, 8)}`;
  const fingerprint = (
    await sha256Hex(
      `${mismatchCode}\0${expectedBytes === undefined ? "unspecified" : expectedBytes}\0${actualBytes}`,
    )
  ).slice(0, 16);
  return new PantryHttpError(
    422,
    "catalog_integrity_mismatch",
    "Pantry catalog integrity verification failed",
    false,
    {
      "x-nabuflow-pantry-cause": "catalog-rejected",
      "x-nabuflow-pantry-error-class": "PantryHttpError",
      "x-nabuflow-pantry-operation": operation,
      "x-nabuflow-pantry-error-code": mismatchCode,
      "x-nabuflow-pantry-error-fingerprint": fingerprint,
    },
  );
}

async function verifyImmutableObjectBytes(
  object: { arrayBuffer(): Promise<ArrayBuffer> },
  expectedSha256: string,
  expectedBytes: number | undefined,
  operation: PantryIngestFailureRecord["operation"],
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await object.arrayBuffer());
  const actualSha256 = await sha256Hex(bytes);
  if (
    (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) ||
    actualSha256 !== expectedSha256
  ) {
    throw await immutableIntegrityError(
      expectedSha256,
      actualSha256,
      expectedBytes,
      bytes.byteLength,
      operation,
    );
  }
  return bytes;
}

async function putImmutableObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  sha256: string,
  operation: PantryIngestFailureRecord["operation"],
): Promise<"created" | "exists"> {
  // Immutable content addresses are discovered by a verified read. Never send bytes merely to
  // learn that an object exists: large conditional re-puts are both wasteful and can fail inside
  // the R2 binding before the precondition is evaluated.
  const beforeCreate = await catalogBindingOperation(() => bucket.get(key));
  if (beforeCreate !== null) {
    const existing = await verifyImmutableObjectBytes(
      beforeCreate,
      sha256,
      bytes.byteLength,
      operation,
    );
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (existing[index] !== bytes[index]) {
        throw await immutableIntegrityError(
          sha256,
          await sha256Hex(existing),
          bytes.byteLength,
          existing.byteLength,
          operation,
        );
      }
    }
    return "exists";
  }
  const created = await catalogBindingOperation(() =>
    bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
    }),
  );
  if (created !== null) {
    await readAndVerifyObject(bucket, key, sha256, bytes.byteLength, operation);
    return "created";
  }
  // A concurrent creator won after the verified absence. Trust only an independent full read and
  // content verification of the winning bytes.
  const existing = await readAndVerifyObject(bucket, key, sha256, bytes.byteLength, operation);
  if (existing.byteLength !== bytes.byteLength) {
    throw await immutableIntegrityError(
      sha256,
      await sha256Hex(existing),
      bytes.byteLength,
      existing.byteLength,
      operation,
    );
  }
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (existing[index] !== bytes[index]) {
      throw await immutableIntegrityError(
        sha256,
        await sha256Hex(existing),
        bytes.byteLength,
        existing.byteLength,
        operation,
      );
    }
  }
  return "exists";
}

function configuredPublicKeys(env: PantryWorkerBindings): ReadonlyMap<string, string> {
  const raw = (env as PantryWorkerBindings & { PANTRY_REVISION_PUBLIC_KEYS?: string })
    .PANTRY_REVISION_PUBLIC_KEYS;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PantryHttpError(
      503,
      "catalog_infrastructure_unavailable",
      "Pantry verification keys are not configured",
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const keys = new Map<string, string>();
    for (const [kid, pem] of Object.entries(parsed)) {
      if (typeof pem !== "string" || pem.length === 0) throw new Error();
      keys.set(kid, pem);
    }
    if (keys.size === 0) throw new Error();
    return keys;
  } catch {
    throw new PantryHttpError(
      503,
      "catalog_infrastructure_unavailable",
      "Pantry verification keys are not configured",
    );
  }
}

async function handleStockRequest(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin"]);
  if (env.PANTRY_INGEST_QUEUE === undefined) {
    throw new PantryHttpError(
      503,
      "catalog_infrastructure_unavailable",
      "Pantry ingest queue is not configured",
    );
  }
  const input = strictParse(pantryCatalogStockRequestSchema, await readJson(request));
  if ((await pantryCatalogStockRequestHash(input)) !== input.requestSha256) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry stock request hash does not match its content",
    );
  }
  const nowMs = Date.now();
  if (
    Date.parse(input.expiresAt) <= nowMs ||
    Date.parse(input.expiresAt) - nowMs > 24 * 60 * 60 * 1_000
  ) {
    throw new PantryHttpError(400, "catalog_invalid_request", "Pantry stock TTL is invalid");
  }
  const result = await coordinator.beginStock(input);
  if (result.state === "conflict") {
    throw new PantryHttpError(
      409,
      "catalog_conflict",
      "Pantry stock identity conflicts with the existing operation",
    );
  }
  // Requests only create or observe durable state. The catalog alarm is the sole queue producer,
  // so status polling can never amplify deliveries while a long ingest stage is in flight.
  const responseState = result.state === "adopted" ? "assembling" : result.state;
  return jsonResponse(
    result.state === "created" ? 201 : 200,
    pantryCatalogStockResponseSchema.parse({
      ok: true,
      state: responseState,
      assemblyId: result.state === "committed" ? result.assemblyId : result.assembly.assemblyId,
      revisionRootSha256: result.state === "committed" ? result.revisionRootSha256 : null,
    }),
  );
}

async function handleStockIdentityStatus(
  request: Request,
  coordinator: PantryCatalogCoordinator,
  identitySha256: string,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin", "builder-readonly"]);
  const status = await coordinator.getStockIdentity(identitySha256);
  if (status === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry stock identity was not found");
  }
  return jsonResponse(200, pantryCatalogStockIdentityStatusResponseSchema.parse(status));
}

async function handleAssemblyStatus(
  request: Request,
  coordinator: PantryCatalogCoordinator,
  assemblyId: string,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin", "builder-readonly"]);
  const assembly = await coordinator.getAssembly(assemblyId);
  if (assembly === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  return jsonResponse(
    200,
    pantryCatalogAssemblyStatusResponseSchema.parse({
      ok: true,
      assemblyId,
      ingest: assembly.ingest ?? {
        state: "queued",
        attempt: 0,
        updatedAt: assembly.request.requestedAt,
        leaseUntil: null,
        failure: null,
      },
      stagedObjects: assembly.objects.length,
    }),
  );
}

async function handleAssemblyDiagnostics(
  request: Request,
  coordinator: PantryCatalogCoordinator,
  assemblyId: string,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin", "builder-readonly"]);
  const diagnostics = await coordinator.getAssemblyDiagnostics(assemblyId);
  if (diagnostics === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  return jsonResponse(200, pantryCatalogAssemblyDiagnosticsResponseSchema.parse(diagnostics));
}

async function handleAssemblyResourceEvidence(
  request: Request,
  coordinator: PantryCatalogCoordinator,
  assemblyId: string,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin"]);
  const generations = await coordinator.getGenerationResourceEvidence(assemblyId);
  if (generations.length === 0) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  return jsonResponse(200, {
    ok: true,
    assemblyId,
    generations,
  });
}

async function handleR2Probe(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin"]);
  const raw = (await readJson(request)) as {
    operations?: unknown;
    concurrency?: unknown;
    profile?: unknown;
    mode?: unknown;
    probeId?: unknown;
    window?: unknown;
    idleBetweenBatchesMs?: unknown;
    cpuHashRounds?: unknown;
  };
  if (raw.profile === "heavy-stage-object") {
    return handleRealisticR2Probe(raw, env, coordinator);
  }
  const operations = raw.operations;
  const concurrency = raw.concurrency;
  if (
    !Number.isSafeInteger(operations) ||
    typeof operations !== "number" ||
    operations < 1 ||
    operations > 900 ||
    !Number.isSafeInteger(concurrency) ||
    typeof concurrency !== "number" ||
    concurrency < 1 ||
    concurrency > 16
  ) {
    throw new PantryHttpError(400, "catalog_invalid_request", "Pantry R2 probe is invalid");
  }
  const nonce = crypto.randomUUID();
  const started = performance.now();
  let completed = 0;
  let maxConcurrency = 0;
  let active = 0;
  let failure:
    | {
        cause: string;
        errorClass: string;
        errorCode: string | null;
        errorFingerprint: string | null;
      }
    | undefined;
  while (completed < operations && failure === undefined) {
    const width = Math.min(concurrency, operations - completed);
    const offset = completed;
    await Promise.all(
      Array.from({ length: width }, async (_, index) => {
        if (failure !== undefined) return;
        active += 1;
        maxConcurrency = Math.max(maxConcurrency, active);
        try {
          await env.PANTRY_CATALOG_OBJECTS.head(
            `diagnostics/r2-probe/${nonce}/${String(offset + index).padStart(4, "0")}`,
          );
          completed += 1;
        } catch (error) {
          failure ??= {
            cause: classifyUnexpectedCatalogCause(error),
            errorClass: sanitizedErrorClass(error),
            errorCode: sanitizedErrorCode(error),
            errorFingerprint: await sanitizedErrorFingerprint(error),
          };
        } finally {
          active -= 1;
        }
      }),
    );
  }
  return jsonResponse(200, {
    ok: failure === undefined,
    requested: operations,
    completed,
    concurrency,
    maxConcurrency,
    elapsedMs: performance.now() - started,
    failure: failure ?? null,
  });
}

// Exact first-fourteen object-size shape from the cold heavy shelf evidence. The fourteenth
// object is the 4,377,468-byte payload on which every warm replay generation failed. Keeping
// the original order distinguishes an operation/body-shape defect from generic R2 weather.
const PANTRY_REALISTIC_R2_PROBE_SIZES = [
  460_701, 543, 11_135, 724, 544, 6_067, 29_207, 718, 665, 542, 738, 644, 678, 4_377_468,
] as const;

function realisticProbePayload(probeId: string, operation: number, bytes: number): Uint8Array {
  const output = new Uint8Array(bytes);
  let state = 0x811c9dc5 ^ operation;
  for (let index = 0; index < probeId.length; index += 1) {
    state = Math.imul(state ^ probeId.charCodeAt(index), 0x01000193) >>> 0;
  }
  for (let index = 0; index < output.byteLength; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 0xff;
  }
  return output;
}

async function clearRealisticR2Probe(
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
  probeId: string,
): Promise<{ objects: number; bytes: number; checkpoints: number }> {
  const prefix = `diagnostics/r2-realistic/${probeId}/`;
  const listed = await catalogBindingOperation(() =>
    env.PANTRY_CATALOG_OBJECTS.list({ prefix, limit: 1_000 }),
  );
  const keys = listed.objects.map((object) => object.key);
  if (keys.length > 0) {
    await catalogBindingOperation(() => env.PANTRY_CATALOG_OBJECTS.delete(keys));
  }
  return {
    objects: keys.length,
    bytes: listed.objects.reduce((total, object) => total + object.size, 0),
    checkpoints: await coordinator.clearR2ProbeCheckpoints(probeId),
  };
}

async function handleRealisticR2Probe(
  raw: {
    concurrency?: unknown;
    mode?: unknown;
    probeId?: unknown;
    window?: unknown;
    idleBetweenBatchesMs?: unknown;
    cpuHashRounds?: unknown;
  },
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
): Promise<Response> {
  const probeId = raw.probeId;
  if (typeof probeId !== "string" || !/^r2probe_[A-Za-z0-9_-]{8,64}$/u.test(probeId)) {
    throw new PantryHttpError(400, "catalog_invalid_request", "Pantry R2 probe ID is invalid");
  }
  if (raw.mode === "cleanup") {
    return jsonResponse(200, {
      ok: true,
      profile: "heavy-stage-object",
      probeId,
      cleaned: await clearRealisticR2Probe(env, coordinator, probeId),
    });
  }
  const concurrency = raw.concurrency;
  const window = raw.window;
  const idleBetweenBatchesMs = raw.idleBetweenBatchesMs;
  const cpuHashRounds = raw.cpuHashRounds;
  if (
    raw.mode !== "run" ||
    !Number.isSafeInteger(window) ||
    typeof window !== "number" ||
    window < 1 ||
    window > 20 ||
    !Number.isSafeInteger(concurrency) ||
    typeof concurrency !== "number" ||
    concurrency < 1 ||
    concurrency > 4 ||
    !Number.isSafeInteger(idleBetweenBatchesMs) ||
    typeof idleBetweenBatchesMs !== "number" ||
    idleBetweenBatchesMs < 0 ||
    idleBetweenBatchesMs > 10_000 ||
    !Number.isSafeInteger(cpuHashRounds) ||
    typeof cpuHashRounds !== "number" ||
    cpuHashRounds < 1 ||
    cpuHashRounds > 4
  ) {
    throw new PantryHttpError(
      400,
      "catalog_invalid_request",
      "Pantry realistic R2 probe is invalid",
    );
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results: Array<{
    operation: number;
    bytes: number;
    contentSha256: string;
    state: "created" | "exists";
    cpuMs: number;
    r2PutAndVerifyMs: number;
    coordinatorWriteMs: number;
    completedAt: string;
  }> = [];
  let failure:
    | {
        operation: number;
        bytes: number;
        stage: "cpu-hash" | "r2-put-and-verify" | "coordinator-write";
        cause: string;
        errorClass: string;
        errorCode: string | null;
        errorFingerprint: string | null;
        elapsedMs: number;
        sinceLastSuccessMs: number | null;
      }
    | undefined;
  let lastSuccessAt = started;

  for (
    let batchOffset = 0;
    batchOffset < PANTRY_REALISTIC_R2_PROBE_SIZES.length && failure === undefined;
    batchOffset += concurrency
  ) {
    const batch = PANTRY_REALISTIC_R2_PROBE_SIZES.slice(batchOffset, batchOffset + concurrency);
    await Promise.all(
      batch.map(async (bytes, batchIndex) => {
        if (failure !== undefined) return;
        const operation = batchOffset + batchIndex + 1;
        let stage: "cpu-hash" | "r2-put-and-verify" | "coordinator-write" = "cpu-hash";
        const operationStarted = performance.now();
        try {
          const payload = realisticProbePayload(probeId, operation, bytes);
          const cpuStarted = performance.now();
          let contentSha256 = "";
          for (let round = 0; round < cpuHashRounds; round += 1) {
            contentSha256 = await sha256Hex(payload);
          }
          const cpuMs = performance.now() - cpuStarted;
          const key = `diagnostics/r2-realistic/${probeId}/${operation
            .toString()
            .padStart(4, "0")}-${contentSha256}`;
          stage = "r2-put-and-verify";
          const r2Started = performance.now();
          const state = await putImmutableObject(
            env.PANTRY_CATALOG_OBJECTS,
            key,
            payload,
            contentSha256,
            "catalog-stage-object",
          );
          const r2PutAndVerifyMs = performance.now() - r2Started;
          stage = "coordinator-write";
          const coordinatorStarted = performance.now();
          const completedAt = new Date().toISOString();
          await coordinator.recordR2ProbeCheckpoint(probeId, window, operation, {
            contentSha256,
            bytes,
            completedAt,
          });
          const coordinatorWriteMs = performance.now() - coordinatorStarted;
          lastSuccessAt = performance.now();
          results.push({
            operation,
            bytes,
            contentSha256,
            state,
            cpuMs,
            r2PutAndVerifyMs,
            coordinatorWriteMs,
            completedAt,
          });
        } catch (error) {
          const failedAt = performance.now();
          failure ??= {
            operation,
            bytes,
            stage,
            cause: classifyUnexpectedCatalogCause(error),
            errorClass: sanitizedErrorClass(error),
            errorCode: sanitizedErrorCode(error),
            errorFingerprint: await sanitizedErrorFingerprint(error),
            elapsedMs: failedAt - operationStarted,
            sinceLastSuccessMs: results.length === 0 ? null : failedAt - lastSuccessAt,
          };
        }
      }),
    );
    if (
      failure === undefined &&
      batchOffset + concurrency < PANTRY_REALISTIC_R2_PROBE_SIZES.length &&
      idleBetweenBatchesMs > 0
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, idleBetweenBatchesMs));
    }
  }

  results.sort((left, right) => left.operation - right.operation);
  return jsonResponse(200, {
    // The signed gateway reserves `ok` for the transport envelope. Probe failure is an observed
    // diagnostic result, not a malformed service response.
    ok: true,
    probeSucceeded: failure === undefined,
    profile: "heavy-stage-object",
    probeId,
    window,
    startedAt,
    completedAt: new Date().toISOString(),
    concurrency,
    idleBetweenBatchesMs,
    cpuHashRounds,
    requested: PANTRY_REALISTIC_R2_PROBE_SIZES.length,
    completed: results.length,
    elapsedMs: performance.now() - started,
    results,
    failure: failure ?? null,
  });
}

async function handleStageObject(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
  assemblyId: string,
  sha256: string,
  rawKind: string,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin"]);
  const kind = strictParse(pantryCatalogObjectKindSchema, rawKind);
  const bytes = await readCappedBytes(request, MAX_CATALOG_OBJECT_BYTES);
  if (bytes.byteLength === 0 || (await sha256Hex(bytes)) !== sha256) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry staged object does not match its content address",
    );
  }
  if (
    (await catalogOperation("catalog-read-assembly", () => coordinator.getAssembly(assemblyId))) ===
    null
  ) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  const key = quarantineObjectKey(assemblyId, sha256);
  const stored = await catalogOperation("catalog-stage-object", () =>
    putImmutableObject(env.PANTRY_CATALOG_OBJECTS, key, bytes, sha256, "catalog-stage-object"),
  );
  const reference = strictParse(pantryCatalogObjectReferenceSchema, {
    kind,
    sha256,
    bytes: bytes.byteLength,
  });
  let recorded: Awaited<ReturnType<PantryCatalogCoordinator["recordStagedObject"]>>;
  try {
    recorded = await catalogOperation("catalog-record-object", () =>
      coordinator.recordStagedObject(assemblyId, reference),
    );
  } catch (error) {
    if (stored === "created") await env.PANTRY_CATALOG_OBJECTS.delete(key);
    throw error;
  }
  if (recorded === "not_found") {
    if (stored === "created") await env.PANTRY_CATALOG_OBJECTS.delete(key);
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  if (recorded === "conflict") {
    if (stored === "created") await env.PANTRY_CATALOG_OBJECTS.delete(key);
    throw new PantryHttpError(409, "catalog_conflict", "Pantry staged object conflicts");
  }
  return jsonResponse(recorded === "recorded" ? 201 : 200, {
    ok: true,
    state: recorded,
    assemblyId,
    object: reference,
  });
}

async function buildCommittedShelf(
  input: PantryCatalogCommitRequest,
  env: PantryWorkerBindings,
): Promise<PantryCatalogShelfRecord> {
  const verification = await verifyPantryRevisionRecord(input.revision, configuredPublicKeys(env));
  if (!verification.ok || !pantryRevisionIsCommittable(input.revision.content)) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry revision verification failed",
    );
  }
  // The commit request's initial lifecycle timestamp is the deterministic commit instant.
  // Reusing it makes a retried commit byte-identical instead of minting a new manifest.
  const committedAt = input.state.updatedAt;
  const withoutHash = {
    format: input.format,
    schemaVersion: input.schemaVersion,
    revision: input.revision,
    state: {
      ...input.state,
      state: "committed" as const,
      stateRevision: 1,
      updatedAt: committedAt,
    },
    objectReferences: input.objectReferences,
    lockfileSha256: input.lockfileSha256,
    sbomSha256: input.sbomSha256,
    toolchainAttestationSha256: input.toolchainAttestationSha256,
    retention: input.retention,
    committedAt,
  };
  return pantryCatalogShelfRecordSchema.parse({
    ...withoutHash,
    manifestSha256: await pantryCatalogShelfManifestHash(withoutHash),
  });
}

async function handleCommit(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
  assemblyId: string,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin"]);
  const input = strictParse(pantryCatalogCommitRequestSchema, await readJson(request));
  if (input.assemblyId !== assemblyId) {
    throw new PantryHttpError(400, "catalog_invalid_request", "Pantry assembly IDs differ");
  }
  const shelf = await catalogOperation("catalog-build-shelf", () =>
    buildCommittedShelf(input, env),
  );
  const existing = await catalogOperation("catalog-read-existing-shelf", () =>
    coordinator.getShelfByRoot(shelf.revision.rootSha256),
  );
  if (existing !== null) {
    if (existing.shelf.manifestSha256 !== shelf.manifestSha256) {
      throw new PantryHttpError(409, "catalog_conflict", "Pantry revision already exists");
    }
    await catalogOperation("catalog-verify-existing-shelf", () =>
      verifyStoredShelf(env.PANTRY_CATALOG_OBJECTS, existing.shelf),
    );
    return jsonResponse(200, {
      ok: true,
      state: "replay",
      shelf: existing.shelf,
      lifecycle: existing.lifecycle,
    });
  }
  const assembly = await catalogOperation("catalog-read-assembly", () =>
    coordinator.getAssembly(assemblyId),
  );
  if (assembly === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  if (canonicalPantryJson(assembly.objects) !== canonicalPantryJson(shelf.objectReferences)) {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry assembly is incomplete");
  }
  const verifiedObjects = await catalogOperation("catalog-verify-quarantine", async () => {
    const verified = new Map<string, Uint8Array>();
    for (const reference of shelf.objectReferences) {
      const bytes = await readAndVerifyObject(
        env.PANTRY_CATALOG_OBJECTS,
        quarantineObjectKey(assemblyId, reference.sha256),
        reference.sha256,
        reference.bytes,
      );
      verified.set(reference.sha256, bytes);
    }
    return verified;
  });
  let manifestWritten = false;
  let committed: Awaited<ReturnType<PantryCatalogCoordinator["commitShelf"]>>;
  try {
    await catalogOperation("catalog-promote-cas", async () => {
      for (const reference of shelf.objectReferences) {
        const bytes = verifiedObjects.get(reference.sha256);
        if (bytes === undefined) {
          throw new PantryHttpError(409, "catalog_incomplete", "Pantry assembly is incomplete");
        }
        await putImmutableObject(
          env.PANTRY_CATALOG_OBJECTS,
          committedObjectKey(reference.sha256),
          bytes,
          reference.sha256,
          "catalog-promote-cas",
        );
      }
    });
    const manifestBytes = new TextEncoder().encode(canonicalPantryJson(shelf));
    await catalogOperation("catalog-write-manifest", async () =>
      putImmutableObject(
        env.PANTRY_CATALOG_OBJECTS,
        revisionManifestKey(shelf),
        manifestBytes,
        await sha256Hex(manifestBytes),
        "catalog-write-manifest",
      ),
    );
    manifestWritten = true;
    committed = await catalogOperation("catalog-commit-ledger", () =>
      coordinator.commitShelf(assemblyId, shelf),
    );
  } catch (error) {
    if (manifestWritten) {
      try {
        const durableShelf = await coordinator.getShelfByRoot(shelf.revision.rootSha256);
        if (durableShelf === null) {
          await env.PANTRY_CATALOG_OBJECTS.delete(revisionManifestKey(shelf));
        }
      } catch {
        // Ambiguous durable state is left intact; the guarded orphan sweep owns the crash gap.
      }
    }
    throw error;
  }
  if (committed === "not_found") {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  if (committed === "incomplete") {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry assembly is incomplete");
  }
  if (committed === "conflict") {
    throw new PantryHttpError(409, "catalog_conflict", "Pantry revision commit conflicts");
  }
  await catalogOperation("catalog-delete-quarantine", async () => {
    for (const reference of assembly.objects) {
      await env.PANTRY_CATALOG_OBJECTS.delete(quarantineObjectKey(assemblyId, reference.sha256));
    }
  });
  return jsonResponse(committed === "committed" ? 201 : 200, {
    ok: true,
    state: committed,
    shelf,
    lifecycle: shelf.state,
  });
}

async function handleCaptureBuildResource(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
): Promise<Response> {
  requirePrincipal(request, ["catalog-admin"]);
  const input = strictParse(pantryCaptureBuildResourceRequestSchema, await readJson(request));
  const parent = await coordinator.getShelfByRoot(input.parentRevisionRootSha256);
  if (parent === null || parent.lifecycle.state !== "committed") {
    throw new PantryHttpError(404, "catalog_not_found", "Parent Pantry revision was not found");
  }
  const existing = parent.shelf.revision.content.capturedBuildResources?.find(
    (resource) =>
      resource.url === input.url &&
      (input.expectedSha256 === null || resource.contentSha256 === input.expectedSha256),
  );
  if (existing !== undefined) {
    return jsonResponse(200, {
      ok: true,
      state: "replay",
      shelf: parent.shelf,
      lifecycle: parent.lifecycle,
      resource: existing,
    });
  }
  let captured: Awaited<ReturnType<typeof capturePantryBuildResource>>;
  try {
    captured = await capturePantryBuildResource(input);
  } catch (error) {
    const typed = ingestErrorDefaults(error);
    throw new PantryHttpError(
      pantryErrorStatus(typed.code),
      typed.code === "stocking_size_limit"
        ? "catalog_invalid_request"
        : typed.code === "integrity_mismatch"
          ? "catalog_integrity_mismatch"
          : "catalog_infrastructure_unavailable",
      typed.message,
      typed.retryable,
    );
  }
  const resourceReference = pantryCatalogObjectReferenceSchema.parse({
    kind: "captured-build-resource",
    sha256: captured.contentSha256,
    bytes: captured.bytes.byteLength,
  });
  await putImmutableObject(
    env.PANTRY_CATALOG_OBJECTS,
    committedObjectKey(captured.contentSha256),
    captured.bytes,
    captured.contentSha256,
    "catalog-promote-cas",
  );
  const identity = await coordinator.allocateRevisionIdentity(input.requestedAt.slice(0, 10));
  if (identity.parentRootSha256 !== input.parentRevisionRootSha256) {
    throw new PantryHttpError(
      409,
      "catalog_conflict",
      "Pantry advanced while the build resource was captured",
      true,
    );
  }
  const signer = requireIngestSigner(env);
  const resources = [
    ...(parent.shelf.revision.content.capturedBuildResources ?? []),
    {
      url: captured.url,
      contentSha256: captured.contentSha256,
      bytes: captured.bytes.byteLength,
      mediaType: captured.mediaType,
    },
  ].sort((left, right) => {
    const a = `${left.url}\0${left.contentSha256}`;
    const b = `${right.url}\0${right.contentSha256}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const revisionContent = {
    ...parent.shelf.revision.content,
    revisionId: identity.revisionId,
    createdAt: input.requestedAt,
    parentRootSha256: input.parentRevisionRootSha256,
    capturedBuildResources: resources,
  };
  const rootSha256 = await pantryRevisionRoot(revisionContent);
  const revision = {
    content: revisionContent,
    rootSha256,
    signature: await signPantryDigest(signer.privateKeyPem, {
      kind: "revision",
      kid: signer.kid,
      payloadSha256: rootSha256,
    }),
  };
  const objectReferences = [
    ...parent.shelf.objectReferences,
    ...(parent.shelf.objectReferences.some(
      (reference) => reference.sha256 === resourceReference.sha256,
    )
      ? []
      : [resourceReference]),
  ].sort((left, right) => {
    const a = `${left.sha256}\0${left.kind}`;
    const b = `${right.sha256}\0${right.kind}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const committedAt = input.requestedAt;
  const withoutHash = {
    format: parent.shelf.format,
    schemaVersion: parent.shelf.schemaVersion,
    revision,
    state: {
      schemaVersion: 1 as const,
      revisionId: identity.revisionId,
      rootSha256,
      state: "committed" as const,
      stateRevision: 1,
      updatedAt: committedAt,
    },
    objectReferences,
    lockfileSha256: parent.shelf.lockfileSha256,
    sbomSha256: parent.shelf.sbomSha256,
    toolchainAttestationSha256: parent.shelf.toolchainAttestationSha256,
    retention: parent.shelf.retention,
    committedAt,
  };
  const shelf = pantryCatalogShelfRecordSchema.parse({
    ...withoutHash,
    manifestSha256: await pantryCatalogShelfManifestHash(withoutHash),
  });
  const manifestBytes = new TextEncoder().encode(canonicalPantryJson(shelf));
  await putImmutableObject(
    env.PANTRY_CATALOG_OBJECTS,
    revisionManifestKey(shelf),
    manifestBytes,
    await sha256Hex(manifestBytes),
    "catalog-write-manifest",
  );
  const committed = await coordinator.commitDerivedShelf(input.parentRevisionRootSha256, shelf);
  if (committed === "not_found") {
    throw new PantryHttpError(404, "catalog_not_found", "Parent Pantry revision was not found");
  }
  if (committed === "conflict") {
    throw new PantryHttpError(409, "catalog_conflict", "Pantry derived revision conflicts", true);
  }
  return jsonResponse(committed === "committed" ? 201 : 200, {
    ok: true,
    state: committed,
    shelf,
    lifecycle: shelf.state,
    resource: resources.find(
      (resource) =>
        resource.url === captured.url && resource.contentSha256 === captured.contentSha256,
    ),
  });
}

async function verifyStoredShelf(bucket: R2Bucket, shelf: PantryCatalogShelfRecord): Promise<void> {
  const manifest = await readAndVerifyObject(
    bucket,
    revisionManifestKey(shelf),
    await sha256Hex(new TextEncoder().encode(canonicalPantryJson(shelf))),
  );
  const parsed = strictParse(
    pantryCatalogShelfRecordSchema,
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)),
  );
  if (canonicalPantryJson(parsed) !== canonicalPantryJson(shelf)) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry shelf manifest does not match the catalog ledger",
    );
  }
  for (const reference of shelf.objectReferences) {
    await readAndVerifyObject(
      bucket,
      committedObjectKey(reference.sha256),
      reference.sha256,
      reference.bytes,
    );
  }
}

async function shelfLookupResponse(
  env: PantryWorkerBindings,
  lookup: Awaited<ReturnType<PantryCatalogCoordinator["getShelfByRoot"]>>,
): Promise<Response> {
  if (lookup === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry revision was not found");
  }
  await verifyStoredShelf(env.PANTRY_CATALOG_OBJECTS, lookup.shelf);
  return jsonResponse(200, { ok: true, ...lookup });
}

async function shelfContentHashesResponse(
  env: PantryWorkerBindings,
  lookup: Awaited<ReturnType<PantryCatalogCoordinator["getShelfByRoot"]>>,
): Promise<Response> {
  if (lookup === null || lookup.lifecycle.state !== "committed") {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry revision was not found");
  }
  const shelf = lookup.shelf;
  await verifyStoredShelf(env.PANTRY_CATALOG_OBJECTS, shelf);
  const revisionVerification = await verifyPantryRevisionRecord(
    shelf.revision,
    configuredPublicKeys(env),
  );
  if (!revisionVerification.ok) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry revision attestation did not verify",
    );
  }
  const references = new Map(
    shelf.objectReferences
      .filter((reference) => reference.kind === "normalized-package")
      .map((reference) => [reference.sha256, reference.bytes]),
  );
  const addresses = [
    ...new Set(
      shelf.revision.content.closure.ingredients.map(
        (ingredient) => ingredient.normalizedContentSha256,
      ),
    ),
  ].sort(compareUtf8);
  const hashes = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const address of addresses) {
    const expectedBytes = references.get(address);
    if (expectedBytes === undefined) {
      throw new PantryHttpError(
        422,
        "catalog_integrity_mismatch",
        "Pantry normalized package attestation is incomplete",
      );
    }
    const bytes = await readAndVerifyObject(
      env.PANTRY_CATALOG_OBJECTS,
      committedObjectKey(address),
      address,
      expectedBytes,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new PantryHttpError(
        422,
        "catalog_integrity_mismatch",
        "Pantry normalized package attestation is invalid",
      );
    }
    const manifest = pantryNormalizedPackageManifestSchema.safeParse(parsed);
    if (!manifest.success || canonicalPantryJson(manifest.data) !== decoder.decode(bytes)) {
      throw new PantryHttpError(
        422,
        "catalog_integrity_mismatch",
        "Pantry normalized package attestation is invalid",
      );
    }
    for (const entry of manifest.data.entries) hashes.add(entry.sha256);
    if (hashes.size > MAX_PANTRY_SHELF_CONTENT_HASHES) {
      throw new PantryHttpError(
        422,
        "catalog_integrity_mismatch",
        "Pantry shelf exceeds the sealed layer content-hash bound",
      );
    }
  }
  const statement = {
    format: PANTRY_SHELF_CONTENT_HASHES_FORMAT,
    schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
    pantryRevisionId: shelf.revision.content.revisionId,
    pantryRevisionRootSha256: shelf.revision.rootSha256,
    shelfManifestSha256: shelf.manifestSha256,
    contentHashes: [...hashes].sort(compareUtf8),
  };
  const statementSha256 = await pantryShelfContentHashesHash(statement);
  const signer = requireIngestSigner(env);
  return jsonResponse(
    200,
    pantryShelfContentHashesResponseSchema.parse({
      ok: true,
      statement,
      statementSha256,
      signature: await signPantryDigest(signer.privateKeyPem, {
        kind: "shelf-content-hashes",
        kid: signer.kid,
        payloadSha256: statementSha256,
      }),
    }),
  );
}

async function listR2(
  bucket: R2Bucket,
): Promise<{ objects: number; bytes: number; quarantineObjects: number }> {
  let cursor: string | undefined;
  let objects = 0;
  let bytes = 0;
  let quarantineObjects = 0;
  do {
    const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }), limit: 1_000 });
    for (const object of page.objects) {
      objects += 1;
      bytes += object.size;
      if (object.key.startsWith("quarantine/")) quarantineObjects += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { objects, bytes, quarantineObjects };
}

async function handleGc(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
): Promise<Response> {
  requirePrincipal(request, ["catalog-gc"]);
  const input = strictParse(pantryCatalogGcRequestSchema, await readJson(request));
  const nowMs = Date.parse(input.now);
  if (input.scope === "orphan-cas-sweep" || input.scope === "targeted-orphan-cas") {
    const safetyCutoffMs = nowMs - PANTRY_ORPHAN_CAS_SAFETY_WINDOW_MS;
    const candidates = new Map<string, { key: string; size: number; uploadedMs: number }>();
    const quarantineCandidates = new Map<
      string,
      { assemblyId: string; size: number; uploadedMs: number }
    >();
    const revisionCandidates = new Map<
      string,
      { rootSha256: string; size: number; uploadedMs: number }
    >();
    if (input.scope === "targeted-orphan-cas") {
      for (const sha256 of input.objectSha256 ?? []) {
        const key = committedObjectKey(sha256);
        const object = await env.PANTRY_CATALOG_OBJECTS.head(key);
        if (object !== null) {
          candidates.set(sha256, {
            key,
            size: object.size,
            uploadedMs: object.uploaded.getTime(),
          });
        }
      }
    } else {
      let cursor: string | undefined;
      do {
        const page = await env.PANTRY_CATALOG_OBJECTS.list({
          prefix: "cas/sha256/",
          limit: 1_000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const object of page.objects) {
          const sha256 = /^cas\/sha256\/([0-9a-f]{64})$/u.exec(object.key)?.[1];
          if (sha256 !== undefined) {
            candidates.set(sha256, {
              key: object.key,
              size: object.size,
              uploadedMs: object.uploaded.getTime(),
            });
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined && candidates.size < input.maxDeletes * 4);
      cursor = undefined;
      do {
        const page = await env.PANTRY_CATALOG_OBJECTS.list({
          prefix: "quarantine/",
          limit: 1_000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const object of page.objects) {
          const match = /^quarantine\/(passembly_[0-9a-f]{64})\/objects\/[0-9a-f]{64}$/u.exec(
            object.key,
          );
          if (match !== null) {
            quarantineCandidates.set(object.key, {
              assemblyId: match[1],
              size: object.size,
              uploadedMs: object.uploaded.getTime(),
            });
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined && quarantineCandidates.size < input.maxDeletes * 4);
      cursor = undefined;
      do {
        const page = await env.PANTRY_CATALOG_OBJECTS.list({
          prefix: "revisions/",
          limit: 1_000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const object of page.objects) {
          const match = /^revisions\/pantry-\d{4}-\d{2}-\d{2}\.\d+\/([0-9a-f]{64})\.json$/u.exec(
            object.key,
          );
          if (match !== null) {
            revisionCandidates.set(object.key, {
              rootSha256: match[1],
              size: object.size,
              uploadedMs: object.uploaded.getTime(),
            });
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined && revisionCandidates.size < input.maxDeletes * 4);
    }
    const deletedObjectSha256: string[] = [];
    const deletedQuarantineKeys: string[] = [];
    const deletedRevisionKeys: string[] = [];
    let deletedBytes = 0;
    for (const [sha256, candidate] of [...candidates.entries()].sort(([left], [right]) =>
      compareUtf8(left, right),
    )) {
      if (deletedObjectSha256.length >= input.maxDeletes) break;
      if (candidate.uploadedMs > safetyCutoffMs) continue;
      if (await coordinator.isObjectReferenced(sha256)) continue;
      await env.PANTRY_CATALOG_OBJECTS.delete(candidate.key);
      deletedObjectSha256.push(sha256);
      deletedBytes += candidate.size;
    }
    if (input.scope === "orphan-cas-sweep") {
      for (const [key, candidate] of [...quarantineCandidates.entries()].sort(([left], [right]) =>
        compareUtf8(left, right),
      )) {
        if (
          deletedObjectSha256.length + deletedQuarantineKeys.length + deletedRevisionKeys.length >=
          input.maxDeletes
        )
          break;
        if (candidate.uploadedMs > safetyCutoffMs) continue;
        if ((await coordinator.getAssembly(candidate.assemblyId)) !== null) continue;
        await env.PANTRY_CATALOG_OBJECTS.delete(key);
        deletedQuarantineKeys.push(key);
        deletedBytes += candidate.size;
      }
      for (const [key, candidate] of [...revisionCandidates.entries()].sort(([left], [right]) =>
        compareUtf8(left, right),
      )) {
        if (
          deletedObjectSha256.length + deletedQuarantineKeys.length + deletedRevisionKeys.length >=
          input.maxDeletes
        )
          break;
        if (candidate.uploadedMs > safetyCutoffMs) continue;
        if ((await coordinator.getShelfByRoot(candidate.rootSha256)) !== null) continue;
        await env.PANTRY_CATALOG_OBJECTS.delete(key);
        deletedRevisionKeys.push(key);
        deletedBytes += candidate.size;
      }
    }
    // eslint-disable-next-line no-console -- metadata-only trusted cleanup audit
    console.log(
      JSON.stringify({
        event: "pantry_orphan_cas_reclaimed",
        scope: input.scope,
        candidates: candidates.size,
        deletedObjects: deletedObjectSha256.length,
        deletedQuarantineObjects: deletedQuarantineKeys.length,
        deletedRevisionManifests: deletedRevisionKeys.length,
        deletedBytes,
      }),
    );
    return jsonResponse(200, {
      ok: true,
      scope: input.scope,
      deletedAssemblyIds: [],
      deletedRevisionRoots: [],
      deletedObjectSha256,
      deletedQuarantineKeys,
      deletedRevisionKeys,
      deletedBytes,
    });
  }
  if (input.scope === "expired-uncommitted") {
    const deletedAssemblyIds = await coordinator.cleanupExpiredAssemblies(nowMs, input.maxDeletes);
    return jsonResponse(200, {
      ok: true,
      scope: input.scope,
      deletedAssemblyIds,
      deletedRevisionRoots: [],
    });
  }
  const retiredRoots: string[] = [];
  const prefix = "revisions/";
  let cursor: string | undefined;
  const candidates = new Set<string>();
  do {
    const page = await env.PANTRY_CATALOG_OBJECTS.list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      const match = /^revisions\/pantry-\d{4}-\d{2}-\d{2}\.\d+\/([0-9a-f]{64})\.json$/u.exec(
        object.key,
      );
      if (match) candidates.add(match[1]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined && candidates.size < input.maxDeletes);
  for (const root of [...candidates].sort().slice(0, input.maxDeletes)) {
    const removed = await coordinator.collectRetiredShelf(
      root,
      input.retentionNamespace ?? "",
      nowMs,
    );
    if (typeof removed === "object") {
      await env.PANTRY_CATALOG_OBJECTS.delete(revisionManifestKey(removed.shelf));
      for (const sha256 of removed.unreferencedObjectSha256) {
        await env.PANTRY_CATALOG_OBJECTS.delete(committedObjectKey(sha256));
      }
      retiredRoots.push(root);
    }
  }
  return jsonResponse(200, {
    ok: true,
    scope: input.scope,
    deletedAssemblyIds: [],
    deletedRevisionRoots: retiredRoots,
  });
}

export async function handlePantryWorkerRequest(
  request: Request,
  env: PantryWorkerBindings,
  injectedCoordinator?: PantryCatalogCoordinator,
): Promise<Response> {
  const coordinator = injectedCoordinator ?? getCoordinator(env);
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (url.search !== "") {
      throw new PantryHttpError(
        400,
        "catalog_invalid_request",
        "Pantry query parameters are not supported",
      );
    }
    if (request.method === "GET" && pathname === `${INTERNAL_PREFIX}/health`) {
      requirePrincipal(request, ["catalog-admin", "builder-readonly", "catalog-gc"]);
      return jsonResponse(200, { ok: true, service: "pantry-catalog", schemaVersion: 1 });
    }
    if (request.method === "POST" && pathname === `${INTERNAL_PREFIX}/stock-requests`) {
      return await handleStockRequest(request, env, coordinator);
    }
    const stockIdentityMatch = new RegExp(
      `^${INTERNAL_PREFIX}/stock-identities/([0-9a-f]{64})$`,
    ).exec(pathname);
    if (stockIdentityMatch !== null) {
      if (request.method !== "GET") {
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      }
      return await handleStockIdentityStatus(request, coordinator, stockIdentityMatch[1]);
    }
    if (request.method === "POST" && pathname === `${INTERNAL_PREFIX}/build-resources`) {
      return await handleCaptureBuildResource(request, env, coordinator);
    }
    if (request.method === "POST" && pathname === `${INTERNAL_PREFIX}/diagnostics/r2-probe`) {
      return await handleR2Probe(request, env, coordinator);
    }
    const diagnosticsMatch = new RegExp(
      `^${INTERNAL_PREFIX}/assemblies/(passembly_[0-9a-f]{64})/diagnostics$`,
    ).exec(pathname);
    if (diagnosticsMatch !== null) {
      if (request.method !== "GET") {
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      }
      return await handleAssemblyDiagnostics(request, coordinator, diagnosticsMatch[1]);
    }
    const resourceEvidenceMatch = new RegExp(
      `^${INTERNAL_PREFIX}/assemblies/(passembly_[0-9a-f]{64})/resource-evidence$`,
    ).exec(pathname);
    if (resourceEvidenceMatch !== null) {
      if (request.method !== "GET") {
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      }
      return await handleAssemblyResourceEvidence(request, coordinator, resourceEvidenceMatch[1]);
    }
    const statusMatch = new RegExp(`^${INTERNAL_PREFIX}/assemblies/(passembly_[0-9a-f]{64})$`).exec(
      pathname,
    );
    if (statusMatch !== null) {
      if (request.method !== "GET") {
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      }
      return await handleAssemblyStatus(request, coordinator, statusMatch[1]);
    }
    const objectMatch = new RegExp(
      `^${INTERNAL_PREFIX}/assemblies/(passembly_[0-9a-f]{64})/objects/([0-9a-f]{64})/([a-z-]+)$`,
    ).exec(pathname);
    if (objectMatch !== null) {
      if (request.method !== "PUT") {
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      }
      return await handleStageObject(
        request,
        env,
        coordinator,
        objectMatch[1],
        objectMatch[2],
        objectMatch[3],
      );
    }
    const commitMatch = new RegExp(
      `^${INTERNAL_PREFIX}/assemblies/(passembly_[0-9a-f]{64})/commit$`,
    ).exec(pathname);
    if (commitMatch !== null) {
      if (request.method !== "POST") {
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      }
      return await handleCommit(request, env, coordinator, commitMatch[1]);
    }
    const rootLookup = new RegExp(`^${INTERNAL_PREFIX}/revisions/by-root/([0-9a-f]{64})$`).exec(
      pathname,
    );
    if (rootLookup !== null) {
      if (request.method !== "GET")
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      requirePrincipal(request, ["catalog-admin", "builder-readonly"]);
      return await shelfLookupResponse(env, await coordinator.getShelfByRoot(rootLookup[1]));
    }
    const contentHashesLookup = new RegExp(
      `^${INTERNAL_PREFIX}/revisions/by-root/([0-9a-f]{64})/content-hashes$`,
    ).exec(pathname);
    if (contentHashesLookup !== null) {
      if (request.method !== "GET")
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      requirePrincipal(request, ["builder-readonly"]);
      return await shelfContentHashesResponse(
        env,
        await coordinator.getShelfByRoot(contentHashesLookup[1]),
      );
    }
    const revisionLookup = new RegExp(
      `^${INTERNAL_PREFIX}/revisions/(pantry-\\d{4}-\\d{2}-\\d{2}\\.[1-9]\\d*)$`,
    ).exec(pathname);
    if (revisionLookup !== null) {
      if (request.method !== "GET")
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      requirePrincipal(request, ["catalog-admin", "builder-readonly"]);
      const lookup = await coordinator.getShelfByRevisionId(revisionLookup[1]);
      return await shelfLookupResponse(env, lookup);
    }
    const stateMatch = new RegExp(`^${INTERNAL_PREFIX}/revisions/([0-9a-f]{64})/state$`).exec(
      pathname,
    );
    if (stateMatch !== null) {
      if (request.method !== "POST")
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      requirePrincipal(request, ["catalog-admin"]);
      const input = strictParse(pantryCatalogStateTransitionRequestSchema, await readJson(request));
      const result = await coordinator.transitionShelf(
        stateMatch[1],
        input.expectedStateRevision,
        input.nextState,
        input.updatedAt,
      );
      if (result === "not_found")
        throw new PantryHttpError(404, "catalog_not_found", "Pantry revision was not found");
      if (result === "conflict")
        throw new PantryHttpError(409, "catalog_conflict", "Pantry lifecycle transition conflicts");
      const lookup = await coordinator.getShelfByRoot(stateMatch[1]);
      return jsonResponse(200, { ok: true, lifecycle: lookup?.lifecycle ?? null });
    }
    const referenceMatch = new RegExp(
      `^${INTERNAL_PREFIX}/revisions/([0-9a-f]{64})/references$`,
    ).exec(pathname);
    if (referenceMatch !== null) {
      requirePrincipal(request, ["catalog-admin"]);
      const input = strictParse(pantryCatalogReferenceRequestSchema, await readJson(request));
      if (request.method === "POST") {
        const result = await coordinator.retainShelf(referenceMatch[1], input.referenceId);
        if (result === "not_found")
          throw new PantryHttpError(404, "catalog_not_found", "Pantry revision was not found");
        return jsonResponse(result === "retained" ? 201 : 200, { ok: true, state: result });
      }
      if (request.method === "DELETE") {
        const result = await coordinator.releaseShelf(referenceMatch[1], input.referenceId);
        if (result === "not_found")
          throw new PantryHttpError(404, "catalog_not_found", "Pantry reference was not found");
        return jsonResponse(200, { ok: true, state: result });
      }
      throw new PantryHttpError(405, "catalog_method_not_allowed", "Pantry method is not allowed");
    }
    if (request.method === "POST" && pathname === `${INTERNAL_PREFIX}/stamps/verify`) {
      requirePrincipal(request, ["catalog-admin", "builder-readonly"]);
      const stamp = strictParse(pantryCatalogShelfStampSchema, await readJson(request));
      const lookup = await coordinator.getShelfByRoot(stamp.pantryRevisionRootSha256);
      if (
        lookup === null ||
        lookup.lifecycle.state !== "committed" ||
        !pantryCatalogShelfMatchesStamp(lookup.shelf, stamp)
      ) {
        throw new PantryHttpError(422, "catalog_stamp_mismatch", "Pantry shelf stamp is not valid");
      }
      await verifyStoredShelf(env.PANTRY_CATALOG_OBJECTS, lookup.shelf);
      return jsonResponse(200, {
        ok: true,
        verified: true,
        revisionRootSha256: stamp.pantryRevisionRootSha256,
      });
    }
    if (request.method === "POST" && pathname === `${INTERNAL_PREFIX}/gc`) {
      return await handleGc(request, env, coordinator);
    }
    if (request.method === "GET" && pathname === `${INTERNAL_PREFIX}/diagnostics`) {
      requirePrincipal(request, ["catalog-admin", "catalog-gc"]);
      return jsonResponse(200, {
        ok: true,
        ledger: await coordinator.diagnostics(),
        r2: await listR2(env.PANTRY_CATALOG_OBJECTS),
      });
    }
    if (request.method === "GET" && pathname === `${INTERNAL_PREFIX}/diagnostics/objects`) {
      requirePrincipal(request, ["catalog-admin"]);
      return jsonResponse(200, await inventoryPantryObjects(env.PANTRY_CATALOG_OBJECTS));
    }
    const objectRead = new RegExp(`^${INTERNAL_PREFIX}/objects/([0-9a-f]{64})$`).exec(pathname);
    if (objectRead !== null) {
      if (request.method !== "GET")
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      requirePrincipal(request, ["builder-readonly"]);
      const range = request.headers.get("range");
      if (range !== null) {
        return await readCommittedObjectRange(env.PANTRY_CATALOG_OBJECTS, objectRead[1], range);
      }
      const bytes = await readAndVerifyObject(
        env.PANTRY_CATALOG_OBJECTS,
        committedObjectKey(objectRead[1]),
        objectRead[1],
      );
      return new Response(bytes.slice().buffer, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      });
    }
    throw new PantryHttpError(404, "catalog_not_found", "Pantry endpoint was not found");
  } catch (error) {
    if (error instanceof PantryHttpError) return errorResponse(error);
    const cause = classifyUnexpectedCatalogCause(error);
    const errorClass = sanitizedErrorClass(error);
    const errorCode = sanitizedErrorCode(error);
    const errorFingerprint = await sanitizedErrorFingerprint(error);
    const operation =
      error instanceof PantryCatalogOperationError ? error.operation : "catalog-build-shelf";
    // eslint-disable-next-line no-console -- metadata-only trusted-service boundary
    console.error(
      JSON.stringify({
        event: "pantry_catalog_unexpected_error",
        errorClass,
        cause,
        operation,
        errorCode,
        errorFingerprint,
      }),
    );
    return errorResponse(
      new PantryHttpError(
        500,
        "catalog_internal_error",
        "The Pantry catalog encountered an internal error",
        true,
      ),
      {
        "x-nabuflow-pantry-cause": cause,
        "x-nabuflow-pantry-error-class": errorClass,
        "x-nabuflow-pantry-operation": operation,
        ...(errorCode === null ? {} : { "x-nabuflow-pantry-error-code": errorCode }),
        ...(errorFingerprint === null
          ? {}
          : { "x-nabuflow-pantry-error-fingerprint": errorFingerprint }),
      },
    );
  }
}

export async function handlePantryQueue(
  batch: MessageBatch<PantryStockQueueMessage>,
  env: PantryWorkerBindings,
  injectedCoordinator?: PantryCatalogCoordinator,
  injectedIngest: typeof ingestPantryStockRequest = ingestPantryStockRequest,
): Promise<void> {
  const rawCoordinator = injectedCoordinator ?? getCoordinator(env);
  for (const message of batch.messages) {
    const body = message.body;
    if (
      body?.schemaVersion !== 1 ||
      !/^passembly_[0-9a-f]{64}$/u.test(body.assemblyId) ||
      !/^[0-9a-f]{64}$/u.test(body.requestSha256) ||
      !Number.isSafeInteger(body.generation) ||
      body.generation < 1
    ) {
      message.ack();
      continue;
    }
    const counters = newInvocationCounters();
    const coordinator = countedCoordinator(rawCoordinator, counters);
    const countedEnv: PantryWorkerBindings = {
      ...env,
      PANTRY_CATALOG_OBJECTS: countedR2(env.PANTRY_CATALOG_OBJECTS, counters),
    };
    await coordinator.markQueueDelivery(body.assemblyId);
    const nowMs = Date.now();
    const ownerId = crypto.randomUUID();
    const claim = await coordinator.claimIngest(body.assemblyId, body.generation, ownerId, nowMs);
    if (
      claim.state === "not_found" ||
      claim.state === "busy" ||
      claim.state === "failed" ||
      claim.state === "stale"
    ) {
      message.ack();
      continue;
    }
    const attempt = claim.assembly.ingest?.attempt ?? 1;
    const persistResourceEvidence = async (
      outcome: PantryGenerationResourceEvidence["outcome"],
    ): Promise<void> => {
      counters.evidenceWrites += 1;
      await rawCoordinator.recordGenerationResourceEvidence(
        resourceEvidence(body.assemblyId, body.generation, attempt, counters, outcome),
      );
    };
    try {
      await ingestAndCommitAssembly(
        countedEnv,
        coordinator,
        claim.assembly,
        body.generation,
        ownerId,
        injectedIngest,
        counters,
        persistResourceEvidence,
      );
      message.ack();
    } catch (error) {
      await persistResourceEvidence("failed");
      const transientCatalogFailure =
        error instanceof PantryInternalCallError &&
        (error.cause === "catalog-storage-unavailable" ||
          error.cause === "catalog-storage-rate-limited");
      const typed =
        error instanceof PantryInternalCallError
          ? {
              code:
                transientCatalogFailure && attempt < PANTRY_CATALOG_TRANSIENT_MAX_ATTEMPTS
                  ? ("upstream_unavailable" as const)
                  : ("catalog_execution_failed" as const),
              message:
                transientCatalogFailure && attempt < PANTRY_CATALOG_TRANSIENT_MAX_ATTEMPTS
                  ? "The trusted Pantry catalog is temporarily unavailable"
                  : "The trusted Pantry catalog operation failed",
              retryable: transientCatalogFailure && attempt < PANTRY_CATALOG_TRANSIENT_MAX_ATTEMPTS,
              stage: error.stage,
              operation: error.operation,
              cause: error.cause,
              errorClass: error.errorClass,
              errorCode: error.errorCode,
              errorFingerprint: error.errorFingerprint,
            }
          : error instanceof PantryExecutionOwnershipError
            ? {
                code: "catalog_execution_failed" as const,
                message: "The Pantry assembly execution owner was fenced",
                retryable: false,
                stage: "lease-renewal" as const,
                operation: "lease-renewal" as const,
                cause: "catalog-owner-fenced" as const,
                errorClass: "Error" as const,
                errorCode: null,
                errorFingerprint: null,
              }
            : {
                ...ingestErrorDefaults(error),
                stage: "registry-ingest" as const,
                operation: "registry-ingest" as const,
                cause: "registry-upstream" as const,
                errorClass: sanitizedErrorClass(error),
                errorCode: sanitizedErrorCode(error),
                errorFingerprint: await sanitizedErrorFingerprint(error),
              };
      const failedAt = new Date().toISOString();
      const retryDelayMs = typed.retryable
        ? Math.min(
            PANTRY_CATALOG_TRANSIENT_RETRY_MAX_MS,
            PANTRY_CATALOG_TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
          )
        : NEGATIVE_CACHE_MS;
      const recorded = await rawCoordinator.recordIngestFailure(
        body.assemblyId,
        body.generation,
        ownerId,
        {
          ...typed,
          failedAt,
          negativeCacheUntil: new Date(Date.parse(failedAt) + retryDelayMs).toISOString(),
        },
      );
      if (!typed.retryable && recorded === "recorded") {
        try {
          const reclaimed = await rawCoordinator.reclaimAssemblyObjects(body.assemblyId);
          // eslint-disable-next-line no-console -- metadata-only trusted cleanup audit
          console.log(
            JSON.stringify({
              event: "pantry_terminal_objects_reclaimed",
              assemblyId: body.assemblyId,
              state: reclaimed.state,
              objects: reclaimed.state === "reclaimed" ? reclaimed.objects : 0,
              bytes: reclaimed.state === "reclaimed" ? reclaimed.bytes : 0,
            }),
          );
        } catch (reclaimError) {
          // The typed terminal already exists. The guarded orphan sweep owns crash-gap recovery.
          // eslint-disable-next-line no-console -- sanitized metadata-only cleanup failure
          console.error(
            JSON.stringify({
              event: "pantry_terminal_reclamation_failed",
              assemblyId: body.assemblyId,
              errorClass: sanitizedErrorClass(reclaimError),
              cause: classifyUnexpectedCatalogCause(reclaimError),
              errorCode: sanitizedErrorCode(reclaimError),
              errorFingerprint: await sanitizedErrorFingerprint(reclaimError),
            }),
          );
        }
      }
      // The catalog alarm owns all retry generation and delivery. Queue retry would create a
      // second, uncoordinated producer and recreate poll-amplification under edge redelivery.
      message.ack();
    }
  }
}

function requireIngestSigner(env: PantryWorkerBindings): { kid: string; privateKeyPem: string } {
  if (
    typeof env.PANTRY_INGEST_SIGNING_KEY_ID !== "string" ||
    env.PANTRY_INGEST_SIGNING_KEY_ID.length === 0 ||
    typeof env.PANTRY_INGEST_SIGNING_PRIVATE_KEY !== "string" ||
    !env.PANTRY_INGEST_SIGNING_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")
  ) {
    throw new PantryHttpError(
      503,
      "catalog_infrastructure_unavailable",
      "Pantry ingest signing is not configured",
      true,
    );
  }
  return {
    kid: env.PANTRY_INGEST_SIGNING_KEY_ID,
    privateKeyPem: env.PANTRY_INGEST_SIGNING_PRIVATE_KEY,
  };
}

async function internalPantryCall(
  request: Request,
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
  stage: PantryInternalCallStage,
): Promise<unknown> {
  const response = await handlePantryWorkerRequest(request, env, coordinator);
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const input = body as { code?: unknown };
    const headerCause = response.headers.get("x-nabuflow-pantry-cause");
    const headerErrorClass = response.headers.get("x-nabuflow-pantry-error-class");
    const headerOperation = response.headers.get("x-nabuflow-pantry-operation");
    const headerErrorCode = response.headers.get("x-nabuflow-pantry-error-code");
    const headerErrorFingerprint = response.headers.get("x-nabuflow-pantry-error-fingerprint");
    const cause: PantryIngestFailureRecord["cause"] =
      headerCause === "catalog-storage-limit" ||
      headerCause === "catalog-storage-rate-limited" ||
      headerCause === "catalog-storage-quota" ||
      headerCause === "catalog-storage-unavailable" ||
      headerCause === "catalog-binding-missing" ||
      headerCause === "catalog-owner-fenced" ||
      headerCause === "catalog-rejected" ||
      headerCause === "catalog-internal" ||
      headerCause === "executor-subrequest-limit"
        ? headerCause
        : response.status >= 500
          ? "catalog-internal"
          : "catalog-rejected";
    const errorClass: PantryIngestFailureRecord["errorClass"] =
      headerErrorClass === "Error" ||
      headerErrorClass === "TypeError" ||
      headerErrorClass === "RangeError" ||
      headerErrorClass === "DOMException" ||
      headerErrorClass === "PantryHttpError" ||
      headerErrorClass === "UnknownError"
        ? headerErrorClass
        : "PantryHttpError";
    const operation: PantryIngestFailureRecord["operation"] =
      headerOperation === "catalog-read-assembly" ||
      headerOperation === "catalog-stage-object" ||
      headerOperation === "catalog-record-object" ||
      headerOperation === "catalog-build-shelf" ||
      headerOperation === "catalog-read-existing-shelf" ||
      headerOperation === "catalog-verify-existing-shelf" ||
      headerOperation === "catalog-verify-quarantine" ||
      headerOperation === "catalog-promote-cas" ||
      headerOperation === "catalog-write-manifest" ||
      headerOperation === "catalog-commit-ledger" ||
      headerOperation === "catalog-delete-quarantine"
        ? headerOperation
        : stage === "stage-object"
          ? "catalog-stage-object"
          : "catalog-commit-ledger";
    throw new PantryInternalCallError(
      stage,
      operation,
      cause,
      errorClass,
      headerErrorCode !== null && /^[A-Za-z0-9_.-]{1,64}$/u.test(headerErrorCode)
        ? headerErrorCode
        : null,
      headerErrorFingerprint !== null && /^[0-9a-f]{16}$/u.test(headerErrorFingerprint)
        ? headerErrorFingerprint
        : null,
      response.status,
      typeof input.code === "string" ? input.code : "catalog_unknown_error",
    );
  }
  return body;
}

async function verifyResumedQuarantineObject(
  bucket: R2Bucket,
  assemblyId: string,
  object: { sha256: string; bytes: Uint8Array },
): Promise<void> {
  try {
    await readAndVerifyObject(
      bucket,
      quarantineObjectKey(assemblyId, object.sha256),
      object.sha256,
      object.bytes.byteLength,
      "catalog-verify-quarantine",
    );
  } catch (error) {
    if (error instanceof PantryHttpError) {
      const headers = new Headers(error.diagnosticHeaders);
      throw new PantryInternalCallError(
        "stage-object",
        "catalog-verify-quarantine",
        "catalog-rejected",
        "PantryHttpError",
        headers.get("x-nabuflow-pantry-error-code"),
        headers.get("x-nabuflow-pantry-error-fingerprint"),
        error.status,
        error.code,
      );
    }
    throw new PantryInternalCallError(
      "stage-object",
      "catalog-verify-quarantine",
      classifyUnexpectedCatalogCause(error),
      sanitizedErrorClass(error),
      sanitizedErrorCode(error),
      await sanitizedErrorFingerprint(error),
      503,
      "catalog_infrastructure_unavailable",
    );
  }
}

async function ingestAndCommitAssembly(
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
  assembly: NonNullable<Awaited<ReturnType<PantryCatalogCoordinator["getAssembly"]>>>,
  generation: number,
  ownerId: string,
  ingest: typeof ingestPantryStockRequest,
  counters: PantryInvocationCounters,
  persistResourceEvidence: (outcome: PantryGenerationResourceEvidence["outcome"]) => Promise<void>,
): Promise<void> {
  const signer = requireIngestSigner(env);
  let heartbeatFailure: Error | null = null;
  let heartbeatChain = Promise.resolve();
  const renew = async (): Promise<void> => {
    if (heartbeatFailure !== null) throw heartbeatFailure;
    const renewed = await coordinator.renewIngest(
      assembly.assemblyId,
      generation,
      ownerId,
      Date.now(),
    );
    if (renewed !== "renewed") {
      throw new PantryExecutionOwnershipError();
    }
  };
  const timer = setInterval(() => {
    heartbeatChain = heartbeatChain.then(renew).catch((error: unknown) => {
      heartbeatFailure = error instanceof Error ? error : new Error("Pantry lease renewal failed");
    });
  }, PANTRY_ASSEMBLY_HEARTBEAT_MS);
  try {
    counters.phase = "registry-ingest";
    const registryClient = new NpmRegistryClient(async (request) => {
      counters.trustedFetches += 1;
      return fetch(request);
    });
    const build = await ingest(assembly.request, registryClient, undefined, async (progress) => {
      await renew();
      const recorded = await coordinator.recordAssemblyEvent(assembly.assemblyId, {
        kind: "ingest-progress",
        stage: progress.stage,
        at: new Date().toISOString(),
        generation,
        attempt: assembly.ingest?.attempt ?? 0,
        metrics: progress.metrics,
      });
      if (recorded === "not_found") {
        throw new Error("Pantry assembly disappeared while ingest progress was recorded");
      }
      counters.phase = progress.stage;
      await persistResourceEvidence("running");
    });
    await renew();
    await coordinator.recordAssemblyEvent(assembly.assemblyId, {
      kind: "ingest-progress",
      stage: "staging-objects",
      at: new Date().toISOString(),
      generation,
      attempt: assembly.ingest?.attempt ?? 0,
    });
    const previouslyStagedBySha256 = new Map(
      assembly.objects.map((reference) => [reference.sha256, reference] as const),
    );
    let reachedFirstIncompleteObject = false;
    for (const object of build.objects) {
      counters.phase = "staging-objects";
      await renew();
      const previous = previouslyStagedBySha256.get(object.sha256);
      if (!reachedFirstIncompleteObject && previous !== undefined) {
        if (previous.kind !== object.kind || previous.bytes !== object.bytes.byteLength) {
          throw new PantryInternalCallError(
            "stage-object",
            "catalog-verify-quarantine",
            "catalog-rejected",
            "PantryHttpError",
            `hash-mismatch-${object.sha256.slice(0, 8)}-metadata`,
            (
              await sha256Hex(
                `${object.sha256}\0${object.kind}\0${object.bytes.byteLength}\0${previous.kind}\0${previous.bytes}`,
              )
            ).slice(0, 16),
            422,
            "catalog_integrity_mismatch",
          );
        }
        await verifyResumedQuarantineObject(
          env.PANTRY_CATALOG_OBJECTS,
          assembly.assemblyId,
          object,
        );
        counters.verifiedResumedObjects += 1;
        await coordinator.recordAssemblyEvent(assembly.assemblyId, {
          kind: "object-resume-verified",
          stage: "staging-objects",
          at: new Date().toISOString(),
          generation,
          attempt: assembly.ingest?.attempt ?? 0,
        });
        continue;
      }
      reachedFirstIncompleteObject = true;
      counters.internalPantryCalls += 1;
      await internalPantryCall(
        new Request(
          `https://pantry.internal${INTERNAL_PREFIX}/assemblies/${assembly.assemblyId}/objects/${object.sha256}/${object.kind}`,
          {
            method: "PUT",
            headers: {
              [PRINCIPAL_HEADER]: "catalog-admin",
              "content-type": "application/octet-stream",
            },
            body: object.bytes.slice().buffer,
          },
        ),
        env,
        coordinator,
        "stage-object",
      );
      if (counters.internalPantryCalls % PANTRY_RESOURCE_EVIDENCE_OBJECT_INTERVAL === 0) {
        await persistResourceEvidence("running");
      }
    }
    const createdAt = new Date().toISOString();
    const identity = await coordinator.allocateRevisionIdentity(createdAt.slice(0, 10));
    const dependencyClosureSha256 = await pantryDependencyClosureHash(build.closure);
    const ingredientMerkleRootSha256 = await pantryIngredientMerkleRoot(build.closure);
    const content = {
      format: PANTRY_REVISION_FORMAT,
      schemaVersion: 1 as const,
      revisionId: identity.revisionId,
      createdAt,
      parentRootSha256: identity.parentRootSha256,
      closure: build.closure,
      dependencyClosureSha256,
      ingredientMerkleRootSha256,
      layers: [],
      scannerPolicy: {
        policyVersion: "nabu-pantry-ingest-scan/v1",
        secretScan: "warning" as const,
        malwareScan: "warning" as const,
        vulnerabilityScan: "warning" as const,
        licenseScan: build.closure.ingredients.every(
          (ingredient) => ingredient.scan.licenseScan === "passed",
        )
          ? ("passed" as const)
          : ("warning" as const),
      },
      provenanceStatus: build.provenanceStatus,
    };
    const rootSha256 = await pantryRevisionRoot(content);
    const revision = {
      content,
      rootSha256,
      signature: await signPantryDigest(signer.privateKeyPem, {
        kind: "revision",
        kid: signer.kid,
        payloadSha256: rootSha256,
      }),
    };
    const objectReferences = build.objects
      .map((object) => ({
        kind: object.kind,
        sha256: object.sha256,
        bytes: object.bytes.byteLength,
      }))
      .sort((left, right) => {
        const a = `${left.sha256}\0${left.kind}`;
        const b = `${right.sha256}\0${right.kind}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    const commit = pantryCatalogCommitRequestSchema.parse({
      format: PANTRY_CATALOG_SHELF_FORMAT,
      schemaVersion: PANTRY_CATALOG_SCHEMA_VERSION,
      assemblyId: assembly.assemblyId,
      revision,
      state: {
        schemaVersion: 1,
        revisionId: identity.revisionId,
        rootSha256,
        state: "assembling",
        stateRevision: 0,
        updatedAt: createdAt,
      },
      objectReferences,
      lockfileSha256: build.lockfileSha256,
      sbomSha256: build.sbomSha256,
      toolchainAttestationSha256: build.toolchainAttestationSha256,
      retention: {
        namespace: "pantry-ingest",
        retainUntil: new Date(Date.parse(createdAt) + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
    counters.phase = "committing-shelf";
    counters.internalPantryCalls += 1;
    await internalPantryCall(
      new Request(
        `https://pantry.internal${INTERNAL_PREFIX}/assemblies/${assembly.assemblyId}/commit`,
        {
          method: "POST",
          headers: { [PRINCIPAL_HEADER]: "catalog-admin", "content-type": "application/json" },
          body: JSON.stringify(commit),
        },
      ),
      env,
      coordinator,
      "commit-shelf",
    );
    await persistResourceEvidence("succeeded");
  } finally {
    clearInterval(timer);
    await heartbeatChain;
  }
}
