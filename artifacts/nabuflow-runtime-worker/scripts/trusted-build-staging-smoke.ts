import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  PANTRY_BUILD_INPUT_FORMAT,
  PANTRY_SCHEMA_VERSION,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_SOURCE_FORMAT,
  canonicalPantryJson,
  deriveRuntimeIdentity,
  pantryBuildAttestationHash,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryShelfContentHashesResponseSchema,
  sha256Hex,
  signControlRequest,
  signPreviewGrant,
  trustedBuildDependencyIntentHash,
  trustedBuildRequestHash,
  trustedBuildRequestSchema,
  trustedBuildSourceManifestHash,
  verifyPantryBuildAttestation,
  type CapabilityDefinition,
  type PantryCatalogShelfRecord,
  type PantryPackageIntent,
  type PantryPlatform,
  type TrustedBuildOutput,
  type TrustedBuildCollectionProgress,
  type TrustedBuildMemoryProgress,
  type TrustedBuildSecretScanSummary,
  type TrustedBuildVerificationProgress,
  type TrustedBuildRequest,
  type TrustedBuildStatusResponse,
} from "@workspace/tenant-runtime-contracts";
import {
  resolveTrustedPantryLayerSealProvenance,
  sealLayeredRuntimeArtifact,
  sealRuntimeArtifactLayer,
  type SealedLayeredRuntimeArtifact,
} from "../../api-server/src/lib/runtime-artifact-layers";
import { sealRuntimeArtifact } from "../../api-server/src/lib/runtime-artifact";
import { PANTRY_TEST_KEY } from "./pantry-catalog-fixture";
import { createStagingEvidenceRunId, writeImmutableStagingEvidence } from "./staging-evidence";
import {
  ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX,
  ARTIFACT_COMMIT_ABORT_MID_PREFIX,
} from "../src/artifact-commit-recovery";

const CONTROL_URL = "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev";
const CONTROL_PREFIX = "/_nabuflow/control/v1";
const PANTRY_PREFIX = `${CONTROL_PREFIX}/pantry`;
const BUILD_PREFIX = `${CONTROL_PREFIX}/build-plane`;
const DEPLOYMENT_NAMESPACE = "staging";
const GATE_REQUIRED = 20;
const GATE_MAX_REQUESTS = 600;
const GATE_MAX_MS = 5 * 60_000;
const SIGNED_CONTROL_MAX_ATTEMPTS = 12;
const SIGNED_CONTROL_TIMEOUT_MS = 5 * 60_000;
const ARTIFACT_COMMIT_LEASE_EXPIRY_WAIT_MS = 17_000;
const DEFAULT_BUILD_TERMINAL_WAIT_MS = 20 * 60_000;
const diagnosticWait = process.env.NABUFLOW_DIAGNOSTIC_BUILD_WAIT_MS;
const BUILD_TERMINAL_WAIT_MS =
  diagnosticWait === undefined ? DEFAULT_BUILD_TERMINAL_WAIT_MS : Number(diagnosticWait);
if (
  !Number.isSafeInteger(BUILD_TERMINAL_WAIT_MS) ||
  BUILD_TERMINAL_WAIT_MS < DEFAULT_BUILD_TERMINAL_WAIT_MS ||
  BUILD_TERMINAL_WAIT_MS > 90 * 60_000
) {
  throw new Error("Diagnostic build wait must be an integer between 20 and 90 minutes");
}
const diagnosticVerificationStall = process.env.NABUFLOW_DIAGNOSTIC_VERIFY_STALL_MS;
const DIAGNOSTIC_VERIFY_STALL_MS =
  diagnosticVerificationStall === undefined ? null : Number(diagnosticVerificationStall);
if (
  DIAGNOSTIC_VERIFY_STALL_MS !== null &&
  (diagnosticWait === undefined ||
    !Number.isSafeInteger(DIAGNOSTIC_VERIFY_STALL_MS) ||
    DIAGNOSTIC_VERIFY_STALL_MS < 60_000 ||
    DIAGNOSTIC_VERIFY_STALL_MS > 10 * 60_000)
) {
  throw new Error("Diagnostic verification stall bound requires a diagnostic run and 1-10 minutes");
}
const PLATFORM: PantryPlatform = {
  runtime: "node",
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux",
  cpu: "x64",
  libc: "glibc",
  toolchainImageDigest: "sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738",
};
const INTENTS: PantryPackageIntent[] = [
  { ecosystem: "npm", name: "esbuild", selector: "latest" },
  { ecosystem: "npm", name: "leaflet", selector: "latest" },
  { ecosystem: "npm", name: "postgres", selector: "latest" },
  { ecosystem: "npm", name: "sharp", selector: "latest" },
  { ecosystem: "npm", name: "stripe", selector: "latest" },
  { ecosystem: "npm", name: "ws", selector: "latest" },
].sort((left, right) =>
  `${left.ecosystem}:${left.name}\0${left.selector}`.localeCompare(
    `${right.ecosystem}:${right.name}\0${right.selector}`,
  ),
);

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
const evidenceRunId = createStagingEvidenceRunId(new Date(), crypto.randomUUID());
const readinessRevisions = new Map<number, string>();
const createdBuildIds = new Set<string>();
const createdShelfRoots: string[] = [];
const persistedCollectionProgress = new Set<string>();
const persistedVerificationProgress = new Set<string>();
const persistedSecretScanSummaries = new Set<string>();
const persistedMemoryProgress = new Set<string>();
let controlToken = "";
let previewPrivateKey = "";
let previewPublicKey = "";
let vaultKek = "";
let workerClockOffsetMs = 0;
let deploymentVersion = "";
let runtimeIdentity = "";
let runtimePath = "";
let locator: { projectId: number; role: "preview"; slot: "primary" } | null = null;
let layeredArtifact: SealedLayeredRuntimeArtifact | null = null;

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

function writeEvidence(phase: "pre-cleanup" | "final"): string {
  const evidenceDirectory = resolve(process.cwd(), "../../tmp/gateway-trusted-build-plane");
  return writeImmutableStagingEvidence({
    directory: evidenceDirectory,
    runId: evidenceRunId,
    phase,
    transcript,
  });
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeCode(body: unknown): string | undefined {
  return (body as { code?: string } | null)?.code;
}

function base64UrlSecret(bytes = 32): string {
  const value = randomBytes(bytes).toString("base64url");
  assertCondition(/^[A-Za-z0-9_-]+$/u.test(value) && !value.includes("="), "Secret format failed");
  assertCondition(Buffer.from(value, "base64url").byteLength === bytes, "Secret size failed");
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
  assertCondition(previewPublicKey.includes("BEGIN PUBLIC KEY"), "Preview public key invalid");
  assertCondition(previewPrivateKey.includes("BEGIN PRIVATE KEY"), "Preview private key invalid");
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
      rejectPromise(new Error("Atomic rotation timed out"));
    }, 120_000);
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? -1);
    });
    child.stdin.end(payload);
  });
  payload = "";
  assertCondition(exitCode === 0, `Atomic rotation failed (${exitCode})`);
  record("rotation.atomic-full-set", 200, {
    entries: 4,
    base64UrlSelfCheck: true,
    persisted: false,
  });
}

async function makeSignedRequest(input: {
  path: string;
  method?: string;
  body?: unknown | Uint8Array;
  nonce: string;
  idempotencyKey?: string;
  secret?: string;
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
  const signature = await signControlRequest(input.secret ?? controlToken, {
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
  const response = await fetch(await makeSignedRequest(input), {
    signal: AbortSignal.timeout(SIGNED_CONTROL_TIMEOUT_MS),
  });
  return { response, body: await readResponse(response) };
}

function isWeather(result: ControlResult): boolean {
  const body = result.body as { code?: string; retryable?: boolean } | null;
  return (
    (result.response.status === 401 && body?.code === "invalid_signature") ||
    (result.response.status === 409 &&
      body?.code === "request_in_progress" &&
      body.retryable === true) ||
    (result.response.status >= 500 && body?.retryable === true)
  );
}

async function signedControlFetch(
  input: Parameters<typeof makeSignedRequest>[0],
  label: string,
): Promise<ControlResult> {
  for (let attempt = 1; attempt <= SIGNED_CONTROL_MAX_ATTEMPTS; attempt += 1) {
    let result: ControlResult;
    try {
      result = await signedFetch({
        ...input,
        nonce: attempt === 1 ? input.nonce : `${label}-retry-${attempt}-${crypto.randomUUID()}`,
      });
    } catch (error) {
      if (attempt === SIGNED_CONTROL_MAX_ATTEMPTS) throw error;
      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
      record(`retry.${label}`, "transport_error", {
        attempt,
        backoffMs,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs));
      continue;
    }
    if (!isWeather(result) || attempt === SIGNED_CONTROL_MAX_ATTEMPTS) return result;
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

async function proveCommitLeaseAdoption(
  input: Parameters<typeof makeSignedRequest>[0],
  label: string,
  expectedStage: "before-materializer" | "mid-materialization",
): Promise<{ result: ControlResult; elapsedMs: number }> {
  const startedAt = performance.now();
  const terminated = await signedFetch(input);
  assertStatus(`${label}.owner-terminated`, terminated, 503);
  assertCondition(
    safeCode(terminated.body) === "artifact_commit_owner_lost",
    `${label}: staging owner-loss probe did not terminate the first owner`,
  );
  const liveOwner = await signedFetch({
    ...input,
    nonce: `${label}-live-owner-${crypto.randomUUID()}`,
  });
  assertStatus(`${label}.live-owner`, liveOwner, 409);
  assertCondition(
    safeCode(liveOwner.body) === "request_in_progress",
    `${label}: live reservation did not preserve in-progress semantics`,
  );
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, ARTIFACT_COMMIT_LEASE_EXPIRY_WAIT_MS),
  );
  const adopted = await signedControlFetch(
    {
      ...input,
      nonce: `${label}-adopt-${crypto.randomUUID()}`,
    },
    `${label}.adopt`,
  );
  assertStatus(`${label}.adopt`, adopted, 200);
  const elapsedMs = Math.round(performance.now() - startedAt);
  record(`${label}.proof`, 200, {
    expectedStage,
    sameIdempotencyKey: true,
    liveOwnerStatus: 409,
    adoptionStatus: 200,
    leaseExpiryWaitMs: ARTIFACT_COMMIT_LEASE_EXPIRY_WAIT_MS,
    elapsedMs,
  });
  return { result: adopted, elapsedMs };
}

function capabilityPath(projectId: number): string {
  return `${CONTROL_PREFIX}/capabilities/${projectId}/nabuflow-harness/echo`;
}

async function probeVault(probeNumber: number): Promise<ControlResult> {
  const projectId = 790_000_000 + probeNumber;
  const revision = `build-readiness-${projectId}-${crypto.randomUUID()}`;
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
  if ([200, 404].includes(revoke.response.status)) readinessRevisions.delete(projectId);
  return revoke;
}

async function probePreviewGrant(replay: boolean, number: number) {
  const identity = await deriveRuntimeIdentity({
    namespace: DEPLOYMENT_NAMESPACE,
    projectId: 780_000_000 + number,
    role: "preview",
    slot: "primary",
  });
  const now = Math.floor((Date.now() + workerClockOffsetMs) / 1_000);
  const grant = await signPreviewGrant(previewPrivateKey, {
    v: 1,
    iss: "nabuflow-api",
    aud: CONTROL_URL,
    sub: identity,
    port: 8080,
    iat: now,
    exp: now + 300,
    jti: `build${number}${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const url = `${CONTROL_URL}/_nabuflow/preview/v1/${identity}/?__nfg=${encodeURIComponent(grant)}`;
  const redeem = await fetch(url, { redirect: "manual" });
  const redeemBody = await readResponse(redeem);
  if (!replay)
    return { green: redeem.status === 302, status: redeem.status, body: redeemBody, requests: 1 };
  const replayed = await fetch(url, { redirect: "manual" });
  const replayBody = await readResponse(replayed);
  return {
    green:
      redeem.status === 302 &&
      replayed.status === 409 &&
      safeCode(replayBody) === "preview_grant_replayed",
    status: replayed.status,
    body: {
      redeemStatus: redeem.status,
      replayStatus: replayed.status,
      replayCode: safeCode(replayBody),
    },
    requests: 2,
  };
}

async function sustainedGreen(): Promise<void> {
  const unsigned = await fetch(`${CONTROL_URL}${CONTROL_PREFIX}/version`);
  const workerDate = unsigned.headers.get("date");
  const workerTime = workerDate === null ? Number.NaN : Date.parse(workerDate);
  assertCondition(Number.isFinite(workerTime), "Worker Date header missing");
  workerClockOffsetMs = workerTime - Date.now();
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
        nonce: `gate-${crypto.randomUUID()}`,
      });
      totalRequests += 1;
      update("controlHmac", result.response.status === 200, result.response.status, result.body);
      if (result.response.status === 200) {
        deploymentVersion = (result.body as { deploymentVersion?: string }).deploymentVersion ?? "";
      }
    }
    if (surfaces.previewGrant.consecutive < GATE_REQUIRED) {
      const result = await probePreviewGrant(false, surfaces.previewGrant.probes + 1);
      totalRequests += result.requests;
      update("previewGrant", result.green, result.status, result.body);
    }
    if (surfaces.vaultKek.consecutive < GATE_REQUIRED) {
      const result = await probeVault(surfaces.vaultKek.probes + 1);
      totalRequests += 2;
      update("vaultKek", result.response.status === 200, result.response.status, result.body);
    }
    if (surfaces.previewReplayPair.consecutive < GATE_REQUIRED) {
      const result = await probePreviewGrant(true, surfaces.previewReplayPair.probes + 1);
      totalRequests += result.requests;
      update("previewReplayPair", result.green, result.status, result.body);
    }
    if (!complete()) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  assertCondition(complete(), `Four-surface gate did not converge: ${JSON.stringify(surfaces)}`);
  assertCondition(deploymentVersion.length > 0, "Active runtime version was not observed");
  record("gate.complete", 200, { elapsedMs: performance.now() - started, totalRequests, surfaces });
}

async function pantryCall(
  suffix: string,
  method: string,
  body: unknown | undefined,
  label: string,
) {
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

async function buildCall(suffix: string, method: string, body: unknown | undefined, label: string) {
  return signedControlFetch(
    {
      path: `${BUILD_PREFIX}${suffix}`,
      method,
      body,
      nonce: `${label}-${crypto.randomUUID()}`,
      ...(method === "GET" ? {} : { idempotencyKey: `${label}-${crypto.randomUUID()}` }),
    },
    label,
  );
}

async function stockHeavyShelf(nowMs: number): Promise<PantryCatalogShelfRecord> {
  const identity = { intents: INTENTS, platform: PLATFORM };
  const request = pantryCatalogStockRequestSchema.parse({
    schemaVersion: 1,
    ...identity,
    requestSha256: await pantryCatalogStockRequestHash(identity),
    requestedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
  });
  const before = await pantryCall("/diagnostics", "GET", undefined, "pantry.diag.before");
  assertStatus("pantry.diag.before", before, 200);
  const beforeDeliveries =
    (before.body as { ledger?: { queueDeliveries?: number } }).ledger?.queueDeliveries ?? 0;
  const concurrent = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      pantryCall("/stock-requests", "POST", request, `pantry.coalesce.${index}`),
    ),
  );
  assertCondition(
    concurrent.every((result) => [200, 201].includes(result.response.status)),
    "Concurrent stock demand failed",
  );
  let root: string | null = null;
  for (let attempt = 1; root === null && attempt <= 150; attempt += 1) {
    const lookup = await pantryCall("/stock-requests", "POST", request, `pantry.poll.${attempt}`);
    assertCondition([200, 201].includes(lookup.response.status), "Pantry stock lookup failed");
    root = (lookup.body as { revisionRootSha256?: string | null }).revisionRootSha256 ?? null;
    if (root === null) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  assertCondition(root !== null, "Heavy Pantry shelf did not commit within five minutes");
  createdShelfRoots.push(root);
  const after = await pantryCall("/diagnostics", "GET", undefined, "pantry.diag.after");
  assertStatus("pantry.diag.after", after, 200);
  const afterDeliveries =
    (after.body as { ledger?: { queueDeliveries?: number } }).ledger?.queueDeliveries ?? 0;
  assertCondition(
    afterDeliveries - beforeDeliveries === 1,
    "100 concurrent misses did not coalesce to one ingest",
  );
  const shelfResult = await pantryCall(
    `/revisions/by-root/${root}`,
    "GET",
    undefined,
    "pantry.shelf",
  );
  assertStatus("pantry.shelf", shelfResult, 200);
  const shelf = (shelfResult.body as { shelf?: PantryCatalogShelfRecord }).shelf;
  assertCondition(shelf !== undefined, "Pantry shelf response was missing");
  const coordinates = shelf.revision.content.closure.ingredients.map(
    (ingredient) => `${ingredient.package.name}@${ingredient.package.version}`,
  );
  for (const intent of INTENTS) {
    assertCondition(
      coordinates.some((value) => value.startsWith(`${intent.name}@`)),
      `Missing root ${intent.name}`,
    );
  }
  record("pantry.heavy-matrix", 200, {
    roots: INTENTS.map((intent) => intent.name),
    ingredients: coordinates.length,
    queueDeliveries: 1,
    concurrentDemanders: 100,
  });
  const coordinateSet = new Set(coordinates);
  const runtimeEdges = shelf.revision.content.closure.ingredients.flatMap((ingredient) =>
    ingredient.dependencies
      .filter((dependency) => dependency.kind === "runtime")
      .map((dependency) => ({
        from: `${ingredient.package.name}@${ingredient.package.version}`,
        to: `${dependency.name}@${dependency.version}`,
      })),
  );
  const unresolvedRuntimeEdges = runtimeEdges.filter((edge) => !coordinateSet.has(edge.to));
  assertCondition(
    unresolvedRuntimeEdges.length === 0,
    "Heavy Pantry shelf contains an unresolved declared runtime dependency",
  );
  const declaredBins = shelf.revision.content.closure.ingredients.flatMap((ingredient) =>
    Object.entries(ingredient.bins ?? {}).map(([command, path]) => ({
      coordinate: `${ingredient.package.name}@${ingredient.package.version}`,
      command,
      path,
    })),
  );
  record("pantry.heavy-closure-completeness", 200, {
    ingredients: coordinates.length,
    declaredRuntimeEdges: runtimeEdges.length,
    unresolvedRuntimeEdges,
    declaredBins,
  });
  const bufferutil = shelf.revision.content.closure.ingredients.find(
    (ingredient) => ingredient.package.name === "bufferutil",
  );
  const nodeGypBuild = shelf.revision.content.closure.ingredients.find(
    (ingredient) => ingredient.package.name === "node-gyp-build",
  );
  const bufferutilNodeGypEdge = bufferutil?.dependencies.find(
    (dependency) => dependency.name === "node-gyp-build" && dependency.kind === "runtime",
  );
  record("pantry.heavy-closure-inspection", 200, {
    bufferutilVersion: bufferutil?.package.version ?? null,
    declaredRuntimeEdge: bufferutilNodeGypEdge ?? null,
    shelvedIngredient:
      nodeGypBuild === undefined
        ? null
        : {
            name: nodeGypBuild.package.name,
            version: nodeGypBuild.package.version,
            tarballSha256: nodeGypBuild.tarballSha256,
          },
    exactEdgeResolves:
      bufferutilNodeGypEdge !== undefined &&
      nodeGypBuild?.package.version === bufferutilNodeGypEdge.version,
  });
  return shelf;
}

async function captureBuildResource(parent: PantryCatalogShelfRecord, nowMs: number) {
  const result = await pantryCall(
    "/build-resources",
    "POST",
    {
      schemaVersion: 1,
      parentRevisionRootSha256: parent.revision.rootSha256,
      url: "https://unpkg.com/leaflet@1.9.4/LICENSE",
      expectedSha256: null,
      maxBytes: 1024 * 1024,
      requestedAt: new Date(nowMs + 1_000).toISOString(),
    },
    "pantry.capture-resource",
  );
  assertStatus("pantry.capture-resource", result, 201);
  const shelf = (result.body as { shelf?: PantryCatalogShelfRecord }).shelf;
  assertCondition(shelf !== undefined, "Derived captured-resource shelf missing");
  createdShelfRoots.push(shelf.revision.rootSha256);
  assertCondition(
    shelf.revision.content.capturedBuildResources?.length === 1,
    "Captured resource not stamped",
  );
  return shelf;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function makeBuildRequest(
  shelf: PantryCatalogShelfRecord,
  marker: string,
  command: string[] = ["node", "build.mjs"],
): Promise<TrustedBuildRequest> {
  const server = `import http from "node:http";\nimport sharp from "sharp";\nimport Stripe from "stripe";\nimport postgres from "postgres";\nimport { WebSocketServer } from "ws";\nconst resolved=[typeof sharp,typeof Stripe,typeof postgres,typeof WebSocketServer,import.meta.resolve("leaflet"),import.meta.resolve("esbuild")];\nhttp.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,resolved:resolved.length,port:Number(process.env.PORT)}));}).listen(Number(process.env.PORT),"0.0.0.0");\n`;
  const buildSource = `import { mkdir, readFile, writeFile } from "node:fs/promises";\nconst map=JSON.parse(await readFile(process.env.NABUFLOW_CAPTURED_RESOURCE_MAP,"utf8"));\nconst entries=Object.values(map);if(entries.length!==1)throw new Error("captured resource missing");\nconst resource=await readFile(entries[0].path);\nawait mkdir("dist",{recursive:true});\nawait writeFile("dist/server.mjs",${JSON.stringify(server)});\nawait writeFile("dist/resource.sha256",entries[0].sha256+":"+resource.length);\n`;
  const sourceFiles = [
    { path: "build.mjs", mode: 0o644 as const, bytes: new TextEncoder().encode(buildSource) },
    {
      path: "package.json",
      mode: 0o644 as const,
      bytes: new TextEncoder().encode(
        '{"name":"trusted-build-acceptance","private":true,"type":"module"}',
      ),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const payload = new Uint8Array(sourceFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0));
  let offset = 0;
  const files = [];
  for (const file of sourceFiles) {
    payload.set(file.bytes, offset);
    files.push({
      path: file.path,
      mode: file.mode,
      offset,
      size: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes),
    });
    offset += file.bytes.byteLength;
  }
  const manifest = {
    format: TRUSTED_BUILD_SOURCE_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    payloadBytes: payload.byteLength,
    files,
  };
  const buildId = `pbuild_${marker}${randomBytes(18).toString("base64url")}`.slice(0, 64);
  const unsigned = {
    format: TRUSTED_BUILD_REQUEST_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    input: {
      format: PANTRY_BUILD_INPUT_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      buildId,
      sourceArtifactSha256: await trustedBuildSourceManifestHash(manifest),
      dependencyIntentSha256: await trustedBuildDependencyIntentHash(INTENTS),
      lockfileSha256: shelf.lockfileSha256,
      pantryRevisionId: shelf.revision.content.revisionId,
      pantryRevisionRootSha256: shelf.revision.rootSha256,
      dependencyClosureSha256: shelf.revision.content.dependencyClosureSha256,
      platform: PLATFORM,
      buildCommand: command,
      createdAt: new Date(Date.now() + workerClockOffsetMs).toISOString(),
    },
    source: { manifest, payloadBase64: encodeBase64(payload) },
    dependencyIntents: INTENTS,
    output: {
      strategy: "bundle-first" as const,
      dependencyPackaging: "layer" as const,
      appDirectory: "dist",
      dependencyLayerMountPath: "node_modules" as const,
    },
  };
  return trustedBuildRequestSchema.parse({
    ...unsigned,
    requestId: `pbuildreq_${await trustedBuildRequestHash(unsigned)}`,
  });
}

async function waitForBuild(
  buildId: string,
  label: string,
): Promise<{ output: TrustedBuildOutput; elapsedMs: number }> {
  const started = performance.now();
  let attempt = 0;
  while (performance.now() - started < BUILD_TERMINAL_WAIT_MS) {
    attempt += 1;
    const status = await buildCall(
      `/builds/${buildId}`,
      "GET",
      undefined,
      `${label}.poll.${attempt}`,
    );
    assertStatus(`${label}.poll.${attempt}`, status, 200);
    const body = status.body as {
      state?: string;
      output?: TrustedBuildOutput | null;
      error?: unknown;
      attempts?: Array<{
        collectionProgress?: TrustedBuildCollectionProgress[];
        memoryProgress?: TrustedBuildMemoryProgress[];
      }>;
    };
    for (const progress of body.attempts?.at(-1)?.collectionProgress ?? []) {
      const key = `${progress.pass}:${progress.root}:${progress.phase}:${progress.recordedAt}`;
      if (persistedCollectionProgress.has(key)) continue;
      persistedCollectionProgress.add(key);
      record(`${label}.collection-progress`, 200, progress);
    }
    for (const progress of body.attempts?.at(-1)?.memoryProgress ?? []) {
      const key = `${buildId}:${progress.pass}:${progress.phase}:${progress.recordedAt}`;
      if (persistedMemoryProgress.has(key)) continue;
      persistedMemoryProgress.add(key);
      record(`${label}.memory-progress`, 200, progress);
    }
    const verificationProgress = (
      body.attempts?.at(-1) as
        | { verificationProgress?: TrustedBuildVerificationProgress[] }
        | undefined
    )?.verificationProgress;
    const secretScanSummaries = (
      body.attempts?.at(-1) as { secretScanSummaries?: TrustedBuildSecretScanSummary[] } | undefined
    )?.secretScanSummaries;
    for (const summary of secretScanSummaries ?? []) {
      const key = `${summary.pass}:${summary.root}:${summary.recordedAt}`;
      if (persistedSecretScanSummaries.has(key)) continue;
      persistedSecretScanSummaries.add(key);
      record(`${label}.secret-scan-summary`, 200, summary);
    }
    for (const progress of verificationProgress ?? []) {
      const key = `${progress.phase}:${progress.recordedAt}`;
      if (persistedVerificationProgress.has(key)) continue;
      persistedVerificationProgress.add(key);
      record(`${label}.verification-progress`, 200, progress);
    }
    if (body.state === "succeeded" && body.output !== null && body.output !== undefined) {
      return { output: body.output, elapsedMs: performance.now() - started };
    }
    if (body.state === "failed" || body.state === "cancelled") {
      await preserveBuildFailureEvidence(buildId, label, "terminal", status);
      throw new Error(`${label}: build ended ${body.state} (${safeCode(body.error) ?? "none"})`);
    }
    const lastVerificationProgress = verificationProgress?.at(-1);
    if (
      DIAGNOSTIC_VERIFY_STALL_MS !== null &&
      body.state === "verifying" &&
      lastVerificationProgress !== undefined &&
      Date.now() + workerClockOffsetMs - Date.parse(lastVerificationProgress.recordedAt) >
        DIAGNOSTIC_VERIFY_STALL_MS
    ) {
      await preserveBuildFailureEvidence(buildId, label, "verification_heartbeat_stalled", status);
      throw new Error(`${label}: verification heartbeat stalled during diagnostic run`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  await preserveBuildFailureEvidence(buildId, label, "terminal_wait_exhausted");
  throw new Error(
    `${label}: build did not complete within ${Math.round(BUILD_TERMINAL_WAIT_MS / 60_000)} minutes`,
  );
}

async function preserveBuildFailureEvidence(
  buildId: string,
  label: string,
  category: "terminal" | "terminal_wait_exhausted" | "verification_heartbeat_stalled",
  observedStatus?: ControlResult,
): Promise<void> {
  let status = observedStatus;
  try {
    status ??= await buildCall(
      `/builds/${buildId}`,
      "GET",
      undefined,
      `${label}.terminal-evidence.status`,
    );
    const parsed = status.body as Partial<TrustedBuildStatusResponse>;
    const error = parsed.error;
    record(`${label}.terminal-evidence`, status.response.status, {
      category,
      buildId,
      state: parsed.state,
      attempt: parsed.attempt,
      attempts: parsed.attempts ?? [],
      updatedAt: parsed.updatedAt,
      error:
        error === null || error === undefined
          ? null
          : {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              status: error.status,
            },
    });
  } catch (error) {
    record(`${label}.terminal-evidence`, "unavailable", {
      category,
      buildId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
  try {
    const diagnostics = await buildCall(
      "/diagnostics",
      "GET",
      undefined,
      `${label}.terminal-evidence.diagnostics`,
    );
    record(`${label}.terminal-evidence.diagnostics.snapshot`, diagnostics.response.status, {
      body: diagnostics.body,
    });
  } catch (error) {
    record(`${label}.terminal-evidence.diagnostics.snapshot`, "unavailable", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function fetchOutputPayload(
  output: TrustedBuildOutput,
  scope: "app" | "layer",
): Promise<Uint8Array> {
  const content = scope === "app" ? output.app.content : output.layers[0]?.content;
  const descriptors = scope === "app" ? output.app.chunks : output.layers[0]?.chunks;
  assertCondition(content !== undefined && descriptors !== undefined, `Missing ${scope} output`);
  const contentSha =
    scope === "app"
      ? await sha256Hex(canonicalPantryJson(content))
      : content.descriptor.contentSha256;
  const payload = new Uint8Array(content.payloadBytes);
  let offset = 0;
  for (const descriptor of descriptors) {
    const result = await buildCall(
      `/builds/${output.buildId}/outputs/${scope}/${contentSha}/chunks/${descriptor.index}`,
      "GET",
      undefined,
      `build.chunk.${scope}.${descriptor.index}`,
    );
    assertStatus(`build.chunk.${scope}.${descriptor.index}`, result, 200);
    const bytes = Buffer.from((result.body as { payloadBase64: string }).payloadBase64, "base64");
    assertCondition(bytes.byteLength === descriptor.bytes, "Build chunk length changed");
    assertCondition((await sha256Hex(bytes)) === descriptor.sha256, "Build chunk digest changed");
    payload.set(bytes, offset);
    offset += bytes.byteLength;
  }
  assertCondition(offset === content.payloadBytes, "Build payload was incomplete");
  return payload;
}

function unpackFiles(
  payload: Uint8Array,
  files: Array<{ path: string; mode: number; offset: number; size: number; sha256: string }>,
) {
  return files.map((file) => ({
    path: file.path,
    content: payload.slice(file.offset, file.offset + file.size),
    executable: file.mode === 0o755,
  }));
}

async function runBuild(
  shelf: PantryCatalogShelfRecord,
): Promise<{ output: TrustedBuildOutput; coldMs: number; warmMs: number }> {
  const request = await makeBuildRequest(shelf, "heavy");
  createdBuildIds.add(request.input.buildId);
  const before = await buildCall("/diagnostics", "GET", undefined, "build.diag.before");
  assertStatus("build.diag.before", before, 200);
  const beginStarted = performance.now();
  const begin = await buildCall("/builds", "POST", request, "build.begin");
  assertStatus("build.begin", begin, 201);
  const duplicate = await buildCall("/builds", "POST", request, "build.begin.duplicate");
  assertStatus("build.begin.duplicate", duplicate, 200);
  assertCondition(
    (duplicate.body as { state?: string }).state === "coalesced",
    "Build did not coalesce",
  );
  const completed = await waitForBuild(request.input.buildId, "build.heavy");
  const coldMs = performance.now() - beginStarted;
  const output = completed.output;
  assertCondition(output.layers.length === 1, "Heavy build did not emit a dependency layer");
  assertCondition(
    output.coldBuild && output.upstreamRequests === 0,
    "Build cell reported upstream access",
  );
  const attestation = await verifyPantryBuildAttestation(
    output.buildAttestation,
    new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
    PLATFORM,
  );
  assertCondition(attestation.ok, "Build attestation did not verify");
  assertCondition(
    (await pantryBuildAttestationHash(output.buildAttestation.statement)) ===
      output.buildAttestation.statementSha256,
    "Build attestation statement hash changed",
  );
  const warmStarted = performance.now();
  const warm = await buildCall("/builds", "POST", request, "build.warm");
  assertStatus("build.warm", warm, 200);
  assertCondition(
    (warm.body as { state?: string }).state === "succeeded",
    "Warm build did not reuse result",
  );
  const warmMs = performance.now() - warmStarted;
  const after = await buildCall("/diagnostics", "GET", undefined, "build.diag.after");
  assertStatus("build.diag.after", after, 200);
  record("build.performance", 200, { coldMs, warmMs, speedup: coldMs / Math.max(warmMs, 1) });
  return { output, coldMs, warmMs };
}

async function proveLiveConsumerDeathRecovery(shelf: PantryCatalogShelfRecord): Promise<void> {
  const request = await makeBuildRequest(shelf, "liveconsumerdeath_");
  assertCondition(
    request.input.buildId.startsWith("pbuild_liveconsumerdeath_"),
    "Live recovery probe build marker changed",
  );
  createdBuildIds.add(request.input.buildId);
  const startedAt = performance.now();
  const begin = await buildCall("/builds", "POST", request, "lease-recovery.live.begin");
  assertStatus("lease-recovery.live.begin", begin, 201);
  await waitForBuild(request.input.buildId, "lease-recovery.live");
  const status = await buildCall(
    `/builds/${request.input.buildId}`,
    "GET",
    undefined,
    "lease-recovery.live.status",
  );
  assertStatus("lease-recovery.live.status", status, 200);
  const body = status.body as TrustedBuildStatusResponse;
  const first = body.attempts.find((attempt) => attempt.attempt === 1);
  const recovered = body.attempts.find((attempt) => attempt.attempt === 2);
  assertCondition(body.state === "succeeded", "Recovered build did not succeed");
  assertCondition(
    first?.progression.some(
      (entry) => entry.pass === 1 && entry.stage === "install" && entry.outcome === "started",
    ),
    "Consumer termination did not occur at the live install stage",
  );
  assertCondition(first?.error === null, "Terminated consumer was misclassified as a build error");
  assertCondition(
    recovered?.lastSuccessfulStage?.stage === "output-persist",
    "Recovered attempt did not complete output persistence",
  );
  record("lease-recovery.live", 200, {
    buildId: request.input.buildId,
    terminatedAttempt: 1,
    recoveredAttempt: 2,
    terminalState: body.state,
    elapsedMs: performance.now() - startedAt,
    manualIntervention: false,
  });
}

async function proveNegativeBuilds(shelf: PantryCatalogShelfRecord): Promise<void> {
  const secretRequest = await makeBuildRequest(shelf, "secret");
  const secretBytes = new TextEncoder().encode("sk_test_ABCDEFGHIJKLMNOPQRST");
  secretRequest.source.payloadBase64 = encodeBase64(secretBytes);
  secretRequest.source.manifest = {
    format: TRUSTED_BUILD_SOURCE_FORMAT,
    schemaVersion: 1,
    payloadBytes: secretBytes.byteLength,
    files: [
      {
        path: "source.mjs",
        mode: 0o644,
        offset: 0,
        size: secretBytes.byteLength,
        sha256: await sha256Hex(secretBytes),
      },
    ],
  };
  secretRequest.input.sourceArtifactSha256 = await trustedBuildSourceManifestHash(
    secretRequest.source.manifest,
  );
  const { requestId: _secretId, ...secretUnsigned } = secretRequest;
  secretRequest.requestId = `pbuildreq_${await trustedBuildRequestHash(secretUnsigned)}`;
  const secret = await signedFetch({
    path: `${BUILD_PREFIX}/builds`,
    method: "POST",
    body: secretRequest,
    nonce: `negative-secret-${crypto.randomUUID()}`,
    idempotencyKey: `negative-secret-${crypto.randomUUID()}`,
  });
  assertStatus("negative.secret-source", secret, 422);
  assertCondition(!JSON.stringify(secret.body).includes("sk_test_"), "Secret leaked in rejection");

  const unsigned = await fetch(`${CONTROL_URL}${BUILD_PREFIX}/health`);
  record("negative.unsigned", unsigned.status, { code: safeCode(await readResponse(unsigned)) });
  assertCondition(unsigned.status === 401, "Unsigned build endpoint was reachable");

  const wrongAbi = await makeBuildRequest(shelf, "abi");
  wrongAbi.input.platform.nodeAbi = "999";
  const { requestId: _abiId, ...abiUnsigned } = wrongAbi;
  wrongAbi.requestId = `pbuildreq_${await trustedBuildRequestHash(abiUnsigned)}`;
  createdBuildIds.add(wrongAbi.input.buildId);
  const abiBegin = await buildCall("/builds", "POST", wrongAbi, "negative.abi.begin");
  assertStatus("negative.abi.begin", abiBegin, 201);
  let abiRejected = false;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const status = await buildCall(
      `/builds/${wrongAbi.input.buildId}`,
      "GET",
      undefined,
      `negative.abi.${attempt}`,
    );
    const body = status.body as { state?: string; error?: { code?: string } };
    if (body.state === "failed") {
      assertCondition(
        body.error?.code === "build_platform_mismatch",
        "Wrong ABI returned wrong error",
      );
      record("negative.wrong-abi", status.response.status, { code: body.error.code });
      abiRejected = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  assertCondition(abiRejected, "Wrong ABI build did not reach a typed terminal rejection");

  const nondeterministic = await makeBuildRequest(shelf, "random", [
    "node",
    "-e",
    'require("fs").mkdirSync("dist",{recursive:true});require("fs").writeFileSync("dist/random.txt",String(Math.random()))',
  ]);
  createdBuildIds.add(nondeterministic.input.buildId);
  const randomBegin = await buildCall("/builds", "POST", nondeterministic, "negative.random.begin");
  assertStatus("negative.random.begin", randomBegin, 201);
  let nondeterminismRejected = false;
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    const status = await buildCall(
      `/builds/${nondeterministic.input.buildId}`,
      "GET",
      undefined,
      `negative.random.${attempt}`,
    );
    const body = status.body as { state?: string; error?: { code?: string } };
    if (body.state === "failed") {
      assertCondition(
        body.error?.code === "attestation_invalid",
        "Nondeterminism returned wrong error",
      );
      record("negative.non-reproducible", 422, { code: body.error.code });
      nondeterminismRejected = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  assertCondition(
    nondeterminismRejected,
    "Non-reproducible build did not reach a typed terminal rejection",
  );
}

async function resolveLayerSealProvenance(
  shelf: PantryCatalogShelfRecord,
  expectedShelf: TrustedBuildOutput["pantryShelf"],
) {
  const suffix = `/revisions/by-root/${shelf.revision.rootSha256}/content-hashes`;
  const unsigned = await fetch(`${CONTROL_URL}${PANTRY_PREFIX}${suffix}`);
  const unsignedBody = await readResponse(unsigned);
  record("pantry.sealer-provenance.unsigned", unsigned.status, {
    code: safeCode(unsignedBody),
  });
  assertCondition(unsigned.status === 401, "Unsigned Pantry provenance read was accepted");

  const missignedRequest = await makeSignedRequest({
    path: `${PANTRY_PREFIX}${suffix}`,
    nonce: `pantry-provenance-missigned-${crypto.randomUUID()}`,
    secret: base64UrlSecret(),
  });
  const missigned = await fetch(missignedRequest);
  const missignedBody = await readResponse(missigned);
  record("pantry.sealer-provenance.missigned", missigned.status, {
    code: safeCode(missignedBody),
  });
  assertCondition(missigned.status === 401, "Missigned Pantry provenance read was accepted");

  const unknown = await pantryCall(
    `/revisions/by-root/${"f".repeat(64)}/content-hashes`,
    "GET",
    undefined,
    "pantry.sealer-provenance.unknown",
  );
  assertStatus("pantry.sealer-provenance.unknown", unknown, 404);
  assertCondition(
    safeCode(unknown.body) === "catalog_not_found",
    "Unknown Pantry provenance read returned the wrong typed error",
  );

  const response = await pantryCall(suffix, "GET", undefined, "pantry.sealer-provenance.read");
  assertStatus("pantry.sealer-provenance.read", response, 200);
  const attestation = pantryShelfContentHashesResponseSchema.parse(response.body);
  const provenance = await resolveTrustedPantryLayerSealProvenance({
    shelf,
    expectedShelf,
    attestation,
    publicKeys: new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
  });
  const tampered = structuredClone(attestation);
  tampered.statement.contentHashes[0] = "0".repeat(64);
  let tamperRejected = false;
  try {
    await resolveTrustedPantryLayerSealProvenance({
      shelf,
      expectedShelf,
      attestation: tampered,
      publicKeys: new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
    });
  } catch {
    tamperRejected = true;
  }
  assertCondition(tamperRejected, "Tampered Pantry provenance attestation was accepted");
  record("pantry.sealer-provenance.tampered", 422, { rejected: true });
  record("dock.layer-sealer.provenance", 200, {
    source: "signed-pantry-ledger",
    pantryRevisionRootSha256: provenance.pantryRevisionRootSha256,
    attestedContentHashes: attestation.statement.contentHashes.length,
    cache: "none",
  });
  return provenance;
}

async function provePreMaterializerCommitRecovery(): Promise<void> {
  assertCondition(locator !== null && runtimePath !== "", "Recovery runtime is unavailable");
  const source = new TextEncoder().encode(String.raw`
import { createServer } from "node:http";
createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: request.url === "/healthz", recovery: "before-materializer" }));
}).listen(8080, "0.0.0.0");
`);
  const artifactRevision = `${ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX}${crypto.randomUUID()}`;
  const artifact = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: "trusted-build-manifest-v1",
    artifactRevision,
    sourceRevision: "staging-commit-recovery-before-v1",
    files: [{ path: "server.mjs", content: source }],
  });
  const sha = artifact.envelope.sealedArtifactSha256;
  const begin = await signedControlFetch(
    {
      path: `${runtimePath}/artifacts/${sha}/begin`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, envelope: artifact.envelope },
      nonce: `dock-recovery-before-begin-${crypto.randomUUID()}`,
      idempotencyKey: `dock-recovery-before-begin-${sha}`,
    },
    "dock.recovery.before.begin",
  );
  assertStatus("dock.recovery.before.begin", begin, 200);
  for (let index = 0; index < artifact.chunks.length; index += 1) {
    const chunk = await signedControlFetch(
      {
        path: `${runtimePath}/artifacts/${sha}/chunks/${index}`,
        method: "PUT",
        body: artifact.chunks[index],
        nonce: `dock-recovery-before-chunk-${index}-${crypto.randomUUID()}`,
        idempotencyKey: `dock-recovery-before-chunk-${sha}-${index}`,
      },
      `dock.recovery.before.chunk.${index}`,
    );
    assertStatus(`dock.recovery.before.chunk.${index}`, chunk, 200);
  }
  await proveCommitLeaseAdoption(
    {
      path: `${runtimePath}/artifacts/${sha}/commit`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
      nonce: `dock-recovery-before-owner-loss-${crypto.randomUUID()}`,
      idempotencyKey: `dock-recovery-before-commit-${sha}`,
    },
    "dock.recovery.before.commit",
    "before-materializer",
  );
  const started = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision,
        artifactSha256: sha,
      },
      nonce: `dock-recovery-before-start-${crypto.randomUUID()}`,
      idempotencyKey: `dock-recovery-before-start-${sha}`,
    },
    "dock.recovery.before.start",
  );
  assertStatus("dock.recovery.before.start", started, 200);
  const health = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          'fetch("http://127.0.0.1:8080/healthz").then(r=>r.text()).then(console.log)',
        ],
        cwd: "/workspace",
        timeoutMs: 20_000,
      },
      nonce: `dock-recovery-before-health-${crypto.randomUUID()}`,
      idempotencyKey: `dock-recovery-before-health-${sha}`,
    },
    "dock.recovery.before.health",
  );
  assertStatus("dock.recovery.before.health", health, 200);
  assertCondition(
    ((health.body as { stdout?: string }).stdout ?? "").includes(
      '"recovery":"before-materializer"',
    ),
    "Adopted pre-materializer artifact did not serve",
  );
  const stopped = await signedControlFetch(
    {
      path: `${runtimePath}/stop`,
      method: "POST",
      body: { locator, reason: "staging-commit-recovery-proof" },
      nonce: `dock-recovery-before-stop-${crypto.randomUUID()}`,
      idempotencyKey: `dock-recovery-before-stop-${sha}`,
    },
    "dock.recovery.before.stop",
  );
  assertStatus("dock.recovery.before.stop", stopped, 200);
  const removed = await signedControlFetch(
    {
      path: `${runtimePath}/artifacts/${sha}`,
      method: "DELETE",
      body: { locator, sealedArtifactSha256: sha },
      nonce: `dock-recovery-before-remove-${crypto.randomUUID()}`,
      idempotencyKey: `dock-recovery-before-remove-${sha}`,
    },
    "dock.recovery.before.remove",
  );
  assertStatus("dock.recovery.before.remove", removed, 200);
}

async function deliverAndStart(
  output: TrustedBuildOutput,
  shelf: PantryCatalogShelfRecord,
): Promise<void> {
  locator = {
    projectId: 820_000_000 + randomBytes(3).readUIntBE(0, 3),
    role: "preview",
    slot: "primary",
  };
  runtimeIdentity = await deriveRuntimeIdentity({ namespace: DEPLOYMENT_NAMESPACE, ...locator });
  runtimePath = `${CONTROL_PREFIX}/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
  assertCondition(
    runtimePath ===
      `${CONTROL_PREFIX}/runtimes/${locator.projectId}/${locator.role}/${locator.slot}` &&
      !runtimePath.includes(runtimeIdentity) &&
      !runtimePath.includes("nbb-"),
    "Harness runtime ensure path does not match the shipped locator route",
  );
  record("runtime.ensure.request", "prepared", {
    runtimeIdentity,
    runtimePath,
    locator,
    expectedDeploymentVersion: deploymentVersion,
    manifest: {
      revision: "trusted-build-manifest-v1",
      runtime: "node-api",
      servicePort: 8080,
      healthPath: "/healthz",
    },
  });
  const ensure = await signedControlFetch(
    {
      path: runtimePath,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        manifest: {
          revision: "trusted-build-manifest-v1",
          runtime: "node-api",
          buildCommand: ["node", "build.mjs"],
          startCommand: ["node", "server.mjs"],
          servicePort: 8080,
          healthPath: "/healthz",
          resourceProfile: "dev",
          public: false,
        },
      },
      nonce: `runtime-ensure-${crypto.randomUUID()}`,
      idempotencyKey: `runtime-ensure-${runtimeIdentity}`,
    },
    "runtime.ensure",
  );
  assertStatus("runtime.ensure", ensure, 200);
  await provePreMaterializerCommitRecovery();
  const appPayload = await fetchOutputPayload(output, "app");
  const layerPayload = await fetchOutputPayload(output, "layer");
  const app = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: "trusted-build-manifest-v1",
    artifactRevision: "trusted-build-app-v1",
    sourceRevision: output.requestSha256,
    files: unpackFiles(appPayload, output.app.content.files),
  });
  assertCondition(
    canonicalPantryJson(app.envelope.content) === canonicalPantryJson(output.app.content),
    "Dock app reseal changed build bytes",
  );
  const layerOutput = output.layers[0];
  assertCondition(layerOutput !== undefined, "Dependency layer output missing");
  const provenance = await resolveLayerSealProvenance(shelf, output.pantryShelf);
  const layer = await sealRuntimeArtifactLayer({
    mountPath: layerOutput.content.descriptor.mountPath,
    platform: PLATFORM,
    files: unpackFiles(layerPayload, layerOutput.content.files),
    provenance,
  });
  assertCondition(
    canonicalPantryJson(layer.content) === canonicalPantryJson(layerOutput.content),
    "Dock layer reseal changed build bytes",
  );
  record("dock.layer-sealer.secret-scan-summary", 200, {
    ...layer.scanSummary,
    pantryRevisionRootSha256: provenance.pantryRevisionRootSha256,
  });
  layeredArtifact = await sealLayeredRuntimeArtifact({
    app,
    layers: [layer],
    pantryRevision: {
      schemaVersion: 1,
      revisionId: output.pantryShelf.pantryRevisionId,
      rootSha256: output.pantryShelf.pantryRevisionRootSha256,
      state: "committed",
      stateRevision: 1,
      updatedAt: output.completedAt,
    },
    dependencyClosureSha256: output.pantryShelf.dependencyClosureSha256,
    buildAttestationSha256: output.buildAttestation.statementSha256,
    platform: PLATFORM,
    artifactRevision: `${ARTIFACT_COMMIT_ABORT_MID_PREFIX}trusted-build-layered-v1`,
  });
  const sha = layeredArtifact.envelope.sealedArtifactSha256;
  const begin = await signedControlFetch(
    {
      path: `${runtimePath}/layered-artifacts/${sha}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: layeredArtifact.envelope,
      },
      nonce: `dock-begin-${crypto.randomUUID()}`,
      idempotencyKey: `dock-begin-${sha}`,
    },
    "dock.begin",
  );
  assertStatus("dock.begin", begin, 200);
  const uploadLayers =
    (begin.body as { layerContentSha256ToUpload?: string[] }).layerContentSha256ToUpload ?? [];
  for (let index = 0; index < layeredArtifact.appChunks.length; index += 1) {
    const uploaded = await signedControlFetch(
      {
        path: `${runtimePath}/layered-artifacts/${sha}/app/chunks/${index}`,
        method: "PUT",
        body: layeredArtifact.appChunks[index],
        nonce: `dock-app-${index}-${crypto.randomUUID()}`,
        idempotencyKey: `dock-app-${sha}-${index}`,
      },
      `dock.app.${index}`,
    );
    assertStatus(`dock.app.${index}`, uploaded, 200);
  }
  if (uploadLayers.includes(layer.content.descriptor.contentSha256)) {
    for (let index = 0; index < layer.chunks.length; index += 1) {
      const uploaded = await signedControlFetch(
        {
          path: `${runtimePath}/layered-artifacts/${sha}/layers/${layer.content.descriptor.contentSha256}/chunks/${index}`,
          method: "PUT",
          body: layer.chunks[index],
          nonce: `dock-layer-${index}-${crypto.randomUUID()}`,
          idempotencyKey: `dock-layer-${sha}-${index}`,
        },
        `dock.layer.${index}`,
      );
      assertStatus(`dock.layer.${index}`, uploaded, 200);
    }
  }
  const commitIdempotencyKey = `dock-commit-${sha}`;
  const commitStartedAt = performance.now();
  await proveCommitLeaseAdoption(
    {
      path: `${runtimePath}/layered-artifacts/${sha}/commit`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
      nonce: `dock-commit-owner-loss-${crypto.randomUUID()}`,
      idempotencyKey: commitIdempotencyKey,
    },
    "dock.commit.mid-materialization",
    "mid-materialization",
  );
  record("dock.commit.liveness", 200, {
    property: "coordinator-resume-after-mid-materialization-owner-loss",
    fileCount:
      layeredArtifact.envelope.content.appArtifact.content.files.length +
      layeredArtifact.envelope.content.layers.reduce(
        (total, value) => total + value.files.length,
        0,
      ),
    elapsedMs: Math.round(performance.now() - commitStartedAt),
    fiveMinuteWallMs: SIGNED_CONTROL_TIMEOUT_MS,
    idempotencyKeyReused: true,
  });
  const started = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision: `${ARTIFACT_COMMIT_ABORT_MID_PREFIX}trusted-build-layered-v1`,
        artifactSha256: sha,
      },
      nonce: `runtime-start-${crypto.randomUUID()}`,
      idempotencyKey: `runtime-start-${crypto.randomUUID()}`,
    },
    "runtime.start",
  );
  assertStatus("runtime.start", started, 200);
  const checked = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          'fetch("http://127.0.0.1:8080/healthz").then(r=>r.text()).then(console.log)',
        ],
        cwd: "/workspace",
        timeoutMs: 20_000,
      },
      nonce: `runtime-health-${crypto.randomUUID()}`,
      idempotencyKey: `runtime-health-${crypto.randomUUID()}`,
    },
    "runtime.health",
  );
  assertStatus("runtime.health", checked, 200);
  const stdout = (checked.body as { stdout?: string }).stdout ?? "";
  assertCondition(
    stdout.includes('"ok":true') && stdout.includes('"resolved":6'),
    "Built app health failed",
  );
  record("dock.layered-start", 200, {
    runtimeIdentity,
    port: 8080,
    healthPath: "/healthz",
    appFiles: output.app.content.files.length,
    layerFiles: layer.content.files.length,
  });
}

async function cleanup(): Promise<void> {
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
    );
  }
  readinessRevisions.clear();
  if (locator !== null && runtimePath !== "") {
    const stopped = await signedControlFetch(
      {
        path: `${runtimePath}/stop`,
        method: "POST",
        body: { locator, reason: "trusted-build-acceptance-cleanup" },
        nonce: `cleanup-stop-${crypto.randomUUID()}`,
        idempotencyKey: `cleanup-stop-${crypto.randomUUID()}`,
      },
      "cleanup.runtime.stop",
    );
    record("cleanup.runtime.stop", stopped.response.status, { code: safeCode(stopped.body) });
    const destroyed = await signedControlFetch(
      {
        path: runtimePath,
        method: "DELETE",
        body: { locator, reason: "trusted-build-acceptance-cleanup" },
        nonce: `cleanup-destroy-${crypto.randomUUID()}`,
        idempotencyKey: `cleanup-destroy-${crypto.randomUUID()}`,
      },
      "cleanup.runtime.destroy",
    );
    record("cleanup.runtime.destroy", destroyed.response.status, {
      code: safeCode(destroyed.body),
    });
    const absent = await signedControlFetch(
      {
        path: `${runtimePath}/status`,
        nonce: `cleanup-status-${crypto.randomUUID()}`,
      },
      "cleanup.runtime.absent",
    );
    assertStatus("cleanup.runtime.absent", absent, 404);
  }
  const buildGc = await buildCall(
    "/gc",
    "POST",
    {
      scope: "all-test-data",
      olderThan: new Date(Date.now() + workerClockOffsetMs + 60_000).toISOString(),
      maxDeletes: 1_000,
    },
    "cleanup.build-gc",
  );
  record("cleanup.build-gc", buildGc.response.status, buildGc.body);
  for (const root of [...createdShelfRoots].reverse()) {
    const read = await pantryCall(
      `/revisions/by-root/${root}`,
      "GET",
      undefined,
      `cleanup.shelf.read.${root.slice(0, 8)}`,
    );
    if (read.response.status !== 200) continue;
    const lifecycle = (read.body as { lifecycle?: { stateRevision?: number; state?: string } })
      .lifecycle;
    let revision = lifecycle?.stateRevision ?? 1;
    if (lifecycle?.state === "committed") {
      await pantryCall(
        `/revisions/${root}/state`,
        "POST",
        {
          expectedStateRevision: revision,
          nextState: "quarantined",
          updatedAt: new Date(Date.now() + workerClockOffsetMs + 1_000).toISOString(),
        },
        `cleanup.shelf.quarantine.${root.slice(0, 8)}`,
      );
      revision += 1;
    }
    await pantryCall(
      `/revisions/${root}/state`,
      "POST",
      {
        expectedStateRevision: revision,
        nextState: "retired",
        updatedAt: new Date(Date.now() + workerClockOffsetMs + 2_000).toISOString(),
      },
      `cleanup.shelf.retire.${root.slice(0, 8)}`,
    );
    await pantryCall(
      "/gc",
      "POST",
      {
        scope: "retired-unreferenced",
        now: new Date(Date.now() + workerClockOffsetMs + 366 * 24 * 60 * 60_000).toISOString(),
        maxDeletes: 100,
        retentionNamespace: "pantry-ingest",
      },
      `cleanup.shelf.gc.${root.slice(0, 8)}`,
    );
    const absent = await pantryCall(
      `/revisions/by-root/${root}`,
      "GET",
      undefined,
      `cleanup.shelf.absent.${root.slice(0, 8)}`,
    );
    assertStatus(`cleanup.shelf.absent.${root.slice(0, 8)}`, absent, 404);
  }
  const buildDiagnostics = await buildCall(
    "/diagnostics",
    "GET",
    undefined,
    "cleanup.build-diagnostics",
  );
  record("cleanup.build-diagnostics", buildDiagnostics.response.status, buildDiagnostics.body);
  assertCondition(buildDiagnostics.response.status === 200, "Build diagnostics unavailable");
  const buildState = buildDiagnostics.body as {
    ledger?: {
      queued?: number;
      running?: number;
      succeeded?: number;
      failed?: number;
      cancelled?: number;
    };
    r2?: { objects?: number; bytes?: number };
    activeCells?: number;
  };
  assertCondition(
    buildState.ledger?.queued === 0 &&
      buildState.ledger.running === 0 &&
      buildState.ledger.succeeded === 0 &&
      buildState.ledger.failed === 0 &&
      buildState.ledger.cancelled === 0 &&
      buildState.r2?.objects === 0 &&
      buildState.r2.bytes === 0 &&
      buildState.activeCells === 0,
    "Trusted build cleanup did not reach zero",
  );
  const pantryDiagnostics = await pantryCall(
    "/diagnostics",
    "GET",
    undefined,
    "cleanup.pantry-diagnostics",
  );
  record("cleanup.pantry-diagnostics", pantryDiagnostics.response.status, pantryDiagnostics.body);
}

async function waitForBuildsToSettleForCleanup(): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 30 * 60_000) {
    const diagnostics = await buildCall(
      "/diagnostics",
      "GET",
      undefined,
      "cleanup.wait-for-terminal",
    );
    assertStatus("cleanup.wait-for-terminal", diagnostics, 200);
    const ledger = (
      diagnostics.body as {
        ledger?: { queued?: number; running?: number };
      }
    ).ledger;
    if (ledger?.queued === 0 && ledger.running === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error("Trusted builds did not settle within the cleanup window");
}

async function cancelExplicitCleanupBuilds(): Promise<void> {
  const buildIds = (process.env.NABUFLOW_CLEANUP_BUILD_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  for (const buildId of buildIds) {
    assertCondition(
      /^pbuild_[A-Za-z0-9_-]{22,128}$/u.test(buildId),
      "Explicit cleanup build identifier is invalid",
    );
    const cancelled = await buildCall(
      `/builds/${buildId}`,
      "DELETE",
      undefined,
      "cleanup.explicit-cancel",
    );
    assertStatus("cleanup.explicit-cancel", cancelled, 200);
  }
}

async function main(): Promise<void> {
  let failure: unknown = null;
  try {
    record("run.configuration", 200, {
      evidenceRunId,
      buildTerminalWaitMs: BUILD_TERMINAL_WAIT_MS,
      diagnosticBound: BUILD_TERMINAL_WAIT_MS !== DEFAULT_BUILD_TERMINAL_WAIT_MS,
      diagnosticVerificationStallMs: DIAGNOSTIC_VERIFY_STALL_MS,
    });
    await rotateWorkerSecrets();
    await sustainedGreen();
    if (process.env.NABUFLOW_CLEANUP_ONLY === "1") {
      await cancelExplicitCleanupBuilds();
      await waitForBuildsToSettleForCleanup();
    } else {
      const health = await buildCall("/health", "GET", undefined, "build.health");
      assertStatus("build.health", health, 200);
      assertCondition(
        (health.body as { secretlessCells?: boolean; directRegistryAccess?: boolean })
          .secretlessCells === true &&
          (health.body as { directRegistryAccess?: boolean }).directRegistryAccess === false,
        "Build service isolation advertisement changed",
      );
      const nowMs = Date.now() + workerClockOffsetMs;
      const baseShelf = await stockHeavyShelf(nowMs);
      if (process.env.NABUFLOW_INSPECT_CLOSURE_ONLY !== "1") {
        const buildShelf = await captureBuildResource(baseShelf, nowMs);
        await proveLiveConsumerDeathRecovery(buildShelf);
        const built = await runBuild(buildShelf);
        if (process.env.NABUFLOW_HEAVY_ONLY !== "1") {
          await proveNegativeBuilds(buildShelf);
          await deliverAndStart(built.output, buildShelf);
        }
      }
    }
  } catch (error) {
    failure = error;
    record("run.failure", "error", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "unknown",
    });
    const preCleanupEvidencePath = writeEvidence("pre-cleanup");
    record("evidence.pre-cleanup.persisted", 200, { path: preCleanupEvidencePath });
  } finally {
    try {
      if (controlToken !== "") await cleanup();
    } catch (cleanupError) {
      record("cleanup.failure", "error", {
        name: cleanupError instanceof Error ? cleanupError.name : "UnknownError",
        message: cleanupError instanceof Error ? cleanupError.message : "unknown",
      });
      failure ??= cleanupError;
    }
    controlToken = "";
    previewPrivateKey = "";
    previewPublicKey = "";
    vaultKek = "";
    record("session-values.erased", 200, { erased: true });
    const evidencePath = writeEvidence("final");
    // eslint-disable-next-line no-console -- staging harness emits only a secret-free summary
    console.log(JSON.stringify({ ok: failure === null, evidencePath, checks: transcript.length }));
  }
  if (failure !== null) throw failure;
}

await main();
