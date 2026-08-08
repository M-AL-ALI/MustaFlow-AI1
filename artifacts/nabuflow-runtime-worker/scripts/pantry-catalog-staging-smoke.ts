import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PANTRY_CATALOG_STAMP_FORMAT,
  deriveRuntimeIdentity,
  pantryCatalogCommitRequestSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  sha256Hex,
  signControlRequest,
  signPreviewGrant,
  type CapabilityDefinition,
} from "@workspace/tenant-runtime-contracts";
import { makePantryFixture, type PantryFixture } from "./pantry-catalog-fixture";

const CONTROL_URL = "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev";
const PANTRY_PUBLIC_URL = "https://nabuflow-pantry-staging.mustafa-alali74.workers.dev";
const CONTROL_PREFIX = "/_nabuflow/control/v1";
const PANTRY_PREFIX = `${CONTROL_PREFIX}/pantry`;
const GATE_REQUIRED = 20;
const GATE_MAX_REQUESTS = 600;
const GATE_MAX_MS = 5 * 60_000;

interface TranscriptEntry {
  step: string;
  status: number | string;
  detail: unknown;
}

interface ControlResult {
  response: Response;
  body: unknown;
}

interface GateSurface {
  consecutive: number;
  probes: number;
  firstGreenMs?: number;
  completedMs?: number;
  lastStatus?: number;
  lastCode?: string;
}

const transcript: TranscriptEntry[] = [];
const readinessRevisions = new Map<number, string>();
const cleanupFixtures: PantryFixture[] = [];
const cleanupIngestRoots: string[] = [];
let controlToken = "";
let previewPrivateKey = "";
let previewPublicKey = "";
let vaultKek = "";
let workerClockOffsetMs = 0;

const echoCapabilityDefinition: CapabilityDefinition = {
  name: "echo",
  provider: "nabuflow-harness",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/echo" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 5_000,
    maxRequestBytes: 32_768,
    maxResponseBytes: 32_768,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

function record(step: string, status: number | string, detail: unknown = null): void {
  transcript.push({ step, status, detail });
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeCode(body: unknown): string | undefined {
  return (body as { code?: string } | null)?.code;
}

function base64UrlSecret(bytes = 32): string {
  const value = randomBytes(bytes).toString("base64url");
  assertCondition(
    /^[A-Za-z0-9_-]+$/u.test(value) && !value.includes("="),
    "Secret format self-check failed",
  );
  assertCondition(
    Buffer.from(value, "base64url").byteLength === bytes,
    "Secret length self-check failed",
  );
  return value;
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function rotateWorkerSecrets(): Promise<void> {
  controlToken = base64UrlSecret();
  vaultKek = base64UrlSecret();
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  previewPublicKey = pair.publicKey;
  previewPrivateKey = pair.privateKey;
  assertCondition(
    previewPublicKey.includes("BEGIN PUBLIC KEY"),
    "Preview public key self-check failed",
  );
  assertCondition(
    previewPrivateKey.includes("BEGIN PRIVATE KEY"),
    "Preview private key self-check failed",
  );

  let payload = JSON.stringify({
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: controlToken,
    CLOUFLOW_RUNTIME_CONTROL_TOKEN: controlToken,
    CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: previewPublicKey,
    CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: vaultKek,
  });
  const command = "node_modules\\.bin\\wrangler.cmd secret bulk --name nabuflow-runtime-staging";
  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: process.cwd(),
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Atomic staging secret rotation exceeded 120 seconds"));
    }, 120_000);
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? -1);
    });
    child.stdin.end(payload);
  });
  payload = "";
  assertCondition(exitCode === 0, `Atomic staging secret rotation failed (${exitCode})`);
  record("rotation.atomic-full-set", 200, {
    entries: [
      "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
      "CLOUFLOW_RUNTIME_CONTROL_TOKEN",
      "CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY",
      "CLOUDFLARE_CAPABILITY_VAULT_KEK_V1",
    ],
    base64UrlSelfCheck: true,
    valuesPersisted: false,
  });
}

async function makeSignedRequest(input: {
  path: string;
  method?: string;
  body?: unknown | Uint8Array;
  nonce: string;
  idempotencyKey?: string;
}): Promise<Request> {
  const method = input.method ?? "GET";
  const rawBody =
    input.body instanceof Uint8Array
      ? input.body
      : input.body === undefined
        ? ""
        : JSON.stringify(input.body);
  const timestamp = String(Date.now() + workerClockOffsetMs);
  const bodySha256 = await sha256Hex(rawBody);
  const idempotencyKey = input.idempotencyKey ?? "";
  const signature = await signControlRequest(controlToken, {
    method,
    pathAndQuery: input.path,
    timestamp,
    nonce: input.nonce,
    bodySha256,
    idempotencyKey,
  });
  return new Request(`${CONTROL_URL}${input.path}`, {
    method,
    body: typeof rawBody === "string" ? rawBody || undefined : rawBody.slice().buffer,
    headers: {
      ...(rawBody
        ? {
            "content-type":
              typeof rawBody === "string" ? "application/json" : "application/octet-stream",
          }
        : {}),
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": input.nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });
}

async function signedFetch(input: Parameters<typeof makeSignedRequest>[0]): Promise<ControlResult> {
  const response = await fetch(await makeSignedRequest(input));
  return { response, body: await readResponse(response) };
}

function isWeather(result: ControlResult): boolean {
  const code = safeCode(result.body);
  return (
    (result.response.status === 401 && code === "invalid_signature") ||
    result.response.status === 503 ||
    result.response.status === 504 ||
    (result.response.status === 502 && code !== "runtime_restart_failed")
  );
}

async function signedControlFetch(
  input: Parameters<typeof makeSignedRequest>[0],
  label: string,
): Promise<ControlResult> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await signedFetch({
      ...input,
      nonce: attempt === 1 ? input.nonce : `${label}-retry-${attempt}-${crypto.randomUUID()}`,
    });
    if (!isWeather(result) || attempt === 8) return result;
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
    record(`retry.${label}`, result.response.status, {
      attempt,
      backoffMs,
      code: safeCode(result.body),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs));
  }
  throw new Error(`${label}: retry bound exhausted`);
}

function assertStatus(label: string, result: ControlResult, expected: number): void {
  record(label, result.response.status, { code: safeCode(result.body) });
  assertCondition(
    result.response.status === expected,
    `${label}: expected ${expected}, got ${result.response.status}`,
  );
}

function capabilityPath(projectId: number): string {
  return `${CONTROL_PREFIX}/capabilities/${projectId}/nabuflow-harness/echo`;
}

async function probeVault(probeNumber: number): Promise<ControlResult> {
  const projectId = 730_000_000 + (probeNumber % 10_000_000);
  const revision = `pantry-readiness-${projectId}-${crypto.randomUUID()}`;
  const provision = await signedFetch({
    path: capabilityPath(projectId),
    method: "PUT",
    body: { projectId, revision, definition: echoCapabilityDefinition },
    nonce: `vault-provision-${crypto.randomUUID()}`,
    idempotencyKey: `vault-provision-${crypto.randomUUID()}`,
  });
  if (provision.response.status !== 200) return provision;
  readinessRevisions.set(projectId, revision);
  const revoke = await signedFetch({
    path: capabilityPath(projectId),
    method: "DELETE",
    body: { projectId, expectedRevision: revision },
    nonce: `vault-revoke-${crypto.randomUUID()}`,
    idempotencyKey: `vault-revoke-${crypto.randomUUID()}`,
  });
  if (revoke.response.status === 200 || revoke.response.status === 404)
    readinessRevisions.delete(projectId);
  return revoke;
}

async function probePreviewGrant(
  replay: boolean,
  probeNumber: number,
): Promise<{
  green: boolean;
  status: number;
  body: unknown;
  requests: number;
}> {
  const identity = await deriveRuntimeIdentity({
    namespace: "staging",
    projectId: 740_000_000 + probeNumber,
    role: "preview",
    slot: "primary",
  });
  const nowSeconds = Math.floor((Date.now() + workerClockOffsetMs) / 1_000);
  const grant = await signPreviewGrant(previewPrivateKey, {
    v: 1,
    iss: "nabuflow-api",
    aud: CONTROL_URL,
    sub: identity,
    port: 8080,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: `pantry${replay ? "pair" : "grant"}${probeNumber}${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const url = `${CONTROL_URL}/_nabuflow/preview/v1/${identity}/?__nfg=${encodeURIComponent(grant)}`;
  const redeemed = await fetch(url, { redirect: "manual" });
  const redeemedBody = await readResponse(redeemed);
  if (!replay)
    return {
      green: redeemed.status === 302,
      status: redeemed.status,
      body: redeemedBody,
      requests: 1,
    };
  const replayed = await fetch(url, { redirect: "manual" });
  const replayBody = await readResponse(replayed);
  return {
    green:
      redeemed.status === 302 &&
      replayed.status === 409 &&
      safeCode(replayBody) === "preview_grant_replayed",
    status: replayed.status,
    body: {
      redeemStatus: redeemed.status,
      replayStatus: replayed.status,
      replayCode: safeCode(replayBody),
    },
    requests: 2,
  };
}

async function sustainedGreen(): Promise<void> {
  const unsigned = await fetch(`${CONTROL_URL}${CONTROL_PREFIX}/version`);
  const workerDate = unsigned.headers.get("date");
  const workerTimeMs = workerDate === null ? Number.NaN : Date.parse(workerDate);
  assertCondition(Number.isFinite(workerTimeMs), "Worker Date header missing");
  workerClockOffsetMs = workerTimeMs - Date.now();
  record("clock.measured", 200, { workerDate, offsetMs: workerClockOffsetMs });

  const surfaces: Record<
    "controlHmac" | "previewGrant" | "vaultKek" | "previewReplayPair",
    GateSurface
  > = {
    controlHmac: { consecutive: 0, probes: 0 },
    previewGrant: { consecutive: 0, probes: 0 },
    vaultKek: { consecutive: 0, probes: 0 },
    previewReplayPair: { consecutive: 0, probes: 0 },
  };
  const started = performance.now();
  let totalRequests = 0;
  const complete = () =>
    Object.values(surfaces).every((surface) => surface.consecutive >= GATE_REQUIRED);
  const update = (name: keyof typeof surfaces, green: boolean, status: number, body: unknown) => {
    const surface = surfaces[name];
    surface.probes += 1;
    surface.lastStatus = status;
    surface.lastCode = safeCode(body);
    if (!green) {
      surface.consecutive = 0;
      surface.firstGreenMs = undefined;
      surface.completedMs = undefined;
      return;
    }
    surface.consecutive += 1;
    surface.firstGreenMs ??= performance.now() - started;
    if (surface.consecutive === GATE_REQUIRED) surface.completedMs = performance.now() - started;
  };
  while (
    !complete() &&
    totalRequests < GATE_MAX_REQUESTS &&
    performance.now() - started < GATE_MAX_MS
  ) {
    if (surfaces.controlHmac.consecutive < GATE_REQUIRED) {
      const result = await signedFetch({
        path: `${CONTROL_PREFIX}/version`,
        nonce: `gate-control-${crypto.randomUUID()}`,
      });
      totalRequests += 1;
      update("controlHmac", result.response.status === 200, result.response.status, result.body);
    }
    if (surfaces.previewGrant.consecutive < GATE_REQUIRED && totalRequests < GATE_MAX_REQUESTS) {
      const result = await probePreviewGrant(false, surfaces.previewGrant.probes + 1);
      totalRequests += result.requests;
      update("previewGrant", result.green, result.status, result.body);
    }
    if (surfaces.vaultKek.consecutive < GATE_REQUIRED && totalRequests + 1 < GATE_MAX_REQUESTS) {
      const result = await probeVault(surfaces.vaultKek.probes + 1);
      totalRequests += 2;
      update("vaultKek", result.response.status === 200, result.response.status, result.body);
    }
    if (
      surfaces.previewReplayPair.consecutive < GATE_REQUIRED &&
      totalRequests + 1 < GATE_MAX_REQUESTS
    ) {
      const result = await probePreviewGrant(true, surfaces.previewReplayPair.probes + 1);
      totalRequests += result.requests;
      update("previewReplayPair", result.green, result.status, result.body);
    }
    if (!complete()) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  assertCondition(complete(), `Four-surface gate did not converge: ${JSON.stringify(surfaces)}`);
  record("gate.complete", 200, { elapsedMs: performance.now() - started, totalRequests, surfaces });
}

async function pantryCall(
  suffix: string,
  method: string,
  body: unknown | Uint8Array | undefined,
  label: string,
): Promise<ControlResult> {
  return signedControlFetch(
    {
      path: `${PANTRY_PREFIX}${suffix}`,
      method,
      body,
      nonce: `${label}-${crypto.randomUUID()}`,
      ...(method === "GET" ? {} : { idempotencyKey: `${label}-${crypto.randomUUID()}` }),
    },
    label,
  );
}

function tuneFixture(
  fixture: PantryFixture,
  expiresAtMs: number,
  retainUntilMs: number,
): PantryFixture {
  fixture.request = pantryCatalogStockRequestSchema.parse({
    ...fixture.request,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  fixture.commit = pantryCatalogCommitRequestSchema.parse({
    ...fixture.commit,
    retention: {
      namespace: "staging-acceptance",
      retainUntil: new Date(retainUntilMs).toISOString(),
    },
  });
  return fixture;
}

async function beginFixture(fixture: PantryFixture, label: string): Promise<ControlResult> {
  return pantryCall("/stock-requests", "POST", fixture.request, `${label}.begin`);
}

async function stageFixture(fixture: PantryFixture, label: string): Promise<void> {
  for (const [sha256, object] of fixture.objects) {
    const result = await pantryCall(
      `/assemblies/${fixture.commit.assemblyId}/objects/${sha256}/${object.kind}`,
      "PUT",
      object.bytes,
      `${label}.stage.${object.kind}.${sha256.slice(0, 8)}`,
    );
    assertCondition(
      result.response.status === 200 || result.response.status === 201,
      `${label}: stage failed`,
    );
  }
}

async function commitFixture(fixture: PantryFixture, label: string): Promise<ControlResult> {
  return pantryCall(
    `/assemblies/${fixture.commit.assemblyId}/commit`,
    "POST",
    fixture.commit,
    `${label}.commit`,
  );
}

function shelfStamp(fixture: PantryFixture) {
  return {
    format: PANTRY_CATALOG_STAMP_FORMAT,
    schemaVersion: 1 as const,
    pantryRevisionId: fixture.commit.revision.content.revisionId,
    pantryRevisionRootSha256: fixture.commit.revision.rootSha256,
    dependencyClosureSha256: fixture.commit.revision.content.dependencyClosureSha256,
    lockfileSha256: fixture.commit.lockfileSha256,
    sbomSha256: fixture.commit.sbomSha256,
    toolchainImageDigest: fixture.commit.revision.content.closure.platform.toolchainImageDigest,
    toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
  };
}

async function transition(
  root: string,
  expected: number,
  next: "quarantined" | "retired",
  nowMs: number,
  label: string,
) {
  const result = await pantryCall(
    `/revisions/${root}/state`,
    "POST",
    {
      expectedStateRevision: expected,
      nextState: next,
      updatedAt: new Date(nowMs).toISOString(),
    },
    label,
  );
  assertStatus(label, result, 200);
}

async function collect(root: string, nowMs: number, label: string): Promise<ControlResult> {
  return collectWithNamespace(root, nowMs, "staging-acceptance", label);
}

async function collectWithNamespace(
  root: string,
  nowMs: number,
  retentionNamespace: string,
  label: string,
): Promise<ControlResult> {
  return pantryCall(
    "/gc",
    "POST",
    {
      scope: "retired-unreferenced",
      now: new Date(nowMs).toISOString(),
      maxDeletes: 20,
      retentionNamespace,
    },
    label,
  );
}

async function runLiveNpmIngest(nowMs: number): Promise<void> {
  const identity = {
    intents: [{ ecosystem: "npm" as const, name: "is-number", selector: "7.0.0" }],
    platform: {
      runtime: "node" as const,
      runtimeVersion: "22.18.0",
      nodeAbi: "127",
      os: "linux" as const,
      cpu: "x64" as const,
      libc: "glibc" as const,
      toolchainImageDigest: `sha256:${"8".repeat(64)}`,
    },
  };
  const request = pantryCatalogStockRequestSchema.parse({
    schemaVersion: 1,
    ...identity,
    requestSha256: await pantryCatalogStockRequestHash(identity),
    requestedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
  });
  const queueBefore = await waitForStableQueue("ingest.queue.before");
  const begin = await pantryCall("/stock-requests", "POST", request, "ingest.public.begin");
  assertCondition(
    begin.response.status === 200 || begin.response.status === 201,
    "Public npm stock request was rejected",
  );
  let root: string | null =
    (begin.body as { revisionRootSha256?: string | null }).revisionRootSha256 ?? null;
  for (let attempt = 1; root === null && attempt <= 90; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    const status = await pantryCall(
      `/assemblies/passembly_${request.requestSha256}`,
      "GET",
      undefined,
      `ingest.public.progress.${attempt}`,
    );
    if (status.response.status === 200) {
      const ingest = (
        status.body as {
          ingest?: { state?: string; failure?: { code?: string } | null };
        }
      ).ingest;
      assertCondition(
        ingest?.state !== "failed",
        `Public npm ingest failed (${ingest?.failure?.code ?? "unknown"})`,
      );
    }
    const lookup = await pantryCall(
      "/stock-requests",
      "POST",
      request,
      `ingest.public.lookup.${attempt}`,
    );
    assertCondition(
      lookup.response.status === 200 || lookup.response.status === 201,
      "Public npm ingest lookup failed",
    );
    root = (lookup.body as { revisionRootSha256?: string | null }).revisionRootSha256 ?? null;
  }
  assertCondition(root !== null, "Public npm ingest did not commit within three minutes");
  cleanupIngestRoots.push(root);
  const shelf = await pantryCall(
    `/revisions/by-root/${root}`,
    "GET",
    undefined,
    "ingest.public.shelf",
  );
  assertStatus("ingest.public.shelf", shelf, 200);
  const shelfBody = shelf.body as {
    shelf?: {
      revision?: {
        content?: {
          closure?: {
            ingredients?: Array<{
              package?: { name?: string; version?: string };
              provenance?: { registrySignatureVerified?: boolean };
            }>;
          };
        };
      };
      objectReferences?: unknown[];
    };
  };
  const ingredient = shelfBody.shelf?.revision?.content?.closure?.ingredients?.[0];
  assertCondition(
    ingredient?.package?.name === "is-number" &&
      ingredient.package.version === "7.0.0" &&
      ingredient.provenance?.registrySignatureVerified === true,
    "Committed public npm shelf did not retain exact verified origin evidence",
  );
  const queueAfter = await waitForStableQueue("ingest.queue.after");
  assertCondition(
    queueAfter - queueBefore === 1,
    "One cold miss did not produce exactly one queue delivery",
  );
  const warm = await pantryCall("/stock-requests", "POST", request, "ingest.public.warm");
  assertStatus("ingest.public.warm", warm, 200);
  assertCondition(
    (warm.body as { state?: string }).state === "committed",
    "Warm Pantry hit did not return the immutable shelf",
  );
  const warmQueue = await waitForStableQueue("ingest.queue.warm");
  assertCondition(
    warmQueue === queueAfter,
    "Warm Pantry hit emitted an upstream ingest queue delivery",
  );
  record("ingest.public-npm.exact-shelf", 200, {
    root,
    coordinate: "is-number@7.0.0",
    registrySignatureVerified: true,
    objects: shelfBody.shelf?.objectReferences?.length ?? 0,
    coldQueueDeliveries: 1,
    warmQueueDeliveries: 0,
  });
  await transition(root, 1, "quarantined", nowMs + 1_000, "ingest.public.quarantine");
  await transition(root, 2, "retired", nowMs + 2_000, "ingest.public.retire");
  const collected = await collectWithNamespace(
    root,
    nowMs + 366 * 24 * 60 * 60_000,
    "pantry-ingest",
    "ingest.public.collect",
  );
  assertStatus("ingest.public.collect", collected, 200);
  assertCondition(
    ((collected.body as { deletedRevisionRoots?: string[] }).deletedRevisionRoots ?? []).includes(
      root,
    ),
    "Public npm shelf cleanup failed",
  );
  cleanupIngestRoots.splice(cleanupIngestRoots.indexOf(root), 1);
}

async function pantryDiagnostics(label: string): Promise<ControlResult> {
  return pantryCall("/diagnostics", "GET", undefined, label);
}

function queueDeliveryCount(result: ControlResult): number {
  return (result.body as { ledger?: { queueDeliveries?: number } }).ledger?.queueDeliveries ?? 0;
}

async function waitForQueueDelivery(baseline: number): Promise<number> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = await pantryDiagnostics(`queue.poll.${attempt}`);
    if (result.response.status === 200) {
      const count = queueDeliveryCount(result);
      if (count > baseline) return count;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Queue delivery was not observed within 20 seconds");
}

async function waitForStableQueue(label: string): Promise<number> {
  let previous: number | null = null;
  let consecutive = 0;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await pantryDiagnostics(`${label}.${attempt}`);
    assertStatus(`${label}.${attempt}`, result, 200);
    const current = queueDeliveryCount(result);
    consecutive = previous === current ? consecutive + 1 : 1;
    previous = current;
    if (consecutive >= 3) return current;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Pantry queue did not become stable within 30 seconds");
}

async function runCatalogAcceptance(): Promise<void> {
  const health = await pantryCall("/health", "GET", undefined, "pantry.health");
  assertStatus("pantry.health", health, 200);

  const direct = await fetch(PANTRY_PUBLIC_URL).catch(() => null);
  record("pantry.private-surface", direct?.status ?? "unreachable", {
    workersDevDisabled: direct === null || direct.status !== 200,
  });
  assertCondition(
    direct === null || direct.status !== 200,
    "Private Pantry Worker unexpectedly exposed a public route",
  );

  const staleIngestCleanup = await pantryCall(
    "/gc",
    "POST",
    {
      scope: "retired-unreferenced",
      now: new Date(Date.now() + workerClockOffsetMs + 366 * 24 * 60 * 60_000).toISOString(),
      maxDeletes: 1_000,
      retentionNamespace: "pantry-ingest",
    },
    "cleanup.preflight.ingest",
  );
  assertStatus("cleanup.preflight.ingest", staleIngestCleanup, 200);

  const nowMs = Date.now() + workerClockOffsetMs;
  const sequence = 10_000 + (Math.floor(nowMs / 1_000) % 80_000);
  const first = tuneFixture(
    await makePantryFixture({ nowMs, sequence, selector: `demand-${crypto.randomUUID()}` }),
    nowMs + 60 * 60_000,
    nowMs + 3 * 60 * 60_000,
  );
  cleanupFixtures.push(first);

  const queueBaselineResult = await pantryDiagnostics("catalog.queue.baseline");
  assertStatus("catalog.queue.baseline", queueBaselineResult, 200);
  const queueBaseline = queueDeliveryCount(queueBaselineResult);

  const concurrent = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      pantryCall("/stock-requests", "POST", first.request, `single-flight.${index}`),
    ),
  );
  const created = concurrent.filter((result) => result.response.status === 201).length;
  const assembling = concurrent.filter((result) => result.response.status === 200).length;
  assertCondition(
    created === 1 && assembling === 99,
    `Single-flight split was ${created}/${assembling}`,
  );
  record("catalog.single-flight.100", 200, { requests: 100, created, coalesced: assembling });
  const queueDeliveries = await waitForQueueDelivery(queueBaseline);
  assertCondition(
    queueDeliveries - queueBaseline === 1,
    "Identical misses emitted more than one queue delivery",
  );
  record("catalog.queue.single-assembly", 200, {
    baseline: queueBaseline,
    after: queueDeliveries,
    delta: queueDeliveries - queueBaseline,
  });

  const [firstSha, firstObject] = first.objects.entries().next().value as [
    string,
    { kind: string; bytes: Uint8Array },
  ];
  const staged = await pantryCall(
    `/assemblies/${first.commit.assemblyId}/objects/${firstSha}/${firstObject.kind}`,
    "PUT",
    firstObject.bytes,
    "catalog.stage.first",
  );
  assertStatus("catalog.stage.first", staged, 201);
  const replay = await pantryCall(
    `/assemblies/${first.commit.assemblyId}/objects/${firstSha}/${firstObject.kind}`,
    "PUT",
    firstObject.bytes,
    "catalog.stage.replay",
  );
  assertStatus("catalog.stage.replay", replay, 200);
  assertCondition(
    (replay.body as { state?: string }).state === "replay",
    "Identical staged write was not idempotent",
  );
  const differentKind = firstObject.kind === "sbom" ? "lockfile" : "sbom";
  const conflict = await pantryCall(
    `/assemblies/${first.commit.assemblyId}/objects/${firstSha}/${differentKind}`,
    "PUT",
    firstObject.bytes,
    "catalog.stage.digest-conflict",
  );
  assertStatus("catalog.stage.digest-conflict", conflict, 409);
  assertCondition(safeCode(conflict.body) === "catalog_conflict", "Digest conflict was not typed");

  await stageFixture(first, "catalog.first");
  const firstCommit = await commitFixture(first, "catalog.first");
  assertStatus("catalog.first.commit", firstCommit, 201);
  const firstCommitReplay = await commitFixture(first, "catalog.first-replay");
  assertStatus("catalog.first.commit-replay", firstCommitReplay, 200);
  assertCondition(
    (firstCommitReplay.body as { state?: string }).state === "replay",
    "Commit retry was not idempotent",
  );

  const firstByRoot = await pantryCall(
    `/revisions/by-root/${first.commit.revision.rootSha256}`,
    "GET",
    undefined,
    "catalog.first.by-root",
  );
  assertStatus("catalog.first.by-root", firstByRoot, 200);
  const firstCanonical = JSON.stringify(firstByRoot.body);
  const firstById = await pantryCall(
    `/revisions/${first.commit.revision.content.revisionId}`,
    "GET",
    undefined,
    "catalog.first.by-id",
  );
  assertStatus("catalog.first.by-id", firstById, 200);
  assertCondition(
    JSON.stringify(firstById.body) === firstCanonical,
    "Root and revision lookup differ",
  );
  const stamp = await pantryCall(
    "/stamps/verify",
    "POST",
    shelfStamp(first),
    "catalog.first.stamp",
  );
  assertStatus("catalog.first.stamp", stamp, 200);
  record("catalog.fixture-closure", 200, {
    packages: first.commit.revision.content.closure.ingredients.length,
    exactVersions: first.commit.revision.content.closure.ingredients.map(
      (ingredient) => ingredient.package.version,
    ),
    merkleRoot: first.commit.revision.content.ingredientMerkleRootSha256,
    lockfile: first.commit.lockfileSha256,
    sbom: first.commit.sbomSha256,
    toolchainAttestation: first.commit.toolchainAttestationSha256,
  });

  const second = tuneFixture(
    await makePantryFixture({
      nowMs: nowMs + 1_000,
      sequence: sequence + 1,
      parentRootSha256: first.commit.revision.rootSha256,
      selector: `demand-${crypto.randomUUID()}`,
    }),
    nowMs + 60 * 60_000,
    nowMs + 3 * 60 * 60_000,
  );
  cleanupFixtures.push(second);
  const secondBegin = await beginFixture(second, "catalog.second");
  assertStatus("catalog.second.begin", secondBegin, 201);
  await stageFixture(second, "catalog.second");
  const secondCommit = await commitFixture(second, "catalog.second");
  assertStatus("catalog.second.commit", secondCommit, 201);
  const firstAfter = await pantryCall(
    `/revisions/by-root/${first.commit.revision.rootSha256}`,
    "GET",
    undefined,
    "catalog.first.after-child",
  );
  assertStatus("catalog.first.after-child", firstAfter, 200);
  assertCondition(
    JSON.stringify(firstAfter.body) === firstCanonical,
    "Adding a shelf mutated the old shelf",
  );
  record("catalog.dated-shelf-immutability", 200, {
    oldRevision: first.commit.revision.content.revisionId,
    newRevision: second.commit.revision.content.revisionId,
    oldBytesStable: true,
  });

  const pending = tuneFixture(
    await makePantryFixture({
      nowMs: nowMs + 2_000,
      sequence: sequence + 2,
      parentRootSha256: second.commit.revision.rootSha256,
      selector: `pending-${crypto.randomUUID()}`,
    }),
    nowMs + 20 * 60_000,
    nowMs + 3 * 60 * 60_000,
  );
  cleanupFixtures.push(pending);
  const pendingBegin = await beginFixture(pending, "catalog.pending");
  assertStatus("catalog.pending.begin", pendingBegin, 201);
  const [pendingSha, pendingObject] = pending.objects.entries().next().value as [
    string,
    { kind: string; bytes: Uint8Array },
  ];
  const pendingStage = await pantryCall(
    `/assemblies/${pending.commit.assemblyId}/objects/${pendingSha}/${pendingObject.kind}`,
    "PUT",
    pendingObject.bytes,
    "catalog.pending.stage",
  );
  assertStatus("catalog.pending.stage", pendingStage, 201);
  const incomplete = await commitFixture(pending, "catalog.pending-incomplete");
  assertStatus("catalog.pending.incomplete", incomplete, 409);
  assertCondition(
    safeCode(incomplete.body) === "catalog_incomplete",
    "Incomplete commit was not typed",
  );
  const expire = await pantryCall(
    "/gc",
    "POST",
    {
      scope: "expired-uncommitted",
      now: new Date(nowMs + 21 * 60_000).toISOString(),
      maxDeletes: 20,
    },
    "catalog.pending.expire",
  );
  assertStatus("catalog.pending.expire", expire, 200);
  assertCondition(
    ((expire.body as { deletedAssemblyIds?: string[] }).deletedAssemblyIds ?? []).includes(
      pending.commit.assemblyId,
    ),
    "Expired assembly was not collected",
  );
  const committedStillPresent = await pantryCall(
    `/revisions/by-root/${first.commit.revision.rootSha256}`,
    "GET",
    undefined,
    "catalog.committed-survives-ttl",
  );
  assertStatus("catalog.committed-survives-ttl", committedStillPresent, 200);

  const referenceId = `artifact:${crypto.randomUUID()}`;
  const retain = await pantryCall(
    `/revisions/${second.commit.revision.rootSha256}/references`,
    "POST",
    { referenceId },
    "catalog.retain",
  );
  assertStatus("catalog.retain", retain, 201);
  await transition(
    second.commit.revision.rootSha256,
    1,
    "quarantined",
    nowMs + 20_000,
    "catalog.second.quarantine",
  );
  await transition(
    second.commit.revision.rootSha256,
    2,
    "retired",
    nowMs + 21_000,
    "catalog.second.retire",
  );
  const blocked = await collect(
    second.commit.revision.rootSha256,
    nowMs + 4 * 60 * 60_000,
    "catalog.gc.blocked",
  );
  assertStatus("catalog.gc.blocked", blocked, 200);
  assertCondition(
    !((blocked.body as { deletedRevisionRoots?: string[] }).deletedRevisionRoots ?? []).includes(
      second.commit.revision.rootSha256,
    ),
    "Referenced shelf was collected",
  );
  const release = await pantryCall(
    `/revisions/${second.commit.revision.rootSha256}/references`,
    "DELETE",
    { referenceId },
    "catalog.release",
  );
  assertStatus("catalog.release", release, 200);
  const secondCollected = await collect(
    second.commit.revision.rootSha256,
    nowMs + 4 * 60 * 60_000,
    "catalog.second.collect",
  );
  assertStatus("catalog.second.collect", secondCollected, 200);
  assertCondition(
    (
      (secondCollected.body as { deletedRevisionRoots?: string[] }).deletedRevisionRoots ?? []
    ).includes(second.commit.revision.rootSha256),
    "Released shelf was not collected",
  );
  const firstSharedObjects = await pantryCall(
    `/revisions/by-root/${first.commit.revision.rootSha256}`,
    "GET",
    undefined,
    "catalog.shared-cas-survives",
  );
  assertStatus("catalog.shared-cas-survives", firstSharedObjects, 200);
  await transition(
    first.commit.revision.rootSha256,
    1,
    "quarantined",
    nowMs + 22_000,
    "catalog.first.quarantine",
  );
  await transition(
    first.commit.revision.rootSha256,
    2,
    "retired",
    nowMs + 23_000,
    "catalog.first.retire",
  );
  const firstCollected = await collect(
    first.commit.revision.rootSha256,
    nowMs + 4 * 60 * 60_000,
    "catalog.first.collect",
  );
  assertStatus("catalog.first.collect", firstCollected, 200);
  assertCondition(
    (
      (firstCollected.body as { deletedRevisionRoots?: string[] }).deletedRevisionRoots ?? []
    ).includes(first.commit.revision.rootSha256),
    "Final shelf was not collected",
  );

  await runLiveNpmIngest(nowMs + 30_000);

  const diagnostics = await pantryDiagnostics("catalog.cleanup.diagnostics");
  assertStatus("catalog.cleanup.diagnostics", diagnostics, 200);
  const body = diagnostics.body as {
    ledger?: {
      assemblies?: number;
      shelves?: number;
      committedObjects?: number;
      externalReferences?: number;
      queueDeliveries?: number;
    };
    r2?: { objects?: number; bytes?: number; quarantineObjects?: number };
  };
  assertCondition(body.ledger?.assemblies === 0, "Pending Pantry assemblies remain");
  assertCondition(body.ledger?.shelves === 0, "Pantry shelf records remain");
  assertCondition(body.ledger?.committedObjects === 0, "Pantry object references remain");
  assertCondition(body.ledger?.externalReferences === 0, "Pantry external references remain");
  assertCondition(
    body.r2?.objects === 0 && body.r2?.bytes === 0,
    "Pantry R2 is not 0 objects / 0 B",
  );
  assertCondition((body.ledger?.queueDeliveries ?? 0) >= 1, "Queue consumption was not recorded");
  record("cleanup.authoritative", 200, body);
}

async function cleanupReadiness(): Promise<void> {
  for (const [projectId, revision] of readinessRevisions) {
    await signedControlFetch(
      {
        path: capabilityPath(projectId),
        method: "DELETE",
        body: { projectId, expectedRevision: revision },
        nonce: `cleanup-vault-${crypto.randomUUID()}`,
        idempotencyKey: `cleanup-vault-${crypto.randomUUID()}`,
      },
      "cleanup.vault",
    ).catch(() => undefined);
  }
  readinessRevisions.clear();
}

async function bestEffortCatalogCleanup(): Promise<void> {
  const nowMs = Date.now() + workerClockOffsetMs + 5 * 60 * 60_000;
  const ingestGcNowMs = Date.now() + workerClockOffsetMs + 366 * 24 * 60 * 60_000;
  await pantryCall(
    "/gc",
    "POST",
    { scope: "expired-uncommitted", now: new Date(nowMs).toISOString(), maxDeletes: 1_000 },
    "cleanup.expired",
  ).catch(() => undefined);
  for (const fixture of [...cleanupFixtures].reverse()) {
    const root = fixture.commit.revision.rootSha256;
    const lookup = await pantryCall(
      `/revisions/by-root/${root}`,
      "GET",
      undefined,
      `cleanup.lookup.${root.slice(0, 8)}`,
    ).catch(() => null);
    if (lookup?.response.status !== 200) continue;
    const lifecycle = (lookup.body as { lifecycle?: { state?: string; stateRevision?: number } })
      .lifecycle;
    if (lifecycle?.state === "committed") {
      await transition(
        root,
        lifecycle.stateRevision ?? 1,
        "quarantined",
        nowMs - 2_000,
        `cleanup.quarantine.${root.slice(0, 8)}`,
      ).catch(() => undefined);
      await transition(
        root,
        (lifecycle.stateRevision ?? 1) + 1,
        "retired",
        nowMs - 1_000,
        `cleanup.retire.${root.slice(0, 8)}`,
      ).catch(() => undefined);
    } else if (lifecycle?.state === "quarantined") {
      await transition(
        root,
        lifecycle.stateRevision ?? 2,
        "retired",
        nowMs - 1_000,
        `cleanup.retire.${root.slice(0, 8)}`,
      ).catch(() => undefined);
    }
    await collect(root, nowMs, `cleanup.collect.${root.slice(0, 8)}`).catch(() => undefined);
  }
  for (const root of [...cleanupIngestRoots].reverse()) {
    const lookup = await pantryCall(
      `/revisions/by-root/${root}`,
      "GET",
      undefined,
      `cleanup.ingest.lookup.${root.slice(0, 8)}`,
    ).catch(() => null);
    const lifecycle = (
      lookup?.body as { lifecycle?: { state?: string; stateRevision?: number } } | undefined
    )?.lifecycle;
    if (lifecycle?.state === "committed") {
      await transition(
        root,
        lifecycle.stateRevision ?? 1,
        "quarantined",
        nowMs - 2_000,
        `cleanup.ingest.quarantine.${root.slice(0, 8)}`,
      ).catch(() => undefined);
      await transition(
        root,
        (lifecycle.stateRevision ?? 1) + 1,
        "retired",
        nowMs - 1_000,
        `cleanup.ingest.retire.${root.slice(0, 8)}`,
      ).catch(() => undefined);
    } else if (lifecycle?.state === "quarantined") {
      await transition(
        root,
        lifecycle.stateRevision ?? 2,
        "retired",
        nowMs - 1_000,
        `cleanup.ingest.retire.${root.slice(0, 8)}`,
      ).catch(() => undefined);
    }
    await collectWithNamespace(
      root,
      ingestGcNowMs,
      "pantry-ingest",
      `cleanup.ingest.collect.${root.slice(0, 8)}`,
    ).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  let failure: unknown;
  try {
    await rotateWorkerSecrets();
    await sustainedGreen();
    await runCatalogAcceptance();
  } catch (error) {
    failure = error;
    record("run.failure", "failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
  } finally {
    await bestEffortCatalogCleanup();
    await cleanupReadiness();
    controlToken = "";
    previewPrivateKey = "";
    previewPublicKey = "";
    vaultKek = "";
    const evidencePath = resolve(process.cwd(), "../../tmp/pantry-catalog-staging-evidence.json");
    mkdirSync(resolve(evidencePath, ".."), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), transcript }, null, 2)}\n`,
      "utf8",
    );
    // eslint-disable-next-line no-console -- sanitized acceptance summary only
    console.log(
      JSON.stringify({ ok: failure === undefined, checks: transcript.length, evidencePath }),
    );
  }
  if (failure !== undefined) throw failure;
}

await main();
