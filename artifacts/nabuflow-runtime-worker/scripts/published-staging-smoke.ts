import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_RUNTIME_ARTIFACT_FILE_BYTES,
  MAX_RUNTIME_ARTIFACT_BYTES,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  deriveRuntimeIdentity,
  sha256Hex,
  signControlRequest,
  signPreviewGrant,
  signStagingHostOverride,
  type CapabilityDefinition,
  type CapabilityIntent,
  type CapabilityInvocation,
} from "@workspace/tenant-runtime-contracts";
import WebSocket from "ws";
import { deliverScratchArtifact } from "./artifact-delivery";
import {
  RuntimeArtifactSealError,
  sealRuntimeArtifact,
} from "../../api-server/src/lib/runtime-artifact";

const controlUrl = required("CLOUDFLARE_RUNTIME_CONTROL_URL").replace(/\/$/, "");
const controlToken = required("CLOUDFLARE_RUNTIME_CONTROL_TOKEN");
const previewPrivateKey = required("CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY");
const deploymentNamespace = required("CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE");
const neonDatabaseUrl = required("NEON_DATABASE_URL");
const neonDatabaseHost = new URL(neonDatabaseUrl).hostname;
const stripeTestSecretKey = required("STRIPE_TEST_SECRET_KEY");
if (!/^sk_test_[A-Za-z0-9]+$/u.test(stripeTestSecretKey)) {
  throw new Error("STRIPE_TEST_SECRET_KEY must be a Stripe test-mode secret key");
}
const holdSignal = process.env.NABUFLOW_PUBLISHED_HOLD_SIGNAL;
const readyPath = process.env.NABUFLOW_PUBLISHED_BROWSER_READY;
const workerPackageRoot = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = resolveWorkerOutputPath(process.env.NABUFLOW_PUBLISHED_EVIDENCE_PATH);
const stopAfterManifestFailure = process.env.NABUFLOW_STOP_AFTER_MANIFEST_FAILURE === "1";
const manifestFailureIterations = readBoundedInteger(
  process.env.NABUFLOW_MANIFEST_FAILURE_ITERATIONS,
  1,
  1,
  25,
  "NABUFLOW_MANIFEST_FAILURE_ITERATIONS",
);
const workerHost = new URL(controlUrl).hostname;
const capabilityEndpoint = "/_nabuflow/capability/v1/invoke";
const capabilityIntentUrl = "http://doorman.staging.nabuflow.internal/v1/invoke";
const ARTIFACT_BINARY_PATH = "assets/runtime-fixture.bin";
const ARTIFACT_BINARY_FIXTURE = Uint8Array.from(
  { length: 4_097 },
  (_value, index) => (index * 73 + 19) % 256,
);

const TENANT_SERVER_SOURCE = String.raw`
const http=require('node:http');
const crypto=require('node:crypto');
const collect=async(req)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks)};
const sendJson=(res,value)=>{res.statusCode=200;res.setHeader('content-type','application/json');res.end(JSON.stringify(value))};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/','http://tenant.invalid');
  if(url.pathname==='/health'||url.pathname==='/health-old'){res.statusCode=200;res.end('healthy');return}
  if(url.pathname==='/sse'){
    res.statusCode=200;res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');
    res.write('event: ready\ndata: first\n\n');
    setTimeout(()=>{res.write('event: tick\ndata: second\n\n');res.end()},1500);return
  }
  if(url.pathname==='/cookie-bad'){
    res.statusCode=200;res.setHeader('set-cookie','tenant_session=secret; Domain=.mustaflow.com; Path=/');res.end('cookie');return
  }
  if(url.pathname==='/intentionally-missing-health'){res.statusCode=503;res.end('unhealthy');return}
  if(url.pathname==='/'){
    res.statusCode=200;res.setHeader('content-type','text/html; charset=utf-8');
    const servedAt=new Date().toISOString();const receivedCookie=req.headers.cookie||'none';
    res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NabuFlow Anonymous Published Staging</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#060f1d;color:#edf6ff;font-family:Inter,system-ui}.card{width:min(800px,86vw);padding:48px;border:1px solid #31547e;border-radius:24px;background:linear-gradient(145deg,#102744,#081629);box-shadow:0 24px 90px #0009}.eyebrow{color:#72eadb;text-transform:uppercase;letter-spacing:.16em;font-size:12px}.ok,.ws{margin-top:16px;padding:12px 16px;border-radius:12px;background:#143f37;color:#91f7d8}.ws{background:#183354;color:#c6ddff}.ws.passed{background:#143f37;color:#91f7d8}h1{font-size:42px;margin:22px 0 14px}p{color:#b5c9e4;line-height:1.65}.meta{margin-top:28px;padding-top:22px;border-top:1px solid #2a496d;color:#a6bfdf;font-family:ui-monospace,monospace;line-height:1.8}</style></head><body><main class="card"><div class="eyebrow">Gateway Doorman — Slice 2b-v</div><h1>NabuFlow Gateway — Anonymous Published Staging</h1><p>This published application was reached by hostname with no grant, session, or login.</p><div class="ok">Anonymous storefront access confirmed</div><div id="ws-result" class="ws">WebSocket: connecting anonymously…</div><div class="meta"><div>served at: '+servedAt+'</div><div>runtime identity: '+process.env.NABUFLOW_RUNTIME_ID+'</div><div>runtime slot: production-blue</div><div>tenant port: '+process.env.PORT+'</div><div>HTTP cookie received: '+receivedCookie+'</div></div></main><script>(function(){const status=document.getElementById("ws-result");const socket=new WebSocket(location.origin.replace(/^http/,"ws")+"/socket");socket.addEventListener("open",function(){socket.send("browser-anonymous-published-echo")});socket.addEventListener("message",function(event){status.textContent="WebSocket echo: "+event.data;status.classList.add("passed");status.setAttribute("data-state","passed");socket.close()});socket.addEventListener("error",function(){status.textContent="WebSocket echo failed";status.setAttribute("data-state","failed")})})();</script></body></html>');return
  }
  const body=await collect(req);
  sendJson(res,{method:req.method,url:req.url,bodyBytes:body.length,bodySha256:crypto.createHash('sha256').update(body).digest('hex'),headers:req.headers});
});
server.on('upgrade',(req,socket)=>{
  const key=req.headers['sec-websocket-key'];if(typeof key!=='string'){socket.destroy();return}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let pending=Buffer.alloc(0);socket.on('data',(chunk)=>{pending=Buffer.concat([pending,chunk]);if(pending.length<6)return;let length=pending[1]&127;let offset=2;if(length===126){if(pending.length<8)return;length=pending.readUInt16BE(2);offset=4}const masked=(pending[1]&128)!==0;if(!masked||pending.length<offset+4+length)return;const mask=pending.subarray(offset,offset+4);offset+=4;const payload=Buffer.alloc(length);for(let i=0;i<length;i++)payload[i]=pending[offset+i]^mask[i%4];const reply=Buffer.from('echo:'+payload.toString('utf8'));const header=reply.length<126?Buffer.from([0x81,reply.length]):Buffer.from([0x81,126,reply.length>>8,reply.length&255]);socket.write(Buffer.concat([header,reply]));pending=Buffer.alloc(0)});
});
server.listen(Number(process.env.PORT),'0.0.0.0',()=>console.log('published tenant ready on '+process.env.PORT));
`;

interface TranscriptEntry {
  step: string;
  status: number | string;
  detail: unknown;
}

const transcript: TranscriptEntry[] = [];
const locator = {
  projectId: 800_000_000 + (Date.now() % 90_000_000),
  role: "production" as const,
  slot: "blue" as const,
};
const foreignExistingProjectId = locator.projectId + 1;
const foreignMissingProjectId = locator.projectId + 2;
const runtimePath = `/_nabuflow/control/v1/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
const simulatedHost = `slice-2b-viii-${locator.projectId}.apps.mustaflow.com`;
const registeredHosts = new Set<string>();
let deploymentVersion = "";
let workerClockOffsetMs = 0;
let runtimeEnsured = false;
let runtimeStarted = false;
let manifestRevision = "";
let runtimeIdentity = "";
let activeContainerId = "";
const provisionedCapabilityProjects = new Set<number>();
const provisionedDatabaseProjects = new Set<number>();
const provisionedStripeProjects = new Set<number>();
const readinessCapabilityRevisions = new Map<number, string>();
const stripeCapabilityRevisions = new Map<number, string>();
const stripePaymentIntentIds = new Set<string>();
let stripeAcceptanceStartedAtSeconds = 0;

const stripeProviderLeakPatterns = [
  /\breq_[A-Za-z0-9]+\b/u,
  new RegExp(
    "\\b(?:amount_too_small|api_connection_error|api_error|api_key_expired|authentication_error|" +
      "card_error|idempotency_error|invalid_request_error|parameter_invalid_integer|parameter_missing|" +
      "payment_intent_unexpected_state|rate_limit_error|resource_missing|testmode_charges_only)\\b",
    "u",
  ),
  new RegExp(
    "\\b(?:request-id|stripe-account|stripe-signature|stripe-should-retry|stripe-version|" +
      "x-stripe-client-user-agent)\\b",
    "iu",
  ),
];

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

const databaseCapabilityDefinition: CapabilityDefinition = {
  name: "database",
  provider: "neon-postgres",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/query" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 262_144,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

const stripeCapabilityDefinition: CapabilityDefinition = {
  name: "payments",
  provider: "stripe",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/payment-intents" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 8_192,
    maxResponseBytes: 65_536,
    maxRequestsPerMinute: 30,
    maxConcurrent: 4,
  },
};

const stripePolicy = {
  allowedCurrencies: ["usd"],
  maxAmount: 50_000,
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function nonce(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(step: string, status: number | string, detail: unknown): void {
  transcript.push({ step, status, detail });
}

function resolveWorkerOutputPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (isAbsolute(value)) return value;

  const normalizedValue = normalize(value);
  const workspacePackagePrefix = `${normalize("artifacts/nabuflow-runtime-worker")}${sep}`;
  const packageRelativeValue = normalizedValue.startsWith(workspacePackagePrefix)
    ? normalizedValue.slice(workspacePackagePrefix.length)
    : normalizedValue;
  return resolve(workerPackageRoot, packageRelativeValue);
}

function assertStatus(step: string, actual: number, expected: number, detail: unknown): void {
  record(step, actual, detail);
  if (actual !== expected)
    throw new Error(`${step}: expected HTTP ${expected}, received ${actual}`);
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function makeSignedRequest(input: {
  path: string;
  method?: string;
  body?: unknown | Uint8Array;
  timestampMs?: number;
  nonce: string;
  idempotencyKey?: string;
  signatureOverride?: string;
}): Promise<Request> {
  const method = input.method ?? "GET";
  const rawBody =
    input.body instanceof Uint8Array
      ? input.body
      : input.body === undefined
        ? ""
        : JSON.stringify(input.body);
  const timestamp = String(input.timestampMs ?? Date.now() + workerClockOffsetMs);
  const bodySha256 = await sha256Hex(rawBody);
  const idempotencyKey = input.idempotencyKey ?? "";
  const signature =
    input.signatureOverride ??
    (await signControlRequest(controlToken, {
      method,
      pathAndQuery: input.path,
      timestamp,
      nonce: input.nonce,
      bodySha256,
      idempotencyKey,
    }));
  return new Request(`${controlUrl}${input.path}`, {
    method,
    body:
      typeof rawBody === "string" ? rawBody || undefined : (rawBody.slice().buffer as ArrayBuffer),
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

async function signedFetch(input: Parameters<typeof makeSignedRequest>[0]) {
  const response = await fetch(await makeSignedRequest(input));
  return { response, body: await readResponse(response) };
}

function isPropagationRetryable(status: number, body: unknown): boolean {
  const code = (body as { code?: string } | null)?.code;
  return (
    (status === 401 && code === "invalid_signature") ||
    (status === 502 && code !== "runtime_restart_failed") ||
    status === 503 ||
    status === 504
  );
}

async function signedControlFetch(input: Parameters<typeof makeSignedRequest>[0], label: string) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await signedFetch({
      ...input,
      nonce: attempt === 1 ? input.nonce : nonce(`${label}-retry-${attempt}`),
    });
    if (!isPropagationRetryable(result.response.status, result.body) || attempt === 8) {
      return result;
    }
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
    record(`control.retry.${label}`, result.response.status, {
      attempt,
      backoffMs,
      code: (result.body as { code?: string }).code,
    });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error(`${label}: bounded control retry exhausted without a response`);
}

async function signedAuthStableFetch(
  input: Parameters<typeof makeSignedRequest>[0],
  label: string,
) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await signedFetch({
      ...input,
      nonce: attempt === 1 ? input.nonce : nonce(`${label}-auth-retry-${attempt}`),
    });
    const code = (result.body as { code?: string } | null)?.code;
    if (!(result.response.status === 401 && code === "invalid_signature") || attempt === 8) {
      return result;
    }
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
    record(`control.retry.${label}`, result.response.status, {
      attempt,
      backoffMs,
      code,
      targetResponseMayBeNonSuccess: true,
    });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error(`${label}: bounded authentication retry exhausted without a response`);
}

async function acceptedReplayableRequest(
  input: Parameters<typeof makeSignedRequest>[0],
  label: string,
) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const request = await makeSignedRequest({
      ...input,
      nonce: attempt === 1 ? input.nonce : nonce(`${label}-retry-${attempt}`),
    });
    const response = await fetch(request.clone());
    const body = await readResponse(response);
    if (!isPropagationRetryable(response.status, body) || attempt === 8) {
      return { request, response, body };
    }
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
    record(`control.retry.${label}`, response.status, {
      attempt,
      backoffMs,
      code: (body as { code?: string }).code,
    });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error(`${label}: bounded replayable retry exhausted without a response`);
}

async function replaySignedRequest(request: Request, label: string) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await fetch(request.clone());
    const body = await readResponse(response);
    if (!isPropagationRetryable(response.status, body) || attempt === 8) {
      return { response, body };
    }
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
    record(`control.retry.${label}`, response.status, {
      attempt,
      backoffMs,
      code: (body as { code?: string }).code,
      exactRequestReplay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error(`${label}: bounded exact-request replay exhausted without a response`);
}

const SUSTAINED_GREEN_REQUIRED = 20;
const SUSTAINED_GREEN_MAX_PROBES = 600;
const SUSTAINED_GREEN_MAX_ELAPSED_MS = 5 * 60 * 1_000;

interface ReadinessSurface {
  consecutive: number;
  totalProbes: number;
  firstGreenMs?: number;
  completedMs?: number;
  lastStatus?: number;
  lastCode?: string;
}

async function probePreviewGrantReadiness(probeNumber: number): Promise<{
  status: number;
  body: unknown;
}> {
  const previewIdentity = await deriveRuntimeIdentity({
    namespace: deploymentNamespace,
    projectId: locator.projectId,
    role: "preview",
    slot: "primary",
  });
  const nowSeconds = Math.floor((Date.now() + workerClockOffsetMs) / 1_000);
  const grant = await signPreviewGrant(previewPrivateKey, {
    v: 1,
    iss: "nabuflow-api",
    aud: controlUrl,
    sub: previewIdentity,
    port: 8080,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: `readiness${probeNumber}${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const path = `/_nabuflow/preview/v1/${previewIdentity}/`;
  const response = await fetch(`${controlUrl}${path}?__nfg=${encodeURIComponent(grant)}`, {
    redirect: "manual",
  });
  return { status: response.status, body: await readResponse(response) };
}

async function probePreviewGrantReplayReadiness(probeNumber: number): Promise<{
  status: number;
  body: unknown;
  green: boolean;
  requestCount: number;
}> {
  const previewIdentity = await deriveRuntimeIdentity({
    namespace: deploymentNamespace,
    projectId: locator.projectId,
    role: "preview",
    slot: "primary",
  });
  const nowSeconds = Math.floor((Date.now() + workerClockOffsetMs) / 1_000);
  const grant = await signPreviewGrant(previewPrivateKey, {
    v: 1,
    iss: "nabuflow-api",
    aud: controlUrl,
    sub: previewIdentity,
    port: 8080,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: `readinesspair${probeNumber}${crypto.randomUUID().replaceAll("-", "")}`,
  });
  const path = `/_nabuflow/preview/v1/${previewIdentity}/`;
  const url = `${controlUrl}${path}?__nfg=${encodeURIComponent(grant)}`;
  const redeemed = await fetch(url, { redirect: "manual" });
  const redeemedBody = await readResponse(redeemed);
  const replayed = await fetch(url, { redirect: "manual" });
  const replayedBody = await readResponse(replayed);
  const replayCode = (replayedBody as { code?: string } | null)?.code;
  return {
    status: replayed.status,
    body: {
      code: replayCode,
      redeemStatus: redeemed.status,
      redeemCode: (redeemedBody as { code?: string } | null)?.code,
      replayStatus: replayed.status,
      replayCode,
    },
    green:
      redeemed.status === 302 && replayed.status === 409 && replayCode === "preview_grant_replayed",
    requestCount: 2,
  };
}

async function probeVaultKekReadiness(probeNumber: number): Promise<{
  status: number;
  body: unknown;
}> {
  const projectId = 700_000_000 + (locator.projectId % 90_000_000);
  const revision = `readiness-v1-${projectId}-${crypto.randomUUID()}`;
  const path = capabilityControlPath(projectId);
  const provision = await signedFetch({
    path,
    method: "PUT",
    body: { projectId, revision, definition: echoCapabilityDefinition },
    nonce: nonce(`vault-readiness-provision-${probeNumber}`),
    idempotencyKey: `vault-readiness-provision-${projectId}-${crypto.randomUUID()}`,
  });
  if (provision.response.status !== 200) {
    return { status: provision.response.status, body: provision.body };
  }
  readinessCapabilityRevisions.set(projectId, revision);

  const revoke = await signedFetch({
    path,
    method: "DELETE",
    body: { projectId, expectedRevision: revision },
    nonce: nonce(`vault-readiness-revoke-${probeNumber}`),
    idempotencyKey: `vault-readiness-revoke-${projectId}-${crypto.randomUUID()}`,
  });
  if (revoke.response.status === 200 || revoke.response.status === 404) {
    readinessCapabilityRevisions.delete(projectId);
  }
  return { status: revoke.response.status, body: revoke.body };
}

async function waitForSustainedGreenWindow(): Promise<unknown> {
  const startedAt = performance.now();
  const surfaces: Record<
    "controlHmac" | "previewGrant" | "previewGrantReplay" | "vaultKek",
    ReadinessSurface
  > = {
    controlHmac: { consecutive: 0, totalProbes: 0 },
    previewGrant: { consecutive: 0, totalProbes: 0 },
    previewGrantReplay: { consecutive: 0, totalProbes: 0 },
    vaultKek: { consecutive: 0, totalProbes: 0 },
  };
  let totalRequests = 0;
  let stableVersion = "";
  let lastBody: unknown = null;
  record("auth.sustained-green.surfaces", "enumerated", {
    atomicSecretEntries: [
      {
        name: "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
        surface: "signed control /version",
      },
      {
        name: "CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY",
        surface: "fresh ES256 preview-grant redemption",
      },
      {
        name: "CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY",
        surface: "fresh ES256 preview-grant redeem plus replay-detection pair",
      },
      {
        name: "CLOUDFLARE_CAPABILITY_VAULT_KEK_V1",
        surface: "echo-vault envelope encrypt and strict-body revoke",
      },
      {
        name: "CLOUFLOW_RUNTIME_CONTROL_TOKEN",
        surface: "legacy adapter alias; same value as control token; no Worker binding",
      },
    ],
    requiredConsecutivePerSurface: SUSTAINED_GREEN_REQUIRED,
    maxElapsedMs: SUSTAINED_GREEN_MAX_ELAPSED_MS,
    maxRequests: SUSTAINED_GREEN_MAX_PROBES,
  });

  const allComplete = () =>
    Object.values(surfaces).every((surface) => surface.consecutive >= SUSTAINED_GREEN_REQUIRED);
  const updateSurface = (
    name: keyof typeof surfaces,
    green: boolean,
    status: number,
    body: unknown,
  ) => {
    const surface = surfaces[name];
    surface.totalProbes += 1;
    surface.lastStatus = status;
    surface.lastCode = (body as { code?: string } | null)?.code;
    if (green) {
      surface.consecutive += 1;
      surface.firstGreenMs ??= performance.now() - startedAt;
      if (surface.consecutive === SUSTAINED_GREEN_REQUIRED) {
        surface.completedMs = performance.now() - startedAt;
      }
      return;
    }
    surface.consecutive = 0;
    surface.firstGreenMs = undefined;
    surface.completedMs = undefined;
    record(`auth.sustained-green.${name}.reset`, status, {
      totalProbes: surface.totalProbes,
      code: surface.lastCode,
    });
  };

  while (
    !allComplete() &&
    totalRequests < SUSTAINED_GREEN_MAX_PROBES &&
    performance.now() - startedAt < SUSTAINED_GREEN_MAX_ELAPSED_MS
  ) {
    if (surfaces.controlHmac.consecutive < SUSTAINED_GREEN_REQUIRED) {
      totalRequests += 1;
      const result = await signedFetch({
        path: "/_nabuflow/control/v1/version",
        nonce: nonce(`sustained-green-control-${surfaces.controlHmac.totalProbes + 1}`),
      });
      lastBody = result.body;
      const observedVersion =
        (result.body as { deploymentVersion?: string }).deploymentVersion ?? "";
      const green = result.response.status === 200 && observedVersion.length > 0;
      if (green && stableVersion && stableVersion !== observedVersion) {
        surfaces.controlHmac.consecutive = 0;
      }
      stableVersion = green ? observedVersion : "";
      updateSurface("controlHmac", green, result.response.status, result.body);
    }

    if (
      surfaces.previewGrant.consecutive < SUSTAINED_GREEN_REQUIRED &&
      totalRequests < SUSTAINED_GREEN_MAX_PROBES
    ) {
      totalRequests += 1;
      const result = await probePreviewGrantReadiness(surfaces.previewGrant.totalProbes + 1);
      updateSurface("previewGrant", result.status === 302, result.status, result.body);
    }

    if (
      surfaces.vaultKek.consecutive < SUSTAINED_GREEN_REQUIRED &&
      totalRequests + 1 < SUSTAINED_GREEN_MAX_PROBES
    ) {
      totalRequests += 2;
      const result = await probeVaultKekReadiness(surfaces.vaultKek.totalProbes + 1);
      updateSurface("vaultKek", result.status === 200, result.status, result.body);
    }

    if (
      surfaces.previewGrantReplay.consecutive < SUSTAINED_GREEN_REQUIRED &&
      totalRequests + 1 < SUSTAINED_GREEN_MAX_PROBES
    ) {
      const result = await probePreviewGrantReplayReadiness(
        surfaces.previewGrantReplay.totalProbes + 1,
      );
      totalRequests += result.requestCount;
      updateSurface("previewGrantReplay", result.green, result.status, result.body);
    }

    if (!allComplete()) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  assertCondition(
    allComplete(),
    `Multi-surface authentication did not converge: ${JSON.stringify(surfaces)}`,
  );
  record("auth.sustained-green.multi-surface", 200, {
    surfaces,
    totalRequests,
    elapsedMs: performance.now() - startedAt,
    deploymentVersion: stableVersion,
  });
  return lastBody;
}

function capabilityControlPath(projectId: number): string {
  return `/_nabuflow/control/v1/capabilities/${projectId}/nabuflow-harness/echo`;
}

async function provisionCapability(projectId: number): Promise<void> {
  const revision = `echo-v1-${projectId}`;
  const result = await signedControlFetch(
    {
      path: capabilityControlPath(projectId),
      method: "PUT",
      body: { projectId, revision, definition: echoCapabilityDefinition },
      nonce: nonce(`capability-provision-${projectId}`),
      idempotencyKey: `capability-provision-${projectId}-${crypto.randomUUID()}`,
    },
    `capability.provision.${projectId}`,
  );
  assertStatus(`capability.provision.${projectId}`, result.response.status, 200, result.body);
  assertCondition(
    (result.body as { keyId?: string }).keyId === "v1",
    "Capability provision did not use the active v1 envelope key",
  );
  provisionedCapabilityProjects.add(projectId);
}

async function revokeCapability(projectId: number): Promise<void> {
  if (!provisionedCapabilityProjects.has(projectId)) return;
  const result = await signedControlFetch(
    {
      path: capabilityControlPath(projectId),
      method: "DELETE",
      body: { projectId, expectedRevision: `echo-v1-${projectId}` },
      nonce: nonce(`capability-revoke-${projectId}`),
      idempotencyKey: `capability-revoke-${projectId}-${crypto.randomUUID()}`,
    },
    `capability.revoke.${projectId}`,
  );
  record(`capability.revoke.${projectId}`, result.response.status, result.body);
  if (result.response.status !== 200 && result.response.status !== 404) {
    throw new Error(`Capability cleanup failed for project ${projectId}`);
  }
  provisionedCapabilityProjects.delete(projectId);
}

function databaseCapabilityControlPath(projectId: number): string {
  return `/_nabuflow/control/v1/capabilities/${projectId}/neon-postgres/database`;
}

async function provisionDatabaseCapability(projectId: number): Promise<void> {
  const revision = `database-v1-${projectId}`;
  const result = await signedControlFetch(
    {
      path: databaseCapabilityControlPath(projectId),
      method: "PUT",
      body: {
        projectId,
        revision,
        definition: databaseCapabilityDefinition,
        credential: { kind: "neon-connection-string", value: neonDatabaseUrl },
      },
      nonce: nonce(`database-provision-${projectId}`),
      idempotencyKey: `database-provision-${projectId}-${crypto.randomUUID()}`,
    },
    `database.provision.${projectId}`,
  );
  assertStatus(`database.provision.${projectId}`, result.response.status, 200, result.body);
  assertCondition(
    (result.body as { keyId?: string }).keyId === "v1",
    "Database capability provision did not use the active v1 envelope key",
  );
  assertCondition(
    !JSON.stringify(result.body).includes(neonDatabaseUrl),
    "Database provisioning response exposed the credential",
  );
  provisionedDatabaseProjects.add(projectId);
}

async function revokeDatabaseCapability(projectId: number): Promise<void> {
  if (!provisionedDatabaseProjects.has(projectId)) return;
  const result = await signedControlFetch(
    {
      path: databaseCapabilityControlPath(projectId),
      method: "DELETE",
      body: { projectId, expectedRevision: `database-v1-${projectId}` },
      nonce: nonce(`database-revoke-${projectId}`),
      idempotencyKey: `database-revoke-${projectId}-${crypto.randomUUID()}`,
    },
    `database.revoke.${projectId}`,
  );
  record(`database.revoke.${projectId}`, result.response.status, result.body);
  if (result.response.status !== 200 && result.response.status !== 404) {
    throw new Error(`Database capability cleanup failed for project ${projectId}`);
  }
  provisionedDatabaseProjects.delete(projectId);
}

function stripeCapabilityControlPath(projectId: number): string {
  return `/_nabuflow/control/v1/capabilities/${projectId}/stripe/payments`;
}

async function provisionStripeCapability(
  projectId: number,
  revision = `stripe-v1-${projectId}`,
): Promise<void> {
  const result = await signedControlFetch(
    {
      path: stripeCapabilityControlPath(projectId),
      method: "PUT",
      body: {
        projectId,
        revision,
        definition: stripeCapabilityDefinition,
        policy: stripePolicy,
        credential: { kind: "stripe-test-secret-key", value: stripeTestSecretKey },
      },
      nonce: nonce(`stripe-provision-${projectId}`),
      idempotencyKey: `stripe-provision-${projectId}-${crypto.randomUUID()}`,
    },
    `stripe.provision.${projectId}`,
  );
  assertStatus(`stripe.provision.${projectId}`, result.response.status, 200, result.body);
  assertCondition(
    (result.body as { keyId?: string }).keyId === "v1",
    "Stripe capability provision did not use the active v1 envelope key",
  );
  const responseText = JSON.stringify(result.body);
  assertCondition(
    !responseText.includes(stripeTestSecretKey) && !responseText.includes("sk_test_"),
    "Stripe provisioning response exposed credential material",
  );
  provisionedStripeProjects.add(projectId);
  stripeCapabilityRevisions.set(projectId, revision);
}

async function revokeStripeCapability(projectId: number): Promise<void> {
  if (!provisionedStripeProjects.has(projectId)) return;
  const result = await signedControlFetch(
    {
      path: stripeCapabilityControlPath(projectId),
      method: "DELETE",
      body: {
        projectId,
        expectedRevision: stripeCapabilityRevisions.get(projectId) ?? `stripe-v1-${projectId}`,
      },
      nonce: nonce(`stripe-revoke-${projectId}`),
      idempotencyKey: `stripe-revoke-${projectId}-${crypto.randomUUID()}`,
    },
    `stripe.revoke.${projectId}`,
  );
  record(`stripe.revoke.${projectId}`, result.response.status, result.body);
  if (result.response.status !== 200 && result.response.status !== 404) {
    throw new Error(`Stripe capability cleanup failed for project ${projectId}`);
  }
  provisionedStripeProjects.delete(projectId);
  stripeCapabilityRevisions.delete(projectId);
}

function stripeIdempotencyDigest(projectId: number, tenantIdempotencyKey: string): string {
  return createHash("sha256")
    .update(
      [
        "nabuflow-stripe-idempotency-v1",
        `project=${projectId}`,
        "provider=stripe",
        "name=payments",
        "operation=create-payment-intent",
        `key=${tenantIdempotencyKey}`,
      ].join("\n"),
    )
    .digest("hex");
}

async function stripeTestApiFetch(
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(init.headers);
  headers.set(
    "authorization",
    `Basic ${Buffer.from(`${stripeTestSecretKey}:`, "utf8").toString("base64")}`,
  );
  headers.set("stripe-version", "2025-11-17.clover");
  const response = await fetch(`https://api.stripe.com${pathAndQuery}`, { ...init, headers });
  return { response, body: await readResponse(response) };
}

async function countStripeObjectsForDigest(digest: string): Promise<number> {
  const query = new URLSearchParams({
    limit: "100",
    "created[gte]": String(stripeAcceptanceStartedAtSeconds),
  });
  const result = await stripeTestApiFetch(`/v1/payment_intents?${query.toString()}`);
  if (result.response.status !== 200) {
    throw new Error(`Stripe test-object inspection failed with HTTP ${result.response.status}`);
  }
  const data = (result.body as { data?: Array<{ id?: string; metadata?: Record<string, string> }> })
    .data;
  assertCondition(Array.isArray(data), "Stripe test-object inspection returned no data array");
  return data.filter(
    (paymentIntent) => paymentIntent.metadata?.nabuflow_idempotency_digest === digest,
  ).length;
}

async function expectStripeObjectCount(
  label: string,
  digest: string,
  expected: number,
): Promise<void> {
  let actual = -1;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    actual = await countStripeObjectsForDigest(digest);
    if (actual === expected) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  record(label, 200, { matchingStripeObjects: actual, expected });
  assertCondition(actual === expected, `${label}: expected ${expected} Stripe test object(s)`);
}

async function cleanupStripeTestObjects(): Promise<void> {
  for (const paymentIntentId of stripePaymentIntentIds) {
    const retrieved = await stripeTestApiFetch(
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    );
    if (retrieved.response.status === 404) continue;
    if (retrieved.response.status !== 200) {
      throw new Error(`Stripe test-object retrieval failed with HTTP ${retrieved.response.status}`);
    }
    const status = (retrieved.body as { status?: string }).status;
    if (status === "canceled" || status === "succeeded") continue;
    const canceled = await stripeTestApiFetch(
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
      { method: "POST" },
    );
    if (canceled.response.status !== 200) {
      throw new Error(`Stripe test-object cleanup failed with HTTP ${canceled.response.status}`);
    }
    assertCondition(
      (canceled.body as { status?: string; livemode?: boolean }).status === "canceled" &&
        (canceled.body as { livemode?: boolean }).livemode === false,
      "Stripe test PaymentIntent did not enter the expected test-mode canceled state",
    );
    record("stripe.cleanup.payment-intent", 200, { paymentIntentId, status: "canceled" });
  }
}

function capabilityIntent(requestId: string, requestedProjectId?: number): CapabilityIntent {
  return {
    v: 1,
    capability: { provider: "nabuflow-harness", name: "echo" },
    action: "invoke",
    requestId,
    ...(requestedProjectId === undefined ? {} : { requestedProjectId }),
    input: { message: "doorman-acted", projectId: locator.projectId },
  };
}

function capabilityInvocation(
  requestId: string,
  containerId = activeContainerId,
  requestedProjectId?: number,
): CapabilityInvocation {
  return {
    ...capabilityIntent(requestId, requestedProjectId),
    caller: { containerId, runtimeIdentity },
  };
}

function databaseCapabilityIntent(
  requestId: string,
  input: Record<string, unknown>,
  requestedProjectId?: number,
): CapabilityIntent {
  return {
    v: 1,
    capability: { provider: "neon-postgres", name: "database" },
    action: "query",
    requestId,
    ...(requestedProjectId === undefined ? {} : { requestedProjectId }),
    input,
  };
}

function databaseCapabilityInvocation(
  requestId: string,
  input: Record<string, unknown>,
  containerId = activeContainerId,
  requestedProjectId?: number,
): CapabilityInvocation {
  return {
    ...databaseCapabilityIntent(requestId, input, requestedProjectId),
    caller: { containerId, runtimeIdentity },
  };
}

function stripeCapabilityIntent(
  requestId: string,
  input: Record<string, unknown>,
  requestedProjectId?: number,
): CapabilityIntent {
  return {
    v: 1,
    capability: { provider: "stripe", name: "payments" },
    action: "execute",
    requestId,
    ...(requestedProjectId === undefined ? {} : { requestedProjectId }),
    input,
  };
}

function stripeCapabilityInvocation(
  requestId: string,
  input: Record<string, unknown>,
  containerId = activeContainerId,
  requestedProjectId?: number,
): CapabilityInvocation {
  return {
    ...stripeCapabilityIntent(requestId, input, requestedProjectId),
    caller: { containerId, runtimeIdentity },
  };
}

async function runContainerNode(label: string, source: string): Promise<unknown> {
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
      nonce: nonce(`container-${label}`),
      idempotencyKey: `container-${label}-${locator.projectId}-${crypto.randomUUID()}`,
    },
    `container.${label}`,
  );
  assertStatus(`container.${label}`, result.response.status, 200, result.body);
  const stdout = (result.body as { stdout?: string }).stdout?.trim() ?? "";
  const line = stdout.split(/\r?\n/u).filter(Boolean).at(-1);
  assertCondition(line, `Container ${label} probe returned no output`);
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Container ${label} probe returned malformed JSON`);
  }
}

async function invokeCapabilityFromContainer(
  label: string,
  intent: CapabilityIntent,
): Promise<{ status: number; body: unknown }> {
  const source = `const intent=${JSON.stringify(intent)};fetch(${JSON.stringify(capabilityIntentUrl)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(intent)}).then(async response=>console.log(JSON.stringify({status:response.status,body:await response.json()})))`;
  return (await runContainerNode(label, source)) as { status: number; body: unknown };
}

async function invokeDatabaseFromContainer(
  label: string,
  input: Record<string, unknown>,
  expectedStatus = 200,
  requestedProjectId?: number,
): Promise<unknown> {
  const result = await invokeCapabilityFromContainer(
    label,
    databaseCapabilityIntent(`database-${label}-${crypto.randomUUID()}`, input, requestedProjectId),
  );
  assertStatus(`database.${label}`, result.status, expectedStatus, result.body);
  return result.body;
}

async function invokeStripeFromContainer(
  label: string,
  input: Record<string, unknown>,
  expectedStatus = 200,
  requestedProjectId?: number,
): Promise<unknown> {
  const result = await invokeCapabilityFromContainer(
    label,
    stripeCapabilityIntent(`stripe-${label}-${crypto.randomUUID()}`, input, requestedProjectId),
  );
  assertStatus(`stripe.${label}`, result.status, expectedStatus, result.body);
  return result.body;
}

async function websocketCapabilityRejection(): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${controlUrl.replace(/^http/u, "ws")}${capabilityEndpoint}`);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Capability WebSocket rejection timed out"));
    }, 20_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error("Capability endpoint unexpectedly accepted a WebSocket upgrade"));
    });
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timeout);
        socket.terminate();
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
        } catch {
          resolve({ status: response.statusCode ?? 0, body: text });
        }
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function overrideHeaders(
  host: string,
  pathAndQuery: string,
  method: string,
): Promise<Record<string, string>> {
  const timestamp = String(Date.now() + workerClockOffsetMs);
  const overrideNonce = nonce("host-override");
  return {
    "x-nabuflow-staging-host-override": host,
    "x-nabuflow-staging-timestamp": timestamp,
    "x-nabuflow-staging-nonce": overrideNonce,
    "x-nabuflow-staging-signature": await signStagingHostOverride(controlToken, {
      method,
      pathAndQuery,
      timestamp,
      nonce: overrideNonce,
      actualHost: workerHost,
      overrideHost: host,
    }),
  };
}

async function signedHostOverrideFetch(
  host: string,
  pathAndQuery: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const method = init.method ?? "GET";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const headers = new Headers(init.headers);
    const signedOverride = await overrideHeaders(host, pathAndQuery, method);
    for (const [name, value] of Object.entries(signedOverride)) headers.set(name, value);
    const response = await fetch(`${controlUrl}${pathAndQuery}`, { ...init, method, headers });
    if (response.status !== 401) return response;
    const body = await readResponse(response.clone());
    const code = (body as { code?: string } | null)?.code;
    const transientAuthFailure =
      code === "invalid_staging_host_override" || code === "invalid_signature";
    if (!transientAuthFailure || attempt === 8) return response;
    const backoffMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
    record(`signed-staging.retry.${label}`, response.status, {
      attempt,
      backoffMs,
      code,
    });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error(`${label}: bounded signed staging retry exhausted without a response`);
}

async function publishedFetch(
  host: string,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown; elapsedMs: number }> {
  const method = init.method ?? "GET";
  const started = performance.now();
  const response = await signedHostOverrideFetch(
    host,
    pathAndQuery,
    { ...init, method },
    `published.${method}.${pathAndQuery}`,
  );
  const elapsedMs = performance.now() - started;
  return { response, body: await readResponse(response), elapsedMs };
}

function routeRecord(
  hostname: string,
  slot: "blue" | "green" = "blue",
  identity = runtimeIdentity,
) {
  return {
    hostname,
    projectId: locator.projectId,
    role: "production" as const,
    activeSlot: slot,
    manifestRevision,
    servicePort: 8080,
    sandboxIdentity: identity,
  };
}

function activateBody(hostname: string) {
  return { route: routeRecord(hostname), expectedPreviousManifestRevision: null };
}

function deactivateBody(hostname: string) {
  return {
    hostname,
    expectedManifestRevision: manifestRevision,
    expectedSandboxIdentity: runtimeIdentity,
  };
}

async function activateRoute(hostname: string, label: string): Promise<void> {
  const path = `/_nabuflow/control/v1/routes/${hostname}/activate`;
  const result = await signedControlFetch(
    {
      path,
      method: "POST",
      body: activateBody(hostname),
      nonce: nonce(`${label}-activate`),
      idempotencyKey: `${label}-activate-${locator.projectId}`,
    },
    `${label}.activate`,
  );
  assertStatus(`${label}.activate`, result.response.status, 200, result.body);
  registeredHosts.add(hostname);
}

async function deactivateRoute(hostname: string, label: string): Promise<void> {
  if (!registeredHosts.has(hostname)) return;
  const path = `/_nabuflow/control/v1/routes/${hostname}`;
  const result = await signedControlFetch(
    {
      path,
      method: "DELETE",
      body: deactivateBody(hostname),
      nonce: nonce(`${label}-deactivate`),
      idempotencyKey: `${label}-deactivate-${locator.projectId}-${crypto.randomUUID()}`,
    },
    `${label}.deactivate`,
  );
  record(`${label}.deactivate`, result.response.status, result.body);
  if (result.response.status !== 200 && result.response.status !== 404) {
    throw new Error(`${label} route cleanup failed`);
  }
  registeredHosts.delete(hostname);
}

async function websocketEcho(url: string, message: string) {
  return new Promise<{ status: number; sent: string; received: string; requestHeaders: string[] }>(
    (resolve, reject) => {
      const socket = new WebSocket(url);
      let upgradeStatus = 0;
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Published WebSocket smoke timed out"));
      }, 20_000);
      socket.once("upgrade", (response) => {
        upgradeStatus = response.statusCode ?? 0;
      });
      socket.once("open", () => socket.send(message));
      socket.once("message", (data) => {
        clearTimeout(timeout);
        const received = data.toString();
        socket.close();
        resolve({
          status: upgradeStatus || 101,
          sent: message,
          received,
          requestHeaders: ["Host", "Upgrade", "Connection", "Sec-WebSocket-Key"],
        });
      });
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timeout);
        reject(new Error(`Published WebSocket received HTTP ${response.statusCode}`));
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    },
  );
}

async function waitForBrowser(): Promise<void> {
  if (!holdSignal || !readyPath) return;
  if (existsSync(holdSignal)) rmSync(holdSignal, { force: true });
  writeFileSync(
    readyPath,
    JSON.stringify({
      ready: true,
      url: `${controlUrl}/`,
      hostname: workerHost,
      runtimeIdentity,
      slot: "production-blue",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  record("browser.ready", 200, { url: `${controlUrl}/`, freshAnonymousSessionRequired: true });
  const deadline = Date.now() + 30 * 60_000;
  while (!existsSync(holdSignal)) {
    if (Date.now() > deadline) throw new Error("Browser evidence window timed out");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  record("browser.confirmed", 200, { signalReceived: true });
}

async function verifyArtifactRejectionMatrix(initialManifestRevision: string): Promise<void> {
  let fakeCredentialEnvelopeProduced = false;
  try {
    await sealRuntimeArtifact({
      targetRuntimeIdentity: runtimeIdentity,
      manifestRevision: initialManifestRevision,
      artifactRevision: `fake-secret-${Date.now()}`,
      sourceRevision: "fake-secret-fixture",
      files: [
        {
          path: "fixture.txt",
          content: "sk_test_FAKEONLYNOTAREALSECRET1234567890",
        },
      ],
    });
    fakeCredentialEnvelopeProduced = true;
  } catch (error) {
    assertCondition(
      error instanceof RuntimeArtifactSealError && error.code === "artifact_secret_detected",
      "Fake credential was rejected for an unexpected reason",
    );
  }
  assertCondition(!fakeCredentialEnvelopeProduced, "Fake credential produced a sealed envelope");
  record("artifact.local-secret-scan", "refused", {
    code: "artifact_secret_detected",
    envelopeProduced: false,
    uploadBegun: false,
  });

  await expectSealError(
    "artifact.local-oversized",
    "artifact_too_large",
    new Uint8Array(MAX_RUNTIME_ARTIFACT_FILE_BYTES + 1),
    "oversized.bin",
    initialManifestRevision,
  );
  await expectSealError(
    "artifact.local-traversal",
    "artifact_invalid_path",
    new TextEncoder().encode("safe fixture"),
    "../escape.mjs",
    initialManifestRevision,
  );

  const probe = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: initialManifestRevision,
    artifactRevision: `artifact-negative-${Date.now()}`,
    sourceRevision: "artifact-negative-fixture",
    files: [{ path: "server.mjs", content: "console.log('fixture')\n" }],
  });
  const artifactPath = `${runtimePath}/artifacts/${probe.envelope.sealedArtifactSha256}`;
  const begin = await signedControlFetch(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: probe.envelope,
      },
      nonce: nonce("artifact-integrity-begin"),
      idempotencyKey: `artifact-integrity-begin-${crypto.randomUUID()}`,
    },
    "artifact.integrity.begin",
  );
  assertStatus("artifact.integrity.begin", begin.response.status, 200, begin.body);
  const altered = probe.chunks[0].slice();
  altered[0] ^= 0xff;
  const signedOriginalChunk = await makeSignedRequest({
    path: `${artifactPath}/chunks/0`,
    method: "PUT",
    body: probe.chunks[0],
    nonce: nonce("artifact-chunk-tampered"),
    idempotencyKey: `artifact-chunk-tampered-${crypto.randomUUID()}`,
  });
  const tamperedChunkResponse = await fetch(
    new Request(signedOriginalChunk, {
      body: altered.slice().buffer as ArrayBuffer,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  assertStatus(
    "artifact.chunk-tampered",
    tamperedChunkResponse.status,
    401,
    await readResponse(tamperedChunkResponse),
  );
  const badChunk = await signedControlFetch(
    {
      path: `${artifactPath}/chunks/0`,
      method: "PUT",
      body: altered,
      nonce: nonce("artifact-integrity-chunk"),
      idempotencyKey: `artifact-integrity-chunk-${crypto.randomUUID()}`,
    },
    "artifact.integrity.chunk",
  );
  assertStatus("artifact.integrity.chunk", badChunk.response.status, 422, badChunk.body);
  const removedProbe = await removeArtifact(
    probe.envelope.sealedArtifactSha256,
    "artifact.integrity.remove",
  );
  assertStatus("artifact.integrity.remove", removedProbe.response.status, 200, removedProbe.body);

  const tamperedEnvelope = structuredClone(probe.envelope);
  tamperedEnvelope.manifestRevision = `${initialManifestRevision}-tampered`;
  const tampered = await signedControlFetch(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: tamperedEnvelope,
      },
      nonce: nonce("artifact-envelope-tampered"),
      idempotencyKey: `artifact-envelope-tampered-${crypto.randomUUID()}`,
    },
    "artifact.envelope-tampered",
  );
  assertStatus("artifact.envelope-tampered", tampered.response.status, 422, tampered.body);

  const traversalEnvelope = structuredClone(probe.envelope);
  traversalEnvelope.content.files[0].path = "../escape.mjs";
  const traversal = await signedControlFetch(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: traversalEnvelope,
      },
      nonce: nonce("artifact-receiver-traversal"),
      idempotencyKey: `artifact-receiver-traversal-${crypto.randomUUID()}`,
    },
    "artifact.receiver-traversal",
  );
  assertStatus("artifact.receiver-traversal", traversal.response.status, 400, traversal.body);

  const oversizedEnvelope = structuredClone(probe.envelope);
  oversizedEnvelope.content.payloadBytes = MAX_RUNTIME_ARTIFACT_BYTES + 1;
  oversizedEnvelope.content.files[0].size = MAX_RUNTIME_ARTIFACT_BYTES + 1;
  const oversized = await signedControlFetch(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: oversizedEnvelope,
      },
      nonce: nonce("artifact-receiver-oversized"),
      idempotencyKey: `artifact-receiver-oversized-${crypto.randomUUID()}`,
    },
    "artifact.receiver-oversized",
  );
  assertStatus("artifact.receiver-oversized", oversized.response.status, 413, oversized.body);

  const foreignProjectId = locator.projectId + 91;
  const foreignLocator = { projectId: foreignProjectId, role: locator.role, slot: locator.slot };
  const foreignIdentity = await deriveRuntimeIdentity({
    namespace: deploymentNamespace,
    ...foreignLocator,
  });
  const existingRuntimeMismatchEnvelope = structuredClone(probe.envelope);
  existingRuntimeMismatchEnvelope.targetRuntimeIdentity = foreignIdentity;
  const existingRuntimeMismatch = await signedControlFetch(
    {
      path: `${artifactPath}/begin`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: existingRuntimeMismatchEnvelope,
      },
      nonce: nonce("artifact-cross-existing"),
      idempotencyKey: `artifact-cross-existing-${crypto.randomUUID()}`,
    },
    "artifact.cross-existing",
  );
  const missingRuntimePath = `/_nabuflow/control/v1/runtimes/${foreignProjectId}/${locator.role}/${locator.slot}/artifacts/${probe.envelope.sealedArtifactSha256}`;
  const missingRuntimeMismatch = await signedControlFetch(
    {
      path: `${missingRuntimePath}/begin`,
      method: "POST",
      body: {
        locator: foreignLocator,
        expectedDeploymentVersion: deploymentVersion,
        envelope: probe.envelope,
      },
      nonce: nonce("artifact-cross-missing"),
      idempotencyKey: `artifact-cross-missing-${crypto.randomUUID()}`,
    },
    "artifact.cross-missing",
  );
  assertStatus(
    "artifact.cross-existing",
    existingRuntimeMismatch.response.status,
    403,
    existingRuntimeMismatch.body,
  );
  assertStatus(
    "artifact.cross-missing",
    missingRuntimeMismatch.response.status,
    403,
    missingRuntimeMismatch.body,
  );
  assertCondition(
    comparableError(existingRuntimeMismatch.body) === comparableError(missingRuntimeMismatch.body),
    "Artifact cross-runtime response leaked whether the addressed runtime exists",
  );

  const paddingBytes = RUNTIME_ARTIFACT_CHUNK_BYTES + 17;
  const incomplete = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: initialManifestRevision,
    artifactRevision: `artifact-incomplete-${Date.now()}`,
    sourceRevision: "artifact-incomplete-fixture",
    files: [{ path: "large.bin", content: new Uint8Array(paddingBytes) }],
  });
  const incompletePath = `${runtimePath}/artifacts/${incomplete.envelope.sealedArtifactSha256}`;
  await beginArtifact(incompletePath, incomplete.envelope, "artifact.incomplete.begin");
  const firstChunk = await signedControlFetch(
    {
      path: `${incompletePath}/chunks/0`,
      method: "PUT",
      body: incomplete.chunks[0],
      nonce: nonce("artifact-incomplete-chunk"),
      idempotencyKey: `artifact-incomplete-chunk-${crypto.randomUUID()}`,
    },
    "artifact.incomplete.chunk",
  );
  assertStatus("artifact.incomplete.chunk", firstChunk.response.status, 200, firstChunk.body);
  const incompleteCommit = await commitArtifact(
    incompletePath,
    incomplete.envelope.sealedArtifactSha256,
    "artifact.incomplete.commit",
  );
  assertStatus(
    "artifact.incomplete.commit",
    incompleteCommit.response.status,
    409,
    incompleteCommit.body,
  );
  assertCondition(
    (incompleteCommit.body as { code?: string }).code === "artifact_incomplete",
    "Incomplete artifact returned the wrong error code",
  );
  await beginArtifact(incompletePath, incomplete.envelope, "artifact.incomplete.rebegin");
  const emptyCommit = await commitArtifact(
    incompletePath,
    incomplete.envelope.sealedArtifactSha256,
    "artifact.incomplete.empty-commit",
  );
  assertStatus(
    "artifact.incomplete.empty-commit",
    emptyCommit.response.status,
    409,
    emptyCommit.body,
  );
  record("artifact.incomplete.cleaned", 200, {
    rebeginAccepted: true,
    pendingStateCleanedTwice: true,
  });

  const duplicate = await sealRuntimeArtifact({
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: initialManifestRevision,
    artifactRevision: `artifact-duplicate-${Date.now()}`,
    sourceRevision: "artifact-duplicate-fixture",
    files: [{ path: "duplicate.txt", content: "duplicate upload fixture\n" }],
  });
  const duplicatePath = `${runtimePath}/artifacts/${duplicate.envelope.sealedArtifactSha256}`;
  const duplicateBeginKey = `artifact-duplicate-begin-${crypto.randomUUID()}`;
  const duplicateBeginBody = {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    envelope: duplicate.envelope,
  };
  const duplicateBeginFirst = await signedControlFetch(
    {
      path: `${duplicatePath}/begin`,
      method: "POST",
      body: duplicateBeginBody,
      nonce: nonce("artifact-duplicate-begin-first"),
      idempotencyKey: duplicateBeginKey,
    },
    "artifact.duplicate.begin-first",
  );
  const duplicateBeginRetry = await signedControlFetch(
    {
      path: `${duplicatePath}/begin`,
      method: "POST",
      body: duplicateBeginBody,
      nonce: nonce("artifact-duplicate-begin-retry"),
      idempotencyKey: duplicateBeginKey,
    },
    "artifact.duplicate.begin-retry",
  );
  assertStatus(
    "artifact.duplicate.begin-first",
    duplicateBeginFirst.response.status,
    200,
    duplicateBeginFirst.body,
  );
  assertStatus(
    "artifact.duplicate.begin-retry",
    duplicateBeginRetry.response.status,
    200,
    duplicateBeginRetry.body,
  );
  assertCondition(
    JSON.stringify(duplicateBeginFirst.body) === JSON.stringify(duplicateBeginRetry.body),
    "Duplicate artifact begin did not return the cached response",
  );

  const duplicateChunkKey = `artifact-duplicate-chunk-${crypto.randomUUID()}`;
  const duplicateChunkFirst = await signedControlFetch(
    {
      path: `${duplicatePath}/chunks/0`,
      method: "PUT",
      body: duplicate.chunks[0],
      nonce: nonce("artifact-duplicate-chunk-first"),
      idempotencyKey: duplicateChunkKey,
    },
    "artifact.duplicate.chunk-first",
  );
  const duplicateChunkRetry = await signedControlFetch(
    {
      path: `${duplicatePath}/chunks/0`,
      method: "PUT",
      body: duplicate.chunks[0],
      nonce: nonce("artifact-duplicate-chunk-retry"),
      idempotencyKey: duplicateChunkKey,
    },
    "artifact.duplicate.chunk-retry",
  );
  assertStatus(
    "artifact.duplicate.chunk-first",
    duplicateChunkFirst.response.status,
    200,
    duplicateChunkFirst.body,
  );
  assertStatus(
    "artifact.duplicate.chunk-retry",
    duplicateChunkRetry.response.status,
    200,
    duplicateChunkRetry.body,
  );
  assertCondition(
    JSON.stringify(duplicateChunkFirst.body) === JSON.stringify(duplicateChunkRetry.body),
    "Duplicate artifact chunk did not return the cached response",
  );

  const duplicateCommitKey = `artifact-duplicate-commit-${crypto.randomUUID()}`;
  const duplicateCommitBody = {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    sealedArtifactSha256: duplicate.envelope.sealedArtifactSha256,
  };
  const duplicateCommitFirst = await signedControlFetch(
    {
      path: `${duplicatePath}/commit`,
      method: "POST",
      body: duplicateCommitBody,
      nonce: nonce("artifact-duplicate-commit-first"),
      idempotencyKey: duplicateCommitKey,
    },
    "artifact.duplicate.commit-first",
  );
  const duplicateCommitRetry = await signedControlFetch(
    {
      path: `${duplicatePath}/commit`,
      method: "POST",
      body: duplicateCommitBody,
      nonce: nonce("artifact-duplicate-commit-retry"),
      idempotencyKey: duplicateCommitKey,
    },
    "artifact.duplicate.commit-retry",
  );
  assertStatus(
    "artifact.duplicate.commit-first",
    duplicateCommitFirst.response.status,
    200,
    duplicateCommitFirst.body,
  );
  assertStatus(
    "artifact.duplicate.commit-retry",
    duplicateCommitRetry.response.status,
    200,
    duplicateCommitRetry.body,
  );
  assertCondition(
    JSON.stringify(duplicateCommitFirst.body) === JSON.stringify(duplicateCommitRetry.body),
    "Duplicate artifact commit did not return the cached response",
  );
  record("artifact.duplicate.idempotency", 200, {
    beginCached: true,
    chunkCached: true,
    commitCached: true,
    logicalArtifacts: 1,
  });
  const duplicateRemoved = await removeArtifact(
    duplicate.envelope.sealedArtifactSha256,
    "artifact.duplicate.remove",
  );
  assertStatus(
    "artifact.duplicate.remove",
    duplicateRemoved.response.status,
    200,
    duplicateRemoved.body,
  );
}

async function expectSealError(
  label: string,
  expectedCode: RuntimeArtifactSealError["code"],
  content: Uint8Array,
  path: string,
  manifest: string,
): Promise<void> {
  try {
    await sealRuntimeArtifact({
      targetRuntimeIdentity: runtimeIdentity,
      manifestRevision: manifest,
      artifactRevision: `${label}-${Date.now()}`,
      sourceRevision: `${label}-fixture`,
      files: [{ path, content }],
    });
    throw new Error(`${label}: sealer unexpectedly accepted the fixture`);
  } catch (error) {
    assertCondition(
      error instanceof RuntimeArtifactSealError && error.code === expectedCode,
      `${label}: sealer returned an unexpected error`,
    );
  }
  record(label, "refused", { code: expectedCode, envelopeProduced: false, uploadBegun: false });
}

async function beginArtifact(path: string, envelope: unknown, label: string) {
  const result = await signedControlFetch(
    {
      path: `${path}/begin`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, envelope },
      nonce: nonce(label),
      idempotencyKey: `${label}-${crypto.randomUUID()}`,
    },
    label,
  );
  assertStatus(label, result.response.status, 200, result.body);
  return result;
}

function commitArtifact(path: string, sealedArtifactSha256: string, label: string) {
  return signedControlFetch(
    {
      path: `${path}/commit`,
      method: "POST",
      body: { locator, expectedDeploymentVersion: deploymentVersion, sealedArtifactSha256 },
      nonce: nonce(label),
      idempotencyKey: `${label}-${crypto.randomUUID()}`,
    },
    label,
  );
}

function removeArtifact(sealedArtifactSha256: string, label: string) {
  return signedControlFetch(
    {
      path: `${runtimePath}/artifacts/${sealedArtifactSha256}`,
      method: "DELETE",
      body: { locator, sealedArtifactSha256 },
      nonce: nonce(label),
      idempotencyKey: `${label}-${crypto.randomUUID()}`,
    },
    label,
  );
}

function comparableError(body: unknown): string {
  const error = body as { ok?: boolean; code?: string; message?: string; retryable?: boolean };
  return JSON.stringify({
    ok: error.ok,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  });
}

async function run(): Promise<void> {
  const unsignedVersion = await fetch(`${controlUrl}/_nabuflow/control/v1/version`);
  assertStatus(
    "control.version.unsigned",
    unsignedVersion.status,
    401,
    await readResponse(unsignedVersion),
  );
  const workerDate = unsignedVersion.headers.get("date");
  const workerTimeMs = workerDate === null ? Number.NaN : Date.parse(workerDate);
  assertCondition(Number.isFinite(workerTimeMs), "Worker Date header is missing");
  workerClockOffsetMs = workerTimeMs - Date.now();
  record("clock.offset", 200, { workerDate, offsetMs: workerClockOffsetMs });
  // Provider time predicates must use the measured per-run clock offset. The Windows lab
  // clock is known to drift and raw Date.now() can otherwise query provider data in the future.
  stripeAcceptanceStartedAtSeconds = Math.floor((Date.now() + workerClockOffsetMs) / 1_000) - 5;
  record("clock.provider-predicate-start", 200, {
    stripeAcceptanceStartedAtSeconds,
  });

  const versionBody = await waitForSustainedGreenWindow();
  record("control.version.valid", 200, versionBody);
  deploymentVersion = (versionBody as { deploymentVersion?: string }).deploymentVersion ?? "";
  assertCondition(deploymentVersion, "Worker version response omitted deploymentVersion");
  const features = (versionBody as { features?: string[] }).features ?? [];
  assertCondition(
    features.includes("artifact-v1") && features.includes("manifest-update-v1"),
    "Worker version does not advertise the artifact loading dock",
  );
  record("artifact.version-advertisement", 200, { features });

  await verifyPreviewAuthRegression();

  runtimeIdentity = await deriveRuntimeIdentity({ namespace: deploymentNamespace, ...locator });
  const initialManifestRevision = `artifact-react-vite-${Date.now()}`;
  manifestRevision = `artifact-node-api-${Date.now()}`;
  const ensure = await signedControlFetch(
    {
      path: runtimePath,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        manifest: {
          revision: initialManifestRevision,
          runtime: "react-vite",
          buildCommand: ["node", "--version"],
          startCommand: ["node", "server.cjs"],
          servicePort: 8081,
          healthPath: "/health-old",
          resourceProfile: "dev",
          public: true,
        },
      },
      nonce: nonce("ensure"),
      idempotencyKey: `published-ensure-${locator.projectId}`,
    },
    "lifecycle.ensure",
  );
  assertStatus("lifecycle.ensure", ensure.response.status, 200, ensure.body);
  runtimeEnsured = true;

  await verifyArtifactRejectionMatrix(initialManifestRevision);

  const uncommittedArtifactSha256 = await sha256Hex(
    new TextEncoder().encode(`uncommitted-artifact-${locator.projectId}`),
  );
  const uncommittedStart = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision: `uncommitted-${Date.now()}`,
        artifactSha256: uncommittedArtifactSha256,
      },
      nonce: nonce("artifact-uncommitted-start"),
      idempotencyKey: `artifact-uncommitted-start-${locator.projectId}`,
    },
    "artifact.uncommitted-start",
  );
  assertStatus(
    "artifact.uncommitted-start",
    uncommittedStart.response.status,
    409,
    uncommittedStart.body,
  );
  assertCondition(
    (uncommittedStart.body as { code?: string }).code === "artifact_not_committed",
    "Start with an uncommitted artifact hash returned the wrong error",
  );

  const initialArtifact = await deliverScratchArtifact({
    runtimePath,
    locator,
    deploymentVersion,
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision: initialManifestRevision,
    artifactRevision: `artifact-react-vite-${Date.now()}`,
    sourceRevision: `source-react-vite-${Date.now()}`,
    serverSource: TENANT_SERVER_SOURCE,
    send: signedControlFetch,
  });
  const initialStart = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision: initialArtifact.artifactRevision,
        artifactSha256: initialArtifact.sealedArtifactSha256,
      },
      nonce: nonce("initial-start"),
      idempotencyKey: `artifact-initial-start-${locator.projectId}`,
    },
    "artifact.initial-start",
  );
  assertStatus("artifact.initial-start", initialStart.response.status, 200, initialStart.body);
  assertCondition(
    (initialStart.body as { runtime?: { servicePort?: number } }).runtime?.servicePort === 8081,
    "Initial react-vite manifest did not start on port 8081",
  );
  runtimeStarted = true;

  const nextManifest = {
    revision: manifestRevision,
    runtime: "node-api",
    buildCommand: ["node", "--version"],
    startCommand: ["node", "server.cjs"],
    servicePort: 8080,
    healthPath: "/health",
    resourceProfile: "dev",
    public: true,
  };
  const artifact = await deliverScratchArtifact({
    runtimePath,
    locator,
    deploymentVersion,
    targetRuntimeIdentity: runtimeIdentity,
    manifestRevision,
    artifactRevision: `artifact-node-api-${Date.now()}`,
    sourceRevision: `source-node-api-${Date.now()}`,
    serverSource: TENANT_SERVER_SOURCE,
    additionalFiles: [{ path: ARTIFACT_BINARY_PATH, content: ARTIFACT_BINARY_FIXTURE }],
    send: signedControlFetch,
  });
  const staleManifestUpdate = await signedControlFetch(
    {
      path: `${runtimePath}/manifest`,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        expectedManifestRevision: "stale-manifest-revision",
        manifest: nextManifest,
        restart: "restart",
        sealedArtifactSha256: artifact.sealedArtifactSha256,
      },
      nonce: nonce("manifest-stale"),
      idempotencyKey: `artifact-manifest-stale-${locator.projectId}`,
    },
    "artifact.manifest-stale",
  );
  assertStatus(
    "artifact.manifest-stale",
    staleManifestUpdate.response.status,
    409,
    staleManifestUpdate.body,
  );
  const immutableManifestUpdate = await signedControlFetch(
    {
      path: `${runtimePath}/manifest`,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        expectedManifestRevision: initialManifestRevision,
        manifest: { ...nextManifest, resourceProfile: "prod" },
        restart: "restart",
        sealedArtifactSha256: artifact.sealedArtifactSha256,
      },
      nonce: nonce("manifest-immutable"),
      idempotencyKey: `artifact-manifest-immutable-${locator.projectId}`,
    },
    "artifact.manifest-immutable",
  );
  assertStatus(
    "artifact.manifest-immutable",
    immutableManifestUpdate.response.status,
    400,
    immutableManifestUpdate.body,
  );
  const implicitRestart = await signedControlFetch(
    {
      path: `${runtimePath}/manifest`,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        expectedManifestRevision: initialManifestRevision,
        manifest: nextManifest,
        restart: "reject-if-running",
      },
      nonce: nonce("manifest-running-reject"),
      idempotencyKey: `artifact-manifest-running-reject-${locator.projectId}`,
    },
    "artifact.manifest-running-reject",
  );
  assertStatus(
    "artifact.manifest-running-reject",
    implicitRestart.response.status,
    409,
    implicitRestart.body,
  );
  const manifestUpdate = await signedControlFetch(
    {
      path: `${runtimePath}/manifest`,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        expectedManifestRevision: initialManifestRevision,
        manifest: nextManifest,
        restart: "restart",
        sealedArtifactSha256: artifact.sealedArtifactSha256,
      },
      nonce: nonce("manifest-update"),
      idempotencyKey: `artifact-manifest-update-${locator.projectId}`,
    },
    "artifact.manifest-update",
  );
  assertStatus(
    "artifact.manifest-update",
    manifestUpdate.response.status,
    200,
    manifestUpdate.body,
  );
  assertCondition(
    (
      manifestUpdate.body as {
        runtime?: { manifestRevision?: string; servicePort?: number; status?: string };
      }
    ).runtime?.manifestRevision === manifestRevision &&
      (manifestUpdate.body as { runtime?: { servicePort?: number } }).runtime?.servicePort ===
        8080 &&
      (manifestUpdate.body as { runtime?: { status?: string } }).runtime?.status === "running",
    "Manifest update did not restart node-api on port 8080",
  );

  const expectedServerHash = await sha256Hex(TENANT_SERVER_SOURCE);
  const expectedBinaryHash = await sha256Hex(ARTIFACT_BINARY_FIXTURE);
  const binaryRoundTrip = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          `const c=require('node:crypto'),f=require('node:fs');const b=f.readFileSync('${ARTIFACT_BINARY_PATH}');console.log(JSON.stringify({bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}))`,
        ],
        cwd: `/workspace/.nabuflow/releases/${artifact.sealedArtifactSha256}/app`,
        timeoutMs: 10_000,
      },
      nonce: nonce("artifact-binary-round-trip"),
      idempotencyKey: `artifact-binary-round-trip-${locator.projectId}`,
    },
    "artifact.binary-round-trip",
  );
  assertStatus(
    "artifact.binary-round-trip",
    binaryRoundTrip.response.status,
    200,
    binaryRoundTrip.body,
  );
  const binaryRoundTripOutput = JSON.parse(
    (binaryRoundTrip.body as { stdout?: string }).stdout?.trim() ?? "{}",
  ) as { bytes?: number; sha256?: string };
  assertCondition(
    binaryRoundTripOutput.bytes === ARTIFACT_BINARY_FIXTURE.byteLength &&
      binaryRoundTripOutput.sha256 === expectedBinaryHash,
    "Binary artifact did not round-trip byte-for-byte",
  );
  record("artifact.binary-round-trip.verified", 200, {
    bytes: ARTIFACT_BINARY_FIXTURE.byteLength,
    sha256: expectedBinaryHash,
    exact: true,
  });

  const releaseRemoval = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: ["rm", "-rf", "--", `/workspace/.nabuflow/releases/${artifact.sealedArtifactSha256}`],
        cwd: "/workspace",
        timeoutMs: 10_000,
      },
      nonce: nonce("artifact-release-remove"),
      idempotencyKey: `artifact-release-remove-${locator.projectId}`,
    },
    "artifact.rehydrate.release-remove",
  );
  assertStatus(
    "artifact.rehydrate.release-remove",
    releaseRemoval.response.status,
    200,
    releaseRemoval.body,
  );
  assertCondition(
    (releaseRemoval.body as { ok?: boolean }).ok === true,
    "Release removal probe failed",
  );
  record("artifact.rehydrate.eviction-purpose", 200, {
    deliveryMechanism: "sealed-dock-only",
    execPurpose: "destruction-for-ephemeral-restart-simulation",
    evictedWhileRunning: true,
  });
  const rehydrateStop = await signedControlFetch(
    {
      path: `${runtimePath}/stop`,
      method: "POST",
      body: { locator, reason: "artifact restart rehydration proof" },
      nonce: nonce("artifact-rehydrate-stop"),
      idempotencyKey: `artifact-rehydrate-stop-${locator.projectId}`,
    },
    "artifact.rehydrate.stop",
  );
  assertStatus("artifact.rehydrate.stop", rehydrateStop.response.status, 200, rehydrateStop.body);
  runtimeStarted = false;
  const rehydratedStart = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision: artifact.artifactRevision,
        artifactSha256: artifact.sealedArtifactSha256,
      },
      nonce: nonce("artifact-rehydrate-start"),
      idempotencyKey: `artifact-rehydrate-start-${locator.projectId}`,
    },
    "artifact.rehydrate.start",
  );
  assertStatus(
    "artifact.rehydrate.start",
    rehydratedStart.response.status,
    200,
    rehydratedStart.body,
  );
  runtimeStarted = true;
  const rehydratedHash = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          "const c=require('node:crypto'),f=require('node:fs');console.log(c.createHash('sha256').update(f.readFileSync('server.cjs')).digest('hex'))",
        ],
        cwd: `/workspace/.nabuflow/releases/${artifact.sealedArtifactSha256}/app`,
        timeoutMs: 10_000,
      },
      nonce: nonce("artifact-rehydrate-hash"),
      idempotencyKey: `artifact-rehydrate-hash-${locator.projectId}`,
    },
    "artifact.rehydrate.hash",
  );
  assertStatus("artifact.rehydrate.hash", rehydratedHash.response.status, 200, rehydratedHash.body);
  assertCondition(
    (rehydratedHash.body as { stdout?: string }).stdout?.trim() === expectedServerHash,
    "Rehydrated release file hash did not match the sealed artifact",
  );
  record("artifact.rehydrate.verified", 200, {
    releaseEvictedWhileRunning: true,
    source: "private-r2",
    perFileSha256Verified: true,
    manifestRevision,
    servicePort: 8080,
  });

  const tamperRelease = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          `const f=require('node:fs');f.writeFileSync('server.cjs','tampered server');f.writeFileSync('${ARTIFACT_BINARY_PATH}',Buffer.from([0,1,2,3]))`,
        ],
        cwd: `/workspace/.nabuflow/releases/${artifact.sealedArtifactSha256}/app`,
        timeoutMs: 10_000,
      },
      nonce: nonce("artifact-tamper-release"),
      idempotencyKey: `artifact-tamper-release-${locator.projectId}`,
    },
    "artifact.tamper-release",
  );
  assertStatus("artifact.tamper-release", tamperRelease.response.status, 200, tamperRelease.body);
  const tamperStop = await signedControlFetch(
    {
      path: `${runtimePath}/stop`,
      method: "POST",
      body: { locator, reason: "artifact tamper restore proof" },
      nonce: nonce("artifact-tamper-stop"),
      idempotencyKey: `artifact-tamper-stop-${locator.projectId}`,
    },
    "artifact.tamper-restart.stop",
  );
  assertStatus("artifact.tamper-restart.stop", tamperStop.response.status, 200, tamperStop.body);
  runtimeStarted = false;
  const tamperRestart = await signedControlFetch(
    {
      path: `${runtimePath}/start`,
      method: "POST",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        artifactRevision: artifact.artifactRevision,
        artifactSha256: artifact.sealedArtifactSha256,
      },
      nonce: nonce("artifact-tamper-restart"),
      idempotencyKey: `artifact-tamper-restart-${locator.projectId}`,
    },
    "artifact.tamper-restart.start",
  );
  assertStatus(
    "artifact.tamper-restart.start",
    tamperRestart.response.status,
    200,
    tamperRestart.body,
  );
  runtimeStarted = true;
  const restoredHashes = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          `const c=require('node:crypto'),f=require('node:fs'),h=p=>c.createHash('sha256').update(f.readFileSync(p)).digest('hex');console.log(JSON.stringify({server:h('server.cjs'),binary:h('${ARTIFACT_BINARY_PATH}')}))`,
        ],
        cwd: `/workspace/.nabuflow/releases/${artifact.sealedArtifactSha256}/app`,
        timeoutMs: 10_000,
      },
      nonce: nonce("artifact-tamper-restored-hashes"),
      idempotencyKey: `artifact-tamper-restored-hashes-${locator.projectId}`,
    },
    "artifact.tamper-restart.hashes",
  );
  assertStatus(
    "artifact.tamper-restart.hashes",
    restoredHashes.response.status,
    200,
    restoredHashes.body,
  );
  const restoredHashOutput = JSON.parse(
    (restoredHashes.body as { stdout?: string }).stdout?.trim() ?? "{}",
  ) as { server?: string; binary?: string };
  assertCondition(
    restoredHashOutput.server === expectedServerHash &&
      restoredHashOutput.binary === expectedBinaryHash,
    "Restart did not restore every tampered file from the sealed R2 artifact",
  );
  record("artifact.tamper-restart.verified", 200, {
    source: "private-r2",
    filesVerified: ["server.cjs", ARTIFACT_BINARY_PATH],
    perFileSha256Verified: true,
  });

  const manifestFailureProof: Array<{
    iteration: number;
    requestId: string | null;
    failedRevision: string;
    recoveredRevision: string;
  }> = [];
  for (let iteration = 1; iteration <= manifestFailureIterations; iteration += 1) {
    const iterationLabel = `artifact.manifest-failure.${iteration}`;
    const failureManifestRevision = `artifact-health-failure-${iteration}-${Date.now()}`;
    const failureArtifact = await deliverScratchArtifact({
      runtimePath,
      locator,
      deploymentVersion,
      targetRuntimeIdentity: runtimeIdentity,
      manifestRevision: failureManifestRevision,
      artifactRevision: `artifact-health-failure-${iteration}-${Date.now()}`,
      sourceRevision: `source-health-failure-${iteration}-${Date.now()}`,
      serverSource: TENANT_SERVER_SOURCE,
      send: signedControlFetch,
    });
    const failedRestart = await signedAuthStableFetch(
      {
        path: `${runtimePath}/manifest`,
        method: "PUT",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          expectedManifestRevision: manifestRevision,
          manifest: {
            ...nextManifest,
            revision: failureManifestRevision,
            healthPath: "/intentionally-missing-health",
          },
          restart: "restart",
          sealedArtifactSha256: failureArtifact.sealedArtifactSha256,
        },
        nonce: nonce(`manifest-failure-${iteration}`),
        idempotencyKey: `artifact-manifest-failure-${locator.projectId}-${iteration}`,
      },
      iterationLabel,
    );
    assertStatus(iterationLabel, failedRestart.response.status, 502, failedRestart.body);
    assertCondition(
      (failedRestart.body as { code?: string }).code === "runtime_restart_failed",
      `Manifest failure iteration ${iteration} escaped the typed error boundary`,
    );
    runtimeStarted = false;
    const failedStatus = await signedControlFetch(
      { path: runtimePath, nonce: nonce(`manifest-failure-status-${iteration}`) },
      `${iterationLabel}.status`,
    );
    assertStatus(`${iterationLabel}.status`, failedStatus.response.status, 200, failedStatus.body);
    assertCondition(
      (failedStatus.body as { runtime?: { manifestRevision?: string; status?: string } }).runtime
        ?.manifestRevision === failureManifestRevision &&
        (failedStatus.body as { runtime?: { status?: string } }).runtime?.status === "error",
      "Failed manifest restart silently rolled back or did not enter error state",
    );
    const recoveryManifestRevision = `artifact-node-api-recovery-${iteration}-${Date.now()}`;
    const recoveryArtifact = await deliverScratchArtifact({
      runtimePath,
      locator,
      deploymentVersion,
      targetRuntimeIdentity: runtimeIdentity,
      manifestRevision: recoveryManifestRevision,
      artifactRevision: `artifact-node-api-recovery-${iteration}-${Date.now()}`,
      sourceRevision: `source-node-api-recovery-${iteration}-${Date.now()}`,
      serverSource: TENANT_SERVER_SOURCE,
      send: signedControlFetch,
    });
    const recoveredManifest = await signedControlFetch(
      {
        path: `${runtimePath}/manifest`,
        method: "PUT",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          expectedManifestRevision: failureManifestRevision,
          manifest: { ...nextManifest, revision: recoveryManifestRevision },
          restart: "reject-if-running",
        },
        nonce: nonce(`manifest-recovery-${iteration}`),
        idempotencyKey: `artifact-manifest-recovery-${locator.projectId}-${iteration}`,
      },
      `${iterationLabel}.recovery`,
    );
    assertStatus(
      `${iterationLabel}.recovery`,
      recoveredManifest.response.status,
      200,
      recoveredManifest.body,
    );
    const recoveredStart = await signedControlFetch(
      {
        path: `${runtimePath}/start`,
        method: "POST",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          artifactRevision: recoveryArtifact.artifactRevision,
          artifactSha256: recoveryArtifact.sealedArtifactSha256,
        },
        nonce: nonce(`manifest-recovery-start-${iteration}`),
        idempotencyKey: `artifact-manifest-recovery-start-${locator.projectId}-${iteration}`,
      },
      `${iterationLabel}.recovery-start`,
    );
    assertStatus(
      `${iterationLabel}.recovery-start`,
      recoveredStart.response.status,
      200,
      recoveredStart.body,
    );
    manifestRevision = recoveryManifestRevision;
    runtimeStarted = true;
    manifestFailureProof.push({
      iteration,
      requestId: (failedRestart.body as { requestId?: string }).requestId ?? null,
      failedRevision: failureManifestRevision,
      recoveredRevision: recoveryManifestRevision,
    });
  }
  record("artifact.manifest-failure-state", 200, {
    iterations: manifestFailureProof,
    typed502Count: manifestFailureProof.length,
    silentRollback: false,
  });

  if (stopAfterManifestFailure) {
    record("diagnostic.stop-after-manifest-failure", 200, {
      purpose: "credential-free manifest failure-path diagnosis",
    });
    return;
  }

  const binding = await signedControlFetch(
    {
      path: `${runtimePath}/capability-binding`,
      nonce: nonce("capability-binding-active"),
    },
    "capability.binding.active",
  );
  assertStatus("capability.binding.active", binding.response.status, 200, binding.body);
  const bindingBody = binding.body as { active?: boolean; containerId?: string };
  assertCondition(
    bindingBody.active === true && bindingBody.containerId,
    "Runtime binding is not active",
  );
  activeContainerId = bindingBody.containerId;

  await provisionCapability(locator.projectId);
  await provisionCapability(foreignExistingProjectId);

  const validContainerIntent = await invokeCapabilityFromContainer(
    "capability-valid",
    capabilityIntent(`capability-container-valid-${crypto.randomUUID()}`),
  );
  assertStatus(
    "capability.intent.valid",
    validContainerIntent.status,
    200,
    validContainerIntent.body,
  );
  assertCondition(
    (validContainerIntent.body as { actedBy?: string }).actedBy === "capability-vault",
    "Container capability request was not executed by the vault",
  );
  assertCondition(
    !/credential|secret|ciphertext|envelope|keyId|canary|KEK/iu.test(
      JSON.stringify(validContainerIntent.body),
    ),
    "Capability response exposed vault material",
  );

  const crossRequestId = `capability-cross-project-${crypto.randomUUID()}`;
  const crossExisting = await invokeCapabilityFromContainer(
    "capability-cross-existing",
    capabilityIntent(crossRequestId, foreignExistingProjectId),
  );
  const crossMissing = await invokeCapabilityFromContainer(
    "capability-cross-missing",
    capabilityIntent(crossRequestId, foreignMissingProjectId),
  );
  assertStatus(
    "capability.isolation.foreign-existing",
    crossExisting.status,
    403,
    crossExisting.body,
  );
  assertStatus("capability.isolation.foreign-missing", crossMissing.status, 403, crossMissing.body);
  assertCondition(
    JSON.stringify(crossExisting.body) === JSON.stringify(crossMissing.body),
    "Cross-project rejection leaks capability existence",
  );
  assertCondition(
    (crossExisting.body as { code?: string }).code === "capability_tenant_mismatch",
    "Cross-project request returned the wrong structured error",
  );

  const directInvocation = capabilityInvocation(`capability-direct-valid-${crypto.randomUUID()}`);
  const unsignedCapability = await fetch(`${controlUrl}${capabilityEndpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(directInvocation),
  });
  assertStatus(
    "capability.auth.unsigned",
    unsignedCapability.status,
    401,
    await readResponse(unsignedCapability),
  );

  const tamperedCapability = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: { ...directInvocation, requestId: `capability-tampered-${crypto.randomUUID()}` },
    nonce: nonce("capability-tampered"),
    idempotencyKey: `capability-tampered-${crypto.randomUUID()}`,
    signatureOverride: "0".repeat(64),
  });
  assertStatus(
    "capability.auth.tampered",
    tamperedCapability.response.status,
    401,
    tamperedCapability.body,
  );

  const expiredRequestId = `capability-expired-${crypto.randomUUID()}`;
  const expiredCapability = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: capabilityInvocation(expiredRequestId),
    nonce: nonce("capability-expired"),
    idempotencyKey: expiredRequestId,
    timestampMs: Date.now() + workerClockOffsetMs - 60_001,
  });
  assertStatus(
    "capability.auth.expired",
    expiredCapability.response.status,
    401,
    expiredCapability.body,
  );

  const validDirectRequestId = `capability-direct-replay-${crypto.randomUUID()}`;
  const validDirect = await acceptedReplayableRequest(
    {
      path: capabilityEndpoint,
      method: "POST",
      body: capabilityInvocation(validDirectRequestId),
      nonce: nonce("capability-direct"),
      idempotencyKey: validDirectRequestId,
    },
    "capability.auth.valid",
  );
  assertStatus("capability.auth.valid", validDirect.response.status, 200, validDirect.body);
  const replayedCapability = await replaySignedRequest(
    validDirect.request,
    "capability.auth.replay",
  );
  assertStatus(
    "capability.auth.replay",
    replayedCapability.response.status,
    409,
    replayedCapability.body,
  );

  const missingBindingRequestId = `capability-missing-binding-${crypto.randomUUID()}`;
  const missingBinding = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: capabilityInvocation(
      missingBindingRequestId,
      "0000000000000000000000000000000000000000000000000000000000000000",
    ),
    nonce: nonce("capability-missing-binding"),
    idempotencyKey: missingBindingRequestId,
  });
  assertStatus(
    "capability.isolation.missing-binding",
    missingBinding.response.status,
    403,
    missingBinding.body,
  );

  const upgradeRejected = await websocketCapabilityRejection();
  assertStatus("capability.upgrade.rejected", upgradeRejected.status, 426, upgradeRejected.body);

  const directVault = (await runContainerNode(
    "capability-vault-direct",
    "fetch('http://capability-vault.staging.nabuflow.internal/v1/direct').then(async response=>console.log(JSON.stringify({status:response.status,body:await response.text()})))",
  )) as { status: number; body: string };
  assertStatus("capability.vault.direct-unreachable", directVault.status, 520, directVault.body);

  await provisionDatabaseCapability(locator.projectId);
  await provisionDatabaseCapability(foreignExistingProjectId);

  const databaseProbeInput = {
    kind: "statement",
    sql: "select $1::text as value",
    params: ["auth-probe"],
  };
  const databaseCrossRequestId = `database-cross-project-${crypto.randomUUID()}`;
  const databaseCrossExisting = await invokeCapabilityFromContainer(
    "database-cross-existing",
    databaseCapabilityIntent(databaseCrossRequestId, databaseProbeInput, foreignExistingProjectId),
  );
  const databaseCrossMissing = await invokeCapabilityFromContainer(
    "database-cross-missing",
    databaseCapabilityIntent(databaseCrossRequestId, databaseProbeInput, foreignMissingProjectId),
  );
  assertStatus(
    "database.isolation.foreign-existing",
    databaseCrossExisting.status,
    403,
    databaseCrossExisting.body,
  );
  assertStatus(
    "database.isolation.foreign-missing",
    databaseCrossMissing.status,
    403,
    databaseCrossMissing.body,
  );
  assertCondition(
    JSON.stringify(databaseCrossExisting.body) === JSON.stringify(databaseCrossMissing.body),
    "Database cross-project rejection leaks capability existence",
  );

  const unsignedDatabaseInvocation = databaseCapabilityInvocation(
    `database-unsigned-${crypto.randomUUID()}`,
    databaseProbeInput,
  );
  const unsignedDatabase = await fetch(`${controlUrl}${capabilityEndpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unsignedDatabaseInvocation),
  });
  assertStatus(
    "database.auth.unsigned",
    unsignedDatabase.status,
    401,
    await readResponse(unsignedDatabase),
  );

  const tamperedDatabase = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: databaseCapabilityInvocation(
      `database-tampered-${crypto.randomUUID()}`,
      databaseProbeInput,
    ),
    nonce: nonce("database-tampered"),
    idempotencyKey: `database-tampered-${crypto.randomUUID()}`,
    signatureOverride: "0".repeat(64),
  });
  assertStatus(
    "database.auth.tampered",
    tamperedDatabase.response.status,
    401,
    tamperedDatabase.body,
  );

  const expiredDatabaseRequestId = `database-expired-${crypto.randomUUID()}`;
  const expiredDatabase = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: databaseCapabilityInvocation(expiredDatabaseRequestId, databaseProbeInput),
    nonce: nonce("database-expired"),
    idempotencyKey: expiredDatabaseRequestId,
    timestampMs: Date.now() + workerClockOffsetMs - 60_001,
  });
  assertStatus("database.auth.expired", expiredDatabase.response.status, 401, expiredDatabase.body);

  const validDatabaseRequestId = `database-valid-${crypto.randomUUID()}`;
  const validDatabase = await acceptedReplayableRequest(
    {
      path: capabilityEndpoint,
      method: "POST",
      body: databaseCapabilityInvocation(validDatabaseRequestId, databaseProbeInput),
      nonce: nonce("database-valid"),
      idempotencyKey: validDatabaseRequestId,
    },
    "database.auth.valid",
  );
  assertStatus("database.auth.valid", validDatabase.response.status, 200, validDatabase.body);
  assertCondition(
    (validDatabase.body as { actedBy?: string }).actedBy === "database-broker",
    "Valid database request was not executed by the broker",
  );
  const replayedDatabase = await replaySignedRequest(validDatabase.request, "database.auth.replay");
  assertStatus(
    "database.auth.replay",
    replayedDatabase.response.status,
    409,
    replayedDatabase.body,
  );

  await invokeDatabaseFromContainer("create-table", {
    kind: "statement",
    sql: "create table gateway_items (id integer primary key, value text not null)",
    params: [],
  });
  const inserted = await invokeDatabaseFromContainer("insert", {
    kind: "statement",
    sql: "insert into gateway_items(id, value) values ($1, $2) returning id, value",
    params: [1, "created"],
  });
  assertCondition(
    JSON.stringify(inserted).includes('"value":"created"'),
    "Database insert did not round-trip",
  );
  const selected = await invokeDatabaseFromContainer("parameterized-select", {
    kind: "statement",
    sql: "select id, value from gateway_items where id = $1",
    params: [1],
  });
  assertCondition(
    JSON.stringify(selected).includes('"value":"created"'),
    "Parameterized select did not return the inserted row",
  );
  const updated = await invokeDatabaseFromContainer("update", {
    kind: "statement",
    sql: "update gateway_items set value = $1 where id = $2 returning id, value",
    params: ["updated", 1],
  });
  assertCondition(
    JSON.stringify(updated).includes('"value":"updated"'),
    "Database update did not round-trip",
  );
  const deleted = await invokeDatabaseFromContainer("delete", {
    kind: "statement",
    sql: "delete from gateway_items where id = $1 returning id",
    params: [1],
  });
  assertCondition(
    JSON.stringify(deleted).includes('"rowCount":1'),
    "Database delete did not affect one row",
  );

  const committedBatch = await invokeDatabaseFromContainer("batch-commit", {
    kind: "atomic-batch",
    statements: [
      { sql: "insert into gateway_items(id, value) values ($1, $2)", params: [2, "two"] },
      { sql: "insert into gateway_items(id, value) values ($1, $2)", params: [3, "three"] },
      { sql: "select count(*)::int as count from gateway_items", params: [] },
    ],
  });
  assertCondition(
    JSON.stringify(committedBatch).includes('"count":2'),
    "Atomic batch did not commit all statements together",
  );
  const failedBatch = await invokeDatabaseFromContainer(
    "batch-rollback",
    {
      kind: "atomic-batch",
      statements: [
        { sql: "insert into gateway_items(id, value) values ($1, $2)", params: [4, "four"] },
        {
          sql: "insert into gateway_items(id, value) values ($1, $2)",
          params: [2, "duplicate"],
        },
      ],
    },
    409,
  );
  assertCondition(
    (failedBatch as { code?: string }).code === "database_conflict",
    "Failed atomic batch returned an unexpected sanitized error",
  );
  const rollbackCheck = await invokeDatabaseFromContainer("batch-rollback-check", {
    kind: "statement",
    sql: "select id from gateway_items where id = $1",
    params: [4],
  });
  assertCondition(
    JSON.stringify(rollbackCheck).includes('"rows":[]'),
    "Failed atomic batch left a partially committed row",
  );

  const inducedError = await invokeDatabaseFromContainer(
    "sanitized-error",
    {
      kind: "statement",
      sql: "select * from table_that_does_not_exist_2b_vii",
      params: [],
    },
    400,
  );
  const inducedErrorText = JSON.stringify(inducedError);
  assertCondition(
    (inducedError as { code?: string }).code === "database_invalid_query" &&
      !inducedErrorText.includes(neonDatabaseHost) &&
      !/postgres(?:ql)?:\/\//iu.test(inducedErrorText) &&
      !inducedErrorText.includes("staging-password"),
    "Sanitized database error exposed connection details",
  );

  const directDatabase = (await runContainerNode(
    "database-host-direct",
    `fetch(${JSON.stringify(`https://${neonDatabaseHost}/sql`)},{method:'POST'}).then(async response=>console.log(JSON.stringify({connected:response.status<500,status:response.status}))).catch(error=>console.log(JSON.stringify({connected:false,errorType:error&&error.name||'Error'})))`,
  )) as { connected: boolean; status?: number; errorType?: string };
  assertCondition(directDatabase.connected === false, "Tenant container reached the Neon host");
  record("database.direct-host.blocked", directDatabase.status ?? "blocked", {
    connected: false,
    errorType: directDatabase.errorType ?? null,
  });

  await provisionStripeCapability(locator.projectId);
  await provisionStripeCapability(foreignExistingProjectId);

  const stripeProbeKey = `stripe-auth-probe-${crypto.randomUUID()}`;
  const stripeProbeInput = {
    kind: "create-payment-intent",
    idempotencyKey: stripeProbeKey,
    amount: 1_099,
    currency: "usd",
  };
  const stripeCrossRequestId = `stripe-cross-project-${crypto.randomUUID()}`;
  const stripeCrossExisting = await invokeCapabilityFromContainer(
    "stripe-cross-existing",
    stripeCapabilityIntent(stripeCrossRequestId, stripeProbeInput, foreignExistingProjectId),
  );
  const stripeCrossMissing = await invokeCapabilityFromContainer(
    "stripe-cross-missing",
    stripeCapabilityIntent(stripeCrossRequestId, stripeProbeInput, foreignMissingProjectId),
  );
  assertStatus(
    "stripe.isolation.foreign-existing",
    stripeCrossExisting.status,
    403,
    stripeCrossExisting.body,
  );
  assertStatus(
    "stripe.isolation.foreign-missing",
    stripeCrossMissing.status,
    403,
    stripeCrossMissing.body,
  );
  assertCondition(
    JSON.stringify(stripeCrossExisting.body) === JSON.stringify(stripeCrossMissing.body) &&
      (stripeCrossExisting.body as { code?: string }).code === "capability_tenant_mismatch",
    "Stripe cross-project rejection leaks capability existence",
  );

  const unsignedStripeInvocation = stripeCapabilityInvocation(
    `stripe-unsigned-${crypto.randomUUID()}`,
    stripeProbeInput,
  );
  const unsignedStripe = await fetch(`${controlUrl}${capabilityEndpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unsignedStripeInvocation),
  });
  assertStatus(
    "stripe.auth.unsigned",
    unsignedStripe.status,
    401,
    await readResponse(unsignedStripe),
  );

  const tamperedStripe = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: stripeCapabilityInvocation(`stripe-tampered-${crypto.randomUUID()}`, stripeProbeInput),
    nonce: nonce("stripe-tampered"),
    idempotencyKey: `stripe-tampered-${crypto.randomUUID()}`,
    signatureOverride: "0".repeat(64),
  });
  assertStatus("stripe.auth.tampered", tamperedStripe.response.status, 401, tamperedStripe.body);

  const expiredStripeRequestId = `stripe-expired-${crypto.randomUUID()}`;
  const expiredStripe = await signedFetch({
    path: capabilityEndpoint,
    method: "POST",
    body: stripeCapabilityInvocation(expiredStripeRequestId, stripeProbeInput),
    nonce: nonce("stripe-expired"),
    idempotencyKey: expiredStripeRequestId,
    timestampMs: Date.now() + workerClockOffsetMs - 60_001,
  });
  assertStatus("stripe.auth.expired", expiredStripe.response.status, 401, expiredStripe.body);

  const validStripeRequestId = `stripe-valid-${crypto.randomUUID()}`;
  const validStripe = await acceptedReplayableRequest(
    {
      path: capabilityEndpoint,
      method: "POST",
      body: stripeCapabilityInvocation(validStripeRequestId, stripeProbeInput),
      nonce: nonce("stripe-valid"),
      idempotencyKey: validStripeRequestId,
    },
    "stripe.auth.valid",
  );
  assertStatus("stripe.auth.valid", validStripe.response.status, 200, validStripe.body);
  const authPaymentIntent = (
    validStripe.body as {
      actedBy?: string;
      paymentIntent?: { id?: string; livemode?: boolean };
    }
  ).paymentIntent;
  assertCondition(
    (validStripe.body as { actedBy?: string }).actedBy === "stripe-broker" &&
      authPaymentIntent?.id &&
      authPaymentIntent.livemode === false,
    "Valid Stripe request did not return a test-mode PaymentIntent",
  );
  stripePaymentIntentIds.add(authPaymentIntent.id);
  const replayedStripe = await replaySignedRequest(validStripe.request, "stripe.auth.replay");
  assertStatus("stripe.auth.replay", replayedStripe.response.status, 409, replayedStripe.body);
  await expectStripeObjectCount(
    "stripe.auth.valid.provider-object-count",
    stripeIdempotencyDigest(locator.projectId, stripeProbeKey),
    1,
  );

  const businessIdempotencyKey = `stripe-business-payment-${crypto.randomUUID()}`;
  const createInput = {
    kind: "create-payment-intent",
    idempotencyKey: businessIdempotencyKey,
    amount: 2_499,
    currency: "usd",
  };
  const created = await invokeStripeFromContainer("create", createInput);
  const createdPaymentIntent = (
    created as {
      operation?: string;
      idempotentReplay?: boolean;
      paymentIntent?: {
        id?: string;
        amount?: number;
        currency?: string;
        livemode?: boolean;
      };
    }
  ).paymentIntent;
  assertCondition(
    (created as { operation?: string }).operation === "create-payment-intent" &&
      (created as { idempotentReplay?: boolean }).idempotentReplay === false &&
      createdPaymentIntent?.id &&
      createdPaymentIntent.amount === 2_499 &&
      createdPaymentIntent.currency === "usd" &&
      createdPaymentIntent.livemode === false,
    "Stripe create did not return the expected sanitized test-mode result",
  );
  stripePaymentIntentIds.add(createdPaymentIntent.id);

  const retrieved = await invokeStripeFromContainer("retrieve", {
    kind: "retrieve-payment-intent",
    paymentIntentId: createdPaymentIntent.id,
  });
  assertCondition(
    (retrieved as { paymentIntent?: { id?: string; livemode?: boolean } }).paymentIntent?.id ===
      createdPaymentIntent.id &&
      (retrieved as { paymentIntent?: { livemode?: boolean } }).paymentIntent?.livemode === false,
    "Stripe retrieve did not return the owned test-mode PaymentIntent",
  );

  const retried = await invokeStripeFromContainer("idempotent-retry", createInput);
  assertCondition(
    (retried as { paymentIntent?: { id?: string } }).paymentIntent?.id ===
      createdPaymentIntent.id &&
      (retried as { idempotentReplay?: boolean }).idempotentReplay === true,
    "Stripe business retry did not resolve to the original durable result",
  );
  const businessDigest = stripeIdempotencyDigest(locator.projectId, businessIdempotencyKey);
  await expectStripeObjectCount("stripe.idempotency.provider-object-count", businessDigest, 1);

  const changedPayload = await invokeStripeFromContainer(
    "idempotency-conflict",
    { ...createInput, amount: 2_500 },
    409,
  );
  assertCondition(
    (changedPayload as { code?: string }).code === "stripe_idempotency_conflict",
    "Same Stripe idempotency key with a different payload did not fail closed",
  );
  await expectStripeObjectCount(
    "stripe.idempotency.conflict-provider-object-count",
    businessDigest,
    1,
  );

  const overMaxKey = `stripe-over-max-${crypto.randomUUID()}`;
  const overMax = await invokeStripeFromContainer(
    "policy-over-max",
    {
      kind: "create-payment-intent",
      idempotencyKey: overMaxKey,
      amount: stripePolicy.maxAmount + 1,
      currency: "usd",
    },
    403,
  );
  assertCondition(
    (overMax as { code?: string }).code === "capability_policy_rejected",
    "Over-max Stripe request did not return a structured policy rejection",
  );
  await expectStripeObjectCount(
    "stripe.policy.over-max-provider-object-count",
    stripeIdempotencyDigest(locator.projectId, overMaxKey),
    0,
  );

  const disallowedCurrencyKey = `stripe-disallowed-currency-${crypto.randomUUID()}`;
  const disallowedCurrency = await invokeStripeFromContainer(
    "policy-disallowed-currency",
    {
      kind: "create-payment-intent",
      idempotencyKey: disallowedCurrencyKey,
      amount: 1_099,
      currency: "eur",
    },
    403,
  );
  assertCondition(
    (disallowedCurrency as { code?: string }).code === "capability_policy_rejected",
    "Disallowed Stripe currency did not return a structured policy rejection",
  );
  await expectStripeObjectCount(
    "stripe.policy.disallowed-currency-provider-object-count",
    stripeIdempotencyDigest(locator.projectId, disallowedCurrencyKey),
    0,
  );

  const invalidAmountKey = `stripe-provider-invalid-${crypto.randomUUID()}`;
  const stripeSanitizedError = await invokeStripeFromContainer(
    "sanitized-error",
    {
      kind: "create-payment-intent",
      idempotencyKey: invalidAmountKey,
      amount: 1,
      currency: "usd",
    },
    400,
  );
  const stripeSanitizedErrorText = JSON.stringify(stripeSanitizedError);
  assertCondition(
    (stripeSanitizedError as { code?: string }).code === "stripe_invalid_request" &&
      !stripeSanitizedErrorText.includes(stripeTestSecretKey) &&
      !stripeSanitizedErrorText.includes("sk_test_") &&
      !stripeSanitizedErrorText.includes("api.stripe.com") &&
      !stripeProviderLeakPatterns.some((pattern) => pattern.test(stripeSanitizedErrorText)),
    "Sanitized Stripe error exposed provider or credential details",
  );
  await expectStripeObjectCount(
    "stripe.sanitized-error-provider-object-count",
    stripeIdempotencyDigest(locator.projectId, invalidAmountKey),
    0,
  );

  await provisionStripeCapability(locator.projectId, `stripe-v2-${locator.projectId}`);
  const revisionAmbiguity = await invokeStripeFromContainer(
    "credential-revision-ambiguity",
    createInput,
    409,
  );
  assertCondition(
    (revisionAmbiguity as { code?: string }).code === "stripe_idempotency_conflict",
    "Stripe retry across a credential revision did not fail closed",
  );
  await expectStripeObjectCount(
    "stripe.idempotency.revision-provider-object-count",
    businessDigest,
    1,
  );

  const directStripe = (await runContainerNode(
    "stripe-host-direct",
    "fetch('https://api.stripe.com/v1/payment_intents').then(response=>console.log(JSON.stringify({connected:response.status<500,status:response.status}))).catch(error=>console.log(JSON.stringify({connected:false,errorType:error&&error.name||'Error'})))",
  )) as { connected: boolean; status?: number; errorType?: string };
  assertCondition(directStripe.connected === false, "Tenant container reached api.stripe.com");
  record("stripe.direct-host.blocked", directStripe.status ?? "blocked", {
    connected: false,
    errorType: directStripe.errorType ?? null,
  });

  const activationPath = `/_nabuflow/control/v1/routes/${simulatedHost}/activate`;
  const activationBody = activateBody(simulatedHost);
  const unsignedActivate = await fetch(`${controlUrl}${activationPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(activationBody),
  });
  assertStatus(
    "route.activate.unsigned",
    unsignedActivate.status,
    401,
    await readResponse(unsignedActivate),
  );
  const tamperedActivate = await signedFetch({
    path: activationPath,
    method: "POST",
    body: activationBody,
    nonce: nonce("route-activate-tampered"),
    idempotencyKey: `route-activate-tampered-${locator.projectId}`,
    signatureOverride: "0".repeat(64),
  });
  assertStatus(
    "route.activate.tampered",
    tamperedActivate.response.status,
    401,
    tamperedActivate.body,
  );
  const expiredActivate = await signedFetch({
    path: activationPath,
    method: "POST",
    body: activationBody,
    nonce: nonce("route-activate-expired"),
    idempotencyKey: `route-activate-expired-${locator.projectId}`,
    timestampMs: Date.now() + workerClockOffsetMs - 60_001,
  });
  assertStatus(
    "route.activate.expired",
    expiredActivate.response.status,
    401,
    expiredActivate.body,
  );

  const greenIdentity = await deriveRuntimeIdentity({
    namespace: deploymentNamespace,
    projectId: locator.projectId,
    role: "production",
    slot: "green",
  });
  const greenRejected = await signedFetch({
    path: activationPath,
    method: "POST",
    body: {
      route: routeRecord(simulatedHost, "green", greenIdentity),
      expectedPreviousManifestRevision: null,
    },
    nonce: nonce("route-activate-green"),
    idempotencyKey: `route-activate-green-${locator.projectId}`,
  });
  assertStatus(
    "route.activate.green-rejected",
    greenRejected.response.status,
    400,
    greenRejected.body,
  );
  assertCondition(
    (greenRejected.body as { code?: string }).code === "production_blue_required",
    "Production-green route did not return production_blue_required",
  );

  const validActivate = await acceptedReplayableRequest(
    {
      path: activationPath,
      method: "POST",
      body: activationBody,
      nonce: nonce("route-activate-valid"),
      idempotencyKey: `route-activate-valid-${locator.projectId}`,
    },
    "route.activate.valid",
  );
  assertStatus("route.activate.valid", validActivate.response.status, 200, validActivate.body);
  registeredHosts.add(simulatedHost);
  const replayActivate = await replaySignedRequest(validActivate.request, "route.activate.replay");
  assertStatus("route.activate.replay", replayActivate.response.status, 409, replayActivate.body);

  await activateRoute(workerHost, "route.self-host");

  const unknown = await publishedFetch("missing.apps.mustaflow.com", "/missing");
  assertStatus("published.unknown", unknown.response.status, 404, unknown.body);
  assertCondition(
    (unknown.body as { code?: string }).code === "published_route_not_found",
    "Unknown host leaked an unexpected response",
  );

  for (const [method, body] of [
    ["GET", undefined],
    ["POST", "post-body"],
    ["PUT", "put-body"],
    ["DELETE", "delete-body"],
  ] as const) {
    const result = await publishedFetch(simulatedHost, "/echo", { method, body });
    assertStatus(`published.http.${method}`, result.response.status, 200, {
      ...(result.body as object),
      routeLookupAndRequestMs: result.elapsedMs,
    });
    const reflected = result.body as { method?: string; bodySha256?: string };
    assertCondition(reflected.method === method, `${method} changed across the published gateway`);
    assertCondition(
      reflected.bodySha256 ===
        createHash("sha256")
          .update(body ?? "")
          .digest("hex"),
      `${method} body changed across the published gateway`,
    );
  }

  const largeBody = "published-stream-integrity-0123456789abcdef".repeat(65_536);
  const largeHash = createHash("sha256").update(largeBody).digest("hex");
  const large = await publishedFetch(simulatedHost, "/large", { method: "POST", body: largeBody });
  assertStatus("published.http.large-stream", large.response.status, 200, {
    ...(large.body as object),
    expectedBytes: Buffer.byteLength(largeBody),
    expectedSha256: largeHash,
  });
  const largeResult = large.body as { bodyBytes?: number; bodySha256?: string };
  assertCondition(
    largeResult.bodyBytes === Buffer.byteLength(largeBody),
    "Large body length changed",
  );
  assertCondition(largeResult.bodySha256 === largeHash, "Large body hash changed");

  const sseStarted = performance.now();
  const sse = await signedHostOverrideFetch(
    simulatedHost,
    "/sse",
    { method: "GET" },
    "published.GET.sse",
  );
  assertCondition(sse.status === 200 && sse.body, "Published SSE request failed");
  const sseReader = sse.body.getReader();
  const first = await sseReader.read();
  const firstAtMs = performance.now() - sseStarted;
  const second = await sseReader.read();
  const secondAtMs = performance.now() - sseStarted;
  const firstText = new TextDecoder().decode(first.value);
  const secondText = new TextDecoder().decode(second.value);
  assertCondition(firstText.includes("data: first"), "First SSE event was not streamed");
  assertCondition(secondText.includes("data: second"), "Second SSE event was not streamed");
  assertCondition(secondAtMs - firstAtMs >= 900, "SSE events were buffered together");
  record("published.http.sse", sse.status, { firstAtMs, secondAtMs, firstText, secondText });

  const wsUrl = `${controlUrl.replace(/^http/, "ws")}/socket`;
  const websocket = await websocketEcho(wsUrl, "anonymous-published-websocket");
  assertCondition(websocket.status === 101, "Published WebSocket did not upgrade with 101");
  assertCondition(websocket.received === `echo:${websocket.sent}`, "WebSocket echo changed");
  record("published.websocket.echo", 101, websocket);

  const hygiene = await publishedFetch(simulatedHost, "/headers", {
    headers: {
      authorization: "Bearer tenant-app-token",
      cookie: "__session=platform-secret; mustaflow_auth=platform; theme=dark",
      "x-forwarded-for": "198.51.100.44",
      "x-forwarded-host": "attacker.invalid",
      "x-forwarded-proto": "http",
      "x-nabuflow-signature": "control-signature-marker",
      "idempotency-key": "control-key",
    },
  });
  assertStatus("published.hygiene.request", hygiene.response.status, 200, hygiene.body);
  const reflectedHeaders = (hygiene.body as { headers: Record<string, string> }).headers;
  assertCondition(
    reflectedHeaders.authorization === "Bearer tenant-app-token",
    "App auth stripped",
  );
  assertCondition(reflectedHeaders.cookie === "theme=dark", "Platform cookie reached tenant");
  assertCondition(
    reflectedHeaders["x-forwarded-for"] !== "198.51.100.44" &&
      reflectedHeaders["x-forwarded-host"] === simulatedHost &&
      reflectedHeaders["x-forwarded-proto"] === "https",
    "Trusted forwarding metadata was not rebuilt",
  );
  assertCondition(
    reflectedHeaders["x-nabuflow-signature"] === undefined &&
      reflectedHeaders["x-nabuflow-staging-host-override"] === undefined &&
      reflectedHeaders["idempotency-key"] === undefined,
    "Platform or override headers reached tenant",
  );

  const badCookieHeaders = await overrideHeaders(simulatedHost, "/cookie-bad", "GET");
  const badCookie = await fetch(`${controlUrl}/cookie-bad`, { headers: badCookieHeaders });
  assertCondition(badCookie.status === 200, "Response-cookie probe failed");
  assertCondition(badCookie.headers.get("set-cookie") === null, "Forbidden tenant cookie escaped");
  record("published.hygiene.response-cookie", 200, {
    setCookie: null,
    forbiddenDomain: ".mustaflow.com",
  });

  const credentials = await signedControlFetch(
    {
      path: `${runtimePath}/exec`,
      method: "POST",
      body: {
        locator,
        argv: [
          "node",
          "-e",
          "const names=Object.keys(process.env).filter(k=>/(TOKEN|SECRET|KEY|PASSWORD|DATABASE_URL)/i.test(k));console.log(names.length?names.join(','):'none')",
        ],
        cwd: "/workspace",
        timeoutMs: 10_000,
      },
      nonce: nonce("credential-names"),
      idempotencyKey: `published-credential-names-${locator.projectId}`,
    },
    "security.container-credentials",
  );
  assertStatus(
    "security.container-credentials",
    credentials.response.status,
    200,
    credentials.body,
  );
  assertCondition(
    (credentials.body as { stdout?: string }).stdout?.trim() === "none",
    "Credential-like environment names reached the tenant container",
  );

  const deletePath = `/_nabuflow/control/v1/routes/${simulatedHost}`;
  const deleteBody = deactivateBody(simulatedHost);
  const unsignedDelete = await fetch(`${controlUrl}${deletePath}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deleteBody),
  });
  assertStatus(
    "route.deactivate.unsigned",
    unsignedDelete.status,
    401,
    await readResponse(unsignedDelete),
  );
  const tamperedDelete = await signedFetch({
    path: deletePath,
    method: "DELETE",
    body: deleteBody,
    nonce: nonce("route-deactivate-tampered"),
    idempotencyKey: `route-deactivate-tampered-${locator.projectId}`,
    signatureOverride: "0".repeat(64),
  });
  assertStatus(
    "route.deactivate.tampered",
    tamperedDelete.response.status,
    401,
    tamperedDelete.body,
  );
  const expiredDelete = await signedFetch({
    path: deletePath,
    method: "DELETE",
    body: deleteBody,
    nonce: nonce("route-deactivate-expired"),
    idempotencyKey: `route-deactivate-expired-${locator.projectId}`,
    timestampMs: Date.now() + workerClockOffsetMs - 60_001,
  });
  assertStatus("route.deactivate.expired", expiredDelete.response.status, 401, expiredDelete.body);
  const validDelete = await acceptedReplayableRequest(
    {
      path: deletePath,
      method: "DELETE",
      body: deleteBody,
      nonce: nonce("route-deactivate-valid"),
      idempotencyKey: `route-deactivate-valid-${locator.projectId}`,
    },
    "route.deactivate.valid",
  );
  assertStatus("route.deactivate.valid", validDelete.response.status, 200, validDelete.body);
  registeredHosts.delete(simulatedHost);
  const replayDelete = await replaySignedRequest(validDelete.request, "route.deactivate.replay");
  assertStatus("route.deactivate.replay", replayDelete.response.status, 409, replayDelete.body);

  const invalidated = await publishedFetch(simulatedHost, "/after-unregister");
  assertStatus("published.unregister-immediate", invalidated.response.status, 404, {
    body: invalidated.body,
    elapsedMs: invalidated.elapsedMs,
  });

  await waitForBrowser();

  await deactivateRoute(workerHost, "route.self-host");
  const selfInvalidatedStarted = performance.now();
  const selfInvalidated = await fetch(`${controlUrl}/`);
  assertStatus("published.self-host-unregister-immediate", selfInvalidated.status, 404, {
    body: await readResponse(selfInvalidated),
    elapsedMs: performance.now() - selfInvalidatedStarted,
  });
}

async function verifyPreviewAuthRegression(): Promise<void> {
  const previewIdentity = await deriveRuntimeIdentity({
    namespace: deploymentNamespace,
    projectId: locator.projectId,
    role: "preview",
    slot: "primary",
  });
  const previewPath = `/_nabuflow/preview/v1/${previewIdentity}/`;
  const nowSeconds = Math.floor((Date.now() + workerClockOffsetMs) / 1_000);
  const claims = {
    v: 1 as const,
    iss: "nabuflow-api" as const,
    aud: controlUrl,
    sub: previewIdentity,
    port: 8080,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: crypto.randomUUID().replaceAll("-", ""),
  };

  const missing = await fetch(`${controlUrl}${previewPath}`, { redirect: "manual" });
  assertStatus("preview.auth.missing", missing.status, 401, await readResponse(missing));

  const validGrant = await signPreviewGrant(previewPrivateKey, claims);
  const grantSegments = validGrant.split(".");
  const firstSignatureCharacter = grantSegments[2][0];
  grantSegments[2] = `${firstSignatureCharacter === "A" ? "B" : "A"}${grantSegments[2].slice(1)}`;
  const tamperedGrant = grantSegments.join(".");
  const tampered = await fetch(
    `${controlUrl}${previewPath}?__nfg=${encodeURIComponent(tamperedGrant)}`,
    { redirect: "manual" },
  );
  assertStatus("preview.auth.tampered", tampered.status, 401, await readResponse(tampered));

  const expiredGrant = await signPreviewGrant(previewPrivateKey, {
    ...claims,
    iat: nowSeconds - 120,
    exp: nowSeconds - 60,
    jti: crypto.randomUUID().replaceAll("-", ""),
  });
  const expired = await fetch(
    `${controlUrl}${previewPath}?__nfg=${encodeURIComponent(expiredGrant)}`,
    { redirect: "manual" },
  );
  assertStatus("preview.auth.expired", expired.status, 401, await readResponse(expired));

  const wrongKey = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const forgedGrant = await signPreviewGrant(wrongKey.privateKey, {
    ...claims,
    jti: crypto.randomUUID().replaceAll("-", ""),
  });
  const forged = await fetch(
    `${controlUrl}${previewPath}?__nfg=${encodeURIComponent(forgedGrant)}`,
    { redirect: "manual" },
  );
  assertStatus("preview.auth.wrong-key", forged.status, 401, await readResponse(forged));

  const validUrl = `${controlUrl}${previewPath}?__nfg=${encodeURIComponent(validGrant)}`;
  const accepted = await fetch(validUrl, { redirect: "manual" });
  const acceptedBody = await readResponse(accepted);
  assertStatus("preview.auth.valid", accepted.status, 302, {
    body: acceptedBody,
    location: accepted.headers.get("location"),
    setCookiePresent: accepted.headers.has("set-cookie"),
  });
  const sessionCookie = accepted.headers.get("set-cookie")?.split(";", 1)[0];
  assertCondition(sessionCookie, "Valid preview grant did not mint a session cookie");

  const replay = await fetch(validUrl, { redirect: "manual" });
  assertStatus("preview.auth.replay", replay.status, 409, await readResponse(replay));

  const session = await fetch(`${controlUrl}${previewPath}`, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  const sessionBody = await readResponse(session);
  assertStatus("preview.auth.session", session.status, 503, sessionBody);
  assertCondition(
    (sessionBody as { code?: string }).code === "preview_runtime_unavailable",
    "Redeemed preview session fell back to missing-auth classification",
  );
}

async function cleanup(): Promise<void> {
  let stripeObjectCleanupFailure: string | null = null;
  for (const [projectId, expectedRevision] of [...readinessCapabilityRevisions]) {
    const result = await signedControlFetch(
      {
        path: capabilityControlPath(projectId),
        method: "DELETE",
        body: { projectId, expectedRevision },
        nonce: nonce(`cleanup-vault-readiness-${projectId}`),
        idempotencyKey: `cleanup-vault-readiness-${projectId}-${crypto.randomUUID()}`,
      },
      `cleanup.vault-readiness.${projectId}`,
    );
    record(`cleanup.vault-readiness.${projectId}`, result.response.status, result.body);
    if (result.response.status !== 200 && result.response.status !== 404) {
      throw new Error(`Vault readiness cleanup failed for project ${projectId}`);
    }
    readinessCapabilityRevisions.delete(projectId);
  }
  for (const hostname of [...registeredHosts]) {
    await deactivateRoute(hostname, "cleanup.route");
  }
  try {
    await cleanupStripeTestObjects();
  } catch (error) {
    stripeObjectCleanupFailure =
      error instanceof Error ? error.message : "Unknown Stripe test-object cleanup failure";
    record("stripe.cleanup.failure", "failed", { message: stripeObjectCleanupFailure });
  }
  if (runtimeStarted) {
    const stopped = await signedControlFetch(
      {
        path: `${runtimePath}/stop`,
        method: "POST",
        body: { locator, reason: "published staging smoke complete" },
        nonce: nonce("cleanup-stop"),
        idempotencyKey: `published-stop-${locator.projectId}-${crypto.randomUUID()}`,
      },
      "cleanup.stop",
    );
    record("cleanup.stop", stopped.response.status, stopped.body);
    if (stopped.response.status !== 200) throw new Error("Scratch stop failed");
    runtimeStarted = false;

    const stoppedBinding = await signedControlFetch(
      {
        path: `${runtimePath}/capability-binding`,
        nonce: nonce("cleanup-capability-binding"),
      },
      "cleanup.capability-binding",
    );
    assertStatus(
      "cleanup.capability-binding",
      stoppedBinding.response.status,
      200,
      stoppedBinding.body,
    );
    assertCondition(
      (stoppedBinding.body as { active?: boolean; containerId?: string | null }).active === false &&
        (stoppedBinding.body as { containerId?: string | null }).containerId === null,
      "Stopped runtime retained an active capability binding",
    );

    if (activeContainerId) {
      const staleRequestId = `capability-stale-binding-${crypto.randomUUID()}`;
      const staleInvocation = await signedControlFetch(
        {
          path: capabilityEndpoint,
          method: "POST",
          body: capabilityInvocation(staleRequestId, activeContainerId),
          nonce: nonce("cleanup-capability-stale"),
          idempotencyKey: staleRequestId,
        },
        "cleanup.capability-stale",
      );
      assertStatus(
        "cleanup.capability-stale",
        staleInvocation.response.status,
        403,
        staleInvocation.body,
      );
      assertCondition(
        (staleInvocation.body as { code?: string }).code === "capability_runtime_unbound",
        "Stopped runtime did not fail closed at the capability wall",
      );

      const staleDatabaseRequestId = `database-stale-binding-${crypto.randomUUID()}`;
      const staleDatabase = await signedControlFetch(
        {
          path: capabilityEndpoint,
          method: "POST",
          body: databaseCapabilityInvocation(
            staleDatabaseRequestId,
            { kind: "statement", sql: "select 1", params: [] },
            activeContainerId,
          ),
          nonce: nonce("cleanup-database-stale"),
          idempotencyKey: staleDatabaseRequestId,
        },
        "cleanup.database-stale",
      );
      assertStatus(
        "cleanup.database-stale",
        staleDatabase.response.status,
        403,
        staleDatabase.body,
      );
      assertCondition(
        (staleDatabase.body as { code?: string }).code === "capability_runtime_unbound",
        "Stopped runtime did not fail closed for the database capability",
      );

      const staleStripeRequestId = `stripe-stale-binding-${crypto.randomUUID()}`;
      const staleStripe = await signedControlFetch(
        {
          path: capabilityEndpoint,
          method: "POST",
          body: stripeCapabilityInvocation(
            staleStripeRequestId,
            {
              kind: "create-payment-intent",
              idempotencyKey: `stripe-stale-business-${crypto.randomUUID()}`,
              amount: 1_099,
              currency: "usd",
            },
            activeContainerId,
          ),
          nonce: nonce("cleanup-stripe-stale"),
          idempotencyKey: staleStripeRequestId,
        },
        "cleanup.stripe-stale",
      );
      assertStatus("cleanup.stripe-stale", staleStripe.response.status, 403, staleStripe.body);
      assertCondition(
        (staleStripe.body as { code?: string }).code === "capability_runtime_unbound",
        "Stopped runtime did not fail closed for the Stripe capability",
      );
    } else {
      record("cleanup.capability-stale", "skipped", {
        reason: "No active container binding was observed before the stopped run",
      });
    }
  }
  for (const projectId of [...provisionedStripeProjects]) {
    await revokeStripeCapability(projectId);
  }
  for (const projectId of [...provisionedDatabaseProjects]) {
    await revokeDatabaseCapability(projectId);
  }
  for (const projectId of [...provisionedCapabilityProjects]) {
    await revokeCapability(projectId);
  }
  if (runtimeEnsured) {
    const destroyed = await signedControlFetch(
      {
        path: runtimePath,
        method: "DELETE",
        body: { locator, reason: "mandatory published staging cleanup" },
        nonce: nonce("cleanup-destroy"),
        idempotencyKey: `published-destroy-${locator.projectId}-${crypto.randomUUID()}`,
      },
      "cleanup.destroy",
    );
    record("cleanup.destroy", destroyed.response.status, destroyed.body);
    if (destroyed.response.status !== 200) throw new Error("Scratch destroy failed");
    runtimeEnsured = false;

    const status = await signedControlFetch(
      { path: runtimePath, nonce: nonce("cleanup-status") },
      "cleanup.status",
    );
    record("cleanup.status-after-destroy", status.response.status, status.body);
    if (status.response.status !== 404) throw new Error("Destroyed runtime still resolves");
  }
  if (stripeObjectCleanupFailure !== null) throw new Error(stripeObjectCleanupFailure);
}

let failure: string | null = null;
try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error.message : "Unknown published smoke failure";
} finally {
  try {
    await cleanup();
  } catch (error) {
    const cleanupFailure = error instanceof Error ? error.message : "Unknown cleanup failure";
    failure = failure === null ? cleanupFailure : `${failure}; cleanup: ${cleanupFailure}`;
  }
  for (const path of [readyPath, holdSignal]) {
    if (path && existsSync(path)) rmSync(path, { force: true });
  }
}

const evidence = {
  workerUrl: controlUrl,
  workerHost,
  deploymentVersion,
  scratchProjectId: locator.projectId,
  runtimeIdentity,
  activeSlot: "production-blue",
  simulatedHost,
  passed: failure === null,
  failure,
  transcript,
};
const envelope = { evidence, evidenceSha256: await sha256Hex(JSON.stringify(evidence)) };
if (evidencePath) {
  mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 });
  writeFileSync(evidencePath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}
// Redacted by construction: no token, private key, or request signature is retained.
// eslint-disable-next-line no-console
console.log(JSON.stringify(envelope, null, 2));
if (failure !== null) process.exitCode = 1;
