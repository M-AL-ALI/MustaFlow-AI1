import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveRuntimeIdentity,
  sha256Hex,
  signControlRequest,
  signPreviewGrant,
  type CapabilityDefinition,
  type PantryPlatform,
  type RuntimeLayeredArtifactEnvelope,
  type RuntimeLocator,
} from "@workspace/tenant-runtime-contracts";
import {
  RuntimeArtifactLayerSealError,
  sealLayeredRuntimeArtifact,
  sealRuntimeArtifactLayer,
  type SealedLayeredRuntimeArtifact,
  type SealedRuntimeArtifactLayer,
} from "../../api-server/src/lib/runtime-artifact-layers";
import { sealRuntimeArtifact } from "../../api-server/src/lib/runtime-artifact";
import { assertDeclaredEntrypointDelivered, deliverScratchArtifact } from "./artifact-delivery";

const CONTROL_URL = "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev";
const DEPLOYMENT_NAMESPACE = "staging";
const LAYER_PLATFORM: PantryPlatform = {
  runtime: "node",
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux",
  cpu: "x64",
  libc: "glibc",
  toolchainImageDigest: "sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738",
};
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
const locator: RuntimeLocator = {
  projectId: 920_000_000 + (Date.now() % 70_000_000),
  role: "preview",
  slot: "primary",
};
const foreignLocator: RuntimeLocator = { ...locator, projectId: locator.projectId + 1 };
const runtimePath = `/_nabuflow/control/v1/runtimes/${locator.projectId}/preview/primary`;
let controlToken = "";
let previewPrivateKey = "";
let previewPublicKey = "";
let vaultKek = "";
let workerClockOffsetMs = 0;
let deploymentVersion = "";
let runtimeIdentity = "";
let runtimeEnsured = false;
let runtimeStarted = false;
const readinessRevisions = new Map<number, string>();

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

const V1_SERVER = String.raw`
import http from 'node:http';
const server=http.createServer((req,res)=>{if(req.url==='/healthz'){res.statusCode=200;res.end('healthy-v1');return}res.statusCode=200;res.end('artifact-v1-compatible')});
server.listen(Number(process.env.PORT),'0.0.0.0');
`;

const LAYERED_SERVER = String.raw`
import http from 'node:http';
import { pantryValue } from './node_modules/pantry-demo/index.mjs';
const server=http.createServer((req,res)=>{if(req.url==='/healthz'){res.statusCode=200;res.end('healthy-layered');return}res.statusCode=200;res.setHeader('content-type','application/json');res.end(JSON.stringify({pantryValue,runtime:process.env.NABUFLOW_RUNTIME_ID,port:Number(process.env.PORT)}))});
server.listen(Number(process.env.PORT),'0.0.0.0');
`;

function record(step: string, status: number | string, detail: unknown = null): void {
  transcript.push({ step, status, detail });
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function safeCode(body: unknown): string | undefined {
  return (body as { code?: string } | null)?.code;
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
    "Preview public key format self-check failed",
  );
  assertCondition(
    previewPrivateKey.includes("BEGIN PRIVATE KEY"),
    "Preview private key format self-check failed",
  );

  let payload = JSON.stringify({
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: controlToken,
    CLOUFLOW_RUNTIME_CONTROL_TOKEN: controlToken,
    CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: previewPublicKey,
    CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: vaultKek,
  });
  const command = "node_modules\\.bin\\wrangler.cmd secret bulk --name nabuflow-runtime-staging";
  const result = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: process.cwd(),
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Atomic staging secret rotation exceeded its bounded timeout"));
    }, 120_000);
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? -1);
    });
    child.stdin.end(payload);
  });
  payload = "";
  assertCondition(result === 0, `Atomic staging secret rotation failed with exit code ${result}`);
  record("rotation.atomic-full-set", 200, {
    entries: [
      "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
      "CLOUFLOW_RUNTIME_CONTROL_TOKEN",
      "CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY",
      "CLOUDFLARE_CAPABILITY_VAULT_KEK_V1",
    ],
    generatedInProcess: true,
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
  throw new Error(`${label}: bounded retry exhausted`);
}

function assertStatus(label: string, result: ControlResult, expected: number): void {
  record(label, result.response.status, { code: safeCode(result.body) });
  assertCondition(
    result.response.status === expected,
    `${label}: expected ${expected}, received ${result.response.status}`,
  );
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
    namespace: DEPLOYMENT_NAMESPACE,
    projectId: locator.projectId,
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
    jti: `layersgate${replay ? "pair" : "grant"}${probeNumber}${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const url = `${CONTROL_URL}/_nabuflow/preview/v1/${identity}/?__nfg=${encodeURIComponent(grant)}`;
  const redeemed = await fetch(url, { redirect: "manual" });
  const redeemedBody = await readResponse(redeemed);
  if (!replay) {
    return {
      green: redeemed.status === 302,
      status: redeemed.status,
      body: redeemedBody,
      requests: 1,
    };
  }
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

function capabilityPath(projectId: number): string {
  return `/_nabuflow/control/v1/capabilities/${projectId}/nabuflow-harness/echo`;
}

async function probeVault(probeNumber: number): Promise<ControlResult> {
  const projectId = 710_000_000 + (locator.projectId % 80_000_000);
  const revision = `layers-readiness-${projectId}-${crypto.randomUUID()}`;
  const provision = await signedFetch({
    path: capabilityPath(projectId),
    method: "PUT",
    body: { projectId, revision, definition: echoCapabilityDefinition },
    nonce: `vault-provision-${probeNumber}-${crypto.randomUUID()}`,
    idempotencyKey: `vault-provision-${projectId}-${crypto.randomUUID()}`,
  });
  if (provision.response.status !== 200) return provision;
  readinessRevisions.set(projectId, revision);
  const revoke = await signedFetch({
    path: capabilityPath(projectId),
    method: "DELETE",
    body: { projectId, expectedRevision: revision },
    nonce: `vault-revoke-${probeNumber}-${crypto.randomUUID()}`,
    idempotencyKey: `vault-revoke-${projectId}-${crypto.randomUUID()}`,
  });
  if (revoke.response.status === 200 || revoke.response.status === 404)
    readinessRevisions.delete(projectId);
  return revoke;
}

async function sustainedGreen(): Promise<void> {
  const unsigned = await fetch(`${CONTROL_URL}/_nabuflow/control/v1/version`);
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
  record("gate.surfaces", "enumerated", {
    surfaces: [
      "control HMAC signed /version",
      "fresh ES256 preview grant redemption",
      "vault KEK envelope provision plus revoke",
      "fresh preview redeem plus replay pair",
    ],
    requiredConsecutive: GATE_REQUIRED,
    maxRequests: GATE_MAX_REQUESTS,
    maxMs: GATE_MAX_MS,
  });
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
        path: "/_nabuflow/control/v1/version",
        nonce: `gate-control-${crypto.randomUUID()}`,
      });
      totalRequests += 1;
      if (result.response.status === 200) {
        const body = result.body as { deploymentVersion?: string; features?: string[] };
        deploymentVersion = body.deploymentVersion ?? deploymentVersion;
      }
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
  assertCondition(deploymentVersion.length > 0, "Gate did not observe a deployment version");
  const version = await signedControlFetch(
    { path: "/_nabuflow/control/v1/version", nonce: `version-${crypto.randomUUID()}` },
    "version",
  );
  assertStatus("version.signed", version, 200);
  const features = (version.body as { features?: string[] }).features ?? [];
  assertCondition(features.includes("artifact-v1"), "artifact-v1 advertisement disappeared");
  assertCondition(features.includes("artifact-layers-v1"), "artifact-layers-v1 is not advertised");
  record("gate.complete", 200, {
    elapsedMs: performance.now() - started,
    totalRequests,
    deploymentVersion,
    surfaces,
  });
}

async function ensureRuntime(): Promise<void> {
  runtimeIdentity = await deriveRuntimeIdentity({ namespace: DEPLOYMENT_NAMESPACE, ...locator });
  const result = await signedControlFetch(
    {
      path: runtimePath,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        manifest: {
          revision: "layers-manifest-v1",
          runtime: "node-api",
          buildCommand: ["node", "--version"],
          startCommand: ["node", "server.mjs"],
          servicePort: 8080,
          healthPath: "/healthz",
          resourceProfile: "dev",
          public: true,
        },
      },
      nonce: `ensure-${crypto.randomUUID()}`,
      idempotencyKey: `layers-ensure-${locator.projectId}`,
    },
    "ensure",
  );
  assertStatus("runtime.ensure", result, 200);
  runtimeEnsured = true;
}

async function makeLayeredArtifact(
  label: string,
  layer: SealedRuntimeArtifactLayer,
  source = LAYERED_SERVER,
) {
  assertDeclaredEntrypointDelivered(["node", "server.mjs"], ["server.mjs"]);
  const app = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: "layers-manifest-v1",
    artifactRevision: `${label}-app`,
    sourceRevision: `${label}-source`,
    files: [{ path: "server.mjs", content: source, executable: true }],
  });
  return sealLayeredRuntimeArtifact({
    app,
    layers: [layer],
    pantryRevision: {
      schemaVersion: 1,
      revisionId: "pantry-2026-08-08.1",
      rootSha256: "4".repeat(64),
      state: "committed",
      stateRevision: 1,
      updatedAt: "2026-08-08T00:00:00.000Z",
    },
    dependencyClosureSha256: "2".repeat(64),
    buildAttestationSha256: "3".repeat(64),
    platform: layer.content.descriptor.platform,
    artifactRevision: label,
  });
}

async function beginLayered(
  artifact: SealedLayeredRuntimeArtifact,
  label: string,
  expected = 200,
): Promise<ControlResult> {
  const sha = artifact.envelope.sealedArtifactSha256;
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/layered-artifacts/${sha}/begin`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, envelope: artifact.envelope },
      nonce: `${label}-begin-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-begin-${sha}`,
    },
    `${label}.begin`,
  );
  assertStatus(`${label}.begin`, result, expected);
  return result;
}

async function uploadAppChunks(
  artifact: SealedLayeredRuntimeArtifact,
  label: string,
): Promise<void> {
  const sha = artifact.envelope.sealedArtifactSha256;
  for (let index = 0; index < artifact.appChunks.length; index += 1) {
    const result = await signedControlFetch(
      {
        path: `${runtimePath}/layered-artifacts/${sha}/app/chunks/${index}`,
        method: "PUT",
        body: artifact.appChunks[index],
        nonce: `${label}-app-${index}-${crypto.randomUUID()}`,
        idempotencyKey: `${label}-app-${sha}-${index}`,
      },
      `${label}.app.${index}`,
    );
    assertStatus(`${label}.app.${index}`, result, 200);
  }
}

async function uploadLayerChunks(
  artifact: SealedLayeredRuntimeArtifact,
  hashes: string[],
  label: string,
  duplicate = false,
): Promise<void> {
  const sha = artifact.envelope.sealedArtifactSha256;
  for (const layer of artifact.layers) {
    const contentSha = layer.content.descriptor.contentSha256;
    if (!hashes.includes(contentSha)) continue;
    for (let index = 0; index < layer.chunks.length; index += 1) {
      const input = {
        path: `${runtimePath}/layered-artifacts/${sha}/layers/${contentSha}/chunks/${index}`,
        method: "PUT",
        body: layer.chunks[index],
        nonce: `${label}-layer-${index}-${crypto.randomUUID()}`,
        idempotencyKey: `${label}-layer-${sha}-${contentSha}-${index}`,
      };
      const first = await signedControlFetch(input, `${label}.layer.${index}`);
      assertStatus(`${label}.layer.${index}`, first, 200);
      if (duplicate) {
        const replay = await signedControlFetch(
          { ...input, nonce: `${label}-layer-replay-${index}-${crypto.randomUUID()}` },
          `${label}.layer-replay.${index}`,
        );
        assertStatus(`${label}.layer-replay.${index}`, replay, 200);
        assertCondition(
          JSON.stringify(first.body) === JSON.stringify(replay.body),
          "Duplicate layer upload response changed",
        );
      }
    }
  }
}

async function commitLayered(
  artifact: SealedLayeredRuntimeArtifact,
  label: string,
  expected = 200,
): Promise<ControlResult> {
  const sha = artifact.envelope.sealedArtifactSha256;
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/layered-artifacts/${sha}/commit`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256: sha },
      nonce: `${label}-commit-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-commit-${sha}`,
    },
    `${label}.commit`,
  );
  assertStatus(`${label}.commit`, result, expected);
  return result;
}

async function deliverLayered(
  artifact: SealedLayeredRuntimeArtifact,
  label: string,
  duplicate = false,
): Promise<{ uploadHashes: string[] }> {
  const firstBegin = await beginLayered(artifact, label);
  const uploadHashes =
    (firstBegin.body as { layerContentSha256ToUpload?: string[] }).layerContentSha256ToUpload ?? [];
  if (duplicate) {
    const secondBegin = await signedControlFetch(
      {
        path: `${runtimePath}/layered-artifacts/${artifact.envelope.sealedArtifactSha256}/begin`,
        method: "POST",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          envelope: artifact.envelope,
        },
        nonce: `${label}-begin-replay-${crypto.randomUUID()}`,
        idempotencyKey: `${label}-begin-${artifact.envelope.sealedArtifactSha256}`,
      },
      `${label}.begin-replay`,
    );
    assertStatus(`${label}.begin-replay`, secondBegin, 200);
    assertCondition(
      JSON.stringify(firstBegin.body) === JSON.stringify(secondBegin.body),
      "Duplicate begin response changed",
    );
  }
  await uploadAppChunks(artifact, label);
  await uploadLayerChunks(artifact, uploadHashes, label, duplicate);
  const firstCommit = await commitLayered(artifact, label);
  if (duplicate) {
    const secondCommit = await signedControlFetch(
      {
        path: `${runtimePath}/layered-artifacts/${artifact.envelope.sealedArtifactSha256}/commit`,
        method: "POST",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        },
        nonce: `${label}-commit-replay-${crypto.randomUUID()}`,
        idempotencyKey: `${label}-commit-${artifact.envelope.sealedArtifactSha256}`,
      },
      `${label}.commit-replay`,
    );
    assertStatus(`${label}.commit-replay`, secondCommit, 200);
    assertCondition(
      JSON.stringify(firstCommit.body) === JSON.stringify(secondCommit.body),
      "Duplicate commit response changed",
    );
  }
  return { uploadHashes };
}

async function startArtifact(
  artifactRevision: string,
  artifactSha256: string,
  label: string,
  expected = 200,
) {
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision,
        artifactSha256,
      },
      nonce: `${label}-start-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-start-${crypto.randomUUID()}`,
    },
    `${label}.start`,
  );
  assertStatus(`${label}.start`, result, expected);
  if (expected === 200) runtimeStarted = true;
  return result;
}

async function stopRuntime(label: string): Promise<void> {
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/stop`,
      method: "POST",
      body: { locator, reason: label },
      nonce: `${label}-stop-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-stop-${crypto.randomUUID()}`,
    },
    `${label}.stop`,
  );
  assertStatus(`${label}.stop`, result, 200);
  runtimeStarted = false;
}

async function execRuntime(label: string, source: string): Promise<unknown> {
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: ["node", "-e", source],
        cwd: "/workspace",
        timeoutMs: 20_000,
      },
      nonce: `${label}-exec-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-exec-${crypto.randomUUID()}`,
    },
    `${label}.exec`,
  );
  assertStatus(`${label}.exec`, result, 200);
  assertCondition((result.body as { ok?: boolean }).ok === true, `${label}: exec failed`);
  const stdout = (result.body as { stdout?: string }).stdout?.trim() ?? "";
  return stdout ? (JSON.parse(stdout) as unknown) : null;
}

async function removeLayered(artifact: SealedLayeredRuntimeArtifact, label: string): Promise<void> {
  const sha = artifact.envelope.sealedArtifactSha256;
  const result = await signedControlFetch(
    {
      path: `${runtimePath}/layered-artifacts/${sha}`,
      method: "DELETE",
      body: { locator, sealedArtifactSha256: sha },
      nonce: `${label}-remove-${crypto.randomUUID()}`,
      idempotencyKey: `${label}-remove-${sha}`,
    },
    `${label}.remove`,
  );
  assertStatus(`${label}.remove`, result, 200);
}

async function runNegativeMatrix(
  valid: SealedLayeredRuntimeArtifact,
  layer: SealedRuntimeArtifactLayer,
): Promise<void> {
  const altered = await makeLayeredArtifact(`altered-${Date.now()}`, layer);
  const alteredBegin = await beginLayered(altered, "negative.altered");
  await uploadAppChunks(altered, "negative.altered");
  const alteredBytes = altered.layers[0].chunks[0].slice();
  alteredBytes[0] ^= 0xff;
  const alteredResult = await signedControlFetch(
    {
      path: `${runtimePath}/layered-artifacts/${altered.envelope.sealedArtifactSha256}/layers/${altered.envelope.content.layers[0].descriptor.contentSha256}/chunks/0`,
      method: "PUT",
      body: alteredBytes,
      nonce: `altered-${crypto.randomUUID()}`,
      idempotencyKey: `altered-${crypto.randomUUID()}`,
    },
    "negative.altered-layer",
  );
  assertStatus("negative.altered-layer", alteredResult, 422);
  assertCondition(
    (alteredBegin.body as { layerContentSha256ToUpload?: string[] }).layerContentSha256ToUpload
      ?.length === 1,
    "Altered probe unexpectedly reused a layer",
  );
  await removeLayered(altered, "negative.altered-cleanup");

  const wrongPlatformLayer = await sealRuntimeArtifactLayer({
    mountPath: "node_modules",
    platform: { ...LAYER_PLATFORM, cpu: "arm64" },
    files: [
      { path: "pantry-demo/index.mjs", content: "export const pantryValue='wrong-platform'\n" },
    ],
  });
  const wrongPlatform = await makeLayeredArtifact(
    `wrong-platform-${Date.now()}`,
    wrongPlatformLayer,
  );
  await beginLayered(wrongPlatform, "negative.wrong-platform", 422);

  const staleAttestation = structuredClone(valid.envelope);
  staleAttestation.content.buildAttestationSha256 = "9".repeat(64);
  const attestationArtifact = { ...valid, envelope: staleAttestation };
  await beginLayered(attestationArtifact, "negative.attestation", 422);

  const staleManifest = structuredClone(valid.envelope);
  staleManifest.manifestRevision = "other-manifest";
  staleManifest.content.appArtifact.manifestRevision = "other-manifest";
  await beginLayered({ ...valid, envelope: staleManifest }, "negative.manifest-seal", 422);

  const quarantined = structuredClone(valid.envelope) as RuntimeLayeredArtifactEnvelope;
  (quarantined.content.pantryRevision as { state: string }).state = "quarantined";
  await beginLayered({ ...valid, envelope: quarantined }, "negative.quarantined", 400);

  const collision = structuredClone(valid.envelope);
  collision.content.appArtifact.content.files[0].path = "node_modules/pantry-demo/index.mjs";
  await beginLayered({ ...valid, envelope: collision }, "negative.overlay-collision", 400);

  const foreignIdentity = await deriveRuntimeIdentity({
    namespace: DEPLOYMENT_NAMESPACE,
    ...foreignLocator,
  });
  const foreignEnvelope = structuredClone(valid.envelope);
  foreignEnvelope.targetRuntimeIdentity = foreignIdentity;
  foreignEnvelope.content.appArtifact.targetRuntimeIdentity = foreignIdentity;
  const foreignExisting = await signedControlFetch(
    {
      path: `${runtimePath}/layered-artifacts/${foreignEnvelope.sealedArtifactSha256}/begin`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, envelope: foreignEnvelope },
      nonce: `foreign-existing-${crypto.randomUUID()}`,
      idempotencyKey: `foreign-existing-${crypto.randomUUID()}`,
    },
    "negative.foreign-existing",
  );
  assertStatus("negative.foreign-existing", foreignExisting, 403);
  const missingPath = `/_nabuflow/control/v1/runtimes/${foreignLocator.projectId}/preview/primary`;
  const foreignMissing = await signedControlFetch(
    {
      path: `${missingPath}/layered-artifacts/${valid.envelope.sealedArtifactSha256}/begin`,
      method: "POST",
      body: {
        locator: foreignLocator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: valid.envelope,
      },
      nonce: `foreign-missing-${crypto.randomUUID()}`,
      idempotencyKey: `foreign-missing-${crypto.randomUUID()}`,
    },
    "negative.foreign-missing",
  );
  assertStatus("negative.foreign-missing", foreignMissing, 403);
  const normalize = (body: unknown) => {
    const value = structuredClone(body) as Record<string, unknown>;
    delete value.requestId;
    return JSON.stringify(value);
  };
  assertCondition(
    normalize(foreignExisting.body) === normalize(foreignMissing.body),
    "Runtime mismatch responses are distinguishable",
  );

  const uncommitted = await makeLayeredArtifact(`uncommitted-${Date.now()}`, layer);
  await beginLayered(uncommitted, "negative.uncommitted");
  const uncommittedStart = await startArtifact(
    uncommitted.envelope.artifactRevision,
    uncommitted.envelope.sealedArtifactSha256,
    "negative.uncommitted",
    409,
  );
  assertCondition(
    safeCode(uncommittedStart.body) === "artifact_not_committed",
    "Uncommitted start returned wrong code",
  );
  await removeLayered(uncommitted, "negative.uncommitted-cleanup");

  const incomplete = await makeLayeredArtifact(`incomplete-${Date.now()}`, layer);
  await beginLayered(incomplete, "negative.incomplete");
  await uploadAppChunks(incomplete, "negative.incomplete");
  const incompleteCommit = await commitLayered(incomplete, "negative.incomplete", 409);
  assertCondition(
    safeCode(incompleteCommit.body) === "artifact_incomplete",
    "Incomplete commit returned wrong code",
  );

  let fakeSecretRejected = false;
  try {
    await sealRuntimeArtifactLayer({
      mountPath: "node_modules",
      platform: LAYER_PLATFORM,
      files: [
        { path: "fake/index.mjs", content: "export const fake='sk_test_ABCDEFGHIJKLMNOPQRSTUV'\n" },
      ],
    });
  } catch (error) {
    fakeSecretRejected =
      error instanceof RuntimeArtifactLayerSealError && error.code === "artifact_secret_detected";
  }
  assertCondition(fakeSecretRejected, "Planted fake credential was not refused before upload");
  record("negative.fake-credential-seal", "refused", {
    code: "artifact_secret_detected",
    uploadBegun: false,
  });
}

async function runAcceptance(): Promise<void> {
  await ensureRuntime();
  const v1 = await deliverScratchArtifact({
    runtimePath,
    locator,
    deploymentVersion,
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: "layers-manifest-v1",
    artifactRevision: `v1-${Date.now()}`,
    sourceRevision: `v1-source-${Date.now()}`,
    manifestStartCommand: ["node", "server.mjs"],
    serverPath: "server.mjs",
    serverSource: V1_SERVER,
    send: signedControlFetch,
  });
  await startArtifact(v1.artifactRevision, v1.sealedArtifactSha256, "v1.compatibility");
  const v1Health = await execRuntime(
    "v1.health",
    "fetch('http://127.0.0.1:8080/healthz').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))",
  );
  assertCondition(
    (v1Health as { status?: number; body?: string }).status === 200 &&
      (v1Health as { body?: string }).body === "healthy-v1",
    "Artifact v1 live compatibility failed",
  );
  await stopRuntime("v1-compatibility");
  const v1Remove = await signedControlFetch(
    {
      path: `${runtimePath}/artifacts/${v1.sealedArtifactSha256}`,
      method: "DELETE",
      body: { locator, sealedArtifactSha256: v1.sealedArtifactSha256 },
      nonce: `v1-remove-${crypto.randomUUID()}`,
      idempotencyKey: `v1-remove-${v1.sealedArtifactSha256}`,
    },
    "v1.remove",
  );
  assertStatus("v1.remove", v1Remove, 200);

  const binary = Uint8Array.from({ length: 4_097 }, (_value, index) => (index * 71 + 23) % 256);
  const layer = await sealRuntimeArtifactLayer({
    mountPath: "node_modules",
    platform: LAYER_PLATFORM,
    files: [
      {
        path: "pantry-demo/index.mjs",
        content: "export const pantryValue='dated-shelf-ingredient'\n",
      },
      { path: "pantry-demo/fixture.bin", content: binary },
      {
        path: "pantry-demo/bin/tool.sh",
        content: "#!/bin/sh\nprintf pantry-tool\n",
        executable: true,
      },
    ],
  });
  const first = await makeLayeredArtifact(`layers-first-${Date.now()}`, layer);
  await runNegativeMatrix(first, layer);
  const firstDelivery = await deliverLayered(first, "layers.first", true);
  assertCondition(
    firstDelivery.uploadHashes.length === 1,
    "First artifact did not upload its dependency layer exactly once",
  );
  await startArtifact(
    first.envelope.artifactRevision,
    first.envelope.sealedArtifactSha256,
    "layers.first",
  );
  const expectedBinarySha = await sha256Hex(binary);
  const firstProof = await execRuntime(
    "layers.first-proof",
    `const f=require('node:fs'),c=require('node:crypto'),r='/workspace/.nabuflow/releases/${first.envelope.sealedArtifactSha256}/app';fetch('http://127.0.0.1:8080/').then(async x=>console.log(JSON.stringify({status:x.status,body:JSON.parse(await x.text()),binaryBytes:f.statSync(r+'/node_modules/pantry-demo/fixture.bin').size,binarySha:c.createHash('sha256').update(f.readFileSync(r+'/node_modules/pantry-demo/fixture.bin')).digest('hex'),toolMode:f.statSync(r+'/node_modules/pantry-demo/bin/tool.sh').mode&511})))`,
  );
  assertCondition(
    (firstProof as { status?: number }).status === 200 &&
      (firstProof as { body?: { pantryValue?: string } }).body?.pantryValue ===
        "dated-shelf-ingredient" &&
      (firstProof as { binaryBytes?: number }).binaryBytes === binary.byteLength &&
      (firstProof as { binarySha?: string }).binarySha === expectedBinarySha &&
      (firstProof as { toolMode?: number }).toolMode === 0o755,
    "Layered materialization, binary, or mode proof failed",
  );
  record("layers.materialization.verified", 200, {
    binaryBytes: binary.byteLength,
    binarySha: expectedBinarySha,
    executableMode: "0755",
  });

  const tamper = await execRuntime(
    "layers.tamper",
    `const f=require('node:fs'),r='/workspace/.nabuflow/releases/${first.envelope.sealedArtifactSha256}/app';f.writeFileSync(r+'/server.mjs','tampered');f.writeFileSync(r+'/node_modules/pantry-demo/fixture.bin',Buffer.from([1,2,3]));console.log(JSON.stringify({tampered:true}))`,
  );
  assertCondition((tamper as { tampered?: boolean }).tampered === true, "Tamper simulation failed");
  await stopRuntime("layers-tamper");
  await startArtifact(
    first.envelope.artifactRevision,
    first.envelope.sealedArtifactSha256,
    "layers.rehydrate",
  );
  const restored = await execRuntime(
    "layers.rehydrate-proof",
    `const f=require('node:fs'),c=require('node:crypto'),r='/workspace/.nabuflow/releases/${first.envelope.sealedArtifactSha256}/app';fetch('http://127.0.0.1:8080/healthz').then(async x=>console.log(JSON.stringify({status:x.status,body:await x.text(),binarySha:c.createHash('sha256').update(f.readFileSync(r+'/node_modules/pantry-demo/fixture.bin')).digest('hex')})))`,
  );
  assertCondition(
    (restored as { status?: number }).status === 200 &&
      (restored as { body?: string }).body === "healthy-layered" &&
      (restored as { binarySha?: string }).binarySha === expectedBinarySha,
    "R2 rehydration did not restore the sealed release",
  );
  record("layers.rehydration.verified", 200, {
    source: "private-r2",
    perFileHashVerified: true,
    tamperRepaired: true,
  });
  await stopRuntime("layers-first-complete");

  const second = await makeLayeredArtifact(
    `layers-second-${Date.now()}`,
    layer,
    LAYERED_SERVER.replace("dated-shelf-ingredient", "dated-shelf-ingredient"),
  );
  const secondDelivery = await deliverLayered(second, "layers.second");
  assertCondition(
    secondDelivery.uploadHashes.length === 0,
    "Shared committed layer was uploaded twice",
  );
  record("layers.shared-reference", 200, {
    layerContentSha256: layer.content.descriptor.contentSha256,
    firstUploadCount: 1,
    secondUploadCount: 0,
    references: 2,
  });
  await removeLayered(first, "layers.first-retire");
  await startArtifact(
    second.envelope.artifactRevision,
    second.envelope.sealedArtifactSha256,
    "layers.second-after-first-remove",
  );
  const retained = await execRuntime(
    "layers.shared-retained",
    "fetch('http://127.0.0.1:8080/').then(async r=>console.log(JSON.stringify({status:r.status,body:JSON.parse(await r.text())})))",
  );
  assertCondition(
    (retained as { status?: number }).status === 200 &&
      (retained as { body?: { pantryValue?: string } }).body?.pantryValue ===
        "dated-shelf-ingredient",
    "Shared layer disappeared after one reference was removed",
  );
  await stopRuntime("layers-second-complete");
  await removeLayered(second, "layers.second-retire");
}

async function cleanup(): Promise<void> {
  for (const [projectId, expectedRevision] of [...readinessRevisions]) {
    const result = await signedControlFetch(
      {
        path: capabilityPath(projectId),
        method: "DELETE",
        body: { projectId, expectedRevision },
        nonce: `cleanup-vault-${crypto.randomUUID()}`,
        idempotencyKey: `cleanup-vault-${crypto.randomUUID()}`,
      },
      "cleanup.vault",
    );
    if (result.response.status !== 200 && result.response.status !== 404)
      throw new Error("Vault readiness cleanup failed");
    readinessRevisions.delete(projectId);
  }
  if (runtimeStarted) await stopRuntime("cleanup");
  if (runtimeEnsured) {
    const destroyed = await signedControlFetch(
      {
        path: runtimePath,
        method: "DELETE",
        body: { locator, reason: "layered artifact staging acceptance cleanup" },
        nonce: `cleanup-destroy-${crypto.randomUUID()}`,
        idempotencyKey: `cleanup-destroy-${crypto.randomUUID()}`,
      },
      "cleanup.destroy",
    );
    assertStatus("cleanup.destroy", destroyed, 200);
    runtimeEnsured = false;
    const status = await signedControlFetch(
      { path: runtimePath, nonce: `cleanup-status-${crypto.randomUUID()}` },
      "cleanup.status",
    );
    assertStatus("cleanup.status-after-destroy", status, 404);
  }
}

async function main(): Promise<void> {
  let failure: string | null = null;
  await rotateWorkerSecrets();
  try {
    await sustainedGreen();
    await runAcceptance();
  } catch (error) {
    failure =
      error instanceof Error ? error.message : "Unknown layered artifact acceptance failure";
  } finally {
    try {
      await cleanup();
    } catch (error) {
      const cleanupFailure = error instanceof Error ? error.message : "Unknown cleanup failure";
      failure = failure === null ? cleanupFailure : `${failure}; cleanup: ${cleanupFailure}`;
    }
    controlToken = "";
    previewPrivateKey = "";
    previewPublicKey = "";
    vaultKek = "";
  }

  const evidence = {
    slice: "2b-ix-b2",
    workerUrl: CONTROL_URL,
    scratchProjectId: locator.projectId,
    runtimeIdentity,
    deploymentVersion,
    checks: transcript.length,
    transcript,
    cleanup: {
      runtimeDestroyed: !runtimeEnsured,
      readinessVaultRecords: readinessRevisions.size,
      sessionValuesErased:
        controlToken === "" &&
        previewPrivateKey === "" &&
        previewPublicKey === "" &&
        vaultKek === "",
    },
    failure,
  };
  const evidencePath = resolve(
    process.cwd(),
    "../../../tmp/gateway-artifact-layers-staging-evidence.json",
  );
  mkdirSync(resolve(process.cwd(), "../../../tmp"), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8" });
  if (failure !== null) throw new Error(failure);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      deploymentVersion,
      scratchProjectId: locator.projectId,
      runtimeIdentity,
      checks: transcript.length,
      evidencePath,
      cleanup: evidence.cleanup,
    })}\n`,
  );
}

await main();
