import {
  PANTRY_CATALOG_SCHEMA_VERSION,
  PANTRY_CATALOG_SHELF_FORMAT,
  PANTRY_REVISION_FORMAT,
  canonicalPantryJson,
  pantryCatalogCommitRequestSchema,
  pantryCatalogGcRequestSchema,
  pantryCatalogObjectKindSchema,
  pantryCatalogObjectReferenceSchema,
  pantryCatalogReferenceRequestSchema,
  pantryCatalogShelfManifestHash,
  pantryCatalogShelfMatchesStamp,
  pantryCatalogShelfRecordSchema,
  pantryCatalogShelfStampSchema,
  pantryCatalogStateTransitionRequestSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryDependencyClosureHash,
  pantryIngredientMerkleRoot,
  pantryRevisionRoot,
  pantryRevisionIsCommittable,
  signPantryDigest,
  verifyPantryRevisionRecord,
  sha256Hex,
  type PantryCatalogCommitRequest,
  type PantryCatalogErrorResponse,
  type PantryCatalogShelfRecord,
} from "@workspace/tenant-runtime-contracts";
import { ingestErrorDefaults, ingestPantryStockRequest } from "./pantry-ingest";
import type {
  PantryCatalogCoordinator,
  PantryStockQueueMessage,
  PantryWorkerBindings,
} from "./pantry-catalog-model";
import type { PantryCatalogDurableObject } from "./pantry-catalog-durable-object";

const INTERNAL_PREFIX = "/internal/v1";
const PRINCIPAL_HEADER = "x-nabuflow-pantry-principal";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_OBJECT_BYTES = 32 * 1024 * 1024;
const INGEST_LEASE_MS = 3 * 60 * 1_000;
const NEGATIVE_CACHE_MS = 5 * 60 * 1_000;

type PantryPrincipal = "catalog-admin" | "builder-readonly" | "catalog-gc";

class PantryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: PantryCatalogErrorResponse["code"],
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(error: PantryHttpError): Response {
  return jsonResponse(error.status, {
    ok: false,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  } satisfies PantryCatalogErrorResponse);
}

function quarantineObjectKey(assemblyId: string, sha256: string): string {
  return `quarantine/${assemblyId}/objects/${sha256}`;
}

function committedObjectKey(sha256: string): string {
  return `cas/sha256/${sha256}`;
}

function revisionManifestKey(shelf: PantryCatalogShelfRecord): string {
  return `revisions/${shelf.revision.content.revisionId}/${shelf.revision.rootSha256}.json`;
}

async function readAndVerifyObject(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry catalog object is missing");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) ||
    (await sha256Hex(bytes)) !== expectedSha256
  ) {
    throw new PantryHttpError(
      422,
      "catalog_integrity_mismatch",
      "Pantry catalog integrity verification failed",
    );
  }
  return bytes;
}

async function putImmutableObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<"created" | "exists"> {
  const created = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256,
  });
  if (created !== null) {
    await readAndVerifyObject(bucket, key, sha256, bytes.byteLength);
    return "created";
  }
  const existing = await readAndVerifyObject(bucket, key, sha256, bytes.byteLength);
  if (existing.byteLength !== bytes.byteLength) {
    throw new PantryHttpError(
      409,
      "catalog_conflict",
      "Pantry content address already contains different bytes",
    );
  }
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (existing[index] !== bytes[index]) {
      throw new PantryHttpError(
        409,
        "catalog_conflict",
        "Pantry content address already contains different bytes",
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
  if (result.state === "created") {
    await env.PANTRY_INGEST_QUEUE.send({
      schemaVersion: 1,
      assemblyId: result.assembly.assemblyId,
      requestSha256: input.requestSha256,
    });
  }
  return jsonResponse(result.state === "created" ? 201 : 200, {
    ok: true,
    state: result.state,
    assemblyId: result.state === "committed" ? result.assemblyId : result.assembly.assemblyId,
    revisionRootSha256: result.state === "committed" ? result.revisionRootSha256 : null,
  });
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
  return jsonResponse(200, {
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
  if ((await coordinator.getAssembly(assemblyId)) === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  const key = quarantineObjectKey(assemblyId, sha256);
  const stored = await putImmutableObject(env.PANTRY_CATALOG_OBJECTS, key, bytes, sha256);
  const reference = strictParse(pantryCatalogObjectReferenceSchema, {
    kind,
    sha256,
    bytes: bytes.byteLength,
  });
  const recorded = await coordinator.recordStagedObject(assemblyId, reference);
  if (recorded === "not_found") {
    if (stored === "created") await env.PANTRY_CATALOG_OBJECTS.delete(key);
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  if (recorded === "conflict") {
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
  const shelf = await buildCommittedShelf(input, env);
  const existing = await coordinator.getShelfByRoot(shelf.revision.rootSha256);
  if (existing !== null) {
    if (existing.shelf.manifestSha256 !== shelf.manifestSha256) {
      throw new PantryHttpError(409, "catalog_conflict", "Pantry revision already exists");
    }
    await verifyStoredShelf(env.PANTRY_CATALOG_OBJECTS, existing.shelf);
    return jsonResponse(200, {
      ok: true,
      state: "replay",
      shelf: existing.shelf,
      lifecycle: existing.lifecycle,
    });
  }
  const assembly = await coordinator.getAssembly(assemblyId);
  if (assembly === null) {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  if (canonicalPantryJson(assembly.objects) !== canonicalPantryJson(shelf.objectReferences)) {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry assembly is incomplete");
  }
  const verifiedObjects = new Map<string, Uint8Array>();
  for (const reference of shelf.objectReferences) {
    const bytes = await readAndVerifyObject(
      env.PANTRY_CATALOG_OBJECTS,
      quarantineObjectKey(assemblyId, reference.sha256),
      reference.sha256,
      reference.bytes,
    );
    verifiedObjects.set(reference.sha256, bytes);
  }
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
    );
  }
  const manifestBytes = new TextEncoder().encode(canonicalPantryJson(shelf));
  await putImmutableObject(
    env.PANTRY_CATALOG_OBJECTS,
    revisionManifestKey(shelf),
    manifestBytes,
    await sha256Hex(manifestBytes),
  );
  const committed = await coordinator.commitShelf(assemblyId, shelf);
  if (committed === "not_found") {
    throw new PantryHttpError(404, "catalog_not_found", "Pantry assembly was not found");
  }
  if (committed === "incomplete") {
    throw new PantryHttpError(409, "catalog_incomplete", "Pantry assembly is incomplete");
  }
  if (committed === "conflict") {
    throw new PantryHttpError(409, "catalog_conflict", "Pantry revision commit conflicts");
  }
  for (const reference of assembly.objects) {
    await env.PANTRY_CATALOG_OBJECTS.delete(quarantineObjectKey(assemblyId, reference.sha256));
  }
  return jsonResponse(committed === "committed" ? 201 : 200, {
    ok: true,
    state: committed,
    shelf,
    lifecycle: shelf.state,
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
    const objectRead = new RegExp(`^${INTERNAL_PREFIX}/objects/([0-9a-f]{64})$`).exec(pathname);
    if (objectRead !== null) {
      if (request.method !== "GET")
        throw new PantryHttpError(
          405,
          "catalog_method_not_allowed",
          "Pantry method is not allowed",
        );
      requirePrincipal(request, ["builder-readonly"]);
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
    // eslint-disable-next-line no-console -- metadata-only trusted-service boundary
    console.error(
      JSON.stringify({
        event: "pantry_catalog_unexpected_error",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return errorResponse(
      new PantryHttpError(
        500,
        "catalog_internal_error",
        "The Pantry catalog encountered an internal error",
        true,
      ),
    );
  }
}

export async function handlePantryQueue(
  batch: MessageBatch<PantryStockQueueMessage>,
  env: PantryWorkerBindings,
  injectedCoordinator?: PantryCatalogCoordinator,
  injectedIngest: typeof ingestPantryStockRequest = ingestPantryStockRequest,
): Promise<void> {
  const coordinator = injectedCoordinator ?? getCoordinator(env);
  for (const message of batch.messages) {
    const body = message.body;
    if (
      body?.schemaVersion !== 1 ||
      !/^passembly_[0-9a-f]{64}$/u.test(body.assemblyId) ||
      !/^[0-9a-f]{64}$/u.test(body.requestSha256)
    ) {
      message.ack();
      continue;
    }
    await coordinator.markQueueDelivery(body.assemblyId);
    const now = new Date();
    const claim = await coordinator.claimIngest(
      body.assemblyId,
      now.toISOString(),
      new Date(now.getTime() + INGEST_LEASE_MS).toISOString(),
    );
    if (claim.state === "not_found" || claim.state === "busy" || claim.state === "failed") {
      message.ack();
      continue;
    }
    try {
      await ingestAndCommitAssembly(env, coordinator, claim.assembly, injectedIngest);
      message.ack();
    } catch (error) {
      const typed = ingestErrorDefaults(error);
      const failedAt = new Date().toISOString();
      await coordinator.recordIngestFailure(body.assemblyId, {
        ...typed,
        failedAt,
        negativeCacheUntil: new Date(
          Date.parse(failedAt) + (typed.retryable ? 10_000 : NEGATIVE_CACHE_MS),
        ).toISOString(),
      });
      if (typed.retryable) message.retry({ delaySeconds: 10 });
      else message.ack();
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
): Promise<unknown> {
  const response = await handlePantryWorkerRequest(request, env, coordinator);
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const input = body as { message?: unknown; retryable?: unknown };
    throw new Error(
      typeof input.message === "string" ? input.message : "Pantry internal operation failed",
    );
  }
  return body;
}

async function ingestAndCommitAssembly(
  env: PantryWorkerBindings,
  coordinator: PantryCatalogCoordinator,
  assembly: NonNullable<Awaited<ReturnType<PantryCatalogCoordinator["getAssembly"]>>>,
  ingest: typeof ingestPantryStockRequest,
): Promise<void> {
  const signer = requireIngestSigner(env);
  const build = await ingest(assembly.request);
  for (const object of build.objects) {
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
    );
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
    .map((object) => ({ kind: object.kind, sha256: object.sha256, bytes: object.bytes.byteLength }))
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
  );
}
