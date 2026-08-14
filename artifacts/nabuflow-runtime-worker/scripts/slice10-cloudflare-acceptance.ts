import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const CONTROL_URL = "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev";
const PROVISIONER_URL =
  "https://nabuflow-acceptance-provisioner-staging.mustafa-alali74.workers.dev";
const PROVISIONER_NAME = "nabuflow-acceptance-provisioner-staging";
const WORKLOAD_KEY_ID = `slice10-${Date.now()}-es256`;
const WORKLOAD_ISSUER = "https://staging-acceptance.mustaflow.invalid";
const WORKLOAD_AUDIENCE = "nabuflow-acceptance-provisioner-staging";
const WORKLOAD_SUBJECT = `codex-zero-cloudflare-acceptance-${Date.now()}`;
const NEON_ORGANIZATION_ID = "org-young-poetry-18075521";
const STRIPE_SANDBOX_ID = "acct_1U1r21DoZmlNFmDX";
const FLY_ORGANIZATION_SLUG = "nabuflow-acceptance-staging";
const FLY_IMAGE_REF =
  "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
const MAX_COST_MINOR_UNITS = "100";
const DEPLOYMENT_NAMESPACE = "staging";
const RUN_ID = new Date().toISOString().replaceAll(/[:.]/gu, "");
const workerRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(workerRoot, "..", "..");
const outputRoot = resolve(repoRoot, "tmp", "gateway-doorman-2b-ix-b10");
// Wrangler resolves a relative `main` from the config directory. Keep the ephemeral config beside
// the inert source config so opening the temporary route cannot change entry-point resolution.
const openConfigPath = resolve(workerRoot, `wrangler.acceptance.open-${RUN_ID}.jsonc`);
const evidencePath = resolve(outputRoot, `gateway-doorman-2b-ix-b10-${RUN_ID}-gateway-final.json`);
const launcherEvidencePath = resolve(
  outputRoot,
  `gateway-doorman-2b-ix-b10-${RUN_ID}-launcher-final.json`,
);
const runtimeBuildDiagnosticEvidencePath = resolve(
  outputRoot,
  `gateway-doorman-2b-ix-b10-${RUN_ID}-zero-build-precleanup.json`,
);
const REAL_ZERO_BUILD_ID = process.env.SLICE10_REAL_ZERO_BUILD_ID;
const SESSION_CONTROL_TOKEN = process.env.SLICE10_RUNTIME_CONTROL_TOKEN?.trim();
const SESSION_PREVIEW_PRIVATE_KEY = process.env.SLICE10_PREVIEW_PRIVATE_KEY?.trim();
const wranglerCli = resolve(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const tsxCli = resolve(workerRoot, "node_modules", "tsx", "dist", "cli.mjs");

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

const evidence: EvidenceEntry[] = [];

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
  assertCondition(/^[A-Za-z0-9_-]+$/u.test(value), "Generated secret has an invalid alphabet");
  assertCondition(!value.includes("="), "Generated secret contains padding");
  assertCondition(
    Buffer.from(value, "base64url").byteLength === bytes,
    "Generated secret failed its byte-length self-check",
  );
  return value;
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
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
  const pattern = new RegExp(
    `("${property.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
    "u",
  );
  assertCondition(pattern.test(source), `Provisioner config is missing ${property}`);
  return source.replace(pattern, `$1${JSON.stringify(value)}`);
}

function buildProvisionerConfig(publicKey: string, open: boolean): string {
  let config = readFileSync(resolve(workerRoot, "wrangler.acceptance.jsonc"), "utf8");
  config = config.replace(/"workers_dev"\s*:\s*false/u, `"workers_dev": ${String(open)}`);
  config = replaceJsonString(config, "ACCEPTANCE_STAGING_ENABLED", open ? "true" : "false");
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
  let result = await runProcess(
    process.execPath,
    [wranglerCli, "deploy", "--config", configPath, "--message", message],
    { timeoutMs: 180_000 },
  );
  if (result.code === 3221226505) {
    const relativeConfig = relative(workerRoot, configPath);
    assertCondition(
      !/[\s"']/u.test(relativeConfig) && !/[\s"']/u.test(message),
      "Provisioner wrapper fallback received an unsafe argument",
    );
    record("provisioner.deploy.wrapper-fallback", "native_abort", {
      primaryExitCode: result.code,
      stderrBytes: Buffer.byteLength(result.stderr),
      stdoutBytes: Buffer.byteLength(result.stdout),
    });
    result = await runProcess(
      process.env.ComSpec ?? "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `node_modules\\.bin\\wrangler.cmd deploy --config ${relativeConfig} --message ${message}`,
      ],
      { timeoutMs: 180_000 },
    );
  }
  assertCondition(
    result.code === 0,
    `Provisioner deployment failed (${String(result.code)}; stdoutBytes=${String(Buffer.byteLength(result.stdout))}; stderrBytes=${String(Buffer.byteLength(result.stderr))})`,
  );
  const version = deploymentVersion(`${result.stdout}\n${result.stderr}`);
  assertCondition(version !== null, "Provisioner deployment returned no version ID");
  return version;
}

async function waitForReadyz(expectedKek: "valid", boundMs = 120_000): Promise<void> {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < boundMs) {
    attempt += 1;
    try {
      const response = await fetch(`${PROVISIONER_URL}/_nabuflow/acceptance/v1/readyz`);
      const body = (await response.json()) as unknown;
      if (
        response.status === 200 &&
        JSON.stringify(body) === JSON.stringify({ ready: true, gate: "enabled", kek: expectedKek })
      ) {
        record("provisioner.readyz", 200, { attempt, body });
        return;
      }
      record("provisioner.readyz.attempt", response.status, { attempt, body });
    } catch (error) {
      record("provisioner.readyz.attempt", "transport", {
        attempt,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error("Provisioner readiness did not converge within its bound");
}

async function verifyClosed(): Promise<void> {
  const response = await fetch(`${PROVISIONER_URL}/_nabuflow/acceptance/v1/readyz`, {
    redirect: "manual",
  });
  assertCondition(
    response.status === 404,
    `Temporary Provisioner surface remained open (${String(response.status)})`,
  );
  record("provisioner.surface.closed", 404);
}

async function writeEvidence(passed: boolean, failure: string | null): Promise<void> {
  const body = JSON.stringify(
    {
      runId: RUN_ID,
      passed,
      failure,
      provisioner: {
        name: PROVISIONER_NAME,
        temporaryUrl: PROVISIONER_URL,
        workloadKeyId: WORKLOAD_KEY_ID,
        issuer: WORKLOAD_ISSUER,
        audience: WORKLOAD_AUDIENCE,
        subject: WORKLOAD_SUBJECT,
      },
      gatewayEvidencePath: evidencePath,
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
  mkdirSync(dirname(launcherEvidencePath), { recursive: true });
  writeFileSync(launcherEvidencePath, envelope, { mode: 0o600 });
}

async function captureRealZeroBuildDiagnostic(): Promise<void> {
  assertCondition(
    typeof REAL_ZERO_BUILD_ID === "string" &&
      /^pbuild_zero_[0-9a-f]{64}$/u.test(REAL_ZERO_BUILD_ID),
    "SLICE10_REAL_ZERO_BUILD_ID must identify the completed real Zero build",
  );
  const buildId = REAL_ZERO_BUILD_ID;
  const path = `/_nabuflow/control/v1/build-plane/builds/${buildId}`;
  const method = "GET";
  const clockResponse = await fetch(`${CONTROL_URL}/_nabuflow/control/v1/version`);
  const workerDate = clockResponse.headers.get("date");
  const workerTime = workerDate === null ? Number.NaN : Date.parse(workerDate);
  assertCondition(Number.isFinite(workerTime), "Worker Date header is unavailable");
  const workerClockOffsetMs = workerTime - Date.now();
  const timestamp = String(Date.now() + workerClockOffsetMs);
  const nonce = `slice10-zero-build-diagnostic-${crypto.randomUUID()}`;
  const bodySha256 = createHash("sha256").update("").digest("hex");
  const canonical = [method, path, timestamp, nonce, bodySha256, ""].join("\n");
  const signature = createHmac("sha256", controlToken).update(canonical).digest("hex");
  const response = await fetch(`${CONTROL_URL}${path}`, {
    method,
    headers: {
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = { malformedJson: true, bytes: Buffer.byteLength(text) };
  }
  const recordBody = JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      projectId: 12,
      runtimeId: "nrf-e919a75364398a44-p12-preview-primary",
      buildId,
      status: response.status,
      body,
      purpose: "pre-cleanup typed terminal evidence for the real Zero-generated build",
      clock: {
        source: "https-date-header",
        absoluteOffsetMs: Math.abs(workerClockOffsetMs),
      },
    },
    null,
    2,
  );
  writeFileSync(
    runtimeBuildDiagnosticEvidencePath,
    JSON.stringify(
      {
        record: JSON.parse(recordBody) as unknown,
        sha256: createHash("sha256").update(recordBody).digest("hex"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  record("zero.real-build.terminal-evidence", response.status, {
    buildId,
    evidencePath: runtimeBuildDiagnosticEvidencePath,
    evidenceSha256: createHash("sha256")
      .update(readFileSync(runtimeBuildDiagnosticEvidencePath))
      .digest("hex"),
  });
  assertCondition(
    response.status === 200,
    `Real Zero build diagnostic returned ${String(response.status)} (${String((body as { code?: unknown } | null)?.code ?? "unknown")})`,
  );
  assertCondition(
    (body as { state?: unknown } | null)?.state === "succeeded",
    `Real Zero build is not succeeded (${String((body as { state?: unknown } | null)?.state ?? "unknown")}; ${String((body as { error?: { code?: unknown } } | null)?.error?.code ?? "no-error-code")})`,
  );
}

assertCondition(existsSync(wranglerCli), "Pinned Wrangler CLI is unavailable");
assertCondition(existsSync(tsxCli), "Pinned tsx CLI is unavailable");
assertCondition(
  (SESSION_CONTROL_TOKEN === undefined) === (SESSION_PREVIEW_PRIVATE_KEY === undefined),
  "Session control token and preview private key must be supplied together",
);
mkdirSync(outputRoot, { recursive: true });

const reuseSessionRotation =
  SESSION_CONTROL_TOKEN !== undefined && SESSION_PREVIEW_PRIVATE_KEY !== undefined;
let controlToken = SESSION_CONTROL_TOKEN ?? secret();
let vaultKek = reuseSessionRotation ? "" : secret();
let previewPrivateKey: string;
let workloadPrivateKey: string;
let failure: string | null = null;
let surfaceOpened = false;

try {
  let previewPublicKey = "";
  if (reuseSessionRotation) {
    previewPrivateKey = SESSION_PREVIEW_PRIVATE_KEY!;
    record("runtime.rotation.session-reused", 200, {
      bindingNames: [
        "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
        "CLOUFLOW_RUNTIME_CONTROL_TOKEN",
        "CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY",
        "CLOUDFLARE_CAPABILITY_VAULT_KEK_V1",
      ],
      signerAlreadySynchronized: true,
      valuesPersisted: false,
    });
  } else {
    const previewPair = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    previewPrivateKey = previewPair.privateKey;
    previewPublicKey = previewPair.publicKey;
  }
  const workloadPair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  workloadPrivateKey = workloadPair.privateKey;

  if (!reuseSessionRotation) {
    let rotationPayload = JSON.stringify({
      CLOUDFLARE_RUNTIME_CONTROL_TOKEN: controlToken,
      CLOUFLOW_RUNTIME_CONTROL_TOKEN: controlToken,
      CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: previewPublicKey,
      CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: vaultKek,
    });
    const rotation = await runProcess(
      process.execPath,
      [wranglerCli, "secret", "bulk", "--name", "nabuflow-runtime-staging"],
      { input: rotationPayload, timeoutMs: 180_000 },
    );
    rotationPayload = "";
    assertCondition(
      rotation.code === 0,
      `Runtime atomic rotation failed (${String(rotation.code)})`,
    );
    record("runtime.rotation.atomic", 200, {
      bindingNames: [
        "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
        "CLOUFLOW_RUNTIME_CONTROL_TOKEN",
        "CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY",
        "CLOUDFLARE_CAPABILITY_VAULT_KEK_V1",
      ],
      valuesPersisted: false,
    });
    // Wrangler's Windows process tree can linger briefly after secret bulk and native-abort a
    // back-to-back deploy. The bounded settle belongs to launcher mechanics, not product timing.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 12_000));
  }
  await captureRealZeroBuildDiagnostic();

  writeFileSync(openConfigPath, buildProvisionerConfig(workloadPair.publicKey, true), {
    mode: 0o600,
  });
  const openedVersion = await deployProvisioner(
    openConfigPath,
    `slice10-${RUN_ID}-temporary-proof-surface`,
  );
  surfaceOpened = true;
  record("provisioner.surface.opened", 200, { openedVersion });
  await waitForReadyz("valid");

  const smoke = await runProcess(
    process.execPath,
    [tsxCli, resolve(workerRoot, "scripts", "published-staging-smoke.ts")],
    {
      timeoutMs: 60 * 60_000,
      cwd: workerRoot,
      env: {
        ...process.env,
        CLOUDFLARE_RUNTIME_CONTROL_URL: CONTROL_URL,
        CLOUDFLARE_RUNTIME_CONTROL_TOKEN: controlToken,
        CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY: previewPrivateKey,
        CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: DEPLOYMENT_NAMESPACE,
        ACCEPTANCE_PROVISIONER_URL: PROVISIONER_URL,
        ACCEPTANCE_WORKLOAD_PRIVATE_KEY: workloadPrivateKey,
        ACCEPTANCE_WORKLOAD_KEY_ID: WORKLOAD_KEY_ID,
        ACCEPTANCE_WORKLOAD_ISSUER: WORKLOAD_ISSUER,
        ACCEPTANCE_WORKLOAD_AUDIENCE: WORKLOAD_AUDIENCE,
        ACCEPTANCE_WORKLOAD_SUBJECT: WORKLOAD_SUBJECT,
        ACCEPTANCE_NEON_ORGANIZATION_ID: NEON_ORGANIZATION_ID,
        ACCEPTANCE_STRIPE_SANDBOX_ID: STRIPE_SANDBOX_ID,
        NABUFLOW_PUBLISHED_EVIDENCE_PATH: evidencePath,
        NABUFLOW_MANIFEST_FAILURE_ITERATIONS: "10",
      },
    },
  );
  assertCondition(smoke.code === 0, `Published staging acceptance failed (${String(smoke.code)})`);
  assertCondition(existsSync(evidencePath), "Published staging acceptance wrote no evidence");
  record("published.acceptance", 200, {
    evidencePath,
    evidenceSha256: createHash("sha256").update(readFileSync(evidencePath)).digest("hex"),
  });
} catch (error) {
  failure = error instanceof Error ? error.message : "Unknown Slice 10 launcher failure";
} finally {
  controlToken = "";
  vaultKek = "";
  previewPrivateKey = "";
  workloadPrivateKey = "";
  assertCondition(
    controlToken === "" && vaultKek === "" && previewPrivateKey === "" && workloadPrivateKey === "",
    "Ephemeral launcher values were not scrubbed",
  );
  if (surfaceOpened) {
    try {
      const closedVersion = await deployProvisioner(
        resolve(workerRoot, "wrangler.acceptance.jsonc"),
        `slice10-${RUN_ID}-close-proof-surface`,
      );
      record("provisioner.surface.close-deployed", 200, { closedVersion });
      await verifyClosed();
    } catch (error) {
      const closeFailure =
        error instanceof Error ? error.message : "Unknown surface closure failure";
      failure = failure === null ? closeFailure : `${failure}; closure: ${closeFailure}`;
    }
  }
  rmSync(openConfigPath, { force: true });
  await writeEvidence(failure === null, failure);
}

if (failure !== null) {
  // eslint-disable-next-line no-console
  console.error(failure);
  process.exitCode = 1;
} else {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ passed: true, launcherEvidencePath, evidencePath }));
}
