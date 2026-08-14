import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import {
  deriveRuntimeIdentity,
  sha256Hex,
  signControlRequest,
  trustedBuildDependencyIntentHash,
  type RuntimeLocator,
} from "@workspace/tenant-runtime-contracts";
import { CloudflareRuntimeProvider } from "../../api-server/src/lib/cloudflare-runtime-provider";
import { runZeroGenerationKitchen } from "../../api-server/src/lib/zero-generation-kitchen";
import { prepareZeroSealedNodeSource } from "../../api-server/src/lib/zero-sealed-generation";
import { PANTRY_TEST_KEY } from "./pantry-catalog-fixture";

const CONTROL_URL = "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev";
const PROVISIONER_URL =
  "https://nabuflow-acceptance-provisioner-staging.mustafa-alali74.workers.dev";
const PROVISIONER_NAME = "nabuflow-acceptance-provisioner-staging";
const DEPLOYMENT_NAMESPACE = "staging";
const NEON_ORGANIZATION_ID = "org-young-poetry-18075521";
const STRIPE_SANDBOX_ID = "acct_1U1r21DoZmlNFmDX";
const FLY_ORGANIZATION_SLUG = "nabuflow-acceptance-staging";
const FLY_IMAGE_REF =
  "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
const MAX_COST_MINOR_UNITS = "500";
const WORKLOAD_ISSUER = "https://staging-acceptance.mustaflow.invalid";
const WORKLOAD_AUDIENCE = PROVISIONER_NAME;
const RUN_ID = new Date().toISOString().replaceAll(/[:.]/gu, "");
const WORKLOAD_KEY_ID = `slice11-${RUN_ID}-es256`;
const WORKLOAD_SUBJECT = `codex-zero-fly-parity-${RUN_ID}`;
const workerRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(workerRoot, "..", "..");
const outputRoot = resolve(repoRoot, "tmp", "gateway-doorman-2b-ix-b11");
const sourceRoot = resolve(outputRoot, "project12-corrected");
const sourceRecordPath = resolve(outputRoot, "corrected-source-record.json");
const evidencePath = resolve(outputRoot, `gateway-doorman-2b-ix-b11-${RUN_ID}-final.json`);
const preCleanupEvidencePath = resolve(
  outputRoot,
  `gateway-doorman-2b-ix-b11-${RUN_ID}-precleanup.json`,
);
const openConfigPath = resolve(workerRoot, `wrangler.acceptance.open-${RUN_ID}.jsonc`);
const wranglerCli = resolve(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const tsxCli = resolve(workerRoot, "node_modules", "tsx", "dist", "cli.mjs");
const artifactGatePath = resolve(workerRoot, "scripts", "artifact-layers-staging-smoke.ts");
const gateEvidencePath = resolve(
  outputRoot,
  `gateway-doorman-2b-ix-b11-${RUN_ID}-four-surface-gate.json`,
);
const ORIGINAL_SOURCE_SHA256 = "ef9835e00a455e4cd53244e97189cc0fc72a923846c5a6b068efe01ea7e3529b";
const CORRECTED_SOURCE_SHA256 = "761073b5afa6c902aa11c96a9031144c2d7cb451b029ea22e8ead11c0924f998";
const EXPECTED_LOCK_SHA256 = "24dd838b5fc05da5e6cbf309ae5ffd5a070690ee3a1d1da0bbc828671347fc2c";
const FLY_OPERATION_BOUND_MS = 20 * 60_000;
const FLY_REGISTRY_PROPAGATION_BOUND_MS = 2 * 60_000;
const FLY_REGISTRY_PROPAGATION_POLL_MS = 5_000;
const LEASE_OPERATION_BOUND_MS = 5 * 60_000;
const PROVISIONER_PROPAGATION_BOUND_MS = 120_000;
const PROVISIONER_PROPAGATION_POLL_MS = 2_000;
const PROVISIONER_STABLE_OBSERVATIONS = 5;
const STALE_RUNTIME_PROJECT_IDS = (process.env.NABUFLOW_SLICE11_STALE_RUNTIME_PROJECT_IDS ?? "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isSafeInteger(value) && value > 0);

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface EvidenceEntry {
  at: string;
  step: string;
  status: string | number;
  detail?: unknown;
}

type LeaseProvider = "neon" | "fly";

interface LeaseHandle {
  leaseId: string;
  projectId: number;
  provider: LeaseProvider;
  resourceIds: string[];
}

const evidence: EvidenceEntry[] = [];
const leases = new Map<LeaseProvider, LeaseHandle>();
const locator: RuntimeLocator = {
  projectId: 860_000_000 + randomBytes(3).readUIntBE(0, 3),
  role: "preview",
  slot: "primary",
};
const runtimePath = `/_nabuflow/control/v1/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
let controlToken = "";
let previewPrivateKey = "";
let previewPublicKey = "";
let vaultKek = "";
let workloadPrivateKey = "";
let workerClockOffsetMs = 0;
let acceptanceClockOffsetMs = 0;
let runtimeId = "";
let runtimeCreated = false;
let runtimeStarted = false;
let artifactSha256 = "";
let buildId = "";
let shelfRootSha256 = "";
let provisionerOpened = false;
let flyApp = "";
let flyMachine = "";
let flyStartedAtMs: number | null = null;
let diagnosticProvider: CloudflareRuntimeProvider | null = null;

function record(step: string, status: string | number, detail?: unknown): void {
  evidence.push({
    at: new Date().toISOString(),
    step,
    status,
    ...(detail === undefined ? {} : { detail }),
  });
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function secret(bytes = 32): string {
  const value = randomBytes(bytes).toString("base64url");
  assertCondition(/^[A-Za-z0-9_-]+$/u.test(value), "Generated secret alphabet is invalid");
  assertCondition(!value.includes("="), "Generated secret contains padding");
  assertCondition(Buffer.from(value, "base64url").byteLength === bytes, "Secret self-check failed");
  return value;
}

function sanitizeProcessDiagnosticText(value: string, maxBytes: number): string {
  const scrubbed = value
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}\b/gu, "[REDACTED_STRIPE_KEY]")
    .replace(/\b(?:postgres|postgresql):\/\/[^\s:@/]+:[^\s@/]+@/gu, "postgresql://[REDACTED]@")
    .replace(/\bFlyV1\s+[A-Za-z0-9._-]+/gu, "[REDACTED_FLY_TOKEN]");
  return scrubbed.length <= maxBytes ? scrubbed : scrubbed.slice(-maxBytes);
}

function runProcess(
  executable: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? workerRoot,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Process exceeded ${String(options.timeoutMs ?? 120_000)} ms`));
    }, options.timeoutMs ?? 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

function replaceJsonString(source: string, property: string, value: string): string {
  const escaped = property.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`("${escaped}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "u");
  assertCondition(pattern.test(source), `Provisioner config is missing ${property}`);
  return source.replace(pattern, `$1${JSON.stringify(value)}`);
}

function buildProvisionerConfig(publicKey: string): string {
  let config = readFileSync(resolve(workerRoot, "wrangler.acceptance.jsonc"), "utf8");
  config = config.replace(/"workers_dev"\s*:\s*false/u, '"workers_dev": true');
  config = replaceJsonString(config, "ACCEPTANCE_STAGING_ENABLED", "true");
  config = replaceJsonString(
    config,
    "ACCEPTANCE_WORKLOAD_PUBLIC_KEYS",
    JSON.stringify({ [WORKLOAD_KEY_ID]: publicKey }),
  );
  config = replaceJsonString(config, "ACCEPTANCE_WORKLOAD_ISSUER", WORKLOAD_ISSUER);
  config = replaceJsonString(config, "ACCEPTANCE_WORKLOAD_AUDIENCE", WORKLOAD_AUDIENCE);
  config = replaceJsonString(
    config,
    "ACCEPTANCE_WORKLOAD_SUBJECTS",
    JSON.stringify([WORKLOAD_SUBJECT]),
  );
  config = replaceJsonString(config, "ACCEPTANCE_NEON_ORGANIZATION_ID", NEON_ORGANIZATION_ID);
  config = replaceJsonString(config, "ACCEPTANCE_STRIPE_SANDBOX_ID", STRIPE_SANDBOX_ID);
  config = replaceJsonString(config, "ACCEPTANCE_FLY_ORGANIZATION_SLUG", FLY_ORGANIZATION_SLUG);
  config = replaceJsonString(config, "ACCEPTANCE_FLY_IMAGE_REF", FLY_IMAGE_REF);
  config = replaceJsonString(
    config,
    "ACCEPTANCE_PROVIDER_MAX_COST_MINOR_UNITS",
    MAX_COST_MINOR_UNITS,
  );
  return config;
}

function deploymentVersion(output: string): string | null {
  const matches = [...output.matchAll(/(?:Version ID|Current Version ID):\s+([0-9a-f-]{36})/giu)];
  return matches.at(-1)?.[1] ?? null;
}

async function deployProvisioner(configPath: string, message: string): Promise<string> {
  const result = await runProcess(
    process.execPath,
    [wranglerCli, "deploy", "--config", configPath, "--message", message],
    { timeoutMs: 180_000 },
  );
  assertCondition(result.code === 0, `Provisioner deploy failed (${String(result.code)})`);
  const version = deploymentVersion(`${result.stdout}\n${result.stderr}`);
  assertCondition(version !== null, "Provisioner deploy returned no version ID");
  return version;
}

async function verifyProvisionerClosed(): Promise<void> {
  const deadline = Date.now() + PROVISIONER_PROPAGATION_BOUND_MS;
  let consecutive = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PROVISIONER_URL}/_nabuflow/acceptance/v1/readyz`, {
        redirect: "manual",
      });
      const body = await readJsonResponse(response);
      if (response.status === 404) {
        consecutive += 1;
        if (consecutive >= PROVISIONER_STABLE_OBSERVATIONS) {
          record("provisioner.closed", 404, { consecutive });
          return;
        }
      } else {
        consecutive = 0;
        record("provisioner.close.propagation", response.status, summarizeLeaseBody(body));
      }
    } catch (error) {
      consecutive = 0;
      record("provisioner.close.propagation", "transport", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, PROVISIONER_PROPAGATION_POLL_MS),
    );
  }
  throw new Error("Provisioner route did not remain closed through propagation");
}

async function calibrateClocks(): Promise<void> {
  const runtimeResponse = await fetch(`${CONTROL_URL}/_nabuflow/control/v1/version`);
  const runtimeDate = runtimeResponse.headers.get("date");
  assertCondition(runtimeDate !== null, "Runtime Date header is unavailable");
  workerClockOffsetMs = Date.parse(runtimeDate) - Date.now();
  assertCondition(Number.isFinite(workerClockOffsetMs), "Runtime clock calibration failed");
  const provisionerResponse = await fetch(`${PROVISIONER_URL}/_nabuflow/acceptance/v1/readyz`);
  const provisionerDate = provisionerResponse.headers.get("date");
  assertCondition(provisionerDate !== null, "Provisioner Date header is unavailable");
  acceptanceClockOffsetMs = Date.parse(provisionerDate) - Date.now();
  assertCondition(Number.isFinite(acceptanceClockOffsetMs), "Provisioner clock calibration failed");
  record("clock.calibrated", 200, {
    runtimeAbsoluteOffsetMs: Math.abs(workerClockOffsetMs),
    provisionerAbsoluteOffsetMs: Math.abs(acceptanceClockOffsetMs),
  });
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function workloadToken(): string {
  const nowSeconds = Math.floor((Date.now() + acceptanceClockOffsetMs) / 1_000);
  const header = base64Url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: WORKLOAD_KEY_ID }));
  const payload = base64Url(
    JSON.stringify({
      iss: WORKLOAD_ISSUER,
      aud: WORKLOAD_AUDIENCE,
      sub: WORKLOAD_SUBJECT,
      iat: nowSeconds - 5,
      exp: nowSeconds + 300,
      jti: `slice11-${crypto.randomUUID()}`,
    }),
  );
  const input = `${header}.${payload}`;
  const signature = signBytes("sha256", Buffer.from(input), {
    key: workloadPrivateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${base64Url(signature)}`;
}

function assertOpaque(body: unknown): void {
  const text = JSON.stringify(body);
  assertCondition(
    !/postgres(?:ql)?:\/\/|BEGIN PRIVATE KEY|(?:s|r)k_(?:test|live)_[A-Za-z0-9]/u.test(text),
    "Provisioner response exposed credential material",
  );
  for (const name of [
    "credential",
    "connectionString",
    "databaseUrl",
    "hostname",
    "host",
    "secret",
  ]) {
    assertCondition(
      !(typeof body === "object" && body !== null && name in body),
      `Response exposed ${name}`,
    );
  }
}

function summarizeLeaseBody(body: unknown): Record<string, unknown> {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ok: value.ok,
    code: value.code,
    leaseId: value.leaseId,
    provider: value.provider,
    state: value.state,
    terminalCode: value.terminalCode,
    resourceIds: value.resourceIds,
    resourcesGone: value.resourcesGone,
    configurationGone: value.configurationGone,
    cost: value.cost,
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { malformedJson: true, bytes: Buffer.byteLength(text) };
  }
}

async function provisionerFetch(input: {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  label: string;
}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${PROVISIONER_URL}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${workloadToken()}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJsonResponse(response);
  assertOpaque(body);
  record(input.label, response.status, summarizeLeaseBody(body));
  return { response, body };
}

async function leaseStatus(lease: LeaseHandle, label: string): Promise<Record<string, unknown>> {
  const result = await provisionerFetch({
    path: `/_nabuflow/acceptance/v1/leases/${lease.leaseId}/status`,
    label,
  });
  assertCondition(result.response.status === 200, `${label}: status failed`);
  return result.body as Record<string, unknown>;
}

async function waitLease(
  lease: LeaseHandle,
  state: "active" | "provisioned" | "destroyed",
  label: string,
  updatedAfterMs?: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + LEASE_OPERATION_BOUND_MS;
  while (Date.now() < deadline) {
    const current = await leaseStatus(lease, `${label}.status`);
    const updatedAtMs = typeof current.updatedAt === "string" ? Date.parse(current.updatedAt) : NaN;
    if (
      current.state === state &&
      (updatedAfterMs === undefined ||
        (Number.isFinite(updatedAtMs) && updatedAtMs > updatedAfterMs))
    ) {
      const ids = Array.isArray(current.resourceIds)
        ? current.resourceIds.filter((value): value is string => typeof value === "string")
        : [];
      lease.resourceIds = ids;
      return current;
    }
    assertCondition(
      current.state !== "failed" && current.state !== "expired",
      `${label}: lease reached ${String(current.state)} (${String(current.terminalCode)})`,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${label}: lease did not reach ${state}`);
}

async function createLease(provider: LeaseProvider): Promise<LeaseHandle> {
  const scope =
    provider === "neon"
      ? { provider, organizationId: NEON_ORGANIZATION_ID }
      : { provider, organizationSlug: FLY_ORGANIZATION_SLUG, disposable: true };
  const result = await provisionerFetch({
    path: "/_nabuflow/acceptance/v1/leases",
    method: "POST",
    body: {
      schemaVersion: 1,
      projectId: locator.projectId,
      scope,
      ttlSeconds: 7_200,
      costCeilingMinorUnits: provider === "fly" ? 500 : 0,
    },
    idempotencyKey: `slice11-${provider}-create-${locator.projectId}`,
    label: `acceptance.${provider}.create`,
  });
  assertCondition([200, 201, 202].includes(result.response.status), `${provider} create failed`);
  const leaseId = (result.body as { leaseId?: unknown }).leaseId;
  assertCondition(typeof leaseId === "string", `${provider} create returned no lease ID`);
  const lease: LeaseHandle = { leaseId, projectId: locator.projectId, provider, resourceIds: [] };
  leases.set(provider, lease);
  await waitLease(lease, "active", `acceptance.${provider}.create`);
  return lease;
}

async function provisionNeonCapability(lease: LeaseHandle, revision: string): Promise<void> {
  const before = await leaseStatus(lease, "acceptance.neon.provision.before");
  const beforeMs = Date.parse(String(before.updatedAt));
  assertCondition(Number.isFinite(beforeMs), "Neon lease update timestamp is invalid");
  const result = await provisionerFetch({
    path: `/_nabuflow/acceptance/v1/leases/${lease.leaseId}/provision-capability`,
    method: "POST",
    body: { schemaVersion: 1, revision },
    idempotencyKey: `slice11-neon-provision-${locator.projectId}-${revision}`,
    label: "acceptance.neon.provision",
  });
  assertCondition([200, 202].includes(result.response.status), "Neon capability provision failed");
  await waitLease(lease, "provisioned", "acceptance.neon.provision", beforeMs);
}

async function provisionFlyDatabase(fly: LeaseHandle, neon: LeaseHandle): Promise<void> {
  const before = await leaseStatus(fly, "acceptance.fly.database.before");
  const beforeMs = Date.parse(String(before.updatedAt));
  assertCondition(Number.isFinite(beforeMs), "Fly lease update timestamp is invalid");
  const result = await provisionerFetch({
    path: `/_nabuflow/acceptance/v1/leases/${fly.leaseId}/provision-fly-secret`,
    method: "POST",
    body: { schemaVersion: 1, databaseLeaseId: neon.leaseId },
    idempotencyKey: `slice11-fly-database-${locator.projectId}`,
    label: "acceptance.fly.database",
  });
  assertCondition([200, 202].includes(result.response.status), "Fly database handoff failed");
  await waitLease(fly, "provisioned", "acceptance.fly.database", beforeMs);
}

async function destroyLease(lease: LeaseHandle): Promise<void> {
  const result = await provisionerFetch({
    path: `/_nabuflow/acceptance/v1/leases/${lease.leaseId}/destroy`,
    method: "POST",
    body: { schemaVersion: 1 },
    idempotencyKey: `slice11-${lease.provider}-destroy-${locator.projectId}`,
    label: `acceptance.${lease.provider}.destroy`,
  });
  assertCondition([200, 202].includes(result.response.status), `${lease.provider} destroy failed`);
  await waitLease(lease, "destroyed", `acceptance.${lease.provider}.destroy`);
  const deadline = Date.now() + LEASE_OPERATION_BOUND_MS;
  while (Date.now() < deadline) {
    const verified = await provisionerFetch({
      path: `/_nabuflow/acceptance/v1/leases/${lease.leaseId}/verify-gone`,
      method: "POST",
      body: { schemaVersion: 1 },
      idempotencyKey: `slice11-${lease.provider}-verify-${locator.projectId}`,
      label: `acceptance.${lease.provider}.verify-gone`,
    });
    if (
      verified.response.status === 200 &&
      (verified.body as { resourcesGone?: unknown }).resourcesGone === true &&
      (verified.body as { configurationGone?: unknown }).configurationGone === true
    ) {
      leases.delete(lease.provider);
      return;
    }
    assertCondition(verified.response.status === 202, `${lease.provider} verify-gone failed`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${lease.provider} verify-gone exceeded its bound`);
}

function readSourceFiles(): Array<{ path: string; content: string; mimeType: string }> {
  const files: Array<{ path: string; content: string; mimeType: string }> = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      const absolute = resolve(directory, name);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      const path = relative(sourceRoot, absolute).replaceAll("\\", "/");
      if (["package-lock.json", "Dockerfile", ".dockerignore", "fly-acceptance.mjs"].includes(path))
        continue;
      files.push({ path, content: readFileSync(absolute, "utf8"), mimeType: "text/plain" });
    }
  };
  walk(sourceRoot);
  return files;
}

async function rotateAndGate(): Promise<void> {
  controlToken = secret();
  vaultKek = secret();
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  previewPrivateKey = pair.privateKey;
  previewPublicKey = pair.publicKey;
  const payload = JSON.stringify({
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: controlToken,
    CLOUFLOW_RUNTIME_CONTROL_TOKEN: controlToken,
    CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: previewPublicKey,
    CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: vaultKek,
  });
  const rotation = await runProcess(
    process.execPath,
    [wranglerCli, "secret", "bulk", "--name", "nabuflow-runtime-staging"],
    { input: payload, timeoutMs: 180_000 },
  );
  assertCondition(rotation.code === 0, `Runtime rotation failed (${String(rotation.code)})`);
  record("runtime.rotation", 200, { bindingCount: 4, valuesPersisted: false });
  const gate = await runProcess(process.execPath, [tsxCli, artifactGatePath], {
    timeoutMs: 30 * 60_000,
    cwd: workerRoot,
    env: {
      ...process.env,
      NABUFLOW_ACCEPTANCE_CONTROL_TOKEN: controlToken,
      NABUFLOW_ACCEPTANCE_PREVIEW_PRIVATE_KEY: previewPrivateKey,
      NABUFLOW_ACCEPTANCE_PREVIEW_PUBLIC_KEY: previewPublicKey,
      NABUFLOW_ACCEPTANCE_VAULT_KEK: vaultKek,
      NABUFLOW_GATE_ONLY: "1",
      NABUFLOW_GATE_EVIDENCE_PATH: gateEvidencePath,
    },
  });
  assertCondition(gate.code === 0, `Four-surface gate failed (${String(gate.code)})`);
  const summary = gate.stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((value) => value?.ok === true);
  assertCondition(summary !== undefined, "Four-surface gate returned no summary");
  assertCondition(existsSync(gateEvidencePath), "Four-surface gate wrote no evidence");
  record("runtime.four-surface-gate", 200, {
    ...summary,
    evidencePath: gateEvidencePath,
    evidenceSha256: createHash("sha256").update(readFileSync(gateEvidencePath)).digest("hex"),
  });
}

async function signedControlDeleteArtifact(): Promise<void> {
  if (artifactSha256 === "") return;
  const path = `${runtimePath}/layered-artifacts/${artifactSha256}`;
  const body = JSON.stringify({ locator, sealedArtifactSha256: artifactSha256 });
  const timestamp = String(Date.now() + workerClockOffsetMs);
  const nonce = `slice11-artifact-remove-${crypto.randomUUID()}`;
  const bodySha256 = await sha256Hex(body);
  const idempotencyKey = `slice11-artifact-remove-${artifactSha256}`;
  const signature = await signControlRequest(controlToken, {
    method: "DELETE",
    pathAndQuery: path,
    timestamp,
    nonce,
    bodySha256,
    idempotencyKey,
  });
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
    },
    body,
  });
  const responseBody = await readJsonResponse(response);
  record("cloudflare.artifact.remove", response.status, {
    code: (responseBody as { code?: unknown }).code,
  });
  assertCondition(response.status === 200 || response.status === 404, "Artifact removal failed");
  artifactSha256 = "";
}

async function runRuntimeScript(
  provider: CloudflareRuntimeProvider,
  label: string,
  source: string,
): Promise<unknown> {
  const result = await provider.exec(
    runtimeId,
    ["node", "-e", source],
    locator.projectId,
    "/workspace",
  );
  assertCondition(result.ok, `${label}: runtime exec failed (${String(result.exitCode)})`);
  const stdout = result.stdout.trim();
  assertCondition(stdout !== "", `${label}: runtime exec returned no output`);
  const parsed = JSON.parse(stdout) as unknown;
  record(label, 200, parsed);
  return parsed;
}

const SCHEMA_INTENT_SCRIPT = String.raw`
const input={v:1,capability:{provider:"neon-postgres",name:"database"},action:"query",requestId:crypto.randomUUID(),input:{kind:"statement",sql:"CREATE TABLE IF NOT EXISTS items (id text PRIMARY KEY, name text NOT NULL, sku text UNIQUE NOT NULL, quantity integer NOT NULL, price integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())",params:[]}};
fetch("http://doorman.staging.nabuflow.internal/v1/invoke",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})));
`;

const APP_MATRIX_SCRIPT = String.raw`
const base="http://127.0.0.1:8080";
const call=async(path,init={})=>{const r=await fetch(base+path,{...init,headers:{"content-type":"application/json",...(init.headers||{})}});const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text}return{status:r.status,body,headers:Object.fromEntries(r.headers)}};
const health=await call("/healthz");
const created=await call("/api/items",{method:"POST",body:JSON.stringify({name:"Parity Widget",sku:"PARITY-"+Date.now(),quantity:3,price:1299})});
const id=created.body.id;
const selected=await call("/api/items/"+id);
const replaced=await call("/api/items/"+id,{method:"PUT",body:JSON.stringify({name:"Parity Widget V2",sku:created.body.sku,quantity:4,price:1399})});
const patched=await call("/api/items/"+id,{method:"PATCH",body:JSON.stringify({quantity:5})});
const rollback=await call("/api/transaction-demo");
const listed=await call("/api/items");
const removed=await call("/api/items/"+id,{method:"DELETE"});
const absent=await call("/api/items/"+id);
console.log(JSON.stringify({health,created,selected,replaced,patched,rollback,listed:{status:listed.status,itemCount:Array.isArray(listed.body.items)?listed.body.items.length:null},removed,absent}));
`;

function assertAppMatrix(label: string, value: unknown): void {
  const result = value as Record<string, { status?: number; body?: Record<string, unknown> }>;
  assertCondition(result.health?.status === 200, `${label}: health failed`);
  assertCondition(result.created?.status === 201, `${label}: create failed`);
  assertCondition(result.selected?.status === 200, `${label}: select failed`);
  assertCondition(result.replaced?.status === 200, `${label}: update failed`);
  assertCondition(result.patched?.status === 200, `${label}: patch failed`);
  assertCondition(
    result.rollback?.status === 200 &&
      result.rollback.body?.status === "transaction rolled back as expected",
    `${label}: atomic rollback failed`,
  );
  assertCondition(result.removed?.status === 200, `${label}: delete failed`);
  assertCondition(result.absent?.status === 404, `${label}: absent row did not return 404`);
}

async function buildAndRunCloudflare(): Promise<CloudflareRuntimeProvider> {
  const recordValue = JSON.parse(readFileSync(sourceRecordPath, "utf8")) as {
    originalSourceArtifactSha256?: string;
    sourceArtifactSha256?: string;
  };
  assertCondition(
    recordValue.originalSourceArtifactSha256 === ORIGINAL_SOURCE_SHA256,
    "Original hash drifted",
  );
  assertCondition(
    recordValue.sourceArtifactSha256 === CORRECTED_SOURCE_SHA256,
    "Corrected hash drifted",
  );
  assertCondition(
    createHash("sha256")
      .update(readFileSync(resolve(sourceRoot, "package-lock.json")))
      .digest("hex") === EXPECTED_LOCK_SHA256,
    "Corrected package lock drifted",
  );
  const prepared = prepareZeroSealedNodeSource({
    files: readSourceFiles(),
    manifestRevision:
      "zero-node-v1-438510fa01e4bb80c435bdd2397afba0caa48bf5ff280d01e3efd23c5cbfe68f",
  });
  assertCondition(
    prepared.dependencyPlan.intents.some(
      (intent) => intent.name === "pg" && intent.selector === "8.20.0",
    ),
    "Corrected dependency plan omitted exact pg",
  );
  const dependencyIntentSha256 = await trustedBuildDependencyIntentHash(
    prepared.dependencyPlan.intents,
  );
  buildId = `pbuild_zero_${await sha256Hex(
    `${CORRECTED_SOURCE_SHA256}:${dependencyIntentSha256}`,
  )}`;
  record("cloudflare.build.identity", 200, {
    buildId,
    sourceArtifactSha256: CORRECTED_SOURCE_SHA256,
    dependencyIntentSha256,
  });
  runtimeId = await deriveRuntimeIdentity({ namespace: DEPLOYMENT_NAMESPACE, ...locator });
  const provider = new CloudflareRuntimeProvider(
    { controlUrl: CONTROL_URL, controlToken, deploymentNamespace: DEPLOYMENT_NAMESPACE },
    { now: () => Date.now() + workerClockOffsetMs },
  );
  const zeroGenerationControlRequest = provider.zeroGenerationControlRequest.bind(provider);
  provider.zeroGenerationControlRequest = async (input) => {
    const startedAt = Date.now();
    record("cloudflare.control.dispatch", 0, {
      method: input.method,
      path: input.path,
      operationTimeoutMs: input.operationTimeoutMs ?? null,
    });
    try {
      const value = await zeroGenerationControlRequest(input);
      record("cloudflare.control.result", 200, {
        method: input.method,
        path: input.path,
        elapsedMs: Date.now() - startedAt,
      });
      return value;
    } catch (error) {
      record("cloudflare.control.result", "error", {
        method: input.method,
        path: input.path,
        elapsedMs: Date.now() - startedAt,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        code:
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown",
        status:
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status: unknown }).status)
            : null,
        retryable:
          typeof error === "object" && error !== null && "retryable" in error
            ? Boolean((error as { retryable: unknown }).retryable)
            : null,
        transportCause:
          typeof error === "object" && error !== null && "transportCause" in error
            ? String((error as { transportCause: unknown }).transportCause)
            : null,
      });
      throw error;
    }
  };
  diagnosticProvider = provider;
  const created = await provider.create(locator.projectId, "node-api", undefined, {
    servicePort: 8080,
  });
  assertCondition(created !== null && !("error" in created), "Cloudflare runtime creation failed");
  runtimeCreated = true;
  record("cloudflare.kitchen.enter", 200, { runtimeId, projectId: locator.projectId });
  const result = await runZeroGenerationKitchen(provider, {
    projectId: locator.projectId,
    runtimeId,
    files: prepared.files,
    dependencyPlan: prepared.dependencyPlan,
    manifest: prepared.manifest,
    pantryPublicKeys: new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
    now: () => new Date(Date.now() + workerClockOffsetMs),
    onEvidence: (detail) => record("cloudflare.kitchen.progress", 200, detail),
  });
  runtimeStarted = true;
  artifactSha256 = result.artifactSha256;
  assertCondition(result.buildId === buildId, "Trusted build identity changed");
  shelfRootSha256 = result.shelfRootSha256;
  record("cloudflare.corrected-source.accepted", 200, {
    originalSourceSha256: ORIGINAL_SOURCE_SHA256,
    correctedSourceSha256: CORRECTED_SOURCE_SHA256,
    buildId,
    shelfRootSha256,
    artifactSha256,
    dependencyClosureSha256: result.dependencyClosureSha256,
    coldBuild: result.coldBuild,
    runtimeId,
    port: 8080,
  });
  const health = await runRuntimeScript(
    provider,
    "cloudflare.health.pre-capability",
    'fetch("http://127.0.0.1:8080/healthz").then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))',
  );
  assertCondition((health as { status?: unknown }).status === 200, "Cloudflare health failed");
  const egress = await runRuntimeScript(
    provider,
    "cloudflare.egress.blocked",
    'fetch("https://registry.npmjs.org/").then(async r=>console.log(JSON.stringify({status:r.status,blocked:r.status===520}))).catch(e=>console.log(JSON.stringify({status:"network",blocked:true,errorClass:e?.constructor?.name||"Error"})))',
  );
  assertCondition(
    (egress as { blocked?: unknown }).blocked === true,
    "Cloudflare tenant egress was reachable",
  );
  return provider;
}

async function openProvisioner(publicKey: string): Promise<void> {
  writeFileSync(openConfigPath, buildProvisionerConfig(publicKey), { mode: 0o600 });
  const version = await deployProvisioner(
    openConfigPath,
    `slice11-${RUN_ID}-temporary-lease-window`,
  );
  provisionerOpened = true;
  record("provisioner.opened", 200, { version, publicSurface: "temporary_auth_gated" });
  const deadline = Date.now() + PROVISIONER_PROPAGATION_BOUND_MS;
  let consecutive = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PROVISIONER_URL}/_nabuflow/acceptance/v1/readyz`);
      const body = await readJsonResponse(response);
      if (
        response.status === 200 &&
        JSON.stringify(body) === JSON.stringify({ ready: true, gate: "enabled", kek: "valid" })
      ) {
        consecutive += 1;
        if (consecutive >= PROVISIONER_STABLE_OBSERVATIONS) {
          record("provisioner.ready", 200, {
            ready: true,
            gate: "enabled",
            kek: "valid",
            consecutive,
          });
          return;
        }
      } else {
        consecutive = 0;
        record("provisioner.open.propagation", response.status, summarizeLeaseBody(body));
      }
    } catch (error) {
      consecutive = 0;
      record("provisioner.open.propagation", "transport", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, PROVISIONER_PROPAGATION_POLL_MS),
    );
  }
  throw new Error("Provisioner route did not become ready");
}

async function runCloudflareDatabase(
  provider: CloudflareRuntimeProvider,
  neon: LeaseHandle,
): Promise<void> {
  await provisionNeonCapability(neon, `slice11-${RUN_ID}-database-v1`);
  const schema = await runRuntimeScript(
    provider,
    "cloudflare.database.schema",
    SCHEMA_INTENT_SCRIPT,
  );
  assertCondition(
    (schema as { status?: unknown }).status === 200,
    "Cloudflare schema setup failed",
  );
  const matrix = await runRuntimeScript(provider, "cloudflare.database.matrix", APP_MATRIX_SCRIPT);
  assertAppMatrix("Cloudflare", matrix);
  record("cloudflare.direct-database-env", 200, {
    databaseUrlReadByCloudflareSdk: false,
    databaseOperations: "doorman-capability-only",
  });
}

async function runFlyCommand(
  label: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<ProcessResult> {
  const result = await runProcess("flyctl.exe", args, { cwd: sourceRoot, timeoutMs });
  record(label, result.code, {
    arguments: args,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdoutTail: sanitizeProcessDiagnosticText(result.stdout, 2_048),
    stderrTail: sanitizeProcessDiagnosticText(result.stderr, 2_048),
  });
  assertCondition(result.code === 0, `${label} failed (${String(result.code)})`);
  return result;
}

function isFlyRegistryManifestPropagationRace(result: ProcessResult): boolean {
  return (
    result.code !== 0 &&
    /MANIFEST_UNKNOWN/u.test(result.stderr) &&
    /manifest unknown/u.test(result.stderr) &&
    /failed to get manifest/u.test(result.stderr)
  );
}

function isFlySshWindowsPostOutputHandleArtifact(result: ProcessResult): boolean {
  return result.code === 1 && result.stderr.trim() === "Error: The handle is invalid.";
}

async function runFlyMatrixCommand(label: string): Promise<unknown> {
  const args = [
    "ssh",
    "console",
    "--app",
    flyApp,
    "--machine",
    flyMachine,
    "--command",
    "node /app/fly-acceptance.mjs",
    "--quiet",
  ];
  const result = await runProcess("flyctl.exe", args, {
    cwd: sourceRoot,
    timeoutMs: 300_000,
  });
  const wrapperArtifact = isFlySshWindowsPostOutputHandleArtifact(result);
  record(label, result.code, {
    arguments: args,
    wrapperArtifact,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdoutTail: sanitizeProcessDiagnosticText(result.stdout, 2_048),
    stderrTail: sanitizeProcessDiagnosticText(result.stderr, 2_048),
  });
  const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
  let matrix: unknown;
  try {
    matrix = JSON.parse(lastLine) as unknown;
  } catch {
    throw new Error(`${label}: matrix output was incomplete`);
  }
  assertAppMatrix(label, matrix);
  assertCondition(result.code === 0 || wrapperArtifact, `${label} failed (${String(result.code)})`);
  if (wrapperArtifact) record(`${label}.wrapper-artifact`, 200, { acceptedAfterMatrix: true });
  return matrix;
}

function assertFlyHarnessContract(): void {
  assertCondition(
    isFlyRegistryManifestPropagationRace({
      code: 1,
      stdout: "",
      stderr: "failed to get manifest: MANIFEST_UNKNOWN: manifest unknown",
    }),
    "Fly registry propagation classifier rejected its exact transient",
  );
  assertCondition(
    !isFlyRegistryManifestPropagationRace({
      code: 1,
      stdout: "",
      stderr: "failed to update machine: authorization denied",
    }),
    "Fly registry propagation classifier accepted an unrelated failure",
  );
  assertCondition(
    isFlySshWindowsPostOutputHandleArtifact({
      code: 1,
      stdout: '{"complete":true}\n',
      stderr: "Error: The handle is invalid.\r\n",
    }),
    "Fly SSH wrapper classifier rejected its exact post-output signature",
  );
  assertCondition(
    !isFlySshWindowsPostOutputHandleArtifact({
      code: 1,
      stdout: "",
      stderr: "Error: connection reset",
    }),
    "Fly SSH wrapper classifier accepted an unrelated failure",
  );
  record("harness.fly-registry-propagation.self-check", 200, {
    exactTransientOnly: true,
    propagationBoundMs: FLY_REGISTRY_PROPAGATION_BOUND_MS,
    pollMs: FLY_REGISTRY_PROPAGATION_POLL_MS,
    postOutputHandleArtifactExact: true,
  });
}

async function updateFlyMachineToBuiltImage(
  fly: LeaseHandle,
  imageReference: string,
): Promise<void> {
  const deadline = Date.now() + FLY_REGISTRY_PROPAGATION_BOUND_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const result = await runProcess(
      "flyctl.exe",
      [
        "machine",
        "update",
        flyMachine,
        "--app",
        flyApp,
        "--image",
        imageReference,
        "--skip-start",
        "--yes",
        "--vm-cpu-kind",
        "shared",
        "--vm-cpus",
        "1",
        "--vm-memory",
        "512",
        "--metadata",
        `nabuflow_acceptance_lease=${fly.leaseId}`,
        "--metadata",
        `nabuflow_source_sha256=${CORRECTED_SOURCE_SHA256}`,
      ],
      { cwd: sourceRoot, timeoutMs: FLY_OPERATION_BOUND_MS },
    );
    const propagationRace = isFlyRegistryManifestPropagationRace(result);
    record("fly.machine.update-image.attempt", result.code, {
      attempt,
      imageReference,
      propagationRace,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
      stdoutTail: sanitizeProcessDiagnosticText(result.stdout, 2_048),
      stderrTail: sanitizeProcessDiagnosticText(result.stderr, 2_048),
    });
    if (result.code === 0) return;
    if (!propagationRace || Date.now() + FLY_REGISTRY_PROPAGATION_POLL_MS >= deadline) {
      throw new Error(`fly.machine.update-image failed (${String(result.code)})`);
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, FLY_REGISTRY_PROPAGATION_POLL_MS),
    );
  }
}

async function flyOrgAppNames(): Promise<string[]> {
  const result = await runProcess(
    "flyctl.exe",
    ["apps", "list", "-o", FLY_ORGANIZATION_SLUG, "--json"],
    { cwd: sourceRoot, timeoutMs: 120_000 },
  );
  assertCondition(result.code === 0, "Fly organization inventory failed");
  const parsed = JSON.parse(result.stdout) as Array<{ Name?: unknown }>;
  assertCondition(Array.isArray(parsed), "Fly organization inventory was malformed");
  return parsed
    .map((app) => app.Name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

async function verifyFlyOrgEmpty(label: string): Promise<void> {
  const before = await flyOrgAppNames();
  const builderApps = before.filter((name) => /^fly-builder-[a-z0-9-]+$/u.test(name));
  for (const builderApp of builderApps) {
    const destroyed = await runProcess("flyctl.exe", ["apps", "destroy", builderApp, "--yes"], {
      cwd: sourceRoot,
      timeoutMs: 180_000,
    });
    record(`${label}.builder-destroy`, destroyed.code, {
      app: builderApp,
      stdoutTail: sanitizeProcessDiagnosticText(destroyed.stdout, 1_024),
      stderrTail: sanitizeProcessDiagnosticText(destroyed.stderr, 1_024),
    });
    assertCondition(destroyed.code === 0, "Fly remote-builder cleanup failed");
  }
  const after = await flyOrgAppNames();
  record(label, after.length === 0 ? 200 : 409, { apps: after, builderAppsRemoved: builderApps });
  assertCondition(after.length === 0, "Fly staging organization retained an application");
}

async function runFlyParity(fly: LeaseHandle, neon: LeaseHandle): Promise<void> {
  assertCondition(fly.resourceIds.length === 2, "Fly lease returned an unexpected resource shape");
  [flyApp, flyMachine] = fly.resourceIds;
  assertCondition(/^nabu-accept-[a-f0-9]{24}$/u.test(flyApp), "Fly app identity is invalid");
  assertCondition(/^[a-f0-9]{14}$/u.test(flyMachine), "Fly machine identity is invalid");
  flyStartedAtMs = Date.now();
  const imageLabel = `slice11-${RUN_ID.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
  const imageReference = `registry.fly.io/${flyApp}:${imageLabel}`;
  await runFlyCommand(
    "fly.image.build-push",
    [
      "deploy",
      ".",
      "--app",
      flyApp,
      "--dockerfile",
      "Dockerfile",
      "--build-only",
      "--push",
      "--depot=true",
      "--image-label",
      imageLabel,
      "--yes",
    ],
    FLY_OPERATION_BOUND_MS,
  );
  await updateFlyMachineToBuiltImage(fly, imageReference);
  await provisionFlyDatabase(fly, neon);
  await runFlyCommand(
    "fly.machine.start",
    ["machine", "start", flyMachine, "--app", flyApp],
    300_000,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  await runFlyMatrixCommand("fly.matrix.first");
  await runFlyCommand(
    "fly.machine.stop",
    ["machine", "stop", flyMachine, "--app", flyApp],
    300_000,
  );
  await runFlyCommand(
    "fly.machine.restart",
    ["machine", "start", flyMachine, "--app", flyApp],
    300_000,
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  await runFlyMatrixCommand("fly.matrix.restart");
  record("fly.corrected-source.accepted", 200, {
    sourceSha256: CORRECTED_SOURCE_SHA256,
    packageLockSha256: EXPECTED_LOCK_SHA256,
    app: flyApp,
    machine: flyMachine,
    runtimeMode: "fly-direct-v1",
    port: 8080,
    restartHealthy: true,
    capabilityEndpointCalls: 0,
    databaseCustody: "provisioner-machines-rest-option-b",
    paymentsContract: "excluded",
  });
}

async function persist(path: string, passed: boolean, failure: string | null): Promise<void> {
  const body = JSON.stringify(
    {
      runId: RUN_ID,
      passed,
      failure,
      branch: "codex/zero-fly-parity-acceptance",
      baseSha: "2e9235c552c59d261a2b2f2fc426568a854f1c42",
      source: {
        slice10AcceptedSha256: ORIGINAL_SOURCE_SHA256,
        correctedParitySha256: CORRECTED_SOURCE_SHA256,
        packageLockSha256: EXPECTED_LOCK_SHA256,
      },
      identifiers: {
        projectId: locator.projectId,
        runtimeId,
        buildId,
        shelfRootSha256,
        artifactSha256,
        flyApp,
        flyMachine,
        leases: [...leases.values()].map((lease) => ({
          provider: lease.provider,
          leaseId: lease.leaseId,
          resourceIds: lease.resourceIds,
        })),
      },
      cost: {
        approvedCeilingMinorUnits: 500,
        flyActiveMilliseconds: flyStartedAtMs === null ? 0 : Date.now() - flyStartedAtMs,
      },
      evidence,
    },
    null,
    2,
  );
  const envelope = JSON.stringify(
    {
      record: JSON.parse(body) as unknown,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
    null,
    2,
  );
  writeFileSync(path, envelope, { mode: 0o600 });
}

async function main(): Promise<void> {
  let failure: string | null = null;
  let provider: CloudflareRuntimeProvider | null = null;
  mkdirSync(outputRoot, { recursive: true });
  assertCondition(existsSync(sourceRoot), "Corrected generated source is unavailable");
  assertCondition(existsSync(sourceRecordPath), "Corrected source record is unavailable");
  assertCondition(existsSync(wranglerCli) && existsSync(tsxCli), "Pinned tooling is unavailable");
  assertFlyHarnessContract();
  const workloadPair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  workloadPrivateKey = workloadPair.privateKey;
  try {
    await rotateAndGate();
    await calibrateClocks();
    for (const staleProjectId of STALE_RUNTIME_PROJECT_IDS) {
      const staleRuntimeId = await deriveRuntimeIdentity({
        namespace: DEPLOYMENT_NAMESPACE,
        projectId: staleProjectId,
        role: "preview",
        slot: "primary",
      });
      const staleProvider = new CloudflareRuntimeProvider(
        { controlUrl: CONTROL_URL, controlToken, deploymentNamespace: DEPLOYMENT_NAMESPACE },
        { now: () => Date.now() + workerClockOffsetMs },
      );
      try {
        await staleProvider.destroy(staleRuntimeId, staleProjectId);
        record("cloudflare.stale-runtime.destroyed", 200, { projectId: staleProjectId });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown";
        assertCondition(
          code === "runtime_not_found",
          `Stale runtime ${staleProjectId} cleanup failed`,
        );
        record("cloudflare.stale-runtime.absent", 404, { projectId: staleProjectId, code });
      }
    }
    provider = await buildAndRunCloudflare();
    await verifyFlyOrgEmpty("fly.org.pre-lease-empty");
    await openProvisioner(workloadPair.publicKey);
    await calibrateClocks();
    const neon = await createLease("neon");
    await runCloudflareDatabase(provider, neon);
    const fly = await createLease("fly");
    await runFlyParity(fly, neon);
    await persist(preCleanupEvidencePath, true, null);
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unknown Slice 11 acceptance failure";
    record("run.failure", "error", {
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: failure,
      code:
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined,
      status:
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status)
          : undefined,
      retryable:
        typeof error === "object" && error !== null && "retryable" in error
          ? Boolean((error as { retryable: unknown }).retryable)
          : undefined,
      transportCause:
        typeof error === "object" && error !== null && "transportCause" in error
          ? String((error as { transportCause: unknown }).transportCause)
          : undefined,
      evidence:
        typeof error === "object" && error !== null && "evidence" in error
          ? (error as { evidence: unknown }).evidence
          : undefined,
    });
    const activeProvider = provider ?? diagnosticProvider;
    if (activeProvider !== null && buildId !== "") {
      try {
        const status = (await activeProvider.zeroGenerationControlRequest({
          method: "GET",
          path: `/_nabuflow/control/v1/build-plane/builds/${buildId}`,
        })) as Record<string, unknown>;
        record("cloudflare.build.terminal", 200, {
          buildId,
          state: status.state,
          error: status.error,
          attempts: status.attempts,
          lastStage: status.lastStage,
          evidence: status.evidence,
        });
      } catch (diagnosticError) {
        record("cloudflare.build.terminal", "diagnostic_error", {
          errorClass: diagnosticError instanceof Error ? diagnosticError.name : "UnknownError",
        });
      }
    }
    await persist(preCleanupEvidencePath, false, failure).catch(() => undefined);
  } finally {
    for (const lease of [...leases.values()].sort((left) => (left.provider === "fly" ? -1 : 1))) {
      try {
        await destroyLease(lease);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown lease cleanup failure";
        failure = failure === null ? message : `${failure}; cleanup: ${message}`;
      }
    }
    try {
      await verifyFlyOrgEmpty("fly.org.post-cleanup-empty");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Fly inventory failure";
      failure = failure === null ? message : `${failure}; fly cleanup: ${message}`;
    }
    const cleanupProvider = provider ?? diagnosticProvider;
    if (cleanupProvider !== null && runtimeCreated) {
      try {
        if (runtimeStarted) {
          await cleanupProvider.stop(runtimeId, locator.projectId);
          runtimeStarted = false;
        }
        await signedControlDeleteArtifact();
        await cleanupProvider.destroy(runtimeId, locator.projectId);
        runtimeCreated = false;
        let absentCode = "none";
        try {
          await cleanupProvider.status(runtimeId);
        } catch (error) {
          absentCode =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "unknown";
        }
        assertCondition(absentCode === "runtime_not_found", "Destroyed runtime remained readable");
        record("cloudflare.runtime.destroyed", 404, { code: absentCode });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime cleanup failure";
        failure = failure === null ? message : `${failure}; runtime cleanup: ${message}`;
      }
    }
    if (provisionerOpened) {
      try {
        const version = await deployProvisioner(
          resolve(workerRoot, "wrangler.acceptance.jsonc"),
          `slice11-${RUN_ID}-close-lease-window`,
        );
        record("provisioner.close.deployed", 200, { version });
        await verifyProvisionerClosed();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown Provisioner closure failure";
        failure = failure === null ? message : `${failure}; provisioner closure: ${message}`;
      }
    }
    rmSync(openConfigPath, { force: true });
    controlToken = "";
    previewPrivateKey = "";
    previewPublicKey = "";
    vaultKek = "";
    workloadPrivateKey = "";
    record("session-values.erased", 200, { erased: true });
    await persist(evidencePath, failure === null, failure);
  }
  if (failure !== null) throw new Error(failure);
  process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, preCleanupEvidencePath })}\n`);
}

await main();
