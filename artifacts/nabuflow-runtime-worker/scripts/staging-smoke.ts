import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import {
  deriveRuntimeIdentity,
  sha256Hex,
  signControlRequest,
  signPreviewGrant,
} from "@workspace/tenant-runtime-contracts";
import { mintCloudflarePreviewGrant } from "../../api-server/src/lib/cloudflare-preview-grant";
import WebSocket from "ws";

const controlUrl = process.env.CLOUDFLARE_RUNTIME_CONTROL_URL;
const controlToken = process.env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN;
const previewPrivateKey = process.env.CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY;
const deploymentNamespace = process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE;
if (!controlUrl || !controlToken || !previewPrivateKey || !deploymentNamespace) {
  throw new Error("Control URL/token, preview private key, and deployment namespace are required");
}

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
    const servedAt=new Date().toISOString();
    res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NabuFlow Gateway Staging Preview</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07111f;color:#eaf2ff;font-family:Inter,system-ui}.card{width:min(760px,86vw);padding:48px;border:1px solid #2b4770;border-radius:24px;background:linear-gradient(145deg,#10223e,#091527);box-shadow:0 24px 80px #0008}.eyebrow{color:#6ee7d8;text-transform:uppercase;letter-spacing:.16em;font-size:12px}.ok,.ws{display:flex;gap:10px;align-items:center;margin-top:16px;padding:10px 16px;border-radius:12px}.ok{background:#133b35;color:#8ff5d8}.ws{background:#172f51;color:#bfd8ff}.ws.passed{background:#133b35;color:#8ff5d8}.dot{width:10px;height:10px;border-radius:50%;background:#52e6a7;box-shadow:0 0 16px #52e6a7;flex:0 0 auto}h1{font-size:42px;margin:22px 0 14px}p{color:#adc2df;line-height:1.6}.meta{margin-top:28px;padding-top:22px;border-top:1px solid #274261;color:#9bb6da;font-family:ui-monospace,monospace;line-height:1.8}</style></head><body><main class="card"><div class="eyebrow">Gateway Doorman &mdash; Slice 2b-iv</div><h1>NabuFlow Gateway — Staging Preview</h1><p>This unmistakable page is streaming from a scratch Cloudflare Sandbox through the staging Worker data plane.</p><div class="ok"><span class="dot"></span>Secure session accepted</div><div id="ws-result" class="ws">WebSocket: connecting through the gateway&hellip;</div><div class="meta"><div>served at: '+servedAt+'</div><div>runtime identity: '+process.env.NABUFLOW_RUNTIME_ID+'</div><div>tenant port: '+process.env.PORT+'</div></div></main><script>(function(){const status=document.getElementById("ws-result");const wsUrl=new URL("socket",location.href);wsUrl.protocol=location.protocol==="https:"?"wss:":"ws:";window.setTimeout(function(){const socket=new WebSocket(wsUrl);socket.addEventListener("open",function(){socket.send("browser-native-echo")});socket.addEventListener("message",function(event){status.textContent="WebSocket echo: "+event.data;status.classList.add("passed");status.setAttribute("data-state","passed");socket.close()});socket.addEventListener("error",function(){status.textContent="WebSocket echo failed";status.setAttribute("data-state","failed")})},900)})();</script></body></html>');return
  }
  const body=await collect(req);
  sendJson(res,{method:req.method,url:req.url,bodyBytes:body.length,bodySha256:crypto.createHash('sha256').update(body).digest('hex'),headers:req.headers});
});
server.on('upgrade',(req,socket)=>{
  console.log('tenant websocket upgrade '+(req.url||'/'));
  const key=req.headers['sec-websocket-key'];
  if(typeof key!=='string'){socket.destroy();return}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let pending=Buffer.alloc(0);
  socket.on('data',(chunk)=>{
    console.log('tenant websocket data bytes='+chunk.length);
    pending=Buffer.concat([pending,chunk]);
    if(pending.length<6)return;
    let length=pending[1]&127;let offset=2;
    if(length===126){if(pending.length<8)return;length=pending.readUInt16BE(2);offset=4}
    const masked=(pending[1]&128)!==0;if(!masked||pending.length<offset+4+length)return;
    const mask=pending.subarray(offset,offset+4);offset+=4;
    const payload=Buffer.alloc(length);for(let i=0;i<length;i++)payload[i]=pending[offset+i]^mask[i%4];
    const reply=Buffer.from('echo:'+payload.toString('utf8'));const header=reply.length<126?Buffer.from([0x81,reply.length]):Buffer.from([0x81,126,reply.length>>8,reply.length&255]);
    socket.write(Buffer.concat([header,reply]));pending=Buffer.alloc(0);
  });
});
server.listen(Number(process.env.PORT),'0.0.0.0',()=>console.log('tenant service ready on '+process.env.PORT));
`;

interface TranscriptEntry {
  step: string;
  status: number | string;
  detail: unknown;
}

const transcript: TranscriptEntry[] = [];
const locator = {
  projectId: 900_000_000 + (Date.now() % 90_000_000),
  role: "preview" as const,
  slot: "primary" as const,
};
const runtimePath = `/_nabuflow/control/v1/runtimes/${locator.projectId}/${locator.role}/${locator.slot}`;
let deploymentVersion = "";
let runtimeEnsured = false;
let workerClockOffsetMs = 0;

function nonce(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
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

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function signedFetch(input: Parameters<typeof makeSignedRequest>[0]): Promise<{
  response: Response;
  body: unknown;
}> {
  const response = await fetch(await makeSignedRequest(input));
  return { response, body: await readResponse(response) };
}

function assertStatus(step: string, actual: number, expected: number, body: unknown): void {
  transcript.push({ step, status: actual, detail: body });
  if (actual !== expected) {
    throw new Error(`${step}: expected HTTP ${expected}, received ${actual}`);
  }
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pemPrivateKey(): string {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function tamperCompactSignature(grant: string): string {
  const segments = grant.split(".");
  if (segments.length !== 3) throw new Error("Cannot tamper malformed grant");
  segments[2] = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
  return segments.join(".");
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{
  response: Response;
  body: Record<string, unknown>;
}> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { response, body };
}

async function websocketEcho(
  previewUrl: string,
  cookie: string,
  message: string,
): Promise<{ statusLine: string; sent: string; received: string }> {
  const url = new URL("socket", previewUrl);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        Cookie: `${cookie}; __session=platform-secret`,
        Authorization: "Bearer websocket-app-token",
        Origin: new URL(previewUrl).origin,
      },
    });
    const timeout = setTimeout(() => {
      const readyState = socket.readyState;
      socket.terminate();
      reject(new Error(`WebSocket smoke timed out (readyState=${readyState})`));
    }, 20_000);

    const finish = (error?: Error, received?: string): void => {
      clearTimeout(timeout);
      if (error) {
        socket.terminate();
        reject(error);
        return;
      }
      socket.close();
      resolve({
        statusLine: "HTTP/1.1 101 Switching Protocols",
        sent: message,
        received: received!,
      });
    };

    socket.once("open", () => socket.send(message));
    socket.once("message", (data) => finish(undefined, data.toString()));
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const headers = Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${String(value)}`)
          .join("\r\n");
        finish(
          new Error(
            `WebSocket upgrade failed: HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${headers}\n\n${Buffer.concat(chunks).toString("utf8").slice(0, 2_000)}`,
          ),
        );
      });
    });
    socket.once("error", (error) => finish(error));
  });
}

async function waitForLabBrowser(
  previewUrl: string,
  launchUrl: string,
  mintFounderLaunchUrl: () => Promise<string>,
): Promise<void> {
  if (process.env.KEEP_PREVIEW_FOR_BROWSER !== "1") return;
  const port = Number(process.env.PREVIEW_BRIDGE_PORT ?? "43127");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const bridge = createServer((request, response) => {
      if (request.url === "/open") {
        response.writeHead(302, { location: launchUrl, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.url === "/missing") {
        response.writeHead(302, { location: previewUrl, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.url === "/founder") {
        void mintFounderLaunchUrl().then(
          (freshLaunchUrl) => {
            response.writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            });
            response.end(freshLaunchUrl);
          },
          () => {
            response.writeHead(500, { "cache-control": "no-store" });
            response.end("grant mint failed");
          },
        );
        return;
      }
      if (request.url === "/stop") {
        response.end("cleanup starting");
        settled = true;
        bridge.close(() => resolve());
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      bridge.close();
      reject(new Error("Lab browser evidence window timed out"));
    }, 30 * 60_000);
    bridge.on("close", () => clearTimeout(timer));
    bridge.on("error", reject);
    bridge.listen(port, "127.0.0.1", () => {
      transcript.push({
        step: "browser.bridge-ready",
        status: 200,
        detail: { port, routes: ["/missing", "/open", "/founder", "/stop"] },
      });
    });
  });
}

async function run(): Promise<void> {
  const unsigned = await fetch(`${controlUrl}/_nabuflow/control/v1/version`);
  assertStatus("auth.unsigned", unsigned.status, 401, await readResponse(unsigned));
  const workerDate = unsigned.headers.get("date");
  const workerTimeMs = workerDate === null ? Number.NaN : Date.parse(workerDate);
  if (!Number.isFinite(workerTimeMs))
    throw new Error("Unsigned Worker response omitted its Date header");
  workerClockOffsetMs = workerTimeMs - Date.now();
  transcript.push({
    step: "auth.clock-source",
    status: 200,
    detail: { workerDate, offsetMs: workerClockOffsetMs },
  });

  const tampered = await signedFetch({
    path: "/_nabuflow/control/v1/version",
    nonce: nonce("tampered"),
    signatureOverride: "0".repeat(64),
  });
  assertStatus("auth.tampered", tampered.response.status, 401, tampered.body);

  const expired = await signedFetch({
    path: "/_nabuflow/control/v1/version",
    nonce: nonce("expired"),
    timestampMs: Date.now() + workerClockOffsetMs - 60_001,
  });
  assertStatus("auth.expired", expired.response.status, 401, expired.body);

  let replayRequest: Request | null = null;
  let firstReplayResponse: Response | null = null;
  let firstReplayBody: unknown = null;
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    replayRequest = await makeSignedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: nonce(`replay-${attempt}`),
    });
    firstReplayResponse = await fetch(replayRequest.clone());
    firstReplayBody = await readResponse(firstReplayResponse);
    if (firstReplayResponse.status === 200) {
      transcript.push({
        step: "auth.key-propagated",
        status: firstReplayResponse.status,
        detail: { attempt },
      });
      break;
    }
    transcript.push({
      step: "auth.key-propagation-retry",
      status: firstReplayResponse.status,
      detail: { attempt, body: firstReplayBody },
    });
    if (firstReplayResponse.status !== 401 || attempt === 18) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  assertCondition(
    replayRequest !== null && firstReplayResponse !== null,
    "Control-key propagation gate did not issue a request",
  );
  assertStatus("auth.signed", firstReplayResponse.status, 200, firstReplayBody);
  const replayedResponse = await fetch(replayRequest);
  assertStatus("auth.replayed", replayedResponse.status, 409, await readResponse(replayedResponse));

  const versionBody = firstReplayBody as { deploymentVersion?: string };
  if (!versionBody.deploymentVersion) throw new Error("/version omitted deploymentVersion");
  deploymentVersion = versionBody.deploymentVersion;
  transcript.push({
    step: "version.propagated",
    status: 200,
    detail: { deploymentVersion, protocolVersion: "1" },
  });

  const runtimeId = await deriveRuntimeIdentity({
    namespace: deploymentNamespace,
    ...locator,
  });
  let previewKeyActive = false;
  let consecutivePreviewKeyAccepts = 0;
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const propagationGrant = await mintCloudflarePreviewGrant(
      {
        projectId: locator.projectId,
        runtimeId,
        servicePort: 8080,
      },
      process.env,
      { nowMs: Date.now() + workerClockOffsetMs },
    );
    assertCondition(propagationGrant !== null, "Preview propagation grant was not minted");
    const propagationResponse = await fetch(propagationGrant.launchUrl, {
      redirect: "manual",
    });
    if (propagationResponse.status === 302) {
      consecutivePreviewKeyAccepts += 1;
      if (consecutivePreviewKeyAccepts >= 8) {
        previewKeyActive = true;
        transcript.push({
          step: "preview.key-propagated",
          status: propagationResponse.status,
          detail: { attempt, consecutiveAccepts: consecutivePreviewKeyAccepts },
        });
        break;
      }
    } else {
      consecutivePreviewKeyAccepts = 0;
      const propagationBody = await readResponse(propagationResponse);
      transcript.push({
        step: "preview.key-propagation-retry",
        status: propagationResponse.status,
        detail: { attempt, body: propagationBody },
      });
      if (propagationResponse.status !== 401 || attempt === 45) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assertCondition(previewKeyActive, "Preview-key propagation gate did not stabilize");

  const ensureRequestBody = {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    manifest: {
      revision: `smoke-manifest-${Date.now()}`,
      runtime: "node",
      buildCommand: ["node", "--version"],
      startCommand: ["node", "-e", TENANT_SERVER_SOURCE],
      servicePort: 8080,
      healthPath: "/health",
      resourceProfile: "dev",
      public: false,
    },
  };
  const ensureKey = `smoke-ensure-${locator.projectId}`;
  const ensured = await signedFetch({
    path: runtimePath,
    method: "PUT",
    body: ensureRequestBody,
    nonce: nonce("ensure"),
    idempotencyKey: ensureKey,
  });
  assertStatus("lifecycle.ensure", ensured.response.status, 200, ensured.body);
  runtimeEnsured = true;

  const ensuredReplay = await signedFetch({
    path: runtimePath,
    method: "PUT",
    body: ensureRequestBody,
    nonce: nonce("ensure-replay"),
    idempotencyKey: ensureKey,
  });
  assertStatus(
    "idempotency.response-replay",
    ensuredReplay.response.status,
    200,
    ensuredReplay.body,
  );
  if (JSON.stringify(ensuredReplay.body) !== JSON.stringify(ensured.body)) {
    throw new Error("Idempotency replay response changed");
  }

  const artifactRevision = `smoke-artifact-${Date.now()}`;
  const startBody = {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    artifactRevision,
    artifactSha256: await sha256Hex(artifactRevision),
  };
  let started: Awaited<ReturnType<typeof signedFetch>> | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    started = await signedFetch({
      path: `${runtimePath}/start`,
      method: "POST",
      body: startBody,
      nonce: nonce(`start-${attempt}`),
      idempotencyKey: `smoke-start-${locator.projectId}`,
    });
    if (started.response.status === 200) break;
    transcript.push({
      step: "lifecycle.start.retry",
      status: started.response.status,
      detail: { attempt, body: started.body },
    });
    if (started.response.status !== 502 || attempt === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1_000));
  }
  assertCondition(started !== null, "Start retry loop did not issue a request");
  assertStatus("lifecycle.start", started.response.status, 200, started.body);

  const status = await signedFetch({ path: runtimePath, nonce: nonce("status") });
  assertStatus("lifecycle.status", status.response.status, 200, status.body);

  let previewGrant = await mintCloudflarePreviewGrant(
    {
      projectId: locator.projectId,
      runtimeId,
      servicePort: 8080,
    },
    process.env,
    { nowMs: Date.now() + workerClockOffsetMs },
  );
  assertCondition(previewGrant !== null, "Cloudflare preview grant issuer was inert in staging");

  const missing = await fetchJson(previewGrant.previewUrl);
  assertStatus("preview.auth.missing", missing.response.status, 401, missing.body);

  let redemption: Response | null = null;
  let redemptionFailureBody: unknown = null;
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    redemption = await fetch(previewGrant.launchUrl, { redirect: "manual" });
    if (redemption.status === 302) break;
    redemptionFailureBody = await readResponse(redemption);
    transcript.push({
      step: "preview.auth.valid-propagation-retry",
      status: redemption.status,
      detail: { attempt, body: redemptionFailureBody },
    });
    const code = (redemptionFailureBody as { code?: unknown } | null)?.code;
    if (redemption.status !== 401 || code !== "invalid_preview_grant" || attempt === 18) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    previewGrant = await mintCloudflarePreviewGrant(
      {
        projectId: locator.projectId,
        runtimeId,
        servicePort: 8080,
      },
      process.env,
      { nowMs: Date.now() + workerClockOffsetMs },
    );
    assertCondition(previewGrant !== null, "Preview redemption retry grant was not minted");
  }
  assertCondition(redemption !== null, "Preview redemption retry did not issue a request");
  assertStatus("preview.auth.valid", redemption.status, 302, {
    location: redemption.headers.get("location"),
    cacheControl: redemption.headers.get("cache-control"),
    failureBody: redemptionFailureBody,
  });
  const setCookie = redemption.headers.get("set-cookie");
  assertCondition(setCookie, "Valid grant redemption omitted the preview session cookie");
  assertCondition(
    /HttpOnly; Secure; SameSite=None; Max-Age=\d+; Path=\/$/.test(setCookie),
    "Preview session cookie attributes are incomplete",
  );
  const sessionCookie = setCookie.split(";", 1)[0];

  const replay = await fetchJson(previewGrant.launchUrl, { redirect: "manual" });
  assertStatus("preview.auth.replay", replay.response.status, 409, replay.body);

  const validGrantToken = new URL(previewGrant.launchUrl).searchParams.get("__nfg");
  assertCondition(validGrantToken, "Launch URL omitted its compact preview grant");
  const grantUrl = (token: string) => {
    const url = new URL(previewGrant.previewUrl);
    url.searchParams.set("__nfg", token);
    return url.toString();
  };
  const gatewayOrigin = new URL(previewGrant.previewUrl).origin;
  const nowSeconds = Math.floor((Date.now() + workerClockOffsetMs) / 1_000);
  const expiredGrant = await signPreviewGrant(previewPrivateKey, {
    v: 1,
    iss: "nabuflow-api",
    aud: gatewayOrigin,
    sub: runtimeId,
    port: 8080,
    iat: nowSeconds - 400,
    exp: nowSeconds - 100,
    jti: `expired-${crypto.randomUUID()}`,
  });
  const expiredPreview = await fetchJson(grantUrl(expiredGrant), { redirect: "manual" });
  assertStatus("preview.auth.expired", expiredPreview.response.status, 401, expiredPreview.body);

  const tamperedPreview = await fetchJson(grantUrl(tamperCompactSignature(validGrantToken)), {
    redirect: "manual",
  });
  assertStatus("preview.auth.tampered", tamperedPreview.response.status, 401, tamperedPreview.body);

  const forgedGrant = await signPreviewGrant(pemPrivateKey(), {
    v: 1,
    iss: "nabuflow-api",
    aud: gatewayOrigin,
    sub: runtimeId,
    port: 8080,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: `forged-${crypto.randomUUID()}`,
  });
  const forgedPreview = await fetchJson(grantUrl(forgedGrant), { redirect: "manual" });
  assertStatus("preview.auth.forged", forgedPreview.response.status, 401, forgedPreview.body);

  const previewRequest = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path.replace(/^\//, ""), previewGrant.previewUrl);
    return fetchJson(url.toString(), {
      ...init,
      headers: { cookie: sessionCookie, ...(init.headers ?? {}) },
    });
  };

  for (const [method, body] of [
    ["GET", undefined],
    ["POST", "post-body"],
    ["PUT", "put-body"],
    ["DELETE", "delete-body"],
  ] as const) {
    const result = await previewRequest("echo", { method, body });
    assertStatus(`preview.http.${method}`, result.response.status, 200, {
      method: result.body.method,
      url: result.body.url,
      bodyBytes: result.body.bodyBytes,
      bodySha256: result.body.bodySha256,
    });
    assertCondition(result.body.method === method, `${method} changed while crossing the gateway`);
    assertCondition(
      result.body.bodySha256 ===
        createHash("sha256")
          .update(body ?? "")
          .digest("hex"),
      `${method} body changed while crossing the gateway`,
    );
  }

  const largeBody = "stream-integrity-0123456789abcdef".repeat(65_536);
  const largeExpectedHash = createHash("sha256").update(largeBody).digest("hex");
  const large = await previewRequest("large", { method: "POST", body: largeBody });
  assertStatus("preview.http.large-stream", large.response.status, 200, {
    bodyBytes: large.body.bodyBytes,
    bodySha256: large.body.bodySha256,
    expectedBytes: Buffer.byteLength(largeBody),
    expectedSha256: largeExpectedHash,
  });
  assertCondition(large.body.bodySha256 === largeExpectedHash, "Large streamed body hash changed");
  assertCondition(
    large.body.bodyBytes === Buffer.byteLength(largeBody),
    "Large streamed body length changed",
  );

  const sseStartedAt = performance.now();
  const sse = await fetch(new URL("sse", previewGrant.previewUrl), {
    headers: { cookie: sessionCookie },
  });
  const sseHeadersAtMs = performance.now() - sseStartedAt;
  assertCondition(sse.status === 200 && sse.body, "SSE request failed");
  const sseReader = sse.body.getReader();
  const firstEvent = await sseReader.read();
  const firstEventAtMs = performance.now() - sseStartedAt;
  const secondEvent = await sseReader.read();
  const secondEventAtMs = performance.now() - sseStartedAt;
  const firstEventText = new TextDecoder().decode(firstEvent.value);
  const secondEventText = new TextDecoder().decode(secondEvent.value);
  assertCondition(firstEventText.includes("data: first"), "SSE first event was not streamed");
  assertCondition(secondEventText.includes("data: second"), "SSE second event was not streamed");
  assertCondition(
    secondEventAtMs - firstEventAtMs >= 900,
    "SSE events arrived together instead of streaming",
  );
  transcript.push({
    step: "preview.http.sse",
    status: sse.status,
    detail: { sseHeadersAtMs, firstEventAtMs, secondEventAtMs, firstEventText, secondEventText },
  });

  transcript.push({
    step: "preview.websocket.client-request",
    status: "prepared",
    detail: {
      headerNames: [
        "Host",
        "Upgrade",
        "Connection",
        "Sec-WebSocket-Key",
        "Sec-WebSocket-Version",
        "Cookie",
        "Authorization",
      ],
      cookieHeaderPresent: true,
      sessionCookieAttached: sessionCookie.startsWith("__Host-nabuflow_preview_"),
    },
  });
  let websocket: Awaited<ReturnType<typeof websocketEcho>> | null = null;
  let websocketError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      websocket = await websocketEcho(
        previewGrant.previewUrl,
        sessionCookie,
        "nabuflow-websocket-smoke",
      );
      break;
    } catch (error) {
      websocketError = error;
      transcript.push({
        step: "preview.websocket.retry",
        status: "retryable",
        detail: {
          attempt,
          error: error instanceof Error ? error.message : "Unknown WebSocket error",
        },
      });
      if (attempt < 4)
        await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1_000));
    }
  }
  if (websocket === null) {
    const diagnosticLogs = await signedFetch({
      path: `${runtimePath}/logs?limit=100`,
      nonce: nonce("websocket-diagnostic-logs"),
    });
    transcript.push({
      step: "preview.websocket.diagnostic-logs",
      status: diagnosticLogs.response.status,
      detail: diagnosticLogs.body,
    });
    throw websocketError;
  }
  assertCondition(
    websocket.received === `echo:${websocket.sent}`,
    "WebSocket echo payload changed",
  );
  transcript.push({ step: "preview.websocket.echo", status: 101, detail: websocket });

  const hygiene = await previewRequest("headers", {
    headers: {
      authorization: "Bearer tenant-app-token",
      cookie: `${sessionCookie}; __session=platform-secret; mustaflow_auth=platform; theme=dark`,
      "x-forwarded-for": "198.51.100.44",
      "x-forwarded-host": "attacker.invalid",
      "x-forwarded-proto": "http",
      "x-nabuflow-signature": "control-secret",
      "idempotency-key": "control-key",
    },
  });
  assertStatus("preview.hygiene.request", hygiene.response.status, 200, {
    authorization: (hygiene.body.headers as Record<string, string>).authorization,
    cookie: (hygiene.body.headers as Record<string, string>).cookie,
    forwardedFor: (hygiene.body.headers as Record<string, string>)["x-forwarded-for"],
    forwardedHost: (hygiene.body.headers as Record<string, string>)["x-forwarded-host"],
    forwardedProto: (hygiene.body.headers as Record<string, string>)["x-forwarded-proto"],
    controlHeaderPresent:
      (hygiene.body.headers as Record<string, string>)["x-nabuflow-signature"] !== undefined,
  });
  const reflectedHeaders = hygiene.body.headers as Record<string, string>;
  assertCondition(
    reflectedHeaders.authorization === "Bearer tenant-app-token",
    "App auth stripped",
  );
  assertCondition(reflectedHeaders.cookie === "theme=dark", "Platform cookie reached tenant");
  assertCondition(
    reflectedHeaders["x-forwarded-for"] !== "198.51.100.44",
    "Injected forwarding address reached tenant",
  );
  assertCondition(
    reflectedHeaders["x-forwarded-host"] === new URL(previewGrant.previewUrl).host,
    "Trusted forwarding host was not rebuilt",
  );
  assertCondition(
    reflectedHeaders["x-nabuflow-signature"] === undefined &&
      reflectedHeaders["idempotency-key"] === undefined,
    "Control-plane headers reached tenant",
  );

  const badCookie = await fetch(new URL("cookie-bad", previewGrant.previewUrl), {
    headers: { cookie: sessionCookie },
  });
  assertCondition(badCookie.status === 200, "Bad-cookie probe did not reach tenant");
  assertCondition(
    badCookie.headers.get("set-cookie") === null,
    "mustaflow.com scoped tenant cookie escaped the gateway",
  );
  transcript.push({
    step: "preview.hygiene.response-cookie",
    status: badCookie.status,
    detail: { setCookie: null, forbiddenDomain: ".mustaflow.com" },
  });

  const browserGrant = await mintCloudflarePreviewGrant(
    {
      projectId: locator.projectId,
      runtimeId,
      servicePort: 8080,
    },
    process.env,
    { nowMs: Date.now() + workerClockOffsetMs },
  );
  assertCondition(browserGrant !== null, "Browser preview grant was not minted");
  await waitForLabBrowser(browserGrant.previewUrl, browserGrant.launchUrl, async () => {
    const founderGrant = await mintCloudflarePreviewGrant(
      {
        projectId: locator.projectId,
        runtimeId,
        servicePort: 8080,
      },
      process.env,
      { nowMs: Date.now() + workerClockOffsetMs },
    );
    assertCondition(founderGrant !== null, "Founder preview grant was not minted");
    return founderGrant.launchUrl;
  });

  const exec = await signedFetch({
    path: `${runtimePath}/exec`,
    method: "POST",
    body: {
      locator,
      argv: ["node", "-e", "console.log('nabuflow-control-plane-ok')"],
      cwd: "/workspace",
      timeoutMs: 10_000,
    },
    nonce: nonce("exec"),
    idempotencyKey: `smoke-exec-${locator.projectId}`,
  });
  assertStatus("lifecycle.exec", exec.response.status, 200, exec.body);
  if (!JSON.stringify(exec.body).includes("nabuflow-control-plane-ok")) {
    throw new Error("Scratch exec output was not returned");
  }

  const credentialNames = await signedFetch({
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
    idempotencyKey: `smoke-credential-names-${locator.projectId}`,
  });
  assertStatus(
    "security.container-credential-names",
    credentialNames.response.status,
    200,
    credentialNames.body,
  );

  const blockedEgress = await signedFetch({
    path: `${runtimePath}/exec`,
    method: "POST",
    body: {
      locator,
      argv: [
        "node",
        "-e",
        "fetch('https://www.cloudflare.com').then(async r=>{console.log('status='+r.status);process.exit(r.status===520?0:2)}).catch(e=>{console.error('blocked='+e.name);process.exit(3)})",
      ],
      cwd: "/workspace",
      timeoutMs: 15_000,
    },
    nonce: nonce("egress"),
    idempotencyKey: `smoke-egress-${locator.projectId}`,
  });
  assertStatus("security.egress", blockedEgress.response.status, 200, blockedEgress.body);
  if (!JSON.stringify(blockedEgress.body).includes("status=520")) {
    throw new Error("Non-allowlisted HTTPS egress did not return Cloudflare's 520 block response");
  }

  const logs = await signedFetch({
    path: `${runtimePath}/logs?limit=100`,
    nonce: nonce("logs"),
  });
  assertStatus("lifecycle.logs", logs.response.status, 200, logs.body);

  const stopped = await signedFetch({
    path: `${runtimePath}/stop`,
    method: "POST",
    body: { locator, reason: "staging smoke test complete" },
    nonce: nonce("stop"),
    idempotencyKey: `smoke-stop-${locator.projectId}`,
  });
  assertStatus("lifecycle.stop", stopped.response.status, 200, stopped.body);
}

async function destroyScratchRuntime(): Promise<void> {
  if (!runtimeEnsured) return;
  const destroyed = await signedFetch({
    path: runtimePath,
    method: "DELETE",
    body: { locator, reason: "mandatory staging smoke cleanup" },
    nonce: nonce("destroy"),
    idempotencyKey: `smoke-destroy-${locator.projectId}-${crypto.randomUUID()}`,
  });
  transcript.push({
    step: "cleanup.destroy",
    status: destroyed.response.status,
    detail: destroyed.body,
  });
  if (destroyed.response.status !== 200) throw new Error("Scratch runtime cleanup failed");
}

let failure: string | null = null;
try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error.message : "Unknown smoke failure";
} finally {
  try {
    await destroyScratchRuntime();
  } catch (cleanupError) {
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup failure";
    failure = failure === null ? cleanupMessage : `${failure}; cleanup: ${cleanupMessage}`;
  }
}

const evidence = {
  workerUrl: controlUrl,
  deploymentVersion,
  scratchProjectId: locator.projectId,
  passed: failure === null,
  failure,
  transcript,
};
const serialized = JSON.stringify(evidence);
// This is the runner's redacted evidence artifact. It excludes the control
// token and request signatures by construction.
// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      evidence,
      evidenceSha256: await sha256Hex(serialized),
    },
    null,
    2,
  ),
);
if (failure !== null) process.exitCode = 1;
