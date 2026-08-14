import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  PANTRY_BUILD_INPUT_FORMAT,
  ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
  PANTRY_SCHEMA_VERSION,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_SOURCE_FORMAT,
  ZERO_SEALED_BUILD_PLATFORM,
  canonicalPantryJson,
  deriveRuntimeIdentity,
  pantryBuildAttestationHash,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryShelfContentHashesResponseSchema,
  artifactCommitDiagnosticsResponseSchema,
  durableOperationDiscoveryResponseSchema,
  parseRuntimeIdentity,
  runtimeManifestRestartDiagnosticsResponseSchema,
  runtimeStartDiagnosticsResponseSchema,
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
import {
  CloudflareRuntimeOperationTerminalUnknownError,
  CloudflareRuntimeProvider,
} from "../../api-server/src/lib/cloudflare-runtime-provider";
import {
  ZeroGenerationKitchenError,
  runZeroGenerationKitchen,
} from "../../api-server/src/lib/zero-generation-kitchen";
import { prepareZeroSealedNodeSource } from "../../api-server/src/lib/zero-sealed-generation";
import { PANTRY_TEST_KEY } from "./pantry-catalog-fixture";
import { createStagingEvidenceRunId, writeImmutableStagingEvidence } from "./staging-evidence";
import {
  evaluateAcceptanceTail,
  isKnownVendorAlarmTailEvent,
  knownVendorAlarmOccurrenceKey,
  parseConcatenatedWranglerTailJson,
  type VendorAlarmConsequenceProof,
} from "./staging-tail-evaluation";
import {
  ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX,
  ARTIFACT_COMMIT_ABORT_ALWAYS_PREFIX,
  ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX,
  ARTIFACT_COMMIT_ABORT_MID_PREFIX,
  RUNTIME_START_ABORT_ALWAYS_PREFIX,
  RUNTIME_START_ABORT_CHECKPOINT_PREFIX,
  RUNTIME_MANIFEST_RESTART_ABORT_ALWAYS_PREFIX,
  RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX,
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
const ZERO_GENERATOR_INTENTS: PantryPackageIntent[] = [
  { ecosystem: "npm", name: "@types/express", selector: "^5.0.3" },
  { ecosystem: "npm", name: "@types/node", selector: "^22.18.0" },
  { ecosystem: "npm", name: "express", selector: "^5.1.0" },
  { ecosystem: "npm", name: "typescript", selector: "^5.9.2" },
  { ecosystem: "npm", name: "zod", selector: "^4.1.5" },
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
const observedPantryAssemblyIds = new Set<string>();
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
let preCleanupEvidenceWritten = false;

const ACCEPTANCE_TAIL_SETTLE_MS = 45_000;

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

async function startAcceptanceErrorTail() {
  const startedAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "tail",
      "nabuflow-runtime-staging",
      "--format=json",
      "--status=error",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  assertCondition(child.exitCode === null, "Acceptance tail exited before the lifecycle began");
  record("tail.acceptance-window.started", 200, {
    startedAt,
    afterRotationAndFourSurfaceGate: true,
    deploymentResetEventsBelongTo: "propagation-evidence",
  });

  return {
    startedAt,
    async stop() {
      if (child.exitCode === null) child.kill("SIGINT");
      const exited = await Promise.race([
        new Promise<boolean>((resolvePromise) => child.once("exit", () => resolvePromise(true))),
        new Promise<boolean>((resolvePromise) =>
          setTimeout(() => resolvePromise(child.exitCode !== null), 5_000),
        ),
      ]);
      if (!exited && child.pid !== undefined && process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolvePromise) => killer.once("exit", () => resolvePromise()));
      }
      assertCondition(
        !/error|failed|unauthorized/u.test(stderr.replace(/wrangler/giu, "")),
        "Wrangler tail reported an operator error",
      );
      return parseConcatenatedWranglerTailJson(stdout);
    },
  };
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

function persistPreCleanupEvidence(): string {
  assertCondition(!preCleanupEvidenceWritten, "Pre-cleanup evidence was already persisted");
  const path = writeEvidence("pre-cleanup");
  preCleanupEvidenceWritten = true;
  record("evidence.pre-cleanup.persisted", 200, { path });
  return path;
}

function sanitizedFailureEvidence(error: unknown): Record<string, unknown> {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    code?: unknown;
    retryable?: unknown;
    operation?: unknown;
    elapsedMs?: unknown;
    attempts?: unknown;
    lastObservedOperationState?: unknown;
    operationTimeoutMs?: unknown;
    namedProviderBoundMs?: unknown;
    transportCause?: unknown;
    transportCauseCounts?: unknown;
    successfulObservationCount?: unknown;
  };
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "unknown",
    ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
    ...(typeof candidate.operation === "string" ? { operation: candidate.operation } : {}),
    ...(typeof candidate.elapsedMs === "number" ? { elapsedMs: candidate.elapsedMs } : {}),
    ...(typeof candidate.attempts === "number" ? { attempts: candidate.attempts } : {}),
    ...(typeof candidate.lastObservedOperationState === "string"
      ? { lastObservedOperationState: candidate.lastObservedOperationState }
      : {}),
    ...(typeof candidate.operationTimeoutMs === "number"
      ? { operationTimeoutMs: candidate.operationTimeoutMs }
      : {}),
    ...(typeof candidate.namedProviderBoundMs === "number"
      ? { namedProviderBoundMs: candidate.namedProviderBoundMs }
      : {}),
    ...(typeof candidate.transportCause === "string"
      ? { transportCause: candidate.transportCause }
      : {}),
    ...(typeof candidate.transportCauseCounts === "object" &&
    candidate.transportCauseCounts !== null
      ? { transportCauseCounts: candidate.transportCauseCounts }
      : {}),
    ...(typeof candidate.successfulObservationCount === "number"
      ? { successfulObservationCount: candidate.successfulObservationCount }
      : {}),
    ...(error instanceof ZeroGenerationKitchenError
      ? { code: error.code, evidence: error.evidence }
      : {}),
  };
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
  const accepted = await signedFetch(input);
  assertStatus(`${label}.accepted`, accepted, 409);
  assertCondition(
    safeCode(accepted.body) === "request_in_progress",
    `${label}: queue-backed commit was not durably accepted`,
  );
  const terminal = await waitForCommitTerminal(`${input.path}-diagnostics`, label, 90_000);
  assertCondition(
    terminal.diagnostics.job.state === "succeeded" &&
      terminal.diagnostics.job.attempt >= 2 &&
      terminal.diagnostics.job.events.some((event) => event.event === "driver-adopted"),
    `${label}: queue redelivery did not adopt the killed driver`,
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
    acceptedStatus: 409,
    adoptionStatus: 200,
    attempts: terminal.diagnostics.job.attempt,
    elapsedMs,
  });
  return { result: adopted, elapsedMs };
}

type CommitDiagnostics = ReturnType<typeof artifactCommitDiagnosticsResponseSchema.parse>;

async function readCommitDiagnostics(path: string, label: string): Promise<CommitDiagnostics> {
  const result = await signedControlFetch(
    { path, nonce: `${label}-${crypto.randomUUID()}` },
    label,
  );
  assertStatus(label, result, 200);
  return artifactCommitDiagnosticsResponseSchema.parse(result.body);
}

async function waitForCommitTerminal(
  path: string,
  label: string,
  timeoutMs: number,
): Promise<{ diagnostics: CommitDiagnostics; elapsedMs: number }> {
  const startedAt = performance.now();
  for (;;) {
    const diagnostics = await readCommitDiagnostics(path, `${label}.diagnostics`);
    if (diagnostics.job.state !== "active") {
      return { diagnostics, elapsedMs: Math.round(performance.now() - startedAt) };
    }
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`${label}: artifact commit did not reach a terminal state`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function readRuntimeStartDiagnostics(label: string) {
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/start-diagnostics`,
      method: "GET",
      nonce: `${label}-diagnostics-${crypto.randomUUID()}`,
    },
    `${label}.diagnostics`,
  );
  assertStatus(`${label}.diagnostics`, result, 200);
  return runtimeStartDiagnosticsResponseSchema.parse(result.body);
}

async function waitForRuntimeStartTerminal(label: string, timeoutMs: number) {
  const startedAt = performance.now();
  for (;;) {
    const diagnostics = await readRuntimeStartDiagnostics(label);
    if (diagnostics.job.state !== "active") {
      return { diagnostics, elapsedMs: Math.round(performance.now() - startedAt) };
    }
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`${label}: runtime start did not reach a terminal state`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function readRuntimeManifestRestartDiagnostics(label: string) {
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/manifest-diagnostics`,
      method: "GET",
      nonce: `${label}-diagnostics-${crypto.randomUUID()}`,
    },
    `${label}.diagnostics`,
  );
  assertStatus(`${label}.diagnostics`, result, 200);
  return runtimeManifestRestartDiagnosticsResponseSchema.parse(result.body);
}

async function waitForRuntimeManifestRestartTerminal(label: string, timeoutMs: number) {
  const startedAt = performance.now();
  for (;;) {
    const diagnostics = await readRuntimeManifestRestartDiagnostics(label);
    if (diagnostics.job.state !== "active") {
      return { diagnostics, elapsedMs: Math.round(performance.now() - startedAt) };
    }
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`${label}: runtime manifest restart did not reach a terminal state`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function captureRecentDurableOperationEvidence(label: string): Promise<void> {
  const nowMs = Date.now() + workerClockOffsetMs;
  const since = new Date(nowMs - (24 * 60 * 60_000 - 60_000)).toISOString();
  const discoveryPath = `${CONTROL_PREFIX}/durable-operations?since=${encodeURIComponent(since)}&limit=100`;
  const result = await signedControlFetch(
    {
      path: discoveryPath,
      method: "GET",
      nonce: `${label}-discovery-${crypto.randomUUID()}`,
    },
    `${label}.discovery`,
  );
  assertStatus(`${label}.discovery`, result, 200);
  const discovery = durableOperationDiscoveryResponseSchema.parse(result.body);
  const relevantJobs =
    runtimeIdentity === ""
      ? discovery.jobs
      : discovery.jobs.filter((job) => job.runtimeIdentity === runtimeIdentity);
  record(`${label}.identifiers`, 200, {
    window: discovery.window,
    jobs: relevantJobs,
  });
  for (const job of relevantJobs) {
    const parsed = parseRuntimeIdentity(job.runtimeIdentity);
    const runtimeBase = `${CONTROL_PREFIX}/runtimes/${parsed.projectId}/${parsed.role}/${parsed.slot}`;
    const diagnosticsPath =
      job.kind === "v1"
        ? `${runtimeBase}/artifacts/${job.subjectKey}/commit-diagnostics`
        : job.kind === "layers-v1"
          ? `${runtimeBase}/layered-artifacts/${job.subjectKey}/commit-diagnostics`
          : job.kind === "runtime-start"
            ? `${runtimeBase}/start-diagnostics`
            : `${runtimeBase}/manifest-diagnostics`;
    const diagnostics = await signedControlFetch(
      {
        path: diagnosticsPath,
        method: "GET",
        nonce: `${label}-trail-${crypto.randomUUID()}`,
      },
      `${label}.trail`,
    );
    record(`${label}.trail`, diagnostics.response.status, {
      jobKey: job.jobKey,
      kind: job.kind,
      runtimeIdentity: job.runtimeIdentity,
      subjectKey: job.subjectKey,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      state: job.state,
      checkpoint: job.checkpoint,
      attempt: job.attempt,
      diagnosticsPath,
      diagnostics: diagnostics.body,
    });
  }
}

async function commitStagedV1Artifact(input: {
  artifact: Awaited<ReturnType<typeof sealRuntimeArtifact>>;
  staged: { artifactPath: string; commitPath: string };
  label: string;
}): Promise<void> {
  assertCondition(locator !== null, "Runtime locator is unavailable");
  const sha = input.artifact.envelope.sealedArtifactSha256;
  const key = `${input.label}-commit-${sha}`;
  const accepted = await signedFetch({
    path: input.staged.commitPath,
    method: "POST",
    body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
    nonce: `${input.label}-commit-accept-${crypto.randomUUID()}`,
    idempotencyKey: key,
  });
  assertStatus(`${input.label}.commit.accepted`, accepted, 409);
  const terminal = await waitForCommitTerminal(
    `${input.staged.commitPath}-diagnostics`,
    `${input.label}.commit`,
    ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
  );
  assertCondition(
    terminal.diagnostics.job.state === "succeeded",
    `${input.label}: artifact commit did not succeed`,
  );
  const replay = await signedControlFetch(
    {
      path: input.staged.commitPath,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
      nonce: `${input.label}-commit-terminal-${crypto.randomUUID()}`,
      idempotencyKey: key,
    },
    `${input.label}.commit.terminal`,
  );
  assertStatus(`${input.label}.commit.terminal`, replay, 200);
}

async function stageV1Artifact(input: {
  artifact: Awaited<ReturnType<typeof sealRuntimeArtifact>>;
  label: string;
}): Promise<{ artifactPath: string; commitPath: string }> {
  assertCondition(locator !== null && runtimePath !== "", "Commit proof runtime is unavailable");
  const sha = input.artifact.envelope.sealedArtifactSha256;
  const artifactPath = `${runtimePath}/artifacts/${sha}`;
  const begin = await signedControlFetch(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: input.artifact.envelope,
      },
      nonce: `${input.label}-begin-${crypto.randomUUID()}`,
      idempotencyKey: `${input.label}-begin-${sha}`,
    },
    `${input.label}.begin`,
  );
  assertStatus(`${input.label}.begin`, begin, 200);
  for (let index = 0; index < input.artifact.chunks.length; index += 1) {
    const chunk = await signedControlFetch(
      {
        path: `${artifactPath}/chunks/${index}`,
        method: "PUT",
        body: input.artifact.chunks[index],
        nonce: `${input.label}-chunk-${index}-${crypto.randomUUID()}`,
        idempotencyKey: `${input.label}-chunk-${sha}-${index}`,
      },
      `${input.label}.chunk.${index}`,
    );
    assertStatus(`${input.label}.chunk.${index}`, chunk, 200);
  }
  return { artifactPath, commitPath: `${artifactPath}/commit` };
}

async function removeV1Artifact(artifactPath: string, sha: string, label: string): Promise<void> {
  assertCondition(locator !== null, "Commit proof runtime locator is unavailable");
  const removed = await signedControlFetch(
    {
      path: artifactPath,
      method: "DELETE",
      body: { locator, sealedArtifactSha256: sha },
      nonce: `${label}-remove-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-remove-${sha}`,
    },
    `${label}.remove`,
  );
  assertStatus(`${label}.remove`, removed, 200);
}

async function proveQueueRecoveryAtEveryCheckpoint(manifestRevision: string): Promise<void> {
  assertCondition(locator !== null, "Commit proof runtime locator is unavailable");
  const checkpoints = [
    "initialized",
    "verification-complete",
    "payloads-transferred",
    "unpack-complete",
    "finalized",
  ] as const;
  for (const checkpoint of checkpoints) {
    const artifact = await sealRuntimeArtifact({
      targetRuntimeIdentity: runtimeIdentity,
      manifestRevision,
      artifactRevision: `${ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX}${checkpoint}-${crypto.randomUUID()}`,
      sourceRevision: `queue-recovery-${checkpoint}`,
      files: [
        {
          path: "server.mjs",
          content: `console.log(${JSON.stringify(`queue-recovery-${checkpoint}`)})\n`,
        },
      ],
    });
    const sha = artifact.envelope.sealedArtifactSha256;
    const staged = await stageV1Artifact({ artifact, label: `queue.${checkpoint}` });
    const idempotencyKey = `queue-${checkpoint}-commit-${sha}`;
    const accepted = await signedFetch({
      path: staged.commitPath,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
      nonce: `queue-${checkpoint}-accept-${crypto.randomUUID()}`,
      idempotencyKey,
    });
    assertStatus(`queue.${checkpoint}.accepted`, accepted, 409);
    assertCondition(
      safeCode(accepted.body) === "request_in_progress",
      `queue.${checkpoint}: commit was not durably accepted`,
    );
    const terminal = await waitForCommitTerminal(
      `${staged.commitPath}-diagnostics`,
      `queue.${checkpoint}`,
      90_000,
    );
    assertCondition(
      terminal.diagnostics.job.state === "succeeded" &&
        terminal.diagnostics.job.checkpoint === "finalized" &&
        terminal.diagnostics.job.attempt >= 2,
      `queue.${checkpoint}: killed driver was not adopted to completion`,
    );
    const events = terminal.diagnostics.job.events;
    assertCondition(
      events.filter((event) => event.event === "job-created").length === 1 &&
        events.some((event) => event.event === "driver-adopted"),
      `queue.${checkpoint}: durable event trail did not prove one adopted operation`,
    );
    const replay = await signedControlFetch(
      {
        path: staged.commitPath,
        method: "POST",
        body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
        nonce: `queue-${checkpoint}-terminal-${crypto.randomUUID()}`,
        idempotencyKey,
      },
      `queue.${checkpoint}.terminal`,
    );
    assertStatus(`queue.${checkpoint}.terminal`, replay, 200);
    record(`queue.${checkpoint}.proof`, 200, {
      elapsedMs: terminal.elapsedMs,
      attempts: terminal.diagnostics.job.attempt,
      checkpoint: terminal.diagnostics.job.checkpoint,
      jobCreatedEvents: events.filter((event) => event.event === "job-created").length,
    });
    await removeV1Artifact(staged.artifactPath, sha, `queue.${checkpoint}`);
  }
}

async function withAmbiguousCommitProxy<T>(
  failures: number,
  operation: (controlUrl: string) => Promise<T>,
): Promise<{ result: T; dropped: number; commitKeys: string[] }> {
  let remaining = failures;
  let dropped = 0;
  const commitKeys: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name.toLowerCase() === "host") continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const targetPath = request.url ?? "/";
      const upstream = await fetch(`${CONTROL_URL}${targetPath}`, {
        method: request.method,
        headers,
        body: body.byteLength === 0 ? undefined : body,
      });
      const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
      if (targetPath.endsWith("/commit")) {
        commitKeys.push(headers.get("idempotency-key") ?? "");
        if (remaining > 0) {
          remaining -= 1;
          dropped += 1;
          response.destroy();
          return;
        }
      }
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (
          name === "content-encoding" ||
          name === "content-length" ||
          name === "transfer-encoding"
        ) {
          return;
        }
        response.setHeader(name, value);
      });
      response.setHeader("content-length", upstreamBody.byteLength);
      response.end(upstreamBody);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Commit proxy did not bind");
  try {
    const result = await operation(`http://127.0.0.1:${address.port}`);
    return { result, dropped, commitKeys };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function proveAbortedAndAmbiguousTransport(manifestRevision: string): Promise<void> {
  assertCondition(locator !== null, "Commit proof runtime locator is unavailable");
  const artifact = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision,
    artifactRevision: `queue-transport-${crypto.randomUUID()}`,
    sourceRevision: "queue-transport-live-proof",
    files: [{ path: "server.mjs", content: "console.log('queue-transport-live-proof')\n" }],
  });
  const proof = await withAmbiguousCommitProxy(3, async (controlUrl) => {
    const provider = new CloudflareRuntimeProvider(
      { controlUrl, controlToken, deploymentNamespace: DEPLOYMENT_NAMESPACE },
      { now: () => Date.now() + workerClockOffsetMs },
    );
    return provider.deployArtifact(runtimeIdentity, locator!.projectId, artifact);
  });
  assertCondition(
    proof.result.materialized === true && proof.dropped === 3,
    "Repeated post-dispatch transport failures did not converge to the durable result",
  );
  assertCondition(
    proof.commitKeys.length >= 4 &&
      proof.commitKeys[0] !== "" &&
      new Set(proof.commitKeys).size === 1,
    "Ambiguous transport retry did not preserve one commit idempotency key",
  );
  const sha = artifact.envelope.sealedArtifactSha256;
  const artifactPath = `${runtimePath}/artifacts/${sha}`;
  const diagnostics = await readCommitDiagnostics(
    `${artifactPath}/commit-diagnostics`,
    "queue.transport.diagnostics",
  );
  assertCondition(
    diagnostics.job.state === "succeeded" &&
      diagnostics.job.events.filter((event) => event.event === "job-created").length === 1,
    "Ambiguous transport failures created more than one durable commit operation",
  );
  record("queue.transport.proof", 200, {
    initiatingRequestAbortedAfterDispatch: true,
    repeatedAmbiguousFailures: proof.dropped,
    stableIdempotencyKey: true,
    durableOperations: 1,
  });
  await removeV1Artifact(artifactPath, sha, "queue.transport");
}

async function proveCommitObservationBlackoutRecovery(manifestRevision: string): Promise<void> {
  assertCondition(locator !== null, "Commit blackout runtime locator is unavailable");
  const artifact = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision,
    artifactRevision: `queue-blackout-${crypto.randomUUID()}`,
    sourceRevision: "queue-blackout-live-proof",
    files: [{ path: "server.mjs", content: "console.log('queue-blackout-live-proof')\n" }],
  });
  const sha = artifact.envelope.sealedArtifactSha256;
  const artifactPath = `${runtimePath}/artifacts/${sha}`;
  const commitPath = `${artifactPath}/commit`;
  let blackout = true;
  let dropped = 0;
  let commitInitiationResponsesPassed = 0;
  let preCommitRequests = 0;
  let preCommitResponsesPassed = 0;
  const preCommitStatuses: number[] = [];
  const observedRoutes = new Set<string>();
  const commitKeys: string[] = [];
  const directFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const targetUrl =
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const targetPath = new URL(targetUrl).pathname;
    if (observedRoutes.size < 12) observedRoutes.add(targetPath);
    const isThisArtifactTransfer =
      targetPath === `${artifactPath}/begin` || targetPath.includes(`${artifactPath}/chunks/`);
    if (isThisArtifactTransfer) preCommitRequests += 1;
    if (targetPath !== commitPath) {
      const response = await directFetch(input, init);
      if (isThisArtifactTransfer) {
        preCommitResponsesPassed += 1;
        preCommitStatuses.push(response.status);
      }
      return response;
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    commitKeys.push(headers.get("idempotency-key") ?? "");
    const upstream = await directFetch(input, init);
    if (commitInitiationResponsesPassed === 0) {
      commitInitiationResponsesPassed = 1;
      return upstream;
    }
    if (!blackout) return upstream;
    await upstream.arrayBuffer();
    dropped += 1;
    throw new TypeError("Simulated post-dispatch commit observation blackout");
  };
  const provider = new CloudflareRuntimeProvider(
    {
      controlUrl: CONTROL_URL,
      controlToken,
      deploymentNamespace: DEPLOYMENT_NAMESPACE,
    },
    { now: () => Date.now() + workerClockOffsetMs },
  );
  try {
    let providerSettled = false;
    const providerOutcome = provider
      .deployArtifact(runtimeIdentity, locator.projectId, artifact, {
        operationTimeoutMs: 30_000,
      })
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      )
      .then((outcome) => {
        providerSettled = true;
        return outcome;
      });
    const initiationDeadline = performance.now() + 65_000;
    while (
      commitInitiationResponsesPassed === 0 &&
      !providerSettled &&
      performance.now() < initiationDeadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    record("queue.blackout.scope-progress", 200, {
      preCommitRequests,
      preCommitResponsesPassed,
      preCommitStatuses: [...preCommitStatuses],
      observedRoutes: [...observedRoutes],
      expectedArtifactPath: artifactPath,
      commitInitiationResponsesPassed,
      providerSettledBeforeCommit: providerSettled,
    });
    if (providerSettled && commitInitiationResponsesPassed === 0) {
      const earlyOutcome = await providerOutcome;
      if (earlyOutcome.error !== null) throw earlyOutcome.error;
      throw new Error("Commit blackout provider completed before commit initiation");
    }
    assertCondition(
      commitInitiationResponsesPassed === 1,
      "Commit blackout did not reach one passed initiation response",
    );
    let workerTruth: CommitDiagnostics | null = null;
    const truthDeadline = performance.now() + 25_000;
    for (let observation = 1; performance.now() < truthDeadline; observation += 1) {
      if (commitInitiationResponsesPassed === 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        continue;
      }
      const result = await signedControlFetch(
        {
          path: `${artifactPath}/commit-diagnostics`,
          nonce: `queue-blackout-worker-truth-${observation}-${crypto.randomUUID()}`,
        },
        `queue.blackout.worker-truth.${observation}`,
      );
      record(`queue.blackout.worker-truth.${observation}.status`, result.response.status, {
        code: safeCode(result.body),
      });
      if (result.response.status === 200) {
        workerTruth = artifactCommitDiagnosticsResponseSchema.parse(result.body);
        if (workerTruth.job.state === "succeeded") break;
      } else {
        assertCondition(
          result.response.status === 404,
          "Commit blackout diagnostics returned unexpectedly",
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assertCondition(workerTruth !== null, "Commit blackout durable job was not discoverable");
    assertCondition(
      workerTruth.job.state === "succeeded" &&
        workerTruth.job.events.some((event) => event.event === "driver-succeeded"),
      "Commit blackout durable job did not succeed while observations were blacked out",
    );
    const discoverySince = new Date(
      Date.now() + workerClockOffsetMs - (24 * 60 * 60_000 - 60_000),
    ).toISOString();
    const discovery = await signedControlFetch(
      {
        path: `${CONTROL_PREFIX}/durable-operations?since=${encodeURIComponent(discoverySince)}&limit=100`,
        method: "GET",
        nonce: `queue-blackout-discovery-${crypto.randomUUID()}`,
      },
      "queue.blackout.discovery",
    );
    assertStatus("queue.blackout.discovery", discovery, 200);
    const discovered = durableOperationDiscoveryResponseSchema
      .parse(discovery.body)
      .jobs.find(
        (job) =>
          job.runtimeIdentity === runtimeIdentity && job.kind === "v1" && job.subjectKey === sha,
      );
    assertCondition(
      discovered?.state === "succeeded",
      "Commit blackout discovery did not expose the durable success",
    );
    record("queue.blackout.discovery-proof", 200, {
      jobKey: discovered.jobKey,
      state: discovered.state,
      checkpoint: discovered.checkpoint,
      attempt: discovered.attempt,
    });
    const outcome = await providerOutcome;
    const terminalUnknown = (() => {
      if (outcome.error instanceof CloudflareRuntimeOperationTerminalUnknownError) {
        return outcome.error;
      }
      if (outcome.error !== null) throw outcome.error;
      throw new Error("Commit blackout unexpectedly returned a provider success");
    })();
    record("queue.blackout.terminal-unknown", terminalUnknown.status, {
      code: terminalUnknown.code,
      operation: terminalUnknown.operation,
      retryable: terminalUnknown.retryable,
      attempts: terminalUnknown.attempts,
      successfulObservationCount: terminalUnknown.successfulObservationCount,
      transportCauseCounts: terminalUnknown.transportCauseCounts,
      operationTimeoutMs: terminalUnknown.operationTimeoutMs,
      namedProviderBoundMs: terminalUnknown.namedProviderBoundMs,
      lastObservedOperationState: terminalUnknown.lastObservedOperationState,
      dropped,
      commitRequestsObserved: commitKeys.length,
      commitInitiationResponsesPassed,
      preCommitRequests,
      preCommitResponsesPassed,
      workerStateDuringBlackout: workerTruth.job.state,
    });
    const classifiedTransportAttempts = Object.values(terminalUnknown.transportCauseCounts).reduce(
      (total, count) => total + (count ?? 0),
      0,
    );
    assertCondition(
      terminalUnknown.code === "artifact_commit_terminal_unknown" &&
        terminalUnknown.retryable &&
        terminalUnknown.attempts > 0 &&
        terminalUnknown.lastObservedOperationState.startsWith("transport_") &&
        terminalUnknown.operationTimeoutMs === 30_000 &&
        terminalUnknown.namedProviderBoundMs === ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS &&
        classifiedTransportAttempts > 0 &&
        classifiedTransportAttempts + terminalUnknown.successfulObservationCount ===
          terminalUnknown.attempts,
      "Commit blackout typed evidence was incomplete",
    );
    assertCondition(
      preCommitRequests === preCommitResponsesPassed &&
        preCommitRequests === artifact.chunks.length + 1 &&
        commitInitiationResponsesPassed === 1 &&
        dropped > 0,
      "Commit blackout scope included a pre-commit operation or the initiation response",
    );
    blackout = false;
    const recovered = await provider.deployArtifact(runtimeIdentity, locator.projectId, artifact);
    assertCondition(recovered.materialized, "Late re-observation did not recover durable success");
    assertCondition(
      commitKeys.length > terminalUnknown.attempts &&
        commitKeys[0] !== "" &&
        new Set(commitKeys).size === 1,
      "Commit blackout did not retain one idempotency identity",
    );
    const diagnostics = await readCommitDiagnostics(
      `${artifactPath}/commit-diagnostics`,
      "queue.blackout.diagnostics",
    );
    assertCondition(
      diagnostics.job.state === "succeeded" &&
        diagnostics.job.events.filter((event) => event.event === "job-created").length === 1,
      "Commit blackout created more than one durable operation",
    );
    record("queue.blackout.proof", 200, {
      code: terminalUnknown.code,
      retryable: terminalUnknown.retryable,
      attempts: terminalUnknown.attempts,
      transportCauseCounts: terminalUnknown.transportCauseCounts,
      operationTimeoutMs: terminalUnknown.operationTimeoutMs,
      namedProviderBoundMs: terminalUnknown.namedProviderBoundMs,
      lateReobservationRecovered: true,
      durableOperations: 1,
      dropped,
      commitInitiationResponsesPassed,
      preCommitRequests,
      preCommitResponsesPassed,
      workerSucceededDuringBlackout: true,
    });
    await removeV1Artifact(artifactPath, sha, "queue.blackout");
  } finally {
    globalThis.fetch = directFetch;
  }
}

async function proveAlarmOnlyTerminal(manifestRevision: string): Promise<void> {
  assertCondition(locator !== null, "Commit proof runtime locator is unavailable");
  const artifact = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision,
    artifactRevision: `${ARTIFACT_COMMIT_ABORT_ALWAYS_PREFIX}${crypto.randomUUID()}`,
    sourceRevision: "queue-alarm-terminal-live-proof",
    files: [{ path: "server.mjs", content: "console.log('queue-alarm-terminal')\n" }],
  });
  const sha = artifact.envelope.sealedArtifactSha256;
  const staged = await stageV1Artifact({ artifact, label: "queue.alarm" });
  const idempotencyKey = `queue-alarm-commit-${sha}`;
  const startedAt = performance.now();
  const accepted = await signedFetch({
    path: staged.commitPath,
    method: "POST",
    body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
    nonce: `queue-alarm-accept-${crypto.randomUUID()}`,
    idempotencyKey,
  });
  assertStatus("queue.alarm.accepted", accepted, 409);
  const terminal = await waitForCommitTerminal(
    `${staged.commitPath}-diagnostics`,
    "queue.alarm",
    ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
  );
  assertCondition(
    terminal.diagnostics.job.state === "failed" &&
      terminal.diagnostics.job.terminal?.code === "artifact_commit_abandoned" &&
      terminal.diagnostics.job.events.some((event) => event.event === "deadline-terminal"),
    "Alarm-only abandonment did not persist the typed durable terminal",
  );
  const observedAtMs = Math.round(performance.now() - startedAt);
  assertCondition(
    observedAtMs < ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    "Provider observation bound raced the server terminal",
  );
  const replay = await signedFetch({
    path: staged.commitPath,
    method: "POST",
    body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
    nonce: `queue-alarm-terminal-${crypto.randomUUID()}`,
    idempotencyKey,
  });
  assertStatus("queue.alarm.terminal", replay, 503);
  assertCondition(
    safeCode(replay.body) === "artifact_commit_abandoned",
    "Provider did not observe the durable typed terminal",
  );
  record("queue.alarm.proof", 200, {
    noCommitRetryBeforeTerminal: true,
    terminalCode: "artifact_commit_abandoned",
    observedAtMs,
    providerBoundMs: ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    observationMarginMs: ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS - observedAtMs,
    attempts: terminal.diagnostics.job.attempt,
  });
  await removeV1Artifact(staged.artifactPath, sha, "queue.alarm");
}

function runtimeStartProbeSource(marker: string): string {
  return [
    'import { createServer } from "node:http";',
    `const marker = ${JSON.stringify(marker)};`,
    "const port = Number(process.env.PORT || 8080);",
    "createServer((request, response) => {",
    "  response.statusCode = request.url === '/healthz' ? 200 : 200;",
    "  response.setHeader('content-type', 'application/json');",
    "  response.end(JSON.stringify({ ok: true, marker }));",
    "}).listen(port, '0.0.0.0');",
    "",
  ].join("\n");
}

async function sealRuntimeStartArtifact(
  manifestRevision: string,
  artifactRevision: string,
  label: string,
) {
  return sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision,
    artifactRevision,
    sourceRevision: label,
    files: [{ path: "server.mjs", content: runtimeStartProbeSource(label) }],
  });
}

async function prepareRuntimeStartArtifact(
  manifestRevision: string,
  artifactRevision: string,
  label: string,
) {
  const artifact = await sealRuntimeStartArtifact(manifestRevision, artifactRevision, label);
  const staged = await stageV1Artifact({ artifact, label });
  await commitStagedV1Artifact({ artifact, staged, label });
  return { artifact, staged };
}

function runtimeStartBody(artifact: Awaited<ReturnType<typeof sealRuntimeArtifact>>) {
  assertCondition(locator !== null, "Runtime start locator is unavailable");
  return {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    artifactRevision: artifact.envelope.artifactRevision,
    artifactSha256: artifact.envelope.sealedArtifactSha256,
  };
}

async function proveRuntimeStartRecoveryAtEveryCheckpoint(manifestRevision: string): Promise<void> {
  const checkpoints = [
    "initialized",
    "artifact-verified",
    "materialized",
    "process-started",
    "finalized",
  ] as const;
  for (const checkpoint of checkpoints) {
    const label = `runtime-start.${checkpoint}`;
    const prepared = await prepareRuntimeStartArtifact(
      manifestRevision,
      `${RUNTIME_START_ABORT_CHECKPOINT_PREFIX}${checkpoint}-${crypto.randomUUID()}`,
      label,
    );
    const idempotencyKey = `${label}-${prepared.artifact.envelope.sealedArtifactSha256}`;
    const accepted = await signedFetch({
      path: `${runtimePath}/start`,
      method: "POST",
      body: runtimeStartBody(prepared.artifact),
      nonce: `${label}-accepted-${crypto.randomUUID()}`,
      idempotencyKey,
    });
    assertStatus(`${label}.accepted`, accepted, 409);
    const terminal = await waitForRuntimeStartTerminal(label, 90_000);
    assertCondition(
      terminal.diagnostics.job.state === "succeeded" &&
        terminal.diagnostics.job.checkpoint === "finalized" &&
        terminal.diagnostics.job.attempt >= 2,
      `${label}: killed start driver was not adopted to completion`,
    );
    const events = terminal.diagnostics.job.events;
    assertCondition(
      events.filter((event) => event.event === "job-created").length === 1 &&
        events.some((event) => event.event === "driver-adopted"),
      `${label}: event trail did not prove one adopted operation`,
    );
    const replay = await signedControlFetch(
      {
        path: `${runtimePath}/start`,
        method: "POST",
        body: runtimeStartBody(prepared.artifact),
        nonce: `${label}-terminal-${crypto.randomUUID()}`,
        idempotencyKey,
      },
      `${label}.terminal`,
    );
    assertStatus(`${label}.terminal`, replay, 200);
    record(`${label}.proof`, 200, {
      elapsedMs: terminal.elapsedMs,
      attempts: terminal.diagnostics.job.attempt,
      checkpoint: terminal.diagnostics.job.checkpoint,
      durableOperations: 1,
    });
  }
}

async function withAmbiguousRuntimeStartProxy<T>(
  operation: (controlUrl: string) => Promise<T>,
): Promise<{ result: T; dropped: number; startKeys: string[]; firstDropDelayMs: number }> {
  let remainingDrops = 3;
  let dropped = 0;
  let firstDrop = true;
  const startKeys: string[] = [];
  const firstDropDelayMs = 30_500;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name.toLowerCase() === "host") continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const targetPath = request.url ?? "/";
      const upstream = await fetch(`${CONTROL_URL}${targetPath}`, {
        method: request.method,
        headers,
        body: body.byteLength === 0 ? undefined : body,
      });
      const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
      if (targetPath.endsWith("/start")) {
        startKeys.push(headers.get("idempotency-key") ?? "");
        if (remainingDrops > 0) {
          remainingDrops -= 1;
          dropped += 1;
          if (firstDrop) {
            firstDrop = false;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, firstDropDelayMs));
          }
          response.destroy();
          return;
        }
      }
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (
          name === "content-encoding" ||
          name === "content-length" ||
          name === "transfer-encoding"
        ) {
          return;
        }
        response.setHeader(name, value);
      });
      response.setHeader("content-length", upstreamBody.byteLength);
      response.end(upstreamBody);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Runtime start proxy did not bind");
  }
  try {
    const result = await operation(`http://127.0.0.1:${address.port}`);
    return { result, dropped, startKeys, firstDropDelayMs };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function proveRuntimeStartAbortedAndAmbiguousTransport(
  manifestRevision: string,
): Promise<void> {
  const label = "runtime-start.transport";
  const artifact = await sealRuntimeStartArtifact(
    manifestRevision,
    `runtime-start-transport-${crypto.randomUUID()}`,
    label,
  );
  const proof = await withAmbiguousRuntimeStartProxy(async (controlUrl) => {
    const provider = new CloudflareRuntimeProvider(
      { controlUrl, controlToken, deploymentNamespace: DEPLOYMENT_NAMESPACE },
      { now: () => Date.now() + workerClockOffsetMs },
    );
    await provider.deployArtifact(runtimeIdentity, locator!.projectId, artifact);
    return provider.start(runtimeIdentity, locator!.projectId);
  });
  assertCondition(proof.result === true && proof.dropped === 3, "Runtime start did not converge");
  assertCondition(
    proof.startKeys.length >= 4 && proof.startKeys[0] !== "" && new Set(proof.startKeys).size === 1,
    "Runtime start did not retain one idempotency key across ambiguous transports",
  );
  const diagnostics = await readRuntimeStartDiagnostics(label);
  assertCondition(
    diagnostics.job.state === "succeeded" &&
      diagnostics.job.events.filter((event) => event.event === "job-created").length === 1,
    "Ambiguous runtime start transport created more than one durable operation",
  );
  record(`${label}.proof`, 200, {
    initiatingRequestAbortedAtTransportWindow: true,
    firstDropDelayMs: proof.firstDropDelayMs,
    repeatedAmbiguousFailures: proof.dropped,
    stableIdempotencyKey: true,
    durableOperations: 1,
  });
}

async function proveRuntimeStartAlarmOnlyTerminal(manifestRevision: string): Promise<void> {
  const label = "runtime-start.alarm";
  const prepared = await prepareRuntimeStartArtifact(
    manifestRevision,
    `${RUNTIME_START_ABORT_ALWAYS_PREFIX}${crypto.randomUUID()}`,
    label,
  );
  const idempotencyKey = `${label}-${prepared.artifact.envelope.sealedArtifactSha256}`;
  const startedAt = performance.now();
  const accepted = await signedFetch({
    path: `${runtimePath}/start`,
    method: "POST",
    body: runtimeStartBody(prepared.artifact),
    nonce: `${label}-accepted-${crypto.randomUUID()}`,
    idempotencyKey,
  });
  assertStatus(`${label}.accepted`, accepted, 409);
  const terminal = await waitForRuntimeStartTerminal(
    label,
    ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
  );
  const observedAtMs = Math.round(performance.now() - startedAt);
  assertCondition(
    terminal.diagnostics.job.state === "failed" &&
      terminal.diagnostics.job.terminal?.code === "runtime_start_timeout" &&
      terminal.diagnostics.job.events.some((event) => event.event === "deadline-terminal"),
    "Alarm-only runtime start did not persist the typed terminal",
  );
  assertCondition(
    observedAtMs < ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    "Runtime start terminal raced the provider observation boundary",
  );
  const replay = await signedFetch({
    path: `${runtimePath}/start`,
    method: "POST",
    body: runtimeStartBody(prepared.artifact),
    nonce: `${label}-terminal-${crypto.randomUUID()}`,
    idempotencyKey,
  });
  assertStatus(`${label}.terminal`, replay, 504);
  assertCondition(
    safeCode(replay.body) === "runtime_start_timeout",
    "Typed start terminal missing",
  );
  record(`${label}.proof`, 200, {
    noRetryBeforeTerminal: true,
    terminalCode: "runtime_start_timeout",
    observedAtMs,
    providerBoundMs: ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    observationMarginMs: ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS - observedAtMs,
    attempts: terminal.diagnostics.job.attempt,
  });
}

function runtimeManifestRestartBody(
  expectedManifestRevision: string,
  manifestRevision: string,
  artifact: Awaited<ReturnType<typeof sealRuntimeArtifact>>,
) {
  assertCondition(locator !== null, "Runtime manifest restart locator is unavailable");
  return {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    expectedManifestRevision,
    manifest: {
      revision: manifestRevision,
      runtime: "node-api",
      buildCommand: ["node", "build.mjs"],
      startCommand: ["node", "server.mjs"],
      servicePort: 8080,
      healthPath: "/healthz",
      resourceProfile: "dev" as const,
      public: false,
    },
    restart: "restart" as const,
    sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
  };
}

async function proveRuntimeManifestRestartRecoveryAtEveryCheckpoint(
  initialManifestRevision: string,
): Promise<string> {
  const checkpoints = [
    "initialized",
    "runtime-unbound",
    "manifest-persisted",
    "materialized",
    "process-started",
    "finalized",
  ] as const;
  let currentManifestRevision = initialManifestRevision;
  for (const checkpoint of checkpoints) {
    const label = `runtime-manifest-restart.${checkpoint}`;
    const nextManifestRevision = `${RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX}${checkpoint}-${crypto.randomUUID()}`;
    const artifact = await sealRuntimeStartArtifact(
      nextManifestRevision,
      `runtime-manifest-restart-artifact-${crypto.randomUUID()}`,
      label,
    );
    const staged = await stageV1Artifact({ artifact, label });
    await commitStagedV1Artifact({ artifact, staged, label });
    const body = runtimeManifestRestartBody(
      currentManifestRevision,
      nextManifestRevision,
      artifact,
    );
    const idempotencyKey = `${label}-${artifact.envelope.sealedArtifactSha256}`;
    const accepted = await signedFetch({
      path: `${runtimePath}/manifest`,
      method: "PUT",
      body,
      nonce: `${label}-accepted-${crypto.randomUUID()}`,
      idempotencyKey,
    });
    assertStatus(`${label}.accepted`, accepted, 409);
    const terminal = await waitForRuntimeManifestRestartTerminal(label, 90_000);
    assertCondition(
      terminal.diagnostics.job.state === "succeeded" &&
        terminal.diagnostics.job.checkpoint === "finalized" &&
        terminal.diagnostics.job.attempt >= 2,
      `${label}: killed manifest restart driver was not adopted to completion`,
    );
    assertCondition(
      terminal.diagnostics.job.events.filter((event) => event.event === "job-created").length ===
        1 && terminal.diagnostics.job.events.some((event) => event.event === "driver-adopted"),
      `${label}: event trail did not prove one adopted operation`,
    );
    const replay = await signedControlFetch(
      {
        path: `${runtimePath}/manifest`,
        method: "PUT",
        body,
        nonce: `${label}-terminal-${crypto.randomUUID()}`,
        idempotencyKey,
      },
      `${label}.terminal`,
    );
    assertStatus(`${label}.terminal`, replay, 200);
    record(`${label}.proof`, 200, {
      elapsedMs: terminal.elapsedMs,
      attempts: terminal.diagnostics.job.attempt,
      checkpoint: terminal.diagnostics.job.checkpoint,
      durableOperations: 1,
    });
    currentManifestRevision = nextManifestRevision;
  }
  return currentManifestRevision;
}

async function withAmbiguousRuntimeManifestProxy<T>(
  operation: (controlUrl: string) => Promise<T>,
): Promise<{ result: T; dropped: number; manifestKeys: string[]; firstDropDelayMs: number }> {
  let remainingDrops = 3;
  let dropped = 0;
  let firstDrop = true;
  const manifestKeys: string[] = [];
  const firstDropDelayMs = 30_500;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name.toLowerCase() === "host") continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const targetPath = request.url ?? "/";
      const upstream = await fetch(`${CONTROL_URL}${targetPath}`, {
        method: request.method,
        headers,
        body: body.byteLength === 0 ? undefined : body,
      });
      const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
      if (targetPath.endsWith("/manifest")) {
        manifestKeys.push(headers.get("idempotency-key") ?? "");
        if (remainingDrops > 0) {
          remainingDrops -= 1;
          dropped += 1;
          if (firstDrop) {
            firstDrop = false;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, firstDropDelayMs));
          }
          response.destroy();
          return;
        }
      }
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (
          name === "content-encoding" ||
          name === "content-length" ||
          name === "transfer-encoding"
        )
          return;
        response.setHeader(name, value);
      });
      response.setHeader("content-length", upstreamBody.byteLength);
      response.end(upstreamBody);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Runtime manifest proxy did not bind");
  }
  try {
    const result = await operation(`http://127.0.0.1:${address.port}`);
    return { result, dropped, manifestKeys, firstDropDelayMs };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function proveRuntimeManifestRestartAbortedAndAmbiguousTransport(
  currentManifestRevision: string,
): Promise<string> {
  const label = "runtime-manifest-restart.transport";
  const nextManifestRevision = `runtime-manifest-transport-${crypto.randomUUID()}`;
  const artifact = await sealRuntimeStartArtifact(
    nextManifestRevision,
    `runtime-manifest-transport-artifact-${crypto.randomUUID()}`,
    label,
  );
  const proof = await withAmbiguousRuntimeManifestProxy(async (controlUrl) => {
    const provider = new CloudflareRuntimeProvider(
      { controlUrl, controlToken, deploymentNamespace: DEPLOYMENT_NAMESPACE },
      { now: () => Date.now() + workerClockOffsetMs },
    );
    await provider.deployArtifact(runtimeIdentity, locator!.projectId, artifact);
    return provider.updateRuntimeManifest(runtimeIdentity, locator!.projectId, {
      expectedManifestRevision: currentManifestRevision,
      manifest: runtimeManifestRestartBody(currentManifestRevision, nextManifestRevision, artifact)
        .manifest,
      restart: "restart",
      sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
    });
  });
  assertCondition(proof.dropped === 3, "Runtime manifest restart did not converge");
  assertCondition(
    proof.manifestKeys.length >= 4 &&
      proof.manifestKeys[0] !== "" &&
      new Set(proof.manifestKeys).size === 1,
    "Runtime manifest restart did not retain one idempotency key across transports",
  );
  const diagnostics = await readRuntimeManifestRestartDiagnostics(label);
  assertCondition(
    diagnostics.job.state === "succeeded" &&
      diagnostics.job.events.filter((event) => event.event === "job-created").length === 1,
    "Ambiguous manifest restart transport created more than one durable operation",
  );
  record(`${label}.proof`, 200, {
    initiatingRequestAbortedAtTransportWindow: true,
    firstDropDelayMs: proof.firstDropDelayMs,
    repeatedAmbiguousFailures: proof.dropped,
    stableIdempotencyKey: true,
    durableOperations: 1,
  });
  return nextManifestRevision;
}

async function proveRuntimeManifestRestartAlarmOnlyTerminal(
  currentManifestRevision: string,
): Promise<void> {
  const label = "runtime-manifest-restart.alarm";
  const nextManifestRevision = `${RUNTIME_MANIFEST_RESTART_ABORT_ALWAYS_PREFIX}${crypto.randomUUID()}`;
  const artifact = await sealRuntimeStartArtifact(
    nextManifestRevision,
    `runtime-manifest-alarm-artifact-${crypto.randomUUID()}`,
    label,
  );
  const staged = await stageV1Artifact({ artifact, label });
  await commitStagedV1Artifact({ artifact, staged, label });
  const body = runtimeManifestRestartBody(currentManifestRevision, nextManifestRevision, artifact);
  const idempotencyKey = `${label}-${artifact.envelope.sealedArtifactSha256}`;
  const startedAt = performance.now();
  const accepted = await signedFetch({
    path: `${runtimePath}/manifest`,
    method: "PUT",
    body,
    nonce: `${label}-accepted-${crypto.randomUUID()}`,
    idempotencyKey,
  });
  assertStatus(`${label}.accepted`, accepted, 409);
  const terminal = await waitForRuntimeManifestRestartTerminal(
    label,
    ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
  );
  const observedAtMs = Math.round(performance.now() - startedAt);
  assertCondition(
    terminal.diagnostics.job.state === "failed" &&
      terminal.diagnostics.job.terminal?.code === "runtime_manifest_update_timeout" &&
      terminal.diagnostics.job.events.some((event) => event.event === "deadline-terminal"),
    "Alarm-only runtime manifest restart did not persist the typed terminal",
  );
  assertCondition(
    observedAtMs < ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    "Manifest restart provider observation bound raced the server terminal",
  );
  const replay = await signedControlFetch(
    {
      path: `${runtimePath}/manifest`,
      method: "PUT",
      body,
      nonce: `${label}-terminal-${crypto.randomUUID()}`,
      idempotencyKey,
    },
    `${label}.terminal`,
  );
  assertStatus(`${label}.terminal`, replay, 504);
  assertCondition(
    safeCode(replay.body) === "runtime_manifest_update_timeout",
    "Provider did not observe the durable manifest restart terminal",
  );
  record(`${label}.proof`, 200, {
    noRetryBeforeTerminal: true,
    terminalCode: "runtime_manifest_update_timeout",
    observedAtMs,
    providerBoundMs: ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    observationMarginMs: ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS - observedAtMs,
    attempts: terminal.diagnostics.job.attempt,
  });
}

async function runArtifactCommitLivenessAcceptance(): Promise<void> {
  locator = {
    projectId: 850_000_000 + randomBytes(3).readUIntBE(0, 3),
    role: "preview",
    slot: "primary",
  };
  runtimeIdentity = await deriveRuntimeIdentity({ namespace: DEPLOYMENT_NAMESPACE, ...locator });
  runtimePath = `${CONTROL_PREFIX}/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
  const manifestRevision = `commit-liveness-${crypto.randomUUID()}`;
  const ensured = await signedControlFetch(
    {
      path: runtimePath,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        manifest: {
          revision: manifestRevision,
          runtime: "node-api",
          buildCommand: ["node", "build.mjs"],
          startCommand: ["node", "server.mjs"],
          servicePort: 8080,
          healthPath: "/healthz",
          resourceProfile: "dev",
          public: false,
        },
      },
      nonce: `queue-runtime-ensure-${crypto.randomUUID()}`,
      idempotencyKey: `queue-runtime-ensure-${runtimeIdentity}`,
    },
    "queue.runtime.ensure",
  );
  assertStatus("queue.runtime.ensure", ensured, 200);
  if (process.env.NABUFLOW_COMMIT_BLACKOUT_ONLY === "1") {
    await proveCommitObservationBlackoutRecovery(manifestRevision);
    return;
  }
  await proveQueueRecoveryAtEveryCheckpoint(manifestRevision);
  await proveAbortedAndAmbiguousTransport(manifestRevision);
  await proveCommitObservationBlackoutRecovery(manifestRevision);
  await proveAlarmOnlyTerminal(manifestRevision);
  await proveRuntimeStartRecoveryAtEveryCheckpoint(manifestRevision);
  await proveRuntimeStartAbortedAndAmbiguousTransport(manifestRevision);
  await proveRuntimeStartAlarmOnlyTerminal(manifestRevision);
  let currentManifestRevision =
    await proveRuntimeManifestRestartRecoveryAtEveryCheckpoint(manifestRevision);
  currentManifestRevision =
    await proveRuntimeManifestRestartAbortedAndAmbiguousTransport(currentManifestRevision);
  await proveRuntimeManifestRestartAlarmOnlyTerminal(currentManifestRevision);
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
  let totalSurfaceProbes = 0;
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
    totalSurfaceProbes < GATE_MAX_REQUESTS &&
    performance.now() - started < GATE_MAX_MS
  ) {
    if (surfaces.controlHmac.consecutive < GATE_REQUIRED) {
      const result = await signedFetch({
        path: `${CONTROL_PREFIX}/version`,
        nonce: `gate-${crypto.randomUUID()}`,
      });
      totalRequests += 1;
      totalSurfaceProbes += 1;
      update("controlHmac", result.response.status === 200, result.response.status, result.body);
      if (result.response.status === 200) {
        deploymentVersion = (result.body as { deploymentVersion?: string }).deploymentVersion ?? "";
      }
    }
    if (surfaces.previewGrant.consecutive < GATE_REQUIRED) {
      const result = await probePreviewGrant(false, surfaces.previewGrant.probes + 1);
      totalRequests += result.requests;
      totalSurfaceProbes += 1;
      update("previewGrant", result.green, result.status, result.body);
    }
    if (surfaces.vaultKek.consecutive < GATE_REQUIRED) {
      const result = await probeVault(surfaces.vaultKek.probes + 1);
      totalRequests += 2;
      totalSurfaceProbes += 1;
      update("vaultKek", result.response.status === 200, result.response.status, result.body);
    }
    if (surfaces.previewReplayPair.consecutive < GATE_REQUIRED) {
      const result = await probePreviewGrant(true, surfaces.previewReplayPair.probes + 1);
      totalRequests += result.requests;
      totalSurfaceProbes += 1;
      update("previewReplayPair", result.green, result.status, result.body);
    }
    if (!complete()) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  assertCondition(complete(), `Four-surface gate did not converge: ${JSON.stringify(surfaces)}`);
  assertCondition(deploymentVersion.length > 0, "Active runtime version was not observed");
  record("gate.complete", 200, {
    elapsedMs: performance.now() - started,
    totalSurfaceProbes,
    totalRequests,
    surfaces,
  });
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

async function trackPantryAssembly(intents: readonly PantryPackageIntent[]): Promise<string> {
  const requestSha256 = await pantryCatalogStockRequestHash({
    intents: [...intents],
    platform: ZERO_SEALED_BUILD_PLATFORM,
  });
  const assemblyId = `passembly_${requestSha256}`;
  observedPantryAssemblyIds.add(assemblyId);
  return assemblyId;
}

async function captureObservedPantryAssemblyTrails(): Promise<void> {
  for (const assemblyId of [...observedPantryAssemblyIds].sort()) {
    try {
      const result = await pantryCall(
        `/assemblies/${assemblyId}/diagnostics`,
        "GET",
        undefined,
        `evidence.pantry-assembly.${assemblyId.slice(-12)}`,
      );
      record("evidence.pantry-assembly-diagnostics", result.response.status, {
        assemblyId,
        diagnostics: result.body,
      });
      const resources = await pantryCall(
        `/assemblies/${assemblyId}/resource-evidence`,
        "GET",
        undefined,
        `evidence.pantry-resources.${assemblyId.slice(-12)}`,
      );
      record("evidence.pantry-generation-resources", resources.response.status, {
        assemblyId,
        resources: resources.body,
      });
    } catch (error) {
      record("evidence.pantry-assembly-diagnostics", "capture-error", {
        assemblyId,
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

async function runPantryR2FocusedProbe(): Promise<void> {
  const cleanupProbeIds = (process.env.NABUFLOW_PANTRY_R2_PROBE_CLEANUP_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^r2probe_[A-Za-z0-9_-]{8,64}$/u.test(value));
  if (cleanupProbeIds.length > 0) {
    for (let pass = 1; pass <= 3; pass += 1) {
      for (const probeId of cleanupProbeIds) {
        const cleanup = await pantryCall(
          "/diagnostics/r2-probe",
          "POST",
          { profile: "heavy-stage-object", mode: "cleanup", probeId },
          `probe.pantry-r2-realistic.targeted-cleanup.${pass}`,
        );
        assertStatus("probe.pantry-r2-realistic.targeted-cleanup", cleanup, 200);
        record("probe.pantry-r2-realistic.targeted-cleanup", 200, {
          pass,
          probeId,
          result: cleanup.body,
        });
      }
      if (pass < 3) await new Promise((resolvePromise) => setTimeout(resolvePromise, 30_000));
    }
    return;
  }
  const cases = [
    ...[50, 100, 200, 400, 600, 800, 900].map((operations) => ({
      operations,
      concurrency: 1,
    })),
    ...[2, 4, 8, 16].map((concurrency) => ({ operations: 400, concurrency })),
  ];
  if (process.env.NABUFLOW_PANTRY_R2_REALISTIC_ONLY !== "1") {
    for (const probe of cases) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        const result = await pantryCall(
          "/diagnostics/r2-probe",
          "POST",
          probe,
          `probe.pantry-r2.${probe.operations}.${probe.concurrency}.${repetition}`,
        );
        assertStatus("probe.pantry-r2", result, 200);
        record("probe.pantry-r2", 200, {
          repetition,
          ...probe,
          result: result.body,
        });
      }
    }
  }

  const realisticProfiles = [
    { label: "serial", concurrency: 1, idleBetweenBatchesMs: 250, cpuHashRounds: 2 },
    { label: "parallel-4", concurrency: 4, idleBetweenBatchesMs: 1_000, cpuHashRounds: 2 },
  ] as const;
  for (const profile of realisticProfiles) {
    const probeId = `r2probe_${evidenceRunId.replaceAll("-", "").slice(0, 24)}_${profile.label.replaceAll("-", "")}`;
    try {
      for (let window = 1; window <= 3; window += 1) {
        const result = await pantryCall(
          "/diagnostics/r2-probe",
          "POST",
          {
            profile: "heavy-stage-object",
            mode: "run",
            probeId,
            window,
            concurrency: profile.concurrency,
            idleBetweenBatchesMs: profile.idleBetweenBatchesMs,
            cpuHashRounds: profile.cpuHashRounds,
          },
          `probe.pantry-r2-realistic.${profile.label}.${window}`,
        );
        assertStatus("probe.pantry-r2-realistic", result, 200);
        record("probe.pantry-r2-realistic", 200, {
          profile: profile.label,
          window,
          result: result.body,
        });
        if (window < 3) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 60_000));
        }
      }
    } finally {
      const cleanup = await pantryCall(
        "/diagnostics/r2-probe",
        "POST",
        { profile: "heavy-stage-object", mode: "cleanup", probeId },
        `probe.pantry-r2-realistic.${profile.label}.cleanup`,
      );
      assertStatus("probe.pantry-r2-realistic.cleanup", cleanup, 200);
      record("probe.pantry-r2-realistic.cleanup", 200, {
        profile: profile.label,
        result: cleanup.body,
      });
    }
  }
}

async function capturePantryObjectInventory(label: string): Promise<unknown | null> {
  try {
    const result = await pantryCall(
      "/diagnostics/objects",
      "GET",
      undefined,
      `evidence.pantry-object-inventory.${label}`,
    );
    record("evidence.pantry-object-inventory", result.response.status, {
      label,
      inventory: result.body,
    });
    return result.body;
  } catch (error) {
    record("evidence.pantry-object-inventory", "capture-error", {
      label,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

async function reclaimCapturedPantryOrphans(inventory: unknown): Promise<void> {
  const objects =
    typeof inventory === "object" && inventory !== null && "objects" in inventory
      ? (inventory as { objects?: unknown }).objects
      : null;
  assertCondition(Array.isArray(objects), "Captured Pantry inventory is invalid");
  const objectSha256 = objects
    .map((object) =>
      typeof object === "object" &&
      object !== null &&
      typeof (object as { key?: unknown }).key === "string"
        ? /^cas\/sha256\/([0-9a-f]{64})$/u.exec((object as { key: string }).key)?.[1]
        : undefined,
    )
    .filter((sha256): sha256 is string => sha256 !== undefined)
    .sort();
  if (objectSha256.length === 0) return;
  const result = await pantryCall(
    "/gc",
    "POST",
    {
      scope: "targeted-orphan-cas",
      now: new Date(Date.now() + workerClockOffsetMs).toISOString(),
      maxDeletes: 1_000,
      objectSha256,
    },
    "cleanup.pantry-targeted-orphan-cas",
  );
  assertStatus("cleanup.pantry-targeted-orphan-cas", result, 200);
  const deleted = (result.body as { deletedObjectSha256?: unknown }).deletedObjectSha256;
  assertCondition(
    Array.isArray(deleted) && deleted.length === objectSha256.length,
    "Targeted Pantry orphan reclamation did not delete the captured CAS set",
  );
  record("cleanup.pantry-targeted-orphan-cas", 200, {
    candidates: objectSha256.length,
    deleted: deleted.length,
  });
  const after = await capturePantryObjectInventory("post-targeted-reclamation");
  const remaining =
    typeof after === "object" && after !== null && "objects" in after
      ? (after as { objects?: unknown[] }).objects?.length
      : undefined;
  assertCondition(remaining === 0, "Pantry R2 did not reach zero after targeted reclamation");
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

async function runTailSensitiveVendorLifecycle(): Promise<void> {
  locator = {
    projectId: 870_000_000 + randomBytes(3).readUIntBE(0, 3),
    role: "preview",
    slot: "primary",
  };
  runtimeIdentity = await deriveRuntimeIdentity({ namespace: DEPLOYMENT_NAMESPACE, ...locator });
  runtimePath = `${CONTROL_PREFIX}/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
  const manifestRevision = `tail-sensitive-${crypto.randomUUID()}`;
  const tail = await startAcceptanceErrorTail();
  let stoppedState: VendorAlarmConsequenceProof["stoppedState"] | null = null;
  let destroyStatus: number | null = null;
  let postDestroyStatus: number | null = null;
  let buildState: { r2?: { objects?: number; bytes?: number }; activeCells?: number } | undefined;
  let pantryState:
    | { r2?: { objects?: number; bytes?: number; quarantineObjects?: number } }
    | undefined;
  let events: ReturnType<typeof parseConcatenatedWranglerTailJson>;
  try {
    const ensured = await signedControlFetch(
      {
        path: runtimePath,
        method: "PUT",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          manifest: {
            revision: manifestRevision,
            runtime: "node-api",
            buildCommand: ["node", "build.mjs"],
            startCommand: ["node", "server.mjs"],
            servicePort: 8080,
            healthPath: "/healthz",
            resourceProfile: "dev",
            public: false,
          },
        },
        nonce: `tail-sensitive-ensure-${crypto.randomUUID()}`,
        idempotencyKey: `tail-sensitive-ensure-${runtimeIdentity}`,
      },
      "tail-sensitive.runtime.ensure",
    );
    assertStatus("tail-sensitive.runtime.ensure", ensured, 200);
    const prepared = await prepareRuntimeStartArtifact(
      manifestRevision,
      `tail-sensitive-artifact-${crypto.randomUUID()}`,
      "tail-sensitive",
    );

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const started = await signedControlFetch(
        {
          path: `${runtimePath}/start`,
          method: "POST",
          body: runtimeStartBody(prepared.artifact),
          nonce: `tail-sensitive-start-${cycle}-${crypto.randomUUID()}`,
          idempotencyKey: `tail-sensitive-start-${cycle}-${prepared.artifact.envelope.sealedArtifactSha256}`,
        },
        `tail-sensitive.runtime.start.${cycle}`,
      );
      assertStatus(`tail-sensitive.runtime.start.${cycle}`, started, 200);
      const running = await signedControlFetch(
        { path: runtimePath, nonce: `tail-sensitive-running-${cycle}-${crypto.randomUUID()}` },
        `tail-sensitive.runtime.running.${cycle}`,
      );
      assertStatus(`tail-sensitive.runtime.running.${cycle}`, running, 200);
      assertCondition(
        (running.body as { runtime?: { status?: string } }).runtime?.status === "running",
        "Tail-sensitive runtime was not running",
      );
      const stopped = await signedControlFetch(
        {
          path: `${runtimePath}/stop`,
          method: "POST",
          body: { locator, reason: `tail-sensitive-cycle-${cycle}` },
          nonce: `tail-sensitive-stop-${cycle}-${crypto.randomUUID()}`,
          idempotencyKey: `tail-sensitive-stop-${cycle}-${crypto.randomUUID()}`,
        },
        `tail-sensitive.runtime.stop.${cycle}`,
      );
      assertStatus(`tail-sensitive.runtime.stop.${cycle}`, stopped, 200);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, ACCEPTANCE_TAIL_SETTLE_MS));
      const status = await signedControlFetch(
        { path: runtimePath, nonce: `tail-sensitive-stopped-${cycle}-${crypto.randomUUID()}` },
        `tail-sensitive.runtime.stopped.${cycle}`,
      );
      assertStatus(`tail-sensitive.runtime.stopped.${cycle}`, status, 200);
      const runtime = (status.body as { runtime?: VendorAlarmConsequenceProof["stoppedState"] })
        .runtime;
      assertCondition(runtime !== undefined, "Tail-sensitive stopped descriptor is missing");
      stoppedState = runtime;
      assertCondition(
        stoppedState.status === "stopped" &&
          stoppedState.endpoint === null &&
          stoppedState.readyAt === null &&
          stoppedState.lastError === null,
        "Tail-sensitive stopped state is inconsistent",
      );
      record(`tail-sensitive.runtime.stopped-state.${cycle}`, 200, stoppedState);
    }

    const destroyed = await signedControlFetch(
      {
        path: runtimePath,
        method: "DELETE",
        body: { locator, reason: "tail-sensitive-consequence-proof" },
        nonce: `tail-sensitive-destroy-${crypto.randomUUID()}`,
        idempotencyKey: `tail-sensitive-destroy-${crypto.randomUUID()}`,
      },
      "tail-sensitive.runtime.destroy",
    );
    destroyStatus = destroyed.response.status;
    assertStatus("tail-sensitive.runtime.destroy", destroyed, 200);
    const absent = await signedControlFetch(
      { path: runtimePath, nonce: `tail-sensitive-absent-${crypto.randomUUID()}` },
      "tail-sensitive.runtime.absent",
    );
    postDestroyStatus = absent.response.status;
    assertStatus("tail-sensitive.runtime.absent", absent, 404);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));

    const buildDiagnostics = await buildCall(
      "/diagnostics",
      "GET",
      undefined,
      "tail-sensitive.build-diagnostics",
    );
    assertStatus("tail-sensitive.build-diagnostics", buildDiagnostics, 200);
    buildState = buildDiagnostics.body as typeof buildState;
    const pantryDiagnostics = await pantryCall(
      "/diagnostics",
      "GET",
      undefined,
      "tail-sensitive.pantry-diagnostics",
    );
    assertStatus("tail-sensitive.pantry-diagnostics", pantryDiagnostics, 200);
    pantryState = pantryDiagnostics.body as typeof pantryState;
    assertCondition(
      buildState?.activeCells === 0 &&
        buildState.r2?.objects === 0 &&
        buildState.r2.bytes === 0 &&
        pantryState?.r2?.objects === 0 &&
        pantryState.r2.bytes === 0,
      "Tail-sensitive lifecycle did not reach zero active/storage state",
    );
  } finally {
    events = await tail.stop();
  }

  assertCondition(
    stoppedState !== null && destroyStatus !== null && postDestroyStatus !== null,
    "Tail-sensitive consequence proof is incomplete",
  );
  const consequenceProofs = events.filter(isKnownVendorAlarmTailEvent).map((event) => ({
    occurrenceKey: knownVendorAlarmOccurrenceKey(event),
    stoppedState,
    destroyStatus,
    postDestroyStatus,
    activeRuntimeCount: 0,
    storage: {
      buildObjects: buildState?.r2?.objects,
      buildBytes: buildState?.r2?.bytes,
      pantryObjects: pantryState?.r2?.objects,
      pantryBytes: pantryState?.r2?.bytes,
    },
    cost: { accruing: false },
  }));
  const evaluation = evaluateAcceptanceTail({ events, consequenceProofs });
  record("tail.acceptance-window.evaluated", 200, {
    startedAt: tail.startedAt,
    inspectedExceptionEvents: evaluation.inspectedExceptionEvents,
    unclassifiedExceptions: 0,
    occurrenceBudget: 2,
    knownVendorAlarmOccurrences: evaluation.knownVendorAlarmEvents.map((event) => ({
      type: event.type,
      occurrenceKey: event.occurrenceKey,
      durableObjectId: event.durableObjectId,
      eventTimestamp: event.eventTimestamp,
      scheduledTime: event.scheduledTime,
      reference: event.reference,
      consequenceChecklist: event.consequence,
    })),
    propagationEvents: evaluation.deploymentResetEvents,
  });
  runtimeIdentity = "";
  runtimePath = "";
  locator = null;
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
  if (
    process.env.NABUFLOW_ZERO_CLEANUP === "1" ||
    process.env.NABUFLOW_ZERO_GENERATOR_ONLY === "1"
  ) {
    const identity = { intents: ZERO_GENERATOR_INTENTS, platform: PLATFORM };
    const identitySha256 = await pantryCatalogStockRequestHash(identity);
    const beforeLookup = await pantryCall(
      "/diagnostics",
      "GET",
      undefined,
      "cleanup.zero-readonly-before",
    );
    assertStatus("cleanup.zero-readonly-before", beforeLookup, 200);
    const lookup = await pantryCall(
      `/stock-identities/${identitySha256}`,
      "GET",
      undefined,
      "cleanup.zero-stock-readonly",
    );
    assertCondition(
      lookup.response.status === 200 || lookup.response.status === 404,
      `cleanup.zero-stock-readonly: expected 200/404, got ${lookup.response.status}`,
    );
    record("cleanup.zero-stock-readonly", lookup.response.status, {
      code: safeCode(lookup.body),
    });
    const root = (lookup.body as { revisionRootSha256?: string | null }).revisionRootSha256;
    if (typeof root === "string" && !createdShelfRoots.includes(root)) {
      createdShelfRoots.push(root);
    }
    const afterLookup = await pantryCall(
      "/diagnostics",
      "GET",
      undefined,
      "cleanup.zero-readonly-after",
    );
    assertStatus("cleanup.zero-readonly-after", afterLookup, 200);
    const beforeLedger = (beforeLookup.body as { ledger?: Record<string, number> }).ledger;
    const afterLedger = (afterLookup.body as { ledger?: Record<string, number> }).ledger;
    assertCondition(
      canonicalPantryJson(beforeLedger) === canonicalPantryJson(afterLedger),
      "Read-only cleanup discovery changed Pantry operation counts",
    );
    record("cleanup.zero-readonly-side-effect-free", 200, {
      unchanged: true,
      assemblies: afterLedger?.assemblies ?? null,
      shelves: afterLedger?.shelves ?? null,
      queueDeliveries: afterLedger?.queueDeliveries ?? null,
    });
  }
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
  // A stock request can fail before a shelf root is assigned. Advance the
  // staging-only test clock and collect those incomplete assemblies as well.
  for (let pass = 0; pass < 10; pass += 1) {
    const gc = await pantryCall(
      "/gc",
      "POST",
      {
        scope: "expired-uncommitted",
        now: new Date(Date.now() + workerClockOffsetMs + 366 * 24 * 60 * 60_000).toISOString(),
        maxDeletes: 1_000,
        retentionNamespace: "pantry-ingest",
      },
      `cleanup.pantry-uncommitted-gc.${pass}`,
    );
    assertStatus(`cleanup.pantry-uncommitted-gc.${pass}`, gc, 200);
    const deleted = (gc.body as { deletedAssemblyIds?: string[] }).deletedAssemblyIds ?? [];
    if (deleted.length === 0) break;
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
  if (process.env.NABUFLOW_ZERO_CLEANUP === "1") {
    const state = pantryDiagnostics.body as {
      ledger?: { assemblies?: number; shelves?: number; committedObjects?: number };
      r2?: { objects?: number; bytes?: number; quarantineObjects?: number };
    };
    assertCondition(
      state.ledger?.assemblies === 0 &&
        state.ledger.shelves === 0 &&
        state.ledger.committedObjects === 0 &&
        state.r2?.objects === 0 &&
        state.r2.bytes === 0 &&
        state.r2.quarantineObjects === 0,
      "Pantry cleanup did not reach zero",
    );
  }
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

async function runZeroGeneratorAcceptance(): Promise<void> {
  // The actual product builder module requires its AI integration at import
  // time. These values are deliberately non-credentials: the deterministic
  // adapter makes no model or network call.
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:1/not-used";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "not-a-credential";
  const { runNodeApiBuildPipeline } = await import("../../api-server/src/lib/builder");
  delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  const generated = await runNodeApiBuildPipeline({
    projectName: "zero-live-pantry-app",
    projectKind: "node-api",
    userPrompt: "Generate a records API that uses the NabuFlow database runtime",
    agentMode: "power",
    zeroGenerationTarget: "cloudflare-sealed-staging-v1",
    sealedManifestRevision: "zero-live-manifest-v1",
    modelAdapter: {
      async complete() {
        return {
          blueprint: {
            projectName: "zero-live-pantry-app",
            projectType: "node-api",
            targetPlatforms: ["api"],
            pages: [{ name: "Health", route: "/healthz" }],
            components: [],
            data: ["records"],
            integrationsNeeded: [],
            theme: "none",
          },
          files: [
            {
              path: "package.json",
              mimeType: "application/json",
              content: JSON.stringify({
                name: "zero-live-pantry-app",
                private: true,
                scripts: { build: "tsc", start: "node dist/src/index.js" },
                dependencies: { express: "^5.1.0", zod: "^4.1.5" },
                devDependencies: {
                  "@types/express": "^5.0.3",
                  "@types/node": "^22.18.0",
                  typescript: "^5.9.2",
                },
              }),
            },
            {
              path: "tsconfig.json",
              mimeType: "application/json",
              content: JSON.stringify({
                compilerOptions: {
                  target: "ES2022",
                  module: "CommonJS",
                  moduleResolution: "Node",
                  rootDir: ".",
                  outDir: "dist",
                  strict: true,
                  esModuleInterop: true,
                  skipLibCheck: true,
                },
                include: ["src/**/*.ts", "nabuflow/runtime/**/*.ts"],
              }),
            },
            {
              path: "src/index.ts",
              mimeType: "application/typescript",
              content: `import express from "express";
import { createNabuFlowDatabase } from "../nabuflow/runtime/index";
const app = express();
const database = createNabuFlowDatabase();
app.get("/healthz", (_request, response) => response.json({ ok: true, generated: true }));
app.get("/records", async (_request, response) => response.json(await database.query("select 1")));
app.listen(Number(process.env.PORT ?? "8080"), "0.0.0.0");`,
            },
          ],
          summary: "Generated a fresh records API through the product Node builder.",
          warnings: [],
          nextRecommendation: "Open the staging preview.",
        };
      },
    },
  });
  const firstPrepared = generated.sealedGeneration;
  assertCondition(firstPrepared !== undefined, "Product generator did not emit sealed metadata");
  assertCondition(
    generated.files.some((file) => file.path === "nabuflow/runtime/db.ts"),
    "Product generator did not vendor the dual-mode SDK",
  );
  assertCondition(
    generated.files.every(
      (file) =>
        !/process\.env\.(?:DATABASE_URL|STRIPE_[A-Z0-9_]*)|registry\.npmjs\.org|npm install|\bnpx\b/u.test(
          file.content,
        ),
    ),
    "Generated sealed source contains a credential or tenant dependency-fetch assumption",
  );

  locator = {
    projectId: 840_000_000 + randomBytes(3).readUIntBE(0, 3),
    role: "preview",
    slot: "primary",
  };
  runtimeIdentity = await deriveRuntimeIdentity({ namespace: DEPLOYMENT_NAMESPACE, ...locator });
  runtimePath = `${CONTROL_PREFIX}/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
  const provider = new CloudflareRuntimeProvider(
    {
      controlUrl: CONTROL_URL,
      controlToken,
      deploymentNamespace: DEPLOYMENT_NAMESPACE,
    },
    {
      now: () => Date.now() + workerClockOffsetMs,
    },
  );
  const onKitchenEvidence = (detail: Readonly<Record<string, unknown>>): void => {
    record("zero.generator.durable-operation-identifiers", 200, detail);
  };
  const created = await provider.create(locator.projectId, "react-vite", undefined, {
    servicePort: 5173,
  });
  assertCondition(
    created !== null && !("error" in created),
    "Fresh staging runtime was not created",
  );
  assertCondition(created.runtimeId === runtimeIdentity, "Fresh runtime identity changed");
  const initial = await provider.zeroGenerationRuntimeDescriptor(
    runtimeIdentity,
    locator.projectId,
  );
  assertCondition(
    initial.status === "stopped" &&
      initial.manifestRevision === `project-${locator.projectId}-runtime-v1`,
    "Fresh runtime did not begin stopped on the pre-detection manifest",
  );
  record("zero.generator.fresh-product-path", 200, {
    files: generated.files.length,
    dependencyIntents: firstPrepared.dependencyPlan.intents.length,
    initialStack: "react-vite",
    initialPort: 5173,
    credentialAssumptions: 0,
    modelAdapter: "deterministic-no-network",
  });

  await trackPantryAssembly(firstPrepared.dependencyPlan.intents);
  const first = await runZeroGenerationKitchen(provider, {
    projectId: locator.projectId,
    runtimeId: runtimeIdentity,
    files: generated.files,
    dependencyPlan: firstPrepared.dependencyPlan,
    manifest: firstPrepared.manifest,
    pantryPublicKeys: new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
    now: () => new Date(Date.now() + workerClockOffsetMs),
    onEvidence: onKitchenEvidence,
  });
  createdBuildIds.add(first.buildId);
  createdShelfRoots.push(first.shelfRootSha256);
  const health = await provider.exec(
    runtimeIdentity,
    [
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/healthz").then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})',
    ],
    locator.projectId,
    "/workspace",
  );
  assertCondition(
    health.ok && health.stdout.includes('"generated":true'),
    "Generated app is unhealthy",
  );
  record("zero.generator.live-kitchen-start", 200, {
    runtimeIdentity,
    port: 8080,
    healthPath: "/healthz",
    buildId: first.buildId,
    artifactSha256: first.artifactSha256,
    coldBuild: first.coldBuild,
  });

  const egress = await provider.exec(
    runtimeIdentity,
    [
      "node",
      "-e",
      'fetch("https://registry.npmjs.org/").then(async(response)=>{if(response.status===520){console.log("blocked:520");return;}console.log(`reachable:${response.status}`);process.exit(2)}).catch(()=>console.log("blocked:network"))',
    ],
    locator.projectId,
    "/workspace",
  );
  assertCondition(
    egress.ok && /(?:^|\n)blocked:(?:520|network)(?:\n|$)/u.test(egress.stdout),
    `Tenant registry egress was not blocked (${egress.stdout.trim() || `exit ${egress.exitCode}`})`,
  );
  record("zero.generator.tenant-egress", 200, { registryAccess: "blocked" });

  await provider.stop(runtimeIdentity, locator.projectId);
  const sourceChangedFiles = generated.files.map((file) =>
    file.path === "src/index.ts"
      ? {
          ...file,
          content: file.content.replace(
            "generated: true",
            'generated: true, revision: "source-v2"',
          ),
        }
      : file,
  );
  const sourceChanged = prepareZeroSealedNodeSource({
    files: sourceChangedFiles,
    manifestRevision: "zero-live-manifest-v2",
  });
  assertCondition(
    canonicalPantryJson(sourceChanged.dependencyPlan) ===
      canonicalPantryJson(firstPrepared.dependencyPlan),
    "Source-only edit changed the Pantry dependency intent",
  );
  await trackPantryAssembly(sourceChanged.dependencyPlan.intents);
  const second = await runZeroGenerationKitchen(provider, {
    projectId: locator.projectId,
    runtimeId: runtimeIdentity,
    files: sourceChanged.files,
    dependencyPlan: sourceChanged.dependencyPlan,
    manifest: sourceChanged.manifest,
    pantryPublicKeys: new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
    now: () => new Date(Date.now() + workerClockOffsetMs),
    onEvidence: onKitchenEvidence,
  });
  createdBuildIds.add(second.buildId);
  createdShelfRoots.push(second.shelfRootSha256);
  assertCondition(
    second.dependencyClosureSha256 === first.dependencyClosureSha256 &&
      second.artifactSha256 !== first.artifactSha256,
    "Source-only edit did not reuse the closure while producing a new artifact",
  );
  record("zero.generator.source-only-cache", 200, {
    closureReused: true,
    artifactChanged: true,
    coldBuild: second.coldBuild,
  });

  await provider.stop(runtimeIdentity, locator.projectId);
  const dependencyChangedFiles = sourceChanged.files.map((file) => {
    if (file.path !== "package.json") return file;
    const parsed = JSON.parse(file.content) as { dependencies: Record<string, string> };
    parsed.dependencies.nanoid = "^5.1.5";
    return { ...file, content: JSON.stringify(parsed) };
  });
  const dependencyChanged = prepareZeroSealedNodeSource({
    files: dependencyChangedFiles,
    manifestRevision: "zero-live-manifest-v3",
  });
  await trackPantryAssembly(dependencyChanged.dependencyPlan.intents);
  const third = await runZeroGenerationKitchen(provider, {
    projectId: locator.projectId,
    runtimeId: runtimeIdentity,
    files: dependencyChanged.files,
    dependencyPlan: dependencyChanged.dependencyPlan,
    manifest: dependencyChanged.manifest,
    pantryPublicKeys: new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
    now: () => new Date(Date.now() + workerClockOffsetMs),
    onEvidence: onKitchenEvidence,
  });
  createdBuildIds.add(third.buildId);
  createdShelfRoots.push(third.shelfRootSha256);
  assertCondition(
    third.dependencyClosureSha256 !== second.dependencyClosureSha256 &&
      third.artifactSha256 !== second.artifactSha256,
    "Dependency edit did not produce a new closure and artifact",
  );
  record("zero.generator.dependency-change", 200, {
    closureChanged: true,
    artifactChanged: true,
    dependencyIntents: dependencyChanged.dependencyPlan.intents.length,
    coldBuild: third.coldBuild,
  });
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
    for (const assemblyId of (process.env.NABUFLOW_CAPTURE_PANTRY_ASSEMBLY_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^passembly_[0-9a-f]{64}$/u.test(value))) {
      observedPantryAssemblyIds.add(assemblyId);
    }
    record("run.configuration", 200, {
      evidenceRunId,
      buildTerminalWaitMs: BUILD_TERMINAL_WAIT_MS,
      diagnosticBound: BUILD_TERMINAL_WAIT_MS !== DEFAULT_BUILD_TERMINAL_WAIT_MS,
      diagnosticVerificationStallMs: DIAGNOSTIC_VERIFY_STALL_MS,
    });
    await rotateWorkerSecrets();
    await sustainedGreen();
    if (process.env.NABUFLOW_TAIL_SENSITIVE_ONLY === "1") {
      await runTailSensitiveVendorLifecycle();
      persistPreCleanupEvidence();
      return;
    }
    if (process.env.NABUFLOW_DURABLE_DISCOVERY_ONLY === "1") {
      await captureRecentDurableOperationEvidence("evidence.durable-operations");
      persistPreCleanupEvidence();
      return;
    }

    const preRunPantryInventory = await capturePantryObjectInventory("pre-run");
    if (
      process.env.NABUFLOW_CLEANUP_ONLY === "1" &&
      process.env.NABUFLOW_ZERO_CLEANUP === "1" &&
      typeof preRunPantryInventory === "object" &&
      preRunPantryInventory !== null &&
      "objects" in preRunPantryInventory &&
      Array.isArray((preRunPantryInventory as { objects?: unknown }).objects)
    ) {
      const inventoryObjects = (preRunPantryInventory as { objects: unknown[] }).objects;
      for (const object of inventoryObjects) {
        const key =
          typeof object === "object" &&
          object !== null &&
          typeof (object as { key?: unknown }).key === "string"
            ? (object as { key: string }).key
            : "";
        const root = /^revisions\/pantry-\d{4}-\d{2}-\d{2}\.\d+\/([0-9a-f]{64})\.json$/u.exec(
          key,
        )?.[1];
        if (root !== undefined && !createdShelfRoots.includes(root)) createdShelfRoots.push(root);
      }
      record("cleanup.zero-shelf-discovery", 200, {
        roots: [...createdShelfRoots].sort(),
        source: "authoritative-r2-list-objects",
        sideEffectFree: true,
      });
    }
    if ((process.env.NABUFLOW_CAPTURE_PANTRY_ASSEMBLY_IDS ?? "").trim() !== "") {
      await captureObservedPantryAssemblyTrails();
    }
    if (
      process.env.NABUFLOW_RECLAIM_CAPTURED_PANTRY_ORPHANS === "1" &&
      preRunPantryInventory !== null
    ) {
      await reclaimCapturedPantryOrphans(preRunPantryInventory);
    }
    if (process.env.NABUFLOW_PANTRY_R2_PROBE_ONLY === "1") {
      await runPantryR2FocusedProbe();
    } else if (process.env.NABUFLOW_CLEANUP_ONLY === "1") {
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
      if (process.env.NABUFLOW_ZERO_GENERATOR_ONLY === "1") {
        await runZeroGeneratorAcceptance();
      } else if (process.env.NABUFLOW_COMMIT_LIVENESS_ONLY === "1") {
        await runArtifactCommitLivenessAcceptance();
      } else {
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
    }
    await captureRecentDurableOperationEvidence("evidence.durable-operations");
    await captureObservedPantryAssemblyTrails();
    await capturePantryObjectInventory("pre-cleanup");
    persistPreCleanupEvidence();
  } catch (error) {
    failure = error;
    record("run.failure", "error", sanitizedFailureEvidence(error));
    try {
      await captureRecentDurableOperationEvidence("evidence.durable-operations");
    } catch (diagnosticError) {
      record("evidence.durable-operations", "error", sanitizedFailureEvidence(diagnosticError));
    }
    await captureObservedPantryAssemblyTrails();
    await capturePantryObjectInventory("pre-cleanup");
    persistPreCleanupEvidence();
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
