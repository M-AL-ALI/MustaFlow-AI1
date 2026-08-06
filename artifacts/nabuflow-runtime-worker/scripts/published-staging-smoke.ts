import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  deriveRuntimeIdentity,
  sha256Hex,
  signControlRequest,
  signPreviewGrant,
  signStagingHostOverride,
} from "@workspace/tenant-runtime-contracts";
import WebSocket from "ws";

const controlUrl = required("CLOUDFLARE_RUNTIME_CONTROL_URL").replace(/\/$/, "");
const controlToken = required("CLOUDFLARE_RUNTIME_CONTROL_TOKEN");
const previewPrivateKey = required("CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY");
const deploymentNamespace = required("CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE");
const holdSignal = process.env.NABUFLOW_PUBLISHED_HOLD_SIGNAL;
const readyPath = process.env.NABUFLOW_PUBLISHED_BROWSER_READY;
const evidencePath = process.env.NABUFLOW_PUBLISHED_EVIDENCE_PATH;
const workerHost = new URL(controlUrl).hostname;

const TENANT_SERVER_SOURCE = String.raw`
const http=require('node:http');
const crypto=require('node:crypto');
const collect=async(req)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks)};
const sendJson=(res,value)=>{res.statusCode=200;res.setHeader('content-type','application/json');res.end(JSON.stringify(value))};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/','http://tenant.invalid');
  if(url.pathname==='/health'){res.statusCode=200;res.end('healthy');return}
  if(url.pathname==='/sse'){
    res.statusCode=200;res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');
    res.write('event: ready\ndata: first\n\n');
    setTimeout(()=>{res.write('event: tick\ndata: second\n\n');res.end()},1500);return
  }
  if(url.pathname==='/cookie-bad'){
    res.statusCode=200;res.setHeader('set-cookie','tenant_session=secret; Domain=.mustaflow.com; Path=/');res.end('cookie');return
  }
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
const runtimePath = `/_nabuflow/control/v1/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
const simulatedHost = `slice-2b-v-${locator.projectId}.apps.mustaflow.com`;
const registeredHosts = new Set<string>();
let deploymentVersion = "";
let workerClockOffsetMs = 0;
let runtimeEnsured = false;
let runtimeStarted = false;
let manifestRevision = "";
let runtimeIdentity = "";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
  body?: unknown;
  timestampMs?: number;
  nonce: string;
  idempotencyKey?: string;
  signatureOverride?: string;
}): Promise<Request> {
  const method = input.method ?? "GET";
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const timestamp = String(input.timestampMs ?? Date.now() + workerClockOffsetMs);
  const bodySha256 = await sha256Hex(body);
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
    body: body || undefined,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
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
    status === 502 ||
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

async function waitForSustainedGreenWindow(): Promise<unknown> {
  const startedAt = performance.now();
  let consecutive = 0;
  let totalProbes = 0;
  let stableVersion = "";
  let lastBody: unknown = null;
  while (consecutive < 20 && totalProbes < 180) {
    totalProbes += 1;
    const result = await signedFetch({
      path: "/_nabuflow/control/v1/version",
      nonce: nonce(`sustained-green-${totalProbes}`),
    });
    lastBody = result.body;
    const observedVersion = (result.body as { deploymentVersion?: string }).deploymentVersion ?? "";
    if (result.response.status === 200 && observedVersion) {
      if (stableVersion !== observedVersion) {
        stableVersion = observedVersion;
        consecutive = 0;
      }
      consecutive += 1;
    } else {
      consecutive = 0;
      stableVersion = "";
      record("control.version.sustained-green-reset", result.response.status, {
        totalProbes,
        body: result.body,
      });
    }
    if (consecutive < 20) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assertCondition(consecutive === 20, "Control authentication did not sustain 20 green probes");
  record("control.version.sustained-green", 200, {
    consecutive,
    totalProbes,
    elapsedMs: performance.now() - startedAt,
    deploymentVersion: stableVersion,
  });
  return lastBody;
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

async function publishedFetch(
  host: string,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown; elapsedMs: number }> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const signedOverride = await overrideHeaders(host, pathAndQuery, method);
  for (const [name, value] of Object.entries(signedOverride)) headers.set(name, value);
  const started = performance.now();
  const response = await fetch(`${controlUrl}${pathAndQuery}`, { ...init, method, headers });
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

  const versionBody = await waitForSustainedGreenWindow();
  record("control.version.valid", 200, versionBody);
  deploymentVersion = (versionBody as { deploymentVersion?: string }).deploymentVersion ?? "";
  assertCondition(deploymentVersion, "Worker version response omitted deploymentVersion");

  await verifyPreviewAuthRegression();

  runtimeIdentity = await deriveRuntimeIdentity({ namespace: deploymentNamespace, ...locator });
  manifestRevision = `published-manifest-${Date.now()}`;
  const ensure = await signedControlFetch(
    {
      path: runtimePath,
      method: "PUT",
      body: {
        locator,
        expectedDeploymentVersion: deploymentVersion,
        manifest: {
          revision: manifestRevision,
          runtime: "node",
          buildCommand: ["node", "--version"],
          startCommand: ["node", "-e", TENANT_SERVER_SOURCE],
          servicePort: 8080,
          healthPath: "/health",
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

  const artifactRevision = `published-artifact-${Date.now()}`;
  let start: Awaited<ReturnType<typeof signedFetch>> | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    start = await signedControlFetch(
      {
        path: `${runtimePath}/start`,
        method: "POST",
        body: {
          locator,
          expectedDeploymentVersion: deploymentVersion,
          artifactRevision,
          artifactSha256: await sha256Hex(artifactRevision),
        },
        nonce: nonce(`start-${attempt}`),
        idempotencyKey: `published-start-${locator.projectId}`,
      },
      "lifecycle.start",
    );
    if (start.response.status === 200) break;
    record("lifecycle.start.retry", start.response.status, { attempt, body: start.body });
    if (start.response.status !== 502 || attempt === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1_000));
  }
  assertCondition(start !== null, "Start probe did not run");
  assertStatus("lifecycle.start", start.response.status, 200, start.body);
  runtimeStarted = true;

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
  const replayActivate = await fetch(validActivate.request);
  assertStatus(
    "route.activate.replay",
    replayActivate.status,
    409,
    await readResponse(replayActivate),
  );

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

  const sseHeaders = await overrideHeaders(simulatedHost, "/sse", "GET");
  const sseStarted = performance.now();
  const sse = await fetch(`${controlUrl}/sse`, { headers: sseHeaders });
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
  const replayDelete = await fetch(validDelete.request);
  assertStatus(
    "route.deactivate.replay",
    replayDelete.status,
    409,
    await readResponse(replayDelete),
  );

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
  for (const hostname of [...registeredHosts]) {
    await deactivateRoute(hostname, "cleanup.route");
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
if (evidencePath) writeFileSync(evidencePath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
// Redacted by construction: no token, private key, or request signature is retained.
// eslint-disable-next-line no-console
console.log(JSON.stringify(envelope, null, 2));
if (failure !== null) process.exitCode = 1;
