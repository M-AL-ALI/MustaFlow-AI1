import { sha256Hex, signControlRequest } from "@workspace/tenant-runtime-contracts";

const controlUrl = process.env.CLOUDFLARE_RUNTIME_CONTROL_URL;
const controlToken = process.env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN;
if (!controlUrl || !controlToken) {
  throw new Error(
    "CLOUDFLARE_RUNTIME_CONTROL_URL and CLOUDFLARE_RUNTIME_CONTROL_TOKEN are required",
  );
}

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

  const replayRequest = await makeSignedRequest({
    path: "/_nabuflow/control/v1/version",
    nonce: nonce("replay"),
  });
  const firstReplayResponse = await fetch(replayRequest.clone());
  const firstReplayBody = await readResponse(firstReplayResponse);
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

  const ensureRequestBody = {
    locator,
    expectedDeploymentVersion: deploymentVersion,
    manifest: {
      revision: `smoke-manifest-${Date.now()}`,
      runtime: "node",
      buildCommand: ["node", "--version"],
      startCommand: [
        "node",
        "-e",
        "const http=require('node:http');const port=Number(process.env.PORT);http.createServer((req,res)=>{res.statusCode=200;res.setHeader('content-type','text/plain');res.end(req.url==='/health'?'healthy':'runtime-ready')}).listen(port,'0.0.0.0',()=>console.log('tenant service ready on '+port))",
      ],
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
  const started = await signedFetch({
    path: `${runtimePath}/start`,
    method: "POST",
    body: {
      locator,
      expectedDeploymentVersion: deploymentVersion,
      artifactRevision,
      artifactSha256: await sha256Hex(artifactRevision),
    },
    nonce: nonce("start"),
    idempotencyKey: `smoke-start-${locator.projectId}`,
  });
  assertStatus("lifecycle.start", started.response.status, 200, started.body);

  const status = await signedFetch({ path: runtimePath, nonce: nonce("status") });
  assertStatus("lifecycle.status", status.response.status, 200, status.body);

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
