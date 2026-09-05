/**
 * Container service — Fly.io Machines API integration.
 *
 * Provider choice: Fly.io Machines API
 * - Per-project isolation via individual machines
 * - Persistent volumes for file-system survival across hibernation
 * - HTTP proxy access via fly.io proxy URLs
 * - Native hibernation / auto-stop support
 * - Exec API for running commands inside running machines
 *
 * Graceful degradation: when FLY_API_TOKEN is not set, all operations
 * return no-op results so the rest of the app continues to work.
 *
 * Env vars required:
 *   FLY_API_TOKEN         — Fly.io API access token
 *   FLY_APP_NAME          — Fly.io app name (e.g. "mustaflow-containers")
 *   FLY_ORG_SLUG          — Fly.io org slug (e.g. "personal" or "mustaflow")
 *   FLY_REGION            — Preferred region (e.g. "iad", "lhr") — default "iad"
 */

import { db, projectsTable, containerLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { lookup } from "node:dns/promises";
import { logger } from "./logger";
import { ContainerUnavailableError } from "./errors";
import type { LegacyFlyRetirementRequest } from "./project-retirement-legacy-fly";
import { LEGACY_NODE_SERVICE_PORT, resolveProjectRuntimeManifest } from "./runtime-manifest";

export type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

export interface ContainerInfo {
  containerId: string;
  status: ContainerStatus;
  containerUrl: string | null;
  servicePort: number;
}

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const FLY_ORG = process.env.FLY_ORG_SLUG ?? "personal";
const FLY_REGION = process.env.FLY_REGION ?? "iad";
const FLY_PROXY_HOSTNAME = `${FLY_APP}.fly.dev`;
const CONTAINER_CAPABILITY_CACHE_MS = 60_000;
const CONTAINER_CAPABILITY_PROBE_TIMEOUT_MS = 3_000;

/** Default container image — Node.js 22 LTS. Python stacks override this. */
const DEFAULT_NODE_IMAGE = "node:22-alpine";
const PYTHON_IMAGE = "python:3.12-slim";

/** Default dev server port. Stack-specific ports override this at provision time. */
const DEFAULT_INTERNAL_PORT = LEGACY_NODE_SERVICE_PORT;

/** Derive the container image and dev server port from the project stack. */
function stackConfig(
  stack?: string | null,
  runtimePort?: number | null,
): { image: string; internalPort: number } {
  const internalPort = resolveProjectRuntimeManifest({
    runtimePort,
    stack,
    legacyProfile: "stack",
  }).servicePort;
  switch (stack) {
    case "nextjs":
      return { image: DEFAULT_NODE_IMAGE, internalPort };
    case "node-api":
      return { image: DEFAULT_NODE_IMAGE, internalPort };
    case "python-flask":
      return { image: PYTHON_IMAGE, internalPort };
    case "python-fastapi":
      return { image: PYTHON_IMAGE, internalPort };
    default:
      return { image: DEFAULT_NODE_IMAGE, internalPort };
  }
}

/** Kept for backward compatibility — old code may reference CONTAINER_IMAGE or INTERNAL_PORT. */
const _CONTAINER_IMAGE = DEFAULT_NODE_IMAGE;
const _INTERNAL_PORT = DEFAULT_INTERNAL_PORT;

/** Map a runtime/stack string to the appropriate Docker image for production containers. */
function _imageForRuntime(runtime?: string | null): string {
  return stackConfig(runtime).image;
}

/** Auto-stop after this many seconds of inactivity */
const IDLE_SECONDS = 600; // 10 minutes

function isConfigured(): boolean {
  return FLY_TOKEN.length > 0;
}

/**
 * Raw credential-presence check for lifecycle cleanup only. This does not mean
 * the Fly container layer is operational.
 */
export function hasContainerLayerCredentials(): boolean {
  return isConfigured();
}

let containerCapabilityCache: { value: boolean; expiresAt: number } | null = null;
let containerCapabilityProbeInFlight: Promise<boolean> | null = null;

function settleWithin(
  operation: Promise<boolean>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      onTimeout?.();
      finish(false);
    }, timeoutMs);
    operation.then(finish, () => finish(false));
  });
}

async function probeFlyControlPlane(): Promise<boolean> {
  const controller = new AbortController();
  return settleWithin(
    fetch(`${FLY_API_BASE}/apps/${encodeURIComponent(FLY_APP)}/machines`, {
      method: "GET",
      headers: flyHeaders(),
      signal: controller.signal,
    }).then((response) => response.ok),
    CONTAINER_CAPABILITY_PROBE_TIMEOUT_MS,
    () => controller.abort(),
  );
}

async function probeFlyProxyHostname(): Promise<boolean> {
  return settleWithin(
    lookup(FLY_PROXY_HOSTNAME).then(() => true),
    CONTAINER_CAPABILITY_PROBE_TIMEOUT_MS,
  );
}

async function probeContainerLayerOperational(): Promise<boolean> {
  if (!isConfigured()) return false;
  const [controlPlaneReachable, proxyHostnameResolves] = await Promise.all([
    probeFlyControlPlane(),
    probeFlyProxyHostname(),
  ]);
  return controlPlaneReachable && proxyHostnameResolves;
}

/**
 * Returns true only when the authenticated Fly control plane is reachable and
 * the public proxy hostname resolves. The read-only result is cached for one
 * minute, including failures, so preferences and Builder jobs fail closed
 * without repeatedly probing Fly.
 */
export async function isContainerLayerConfigured(): Promise<boolean> {
  const now = Date.now();
  if (containerCapabilityCache && containerCapabilityCache.expiresAt > now) {
    return containerCapabilityCache.value;
  }
  if (containerCapabilityProbeInFlight) return containerCapabilityProbeInFlight;

  const probe = probeContainerLayerOperational();
  containerCapabilityProbeInFlight = probe;
  try {
    const value = await probe;
    containerCapabilityCache = {
      value,
      expiresAt: Date.now() + CONTAINER_CAPABILITY_CACHE_MS,
    };
    return value;
  } catch {
    containerCapabilityCache = {
      value: false,
      expiresAt: Date.now() + CONTAINER_CAPABILITY_CACHE_MS,
    };
    return false;
  } finally {
    if (containerCapabilityProbeInFlight === probe) {
      containerCapabilityProbeInFlight = null;
    }
  }
}

// ─── Container subsystem self-check ──────────────────────────────────────────

/** Cached result of the startup connectivity probe. null = not yet run. */
let _containerSubsystemStatus: "ok" | "unconfigured" | "error" | null = null;

/**
 * Run a one-time self-check at server startup to verify that the Fly.io
 * container exec path is working before the server accepts traffic.
 *
 * Probe strategy:
 *   1. If FLY_API_TOKEN is absent → "unconfigured" (graceful no-op).
 *   2. Require the authenticated control plane and public proxy DNS to pass
 *      the cached operational capability probe.
 *   3. List machines in the app. If the API call fails → "error".
 *   4. If any machine is in "started" state, call the `/exec` endpoint with
 *      `echo OK` to exercise the actual exec path. Failure → "error".
 *   5. If no started machines exist (e.g. fresh deploy with no projects yet),
 *      API reachability alone is verified and "ok" is returned with a note.
 *
 * The result is cached in-process. The health endpoint reads it without an
 * additional API call on every request.
 *
 * A 10-second timeout is applied to the entire probe so a hung Fly API
 * never blocks server startup indefinitely.
 */
export async function runContainerSelfCheck(): Promise<"ok" | "unconfigured" | "error"> {
  if (!isConfigured()) {
    logger.warn(
      "container subsystem: unconfigured — FLY_API_TOKEN is not set. Container features disabled.",
    );
    _containerSubsystemStatus = "unconfigured";
    return "unconfigured";
  }

  const PROBE_TIMEOUT_MS = 10_000;

  try {
    // Use a clearable setTimeout so the timer is cancelled when the probe wins
    // the race. AbortSignal.timeout + an event listener cannot be cleaned up,
    // causing false "timed out" log lines even after a successful probe.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"error">((resolve) => {
      timeoutHandle = setTimeout(() => {
        logger.warn(
          { timeoutMs: PROBE_TIMEOUT_MS },
          "container subsystem: self-check timed out — marking as error",
        );
        resolve("error");
      }, PROBE_TIMEOUT_MS);
    });

    const result = await Promise.race([
      (async () => {
        if (!(await isContainerLayerConfigured())) {
          logger.warn("container subsystem: ERROR — Fly control plane or proxy DNS is unavailable");
          return "error" as const;
        }
        return _runContainerProbe();
      })().finally(() => clearTimeout(timeoutHandle)),
      timeoutPromise,
    ]);
    _containerSubsystemStatus = result;
    return result;
  } catch (err) {
    logger.warn({ err }, "container subsystem: ERROR — self-check threw unexpectedly");
    _containerSubsystemStatus = "error";
    return "error";
  }
}

/** Internal implementation — runs the actual Fly.io API probe. */
async function _runContainerProbe(): Promise<"ok" | "error"> {
  // Step 1: verify the API is reachable and the token is valid.
  let listRes: Response;
  try {
    listRes = await flyFetch(`/apps/${FLY_APP}/machines`);
  } catch (err) {
    logger.warn({ err }, "container subsystem: ERROR — Fly.io API connectivity probe failed");
    return "error";
  }

  if (!listRes.ok && listRes.status !== 404) {
    logger.warn(
      { status: listRes.status },
      "container subsystem: ERROR — Fly.io machines list returned unexpected status",
    );
    return "error";
  }

  // Step 2: if there are started machines, verify the exec path directly.
  if (listRes.ok) {
    let machines: { id?: string; state?: string }[] = [];
    try {
      machines = (await listRes.json()) as { id?: string; state?: string }[];
    } catch {
      // JSON parse failure is non-fatal — proceed without exec probe
    }

    const startedMachine = machines.find((m) => m.state === "started" && m.id);
    if (startedMachine?.id) {
      try {
        const execRes = await flyFetch(`/apps/${FLY_APP}/machines/${startedMachine.id}/exec`, {
          method: "POST",
          body: JSON.stringify({ command: ["/bin/sh", "-c", "echo OK"], timeout: 5 }),
        });
        if (execRes.ok) {
          logger.info(
            { machineId: startedMachine.id },
            "container subsystem: OK — Fly.io API reachable and exec path verified",
          );
          return "ok";
        }
        logger.warn(
          { machineId: startedMachine.id, status: execRes.status },
          "container subsystem: ERROR — exec probe returned unexpected status",
        );
        return "error";
      } catch (err) {
        logger.warn({ err }, "container subsystem: ERROR — exec probe threw unexpectedly");
        return "error";
      }
    }
  }

  // No started machines available (fresh deploy). API token is valid but
  // exec path is unverified. Log a note and report OK — exec will be
  // exercised naturally on the first agent task.
  logger.info(
    "container subsystem: OK — Fly.io API is reachable (no started machines; exec path will be verified on first task)",
  );
  return "ok";
}

/** Return the cached container subsystem status (set by runContainerSelfCheck at startup). */
export function getContainerSubsystemStatus(): "ok" | "unconfigured" | "error" | null {
  return _containerSubsystemStatus;
}

function flyHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${FLY_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * HTTP statuses from Fly.io that are transient and worth retrying.
 * 429 = rate-limited, 502/503/504 = Fly infra blip.
 */
const FLY_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

async function flyFetch(
  path: string,
  init?: RequestInit,
  /** Per-request timeout in ms. Default 30 s for API calls. Pass 360_000 for
   *  exec calls that stream output for up to Fly's 300-second exec timeout. */
  timeoutMs = 30_000,
  maxAttempts = 3,
): Promise<Response> {
  const { containerCircuit, withRetry, isTransientError } = await import("./resilience");
  return containerCircuit.call(() =>
    withRetry(
      async () => {
        const url = `${FLY_API_BASE}${path}`;
        const res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { ...flyHeaders(), ...(init?.headers ?? {}) },
        });
        // Throw on retryable HTTP error statuses so withRetry can back off
        // and retry — fetch() itself only throws on network failure, not on
        // application-level error codes.
        if (FLY_RETRYABLE_STATUSES.has(res.status)) {
          throw Object.assign(
            new Error(`Fly.io ${res.status} on ${init?.method ?? "GET"} ${path}`),
            { status: res.status, retryable: true },
          );
        }
        return res;
      },
      {
        maxAttempts,
        baseDelayMs: 500,
        shouldRetry: (err: unknown) =>
          isTransientError(err) || (typeof err === "object" && err !== null && "retryable" in err),
        label: `fly:${path}`,
      },
    ),
  );
}

/**
 * Narrow Fly Machines request surface for legacy retirement reconciliation.
 *
 * The caller must still validate the returned machine document before issuing
 * STOP or DELETE. Keeping URL construction and authentication here ensures retirement
 * never handles or exposes the Fly token itself.
 */
export async function requestLegacyFlyMachineForRetirement(
  input: Parameters<LegacyFlyRetirementRequest>[0],
): Promise<Response> {
  if (!isConfigured()) {
    throw new ContainerUnavailableError();
  }
  // The fixed-app catalog must be complete. Only GET observations may retry.
  if (input.resource === "volumes") {
    if (input.method !== "GET") throw new Error("Unsupported retirement machine operation");
    return flyFetch(
      `/apps/${encodeURIComponent(FLY_APP)}/volumes`,
      {
        method: "GET",
        redirect: "error",
      },
      10_000,
    );
  }
  if (
    !(
      (input.resource === undefined && (input.method === "GET" || input.method === "DELETE")) ||
      (input.resource === "lease" && (input.method === "POST" || input.method === "DELETE")) ||
      (input.resource === "stop" && input.method === "POST") ||
      (input.resource === "wait" && input.method === "GET")
    )
  ) {
    throw new Error("Unsupported retirement machine operation");
  }
  const machinePath = `/apps/${encodeURIComponent(FLY_APP)}/machines/${encodeURIComponent(
    input.machineId,
  )}`;
  const leaseNonce = "leaseNonce" in input ? input.leaseNonce : undefined;
  if (
    ((input.method === "DELETE" || input.resource === "stop" || input.resource === "wait") &&
      !leaseNonce) ||
    (leaseNonce !== undefined &&
      (typeof leaseNonce !== "string" || !/^[\x21-\x7E]{1,256}$/u.test(leaseNonce)))
  ) {
    throw new Error("Invalid retirement machine lease");
  }
  if (
    input.resource === "lease" &&
    input.method === "POST" &&
    (!Number.isInteger(input.ttl) ||
      input.ttl < 1 ||
      input.ttl > 300 ||
      typeof input.description !== "string" ||
      input.description.length < 1 ||
      input.description.length > 256)
  ) {
    throw new Error("Invalid retirement machine lease");
  }
  if (
    input.resource === "wait" &&
    (typeof input.instanceId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/iu.test(input.instanceId))
  ) {
    throw new Error("Invalid retirement machine version");
  }
  let path = input.resource === "lease" ? machinePath + "/lease" : machinePath;
  if (input.resource === "stop") path += "/stop";
  if (input.resource === "wait") {
    // Fly's version query supersedes instance_id. Never use the default started
    // state or an unpinned wait. Keep the provider wait below the HTTP deadline.
    path += `/wait?state=stopped&version=${encodeURIComponent(input.instanceId)}&timeout=15`;
  }
  return flyFetch(
    path,
    {
      method: input.method,
      redirect: "error",
      ...(leaseNonce ? { headers: { "fly-machine-lease-nonce": leaseNonce } } : {}),
      ...(input.resource === "lease" && input.method === "POST"
        ? { body: JSON.stringify({ description: input.description, ttl: input.ttl }) }
        : {}),
    },
    input.resource === "wait" ? 20_000 : 10_000,
    input.method === "GET" && input.resource !== "wait" ? 3 : 1,
  );
}

/**
 * Derive the Fly.io internal DNS hostname for a machine.
 * Format: <machineId>.vm.<appName>.internal
 * Accessible via the Fly.io proxy at https://<appName>.fly.dev/<path> when routing is configured.
 */
function machineProxyUrl(machineId: string): string {
  return `https://${FLY_APP}.fly.dev/container/${machineId}`;
}

/** Write a log line to the container_logs table (best-effort, non-fatal). */
async function writeLog(
  projectId: number,
  level: "stdout" | "stderr" | "system",
  message: string,
): Promise<void> {
  try {
    await db.insert(containerLogsTable).values({ projectId, level, message });
  } catch {
    // non-fatal
  }
}

/**
 * Create a new Fly.io machine for a project and return its ID + proxy URL.
 * The image and internal port are derived from the project's stack.
 * A persistent volume should already exist (managed separately).
 *
 * @param extraEnv  Optional additional env vars (decrypted project secrets) to inject.
 */
export async function createContainer(
  projectId: number,
  stack?: string | null,
  extraEnv?: Record<string, string>,
  options?: { servicePort?: number | null },
): Promise<ContainerInfo | { error: string } | null> {
  if (!isConfigured()) {
    logger.warn({ projectId }, "FLY_API_TOKEN not set — container creation skipped");
    return null;
  }

  const machineName = `project-${projectId}`;
  const { image, internalPort } = stackConfig(stack, options?.servicePort);

  const body = {
    name: machineName,
    region: FLY_REGION,
    config: {
      image,
      env: {
        PROJECT_ID: String(projectId),
        PORT: String(internalPort),
        ...(extraEnv ?? {}),
      },
      init: {
        cmd: ["/bin/sh", "-c", "mkdir -p /app && tail -f /dev/null"],
      },
      guest: {
        cpu_kind: "shared",
        cpus: 1,
        memory_mb: 512,
      },
      // Container hardening (Task #510): no extra writable mounts (rootfs is
      // the base image — Fly machines don't grant a writable rootfs by
      // default beyond the running container layer; /app is the only place
      // the agent should write to). DNS pinned to public resolvers. A true
      // Fly egress allowlist would require a wireguard side-car (out of
      // scope here — see replit.md "Egress hardening" notes). Privileged
      // mode is off by default and never requested here.
      mounts: [],
      dns: {
        nameservers: ["1.1.1.1", "8.8.8.8"],
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: internalPort,
          autostop: "stop",
          autostart: true,
          min_machines_running: 0,
          checks: [],
        },
      ],
      auto_destroy: false,
      restart: { policy: "no" },
      stopConfig: {
        timeout: IDLE_SECONDS,
      },
    },
  };

  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ projectId, status: res.status, body: text }, "Failed to create Fly machine");
      await writeLog(projectId, "system", `Container creation failed: ${text}`);
      const reason = `Fly API ${res.status}: ${text.slice(0, 300)}`;
      return { error: reason };
    }

    const data = (await res.json()) as { id: string; state?: string };
    const machineId = data.id;
    const containerUrl = machineProxyUrl(machineId);

    logger.info({ projectId, machineId, containerUrl }, "Fly machine created");
    await writeLog(projectId, "system", `Container created: ${machineId}`);

    return {
      containerId: machineId,
      status: "starting",
      containerUrl,
      servicePort: internalPort,
    };
  } catch (err) {
    logger.error({ err, projectId }, "Error creating Fly machine");
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

/**
 * Start (or wake) an existing Fly.io machine.
 */
export async function startContainer(machineId: string, projectId: number): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/start`, { method: "POST" });
    const ok = res.ok;
    if (ok) {
      await writeLog(projectId, "system", `Container started: ${machineId}`);
    } else {
      const text = await res.text();
      logger.warn({ machineId, projectId, body: text }, "Failed to start Fly machine");
    }
    return ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error starting Fly machine");
    return false;
  }
}

/**
 * Stop a running Fly.io machine (puts it into hibernation).
 */
export async function stopContainer(machineId: string, projectId: number): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/stop`, { method: "POST" });
    const ok = res.ok;
    if (ok) {
      await writeLog(projectId, "system", `Container stopped: ${machineId}`);
    }
    return ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error stopping Fly machine");
    return false;
  }
}

/**
 * Destroy a Fly.io machine permanently.
 */
export async function destroyContainer(machineId: string, projectId: number): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}?force=true`, {
      method: "DELETE",
    });
    const ok = res.ok || res.status === 404;
    if (ok) {
      await writeLog(projectId, "system", `Container destroyed: ${machineId}`);
    }
    return ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error destroying Fly machine");
    return false;
  }
}

/**
 * Get the current status of a Fly.io machine.
 */
export async function getContainerStatus(machineId: string): Promise<ContainerStatus> {
  if (!isConfigured()) return "stopped";
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}`);
    if (res.status === 404) return "stopped";
    if (!res.ok) return "error";
    const data = (await res.json()) as { state?: string };
    return mapFlyState(data.state ?? "");
  } catch {
    return "error";
  }
}

function mapFlyState(state: string): ContainerStatus {
  switch (state) {
    case "started":
      return "running";
    case "starting":
      return "starting";
    case "stopped":
    case "stopping":
      return "hibernated";
    case "destroyed":
      return "stopped";
    default:
      return "stopped";
  }
}

/**
 * Execute a command inside a running Fly.io machine.
 * Returns the combined stdout/stderr output as a string.
 *
 * Requires the machine to be in the "started" state.
 */
export async function execInContainer(
  machineId: string,
  command: string[],
  projectId: number,
  workdir = "/app",
): Promise<{
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the machine had auto-stopped and was woken up to service this exec.
   *  Callers can use this flag to reset any in-memory "installed" state since the
   *  Fly machine's writable layer is reset on each stop/start cycle. */
  machineWoken: boolean;
}> {
  if (!isConfigured()) {
    throw new ContainerUnavailableError(
      "Container exec is not available: FLY_API_TOKEN is not configured. " +
        "Provision the project or add FLY_API_TOKEN to the environment.",
    );
  }

  /** Attempt a single exec POST and return raw response text + ok flag. */
  const attemptExec = async () => {
    // Use a 360-second HTTP timeout — 60 s of headroom above Fly's 300-second
    // exec timeout so the response can arrive before the connection is killed.
    const res = await flyFetch(
      `/apps/${FLY_APP}/machines/${machineId}/exec`,
      { method: "POST", body: JSON.stringify({ command, cwd: workdir, timeout: 300 }) },
      360_000,
    );
    return { res, text: res.ok ? null : await res.text() };
  };

  /**
   * Returns true when the non-ok exec response indicates the machine stopped
   * (or is mid-transition), so we should wake it and retry.
   *
   * Fly returns "failed_precondition: machine not running" in the body when the
   * machine is cleanly stopped.  An empty body occurs during the brief transition
   * between stopped and starting, or occasionally under API transient errors —
   * in both cases a wake-and-retry is the right remedy.
   * "exec request failed: EOF" occurs when the machine stops mid-exec (e.g.
   * autostop fires during a long-running npm install), cutting the HTTP
   * connection — treat it the same way.
   */
  const isMachineStopped = (t: string | null): boolean =>
    t === "" ||
    t === null ||
    (t?.includes("machine not running") ?? false) ||
    (t?.includes("exec request failed: EOF") ?? false);

  let machineWoken = false;

  try {
    let { res, text } = await attemptExec();

    // Fly machines autostop when idle (HTTP port gets no traffic).  If the
    // machine stopped between agent steps, wake it and retry up to 2 times.
    // IMPORTANT: When a Fly machine stops and restarts, its writable layer is
    // reset from the base Docker image — all files written via exec (project
    // files, node_modules) are lost.  Callers must re-sync files and re-run
    // npm install after detecting machineWoken=true.
    for (let attempt = 0; !res.ok && isMachineStopped(text) && attempt < 2; attempt++) {
      logger.info(
        { machineId, projectId, attempt, body: text },
        "Machine stopped between execs — auto-waking and retrying",
      );
      await writeLog(projectId, "system", "Container auto-waking after idle stop…");
      machineWoken = true;
      await startContainer(machineId, projectId);
      await waitForMachineReady(machineId, 45);
      // Give the container processes a moment to initialize after the VM reports "started"
      await new Promise((r) => setTimeout(r, 3_000));
      ({ res, text } = await attemptExec());
    }

    if (!res.ok) {
      const errText = text ?? (await res.text());
      logger.warn({ machineId, projectId, command, body: errText }, "Exec failed");
      return {
        ok: false,
        output: errText,
        stdout: "",
        stderr: errText,
        exitCode: -1,
        machineWoken,
      };
    }

    const data = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number };
    const stdout = data.stdout ?? "";
    const stderr = data.stderr ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    const exitCode = data.exit_code ?? 0;
    const ok = exitCode === 0;

    await writeLog(projectId, ok ? "stdout" : "stderr", output.slice(0, 4000));
    return { ok, output, stdout, stderr, exitCode, machineWoken };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg, stdout: "", stderr: msg, exitCode: -1, machineWoken };
  }
}

/**
 * Options for npmInstallInBackground.
 */
export type NpmInstallOptions = {
  /**
   * Max times to (re)start the install (default 5).
   */
  maxAttempts?: number;
  /**
   * Hard wall-clock cap in milliseconds (default 10 min = 600_000).
   * Once exceeded the function returns immediately with ok:false and a
   * "BLOCKED: dependency install exceeded time limit" message regardless of
   * how many attempts remain. This prevents a stuck npm install from holding
   * the task handler open for the full 5×6-min = 30-min window.
   */
  wallClockCapMs?: number;
  /**
   * Optional AbortSignal. When aborted the function returns immediately with
   * ok:false so the caller's cancel path is honoured without waiting for the
   * current poll cycle to time out.
   */
  signal?: AbortSignal;
  /**
   * Called before every retry that was triggered by a machine restart.
   * Use this to re-sync project files to the container — when the Fly machine
   * autostops, its writable layer is reset, so /app files (including
   * package.json) disappear.  Without a re-sync, npm install would run
   * against an empty directory and succeed with 0 packages installed.
   */
  onMachineRestarted?: () => Promise<void>;
};

/**
 * Runs `npm install` inside a container as a detached background process,
 * then polls for completion with short execs every 5 seconds.
 *
 * Why detached?  Fly machines autostop after ~60 s of no HTTP connections.
 * A direct exec holding the connection open for ~90 s (npm install duration)
 * gets cut with EOF.  Detaching the install from the exec connection means
 * each individual poll exec finishes in < 1 s, staying well under the
 * autostop window.
 *
 * If the machine restarts during polling (machineWoken), /tmp files are lost
 * and we relaunch the install.  The onMachineRestarted callback is invoked
 * before each restart-triggered relaunch so the caller can re-sync project
 * files — without this, npm install would run against an empty /app directory
 * (no package.json) and succeed with 0 packages installed.
 *
 * @param machineId  - Fly machine ID
 * @param projectId  - Project ID (for logging + writeLog)
 * @param opts       - Optional configuration (see NpmInstallOptions)
 */
export async function npmInstallInBackground(
  machineId: string,
  projectId: number,
  opts?: NpmInstallOptions,
): Promise<{ ok: boolean; output: string }> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const wallClockCapMs = opts?.wallClockCapMs ?? 10 * 60 * 1000; // 10-minute hard cap
  const signal = opts?.signal;
  const onMachineRestarted = opts?.onMachineRestarted;
  const deadline = Date.now() + wallClockCapMs;

  const capMinutes = Math.round(wallClockCapMs / 60_000);
  const blockedMsg = `BLOCKED: dependency install exceeded time limit (${capMinutes} min cap). The npm install process did not finish within the allowed window. Check package.json for heavy or broken dependencies.`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      logger.info({ machineId, projectId, attempt }, "npmInstallInBackground: aborted via signal");
      return { ok: false, output: "npmInstallInBackground: aborted" };
    }
    if (Date.now() >= deadline) {
      logger.warn(
        { machineId, projectId, attempt, wallClockCapMs },
        "npmInstallInBackground: wall-clock cap exceeded — aborting before attempt",
      );
      return { ok: false, output: blockedMsg };
    }

    // Launch npm install detached from the exec HTTP connection so it survives EOF/autostop.
    // rm the sentinel files first so stale state from a previous run doesn't confuse polling.
    const launch = await execInContainer(
      machineId,
      [
        "sh",
        "-c",
        "pkill -f 'npm install' 2>/dev/null; sleep 1; " +
          "rm -f /tmp/.npm-done /tmp/.npm-out && " +
          "nohup sh -c 'cd /app && npm install --prefer-offline --no-audit --no-fund > /tmp/.npm-out 2>&1; echo $? > /tmp/.npm-done' " +
          "</dev/null >/dev/null 2>&1 &",
      ],
      projectId,
    );

    if (!launch.ok || launch.machineWoken) {
      logger.warn(
        { machineId, projectId, attempt },
        "npmInstallInBackground: launch exec failed — retrying",
      );
      // Machine restarted → /app is empty. Re-sync files before next launch.
      if (launch.machineWoken && onMachineRestarted) {
        try {
          await onMachineRestarted();
        } catch (e) {
          logger.warn(
            { machineId, projectId, attempt, err: e },
            "npmInstallInBackground: onMachineRestarted callback failed",
          );
        }
      }
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }

    // Poll for /tmp/.npm-done, written by the background shell when npm exits.
    for (let poll = 0; poll < 72; poll++) {
      // 72 × 5 s = 6 min ceiling per attempt; hard wall-clock deadline checked first.
      if (signal?.aborted) {
        logger.info(
          { machineId, projectId, attempt, poll },
          "npmInstallInBackground: aborted via signal during poll",
        );
        return { ok: false, output: "npmInstallInBackground: aborted" };
      }
      if (Date.now() >= deadline) {
        logger.warn(
          { machineId, projectId, attempt, poll, wallClockCapMs },
          "npmInstallInBackground: wall-clock cap exceeded during poll — aborting",
        );
        return { ok: false, output: blockedMsg };
      }
      await new Promise((r) => setTimeout(r, 5_000));

      const check = await execInContainer(
        machineId,
        [
          "sh",
          "-c",
          'if [ -f /tmp/.npm-done ]; then echo "__EXIT_$(cat /tmp/.npm-done)__"; cat /tmp/.npm-out; else echo "__RUNNING__"; fi',
        ],
        projectId,
      );

      if (check.machineWoken) {
        logger.info(
          { machineId, projectId, attempt, poll },
          "npmInstallInBackground: machine restarted during poll — re-syncing files and relaunching install",
        );
        // Machine restarted → /app is empty. Re-sync before the outer loop retries.
        if (onMachineRestarted) {
          try {
            await onMachineRestarted();
          } catch (e) {
            logger.warn(
              { machineId, projectId, attempt, poll, err: e },
              "npmInstallInBackground: onMachineRestarted callback failed",
            );
          }
        }
        break; // break polling loop → outer attempt loop will relaunch
      }

      const m = check.output.match(/__EXIT_(\d+)__/);
      if (m) {
        const exitCode = parseInt(m[1], 10);
        const installOutput = check.output.replace(/__EXIT_\d+__\n?/, "");
        if (exitCode === 0) {
          logger.info(
            { machineId, projectId, attempt, poll },
            "npmInstallInBackground: npm install succeeded",
          );
          return { ok: true, output: installOutput };
        }
        logger.warn(
          { machineId, projectId, attempt, poll, exitCode, output: installOutput.slice(0, 500) },
          "npmInstallInBackground: npm install exited non-zero",
        );
        return { ok: false, output: installOutput };
      }
      // Still running (__RUNNING__) or poll exec returned unexpected output — keep waiting
    }
    // Inner poll loop exhausted (timeout or machine restart) → retry outer attempt
  }
  return { ok: false, output: "npmInstallInBackground: exhausted all attempts" };
}

/**
 * Write a single file to a running container's disk via exec.
 * Uses printf + base64 decode to avoid shell quoting issues with special chars.
 */
export async function writeFileToContainer(
  machineId: string,
  filePath: string,
  content: string | Uint8Array,
  projectId: number,
): Promise<boolean> {
  if (!isConfigured()) {
    throw new ContainerUnavailableError(
      "writeFileToContainer: FLY_API_TOKEN is not configured. " +
        "Cannot sync files to a container without Fly.io credentials.",
    );
  }
  try {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const b64 = bytes.toString("base64");
    const dir = filePath.includes("/")
      ? `/app/${filePath.split("/").slice(0, -1).join("/")}`
      : "/app";
    const fullPath = `/app/${filePath}`;

    // mkdir -p for parent dir, then decode base64 into file
    const cmd = ["/bin/sh", "-c", `mkdir -p "${dir}" && echo "${b64}" | base64 -d > "${fullPath}"`];

    const res = await execInContainer(machineId, cmd, projectId);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Bulk-write all project files to the container's disk.
 * Called on container start to sync DB files → container FS.
 *
 * @param throwIfUnconfigured - When true, throws ContainerUnavailableError instead of
 *   silently returning when FLY_API_TOKEN is absent.  Callers for agentic (Developer Mode)
 *   projects should pass true so the error surfaces visibly rather than silently no-oping.
 *   Non-agentic (static-legacy) callers keep the default false to preserve existing behaviour.
 */
export async function syncFilesToContainer(
  machineId: string,
  projectId: number,
  files: Array<{ path: string; content: string | Uint8Array }>,
  throwIfUnconfigured = false,
): Promise<void> {
  if (!isConfigured()) {
    if (throwIfUnconfigured) {
      throw new ContainerUnavailableError(
        "syncFilesToContainer: FLY_API_TOKEN is not configured. " +
          "Cannot sync files to a container without Fly.io credentials.",
      );
    }
    return;
  }
  await writeLog(projectId, "system", `Syncing ${files.length} files to container…`);

  for (const file of files) {
    await writeFileToContainer(machineId, file.path, file.content, projectId);
  }

  await writeLog(projectId, "system", "File sync complete");
}

/**
 * Ensure the Fly app exists. Creates it if it doesn't (idempotent).
 * Call once at server startup.
 */
export async function ensureFlyApp(): Promise<void> {
  if (!isConfigured()) return;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}`);
    if (res.status === 404) {
      await flyFetch("/apps", {
        method: "POST",
        body: JSON.stringify({ app_name: FLY_APP, org_slug: FLY_ORG }),
      });
      logger.info({ app: FLY_APP }, "Fly app created");
    }
  } catch (err) {
    logger.warn({ err }, "Could not ensure Fly app exists — containers may not work");
  }
}

/**
 * Update the env vars on an existing Fly.io machine via PATCH.
 * The system vars (PROJECT_ID, PORT) are always preserved.
 */
export async function updateContainerEnv(
  machineId: string,
  projectId: number,
  extraEnv: Record<string, string>,
  options?: { servicePort?: number | null },
): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          env: {
            PROJECT_ID: String(projectId),
            PORT: String(
              resolveProjectRuntimeManifest({
                runtimePort: options?.servicePort,
                legacyProfile: "fixed-node",
              }).servicePort,
            ),
            ...extraEnv,
          },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn({ machineId, projectId, body: text }, "Failed to update Fly machine env");
    }
    return res.ok;
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error updating Fly machine env");
    return false;
  }
}

/**
 * Update the env vars on the project's running container and restart it
 * so the new secrets take effect immediately.
 *
 * Called when secrets are added, updated, or deleted while the container is live.
 * Best-effort — failures are logged but never propagated to the caller.
 */
export async function restartContainerWithSecrets(
  projectId: number,
  envVars: Record<string, string>,
  options?: { servicePort?: number | null },
): Promise<void> {
  if (!isConfigured()) return;

  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
      runtimePort: projectsTable.runtimePort,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project?.containerId || project.containerStatus !== "running") return;

  const machineId = project.containerId;

  // 1. Update the stored machine config with the new env vars
  await updateContainerEnv(machineId, projectId, envVars, {
    servicePort: options?.servicePort ?? project.runtimePort,
  });

  // 2. Restart the machine so processes see the new env
  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/restart`, {
      method: "POST",
    });
    if (res.ok) {
      await writeLog(projectId, "system", "Container restarted to apply updated secrets");
      logger.info({ projectId, machineId }, "Container restarted after secret change");
    } else {
      const text = await res.text();
      logger.warn(
        { machineId, projectId, body: text },
        "Failed to restart Fly machine after secret update",
      );
    }
  } catch (err) {
    logger.error({ err, machineId, projectId }, "Error restarting Fly machine after secret update");
  }
}

/**
 * Ensure a container is awake and ready to receive requests.
 *
 * Steps:
 *   1. Calls startContainer (idempotent — safe when already running).
 *   2. Polls Fly machine state until "started" (up to timeoutSeconds).
 *   3. If a containerUrl is provided, also verifies the /healthz endpoint
 *      responds 200 so we know the user's app process is live.
 *
 * Returns { ok: true } immediately when FLY_API_TOKEN is not configured
 * (dev-mode degradation — let the build proceed without a real container).
 */
export async function ensureContainerAwake(
  machineId: string,
  projectId: number,
  containerUrl: string | null,
  timeoutSeconds = 30,
): Promise<{ ok: boolean; message?: string }> {
  if (!isConfigured()) {
    throw new ContainerUnavailableError(
      "ensureContainerAwake: FLY_API_TOKEN is not configured. " +
        "Cannot wake a container without Fly.io credentials.",
    );
  }

  // Wake the machine (idempotent — Fly ignores this when already running)
  await startContainer(machineId, projectId);

  // Poll Fly machine state until "started"
  const machineReady = await waitForMachineReady(machineId, timeoutSeconds);
  if (!machineReady) {
    return {
      ok: false,
      message:
        "Your server did not respond within 30 seconds. It may be hibernated or unreachable — please retry.",
    };
  }

  // If the container has a proxy URL, verify /healthz responds so we know the
  // app process (not just the Fly machine) is accepting traffic.
  if (containerUrl) {
    const healthUrl = `${containerUrl}/healthz`;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let passed = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
        if (res.ok || res.status === 404) {
          // 404 means the app is up but doesn't have /healthz — good enough.
          passed = true;
          break;
        }
      } catch {
        // not ready yet — keep polling
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    if (!passed) {
      // Machine is "started" according to Fly but /healthz never responded.
      // Fail hard so the caller can surface a plain-English message instead
      // of letting the build start against an unresponsive app process.
      logger.warn(
        { projectId, machineId, healthUrl },
        "/healthz did not respond within timeout — failing pre-flight",
      );
      return {
        ok: false,
        message:
          "Your server started but is not responding to health checks. It may have crashed on startup — check the container logs and retry.",
      };
    }
  }

  return { ok: true };
}

/**
 * Map a known Fly.io sync / exec error to a plain-English user-facing message.
 * Called by callers that catch errors from syncFilesToContainer / execInContainer.
 */
export function mapFlyErrorToMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return "Network timeout while syncing files to your container. Check your connection and retry.";
  }
  if (lower.includes("out of memory") || lower.includes("oom") || lower.includes("137")) {
    return "Your container ran out of memory during the file sync. Try reducing the project size or upgrading your container plan.";
  }
  if (lower.includes("no space left") || lower.includes("disk full") || lower.includes("enospc")) {
    return "Your container disk is full. Remove unused files or increase container storage.";
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("unreachable")
  ) {
    return "Could not connect to your container. It may have crashed — try waking it from the Terminal tab and retrying.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized")) {
    return "Access denied while communicating with your container. Check your FLY_API_TOKEN.";
  }
  // Default: sanitise and truncate the raw message
  return `Container sync failed: ${raw.slice(0, 200).replace(/\n/g, " ").trim()}`;
}

/**
 * Provision or wake a container for a project.
 *
 * - If no containerId: creates a new machine + syncs files + runs npm install
 * - If containerId exists and status=hibernated: wakes the machine
 * - If already running: returns current info immediately
 *
 * Updates `projects` table with the latest container metadata.
 *
 * @param extraEnv  Decrypted project secrets to inject as env vars.
 */
export async function provisionContainer(
  projectId: number,
  files: Array<{ path: string; content: string | Uint8Array }>,
  extraEnv?: Record<string, string>,
  options?: { servicePort?: number | null },
): Promise<ContainerInfo | null> {
  if (!isConfigured()) return null;

  // Load current container state (including stack for image selection)
  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
      containerUrl: projectsTable.containerUrl,
      stack: projectsTable.stack,
      runtimePort: projectsTable.runtimePort,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) return null;

  const configuredServicePort = options?.servicePort ?? project.runtimePort;

  // Already running — return current info
  if (project.containerStatus === "running" && project.containerId) {
    const servicePort = resolveProjectRuntimeManifest({
      runtimePort: configuredServicePort,
      stack: project.stack,
      legacyProfile: "stack",
    }).servicePort;
    return {
      containerId: project.containerId,
      status: "running",
      containerUrl: project.containerUrl,
      servicePort,
    };
  }

  // Mark as starting
  await db
    .update(projectsTable)
    .set({ containerStatus: "starting" })
    .where(eq(projectsTable.id, projectId));

  let machineId = project.containerId;
  let containerUrl = project.containerUrl;

  if (!machineId) {
    // Create new machine — stack selects the right image; extraEnv injects project secrets
    const info = await createContainer(projectId, project.stack, extraEnv, {
      servicePort: configuredServicePort,
    });
    if (!info || "error" in info) {
      await db
        .update(projectsTable)
        .set({ containerStatus: "error" })
        .where(eq(projectsTable.id, projectId));
      return null;
    }
    machineId = info.containerId;
    containerUrl = info.containerUrl;

    // Persist immediately
    await db
      .update(projectsTable)
      .set({ containerId: machineId, containerUrl, containerStatus: "starting" })
      .where(eq(projectsTable.id, projectId));

    // Wait for machine to start (up to 30s)
    const newReady = await waitForMachineReady(machineId, 30);
    if (!newReady) {
      logger.warn(
        { projectId, machineId },
        "New container timed out waiting to start — resetting to stopped",
      );
      await db
        .update(projectsTable)
        .set({ containerStatus: "stopped" })
        .where(eq(projectsTable.id, projectId));
      return null;
    }

    // Sync files to container
    await syncFilesToContainer(machineId, projectId, files);
  } else {
    // Always update env vars on the existing machine before waking it.
    // Passing an empty map clears any previously injected secrets that were
    // deleted while the container was hibernated — this is intentional so that
    // removed secrets do not reappear after restart.
    await updateContainerEnv(machineId, projectId, extraEnv ?? {}, {
      servicePort: configuredServicePort,
    });
    // Wake existing machine
    await startContainer(machineId, projectId);
    const wakeReady = await waitForMachineReady(machineId, 30);
    if (!wakeReady) {
      logger.warn(
        { projectId, machineId },
        "Existing container timed out waiting to wake — resetting to stopped",
      );
      await db
        .update(projectsTable)
        .set({ containerStatus: "stopped" })
        .where(eq(projectsTable.id, projectId));
      return null;
    }
  }

  // Mark as running. Task #738 — once the container is back up, flip a
  // previously "hibernated" project back to "ready" so the workspace header
  // reflects the live state. Leave projects still in "provisioning" or
  // "error" alone — those signals must be preserved for the user.
  const [{ ps } = { ps: null as string | null }] = await db
    .select({ ps: projectsTable.provisioningStatus })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  const nextProvisioning = ps === "hibernated" ? "ready" : ps;
  await db
    .update(projectsTable)
    .set({
      containerStatus: "running",
      containerId: machineId,
      containerUrl,
      ...(nextProvisioning && nextProvisioning !== ps
        ? { provisioningStatus: nextProvisioning }
        : {}),
    })
    .where(eq(projectsTable.id, projectId));

  return {
    containerId: machineId,
    status: "running",
    containerUrl,
    servicePort: resolveProjectRuntimeManifest({
      runtimePort: configuredServicePort,
      stack: project.stack,
      legacyProfile: "stack",
    }).servicePort,
  };
}

/**
 * Poll Fly.io until the machine is in "started" state, up to timeoutSeconds.
 * Returns true when the machine is ready, false if the deadline was exceeded.
 */
async function waitForMachineReady(machineId: string, timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const status = await getContainerStatus(machineId);
    if (status === "running") return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Hibernate a container (stop it to save resources).
 * Called automatically after IDLE_SECONDS of inactivity via Fly's autostop,
 * or explicitly via the stop API route.
 */
export async function hibernateContainer(projectId: number): Promise<void> {
  const [project] = await db
    .select({ containerId: projectsTable.containerId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project?.containerId) return;

  await stopContainer(project.containerId, projectId);
  // Task #738 — also propagate to provisioningStatus so the workspace header
  // shows the "hibernated" state. Only override when the project had reached
  // "ready"; if it's still "provisioning" or in "error" we leave that signal
  // intact so users see the real problem.
  const [{ ps } = { ps: null as string | null }] = await db
    .select({ ps: projectsTable.provisioningStatus })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  const nextProvisioning = ps === "ready" || ps === "hibernated" ? "hibernated" : ps;
  await db
    .update(projectsTable)
    .set({
      containerStatus: "hibernated",
      ...(nextProvisioning ? { provisioningStatus: nextProvisioning } : {}),
    })
    .where(eq(projectsTable.id, projectId));
}

// ─── Production container support (Phase E) ──────────────────────────────────

export interface ProdContainerInfo {
  prodContainerId: string;
  containerUrl: string | null;
  status: ContainerStatus;
  servicePort: number;
}

/**
 * Create a production Fly.io machine with injected environment variables.
 * Uses naming convention: prod-{projectId} for the machine name.
 */
export async function createProductionContainer(
  projectId: number,
  envVars: Record<string, string>,
  runtime?: string | null,
  opts?: {
    region?: string | null;
    deploymentType?: string | null;
    servicePort?: number | null;
  },
): Promise<ProdContainerInfo | null> {
  if (!isConfigured()) {
    logger.warn({ projectId }, "FLY_API_TOKEN not set — prod container creation skipped");
    return null;
  }

  const machineName = `prod-${projectId}-${Date.now()}`;
  // Task #543: respect per-project region + deployment type.
  // reserved_vm → always-on (min_machines_running:1)
  // autoscale   → scale-to-zero on demand (min_machines_running:0)
  const region = opts?.region && opts.region.trim() ? opts.region.trim() : FLY_REGION;
  const minMachines = opts?.deploymentType === "autoscale" ? 0 : 1;
  const servicePort = resolveProjectRuntimeManifest({
    runtimePort: opts?.servicePort,
    stack: runtime,
    legacyProfile: "fixed-node",
  }).servicePort;

  const body = {
    name: machineName,
    region,
    config: {
      image: stackConfig(runtime).image,
      env: {
        ...envVars,
        PROJECT_ID: String(projectId),
        PORT: String(servicePort),
        NODE_ENV: "production",
      },
      init: {
        cmd: [
          "/bin/sh",
          "-c",
          "cd /app && ([ -f package.json ] && npm start 2>/dev/null || tail -f /dev/null)",
        ],
      },
      guest: {
        cpu_kind: "shared",
        cpus: 1,
        memory_mb: 512,
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: servicePort,
          autostop: "stop",
          autostart: true,
          min_machines_running: minMachines,
          checks: [],
        },
      ],
      auto_destroy: false,
      restart: { policy: "always" },
    },
  };

  try {
    const res = await flyFetch(`/apps/${FLY_APP}/machines`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { projectId, status: res.status, body: text },
        "Failed to create prod Fly machine",
      );
      await writeLog(projectId, "system", `Prod container creation failed: ${text}`);
      return null;
    }

    const data = (await res.json()) as { id: string; state?: string };
    const machineId = data.id;
    const containerUrl = machineProxyUrl(machineId);

    logger.info({ projectId, machineId, containerUrl }, "Prod Fly machine created");
    await writeLog(projectId, "system", `Prod container created: ${machineId}`);

    return {
      prodContainerId: machineId,
      containerUrl,
      status: "starting",
      servicePort,
    };
  } catch (err) {
    logger.error({ err, projectId }, "Error creating prod Fly machine");
    return null;
  }
}

/**
 * Perform a health check on a container by polling GET / on its proxy URL.
 * Returns true if the container responds 200 within timeoutSeconds.
 */
async function waitForContainerHealthy(
  containerUrl: string,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(containerUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * Blue/green deploy a production container.
 *
 * Algorithm:
 *   1. Create a new "green" machine with the current files + env vars
 *   2. Wait for the machine to start (Fly state = started)
 *   3. Sync project files to the new machine
 *   4. Run npm install in the new machine
 *   5. Poll health check (GET / 200) — up to 90s
 *   6. If healthy: stop the old "blue" machine, return new machine info
 *   7. If unhealthy: destroy new machine, return null (keep old running)
 *
 * Gracefully degrades: when FLY_API_TOKEN is not set returns null without error.
 */
export async function deployProductionContainer(
  projectId: number,
  oldProdMachineId: string | null,
  files: Array<{ path: string; content: string | Uint8Array }>,
  envVars: Record<string, string>,
  options?: { servicePort?: number | null },
): Promise<ProdContainerInfo | null> {
  if (!isConfigured()) return null;

  await writeLog(projectId, "system", "Starting blue/green production deploy…");

  // Load project stack + deployment substrate config (Task #543) so the
  // container uses the right image AND the right region + scaling profile.
  const [proj] = await db
    .select({
      stack: projectsTable.stack,
      region: projectsTable.region,
      deploymentType: projectsTable.deploymentType,
      runtimePort: projectsTable.runtimePort,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  // Create new green container
  const greenInfo = await createProductionContainer(projectId, envVars, proj?.stack, {
    region: proj?.region ?? null,
    deploymentType: proj?.deploymentType ?? null,
    servicePort: options?.servicePort ?? proj?.runtimePort ?? null,
  });
  if (!greenInfo) {
    await writeLog(projectId, "system", "Failed to create new prod container — aborting deploy");
    return null;
  }

  // Wait for machine to enter started state
  await waitForMachineReady(greenInfo.prodContainerId, 60);
  await writeLog(
    projectId,
    "system",
    `New prod container ${greenInfo.prodContainerId} started. Syncing files…`,
  );

  // Sync files to new container
  await syncFilesToContainer(greenInfo.prodContainerId, projectId, files);

  // Run npm install if package.json present
  const hasPackageJson = files.some((f) => f.path === "package.json");
  if (hasPackageJson) {
    await writeLog(projectId, "system", "Running npm install in prod container…");
    await execInContainer(
      greenInfo.prodContainerId,
      ["npm", "install", "--production", "--prefer-offline"],
      projectId,
    );
    await execInContainer(greenInfo.prodContainerId, ["npm", "run", "build"], projectId);
  }

  // Start the app in the container
  await execInContainer(
    greenInfo.prodContainerId,
    ["/bin/sh", "-c", "cd /app && nohup npm start &>/tmp/app.log &"],
    projectId,
  );

  // Health check — poll for up to 90 seconds
  await writeLog(projectId, "system", `Health-checking ${greenInfo.containerUrl}…`);
  const healthy = greenInfo.containerUrl
    ? await waitForContainerHealthy(greenInfo.containerUrl, 90)
    : false;

  if (!healthy) {
    await writeLog(
      projectId,
      "system",
      "Health check failed — destroying new container, keeping old one",
    );
    // Destroy the failed green container
    await destroyContainer(greenInfo.prodContainerId, projectId);
    return null;
  }

  await writeLog(projectId, "system", "Health check passed. Completing blue/green swap…");

  // Stop old blue container if one exists
  if (oldProdMachineId && oldProdMachineId !== greenInfo.prodContainerId) {
    await writeLog(projectId, "system", `Stopping old prod container ${oldProdMachineId}…`);
    await destroyContainer(oldProdMachineId, projectId);
  }

  await writeLog(
    projectId,
    "system",
    `Production deploy complete. Container: ${greenInfo.prodContainerId}`,
  );

  return {
    prodContainerId: greenInfo.prodContainerId,
    containerUrl: greenInfo.containerUrl,
    status: "running",
    servicePort: greenInfo.servicePort,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Container autostop management + keepalive (belt-and-suspenders)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patch the Fly machine's services[].autostop field via the Machines API.
 *
 * Called with "off" before a build task starts and "stop" in the outer finally
 * block.  This is the primary defence against Fly autostop killing long-running
 * inline execs (npm install, tsc, vite build).
 *
 * Fly's PATCH endpoint merges config fields, but services must be provided in
 * full because Fly replaces the services array rather than merging items.  We
 * therefore GET the current config first, patch autostop on each service entry,
 * then PATCH back.  Best-effort — failures are logged but never propagated to
 * the caller so a broken Fly API call never blocks the build.
 */
export async function patchMachineAutostop(
  machineId: string,
  projectId: number,
  autostop: "stop" | "off",
): Promise<void> {
  if (!isConfigured()) return;
  try {
    // GET current machine config so we can merge the autostop change.
    const getRes = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}`);
    if (!getRes.ok) {
      logger.warn(
        { machineId, projectId, status: getRes.status },
        "patchMachineAutostop: GET failed",
      );
      return;
    }
    const machine = (await getRes.json()) as {
      state?: string;
      config?: { services?: Array<Record<string, unknown>>; [key: string]: unknown };
    };
    // Capture whether the machine was running BEFORE the update so we know
    // whether to wait for it to restart after the config POST.
    const wasRunning = machine.state === "started";
    const existingConfig = machine.config ?? {};
    const services = (existingConfig.services ?? []) as Array<Record<string, unknown>>;
    // When disabling autostop ("off"), also set min_machines_running: 1 so Fly cannot
    // reclaim the machine while a long build is running. Restore to 0 when re-enabling
    // autostop ("stop") so the machine can idle-scale back to zero after the task.
    const minMachines = autostop === "off" ? 1 : 0;
    const updatedServices = services.map((s) => ({
      ...s,
      autostop,
      min_machines_running: minMachines,
    }));

    // Fly Machines API uses POST (not PATCH) to update a machine's configuration.
    // We pass the full merged config so other fields (env, init, guest, …) are preserved.
    const updateRes = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}`, {
      method: "POST",
      body: JSON.stringify({ config: { ...existingConfig, services: updatedServices } }),
    });
    if (!updateRes.ok) {
      const text = await updateRes.text();
      logger.warn(
        { machineId, projectId, autostop, minMachines, body: text },
        "patchMachineAutostop: POST failed",
      );
    } else {
      logger.info({ machineId, projectId, autostop, minMachines }, "Machine autostop patched");
      // Fly may restart a RUNNING machine to apply the new config, causing a brief
      // "not running" window.  Only wait for it to come back if the machine was
      // running before the update.  A hibernated/stopped machine won't start on its
      // own from a config POST, so waiting would just add 30 s of dead time.
      if (wasRunning) {
        const ready = await waitForMachineReady(machineId, 30);
        if (!ready) {
          logger.warn(
            { machineId, projectId },
            "patchMachineAutostop: machine did not return to running within 30 s after config update",
          );
        } else {
          logger.info(
            { machineId, projectId },
            "patchMachineAutostop: machine running again after config update",
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err, machineId, projectId, autostop }, "patchMachineAutostop: error (non-fatal)");
  }
}

/**
 * Start a minimal HTTP health-server on the machine's service port.
 *
 * ENVIRONMENT NOTE: This is an optional belt-and-suspenders measure.
 * The primary autostop-prevention mechanism is patchMachineAutostop("off"),
 * which sets autostop:false persistently in Fly's machine config.  When
 * autostop:false, the machine stays alive regardless of connection count, so
 * this health server is not required for correctness.
 *
 * This server is useful in environments where the Fly app URL
 * (https://<app>.fly.dev) is reachable and the keepalive loop can establish
 * TCP connections.  In sandboxed environments where fly.dev DNS does not
 * resolve, this server runs inside the machine but is unreachable externally,
 * and the keepalive loop silently no-ops.  In those environments autostop:false
 * alone is sufficient.
 *
 * The process is tagged with the sentinel string "fly-health-server" so it can
 * be killed cleanly (pkill -f fly-health-server) before the user's own app
 * server starts on the same port.
 *
 * Uses only POSIX sh constructs (no bash-isms) so it works on Alpine Linux.
 */
export async function startContainerHealthServer(
  machineId: string,
  projectId: number,
): Promise<void> {
  if (!isConfigured()) return;
  const nodeOneLiner = `require('http').createServer(function(q,r){r.writeHead(200);r.end('ok')}).listen(parseInt(process.env.PORT)||${DEFAULT_INTERNAL_PORT})`;
  const cmd = [
    "sh",
    "-c",
    // nohup + redirect + </dev/null detaches the process from this exec session.
    // The sentinel comment "fly-health-server" makes it pkill-able later.
    `nohup node -e "/*fly-health-server*/${nodeOneLiner}" >/dev/null 2>&1 </dev/null & echo health-server-ok`,
  ];

  // Retry loop: after patchMachineAutostop the machine restarts briefly.
  // patchMachineAutostop already waits for the machine to return to "running",
  // but exec may still fail if Fly's exec gRPC path lags behind the state API.
  // Retry up to MAX_ATTEMPTS times with RETRY_DELAY_MS backoff.
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAY_MS = 5_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Ensure machine is running before attempting exec (handles lag between
      // state API and exec availability).
      const ready = await waitForMachineReady(machineId, 15);
      if (!ready) {
        logger.warn(
          { machineId, projectId, attempt },
          "startContainerHealthServer: machine not ready before exec attempt",
        );
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        return;
      }

      const res = await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: cmd, timeout: 10 }),
      });

      if (!res.ok) {
        const t = await res.text();
        const isMachineNotRunning =
          t.includes("machine not running") || t.includes("failed_precondition");
        logger.warn(
          { machineId, projectId, attempt, body: t },
          "startContainerHealthServer: exec failed",
        );
        if (isMachineNotRunning && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        return;
      }

      logger.info({ machineId, projectId, attempt }, "Container health server started");
      return;
    } catch (err) {
      logger.warn(
        { err, machineId, projectId, attempt },
        "startContainerHealthServer: error (non-fatal)",
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}

/**
 * Kill the background health server started by startContainerHealthServer.
 * Call this before starting the user's own app server to avoid port conflicts.
 */
export async function stopContainerHealthServer(
  machineId: string,
  _projectId: number,
): Promise<void> {
  if (!isConfigured()) return;
  try {
    await flyFetch(`/apps/${FLY_APP}/machines/${machineId}/exec`, {
      method: "POST",
      body: JSON.stringify({
        command: ["sh", "-c", "pkill -f fly-health-server; echo health-server-killed"],
        timeout: 5,
      }),
    });
  } catch {
    // Best-effort — if the server is already gone, that's fine.
  }
}

/**
 * Optional environment-dependent keepalive: pings the container's /healthz
 * through Fly's proxy every KEEPALIVE_INTERVAL_MS.
 *
 * ENVIRONMENT NOTE: This is NOT the primary autostop-prevention mechanism.
 * patchMachineAutostop("off") sets autostop:false in the Fly machine config,
 * which is the sole required mechanism.  In sandboxed environments where
 * <app>.fly.dev DNS does not resolve (e.g. the Replit dev environment), every
 * ping fails silently with a DNS error and this loop is a no-op.  That is
 * expected and safe — autostop:false keeps the machine alive regardless.
 *
 * In environments where the Fly app URL is reachable, this provides an extra
 * layer: each TCP connection from the ping resets Fly's service-level idle
 * timer on the exact target machine (fly-force-instance-id header).
 */
const KEEPALIVE_INTERVAL_MS = 5_000; // 5 s — shorter than any observed autostop grace period

export function startContainerKeepalive(containerUrl: string, projectId: number): () => void {
  // Extract the machine ID from the proxy URL path (last path segment).
  // URL format: https://<app>.fly.dev/container/<machineId>
  const machineId = containerUrl.split("/").pop() ?? "";
  let stopped = false;

  const ping = async () => {
    if (stopped) return;
    try {
      await fetch(`${containerUrl}/healthz`, {
        signal: AbortSignal.timeout(4_000),
        headers: machineId ? { "fly-force-instance-id": machineId } : {},
      });
    } catch {
      // Ignore — machine may be momentarily starting; next tick will retry.
    }
  };

  // Fire immediately so the first connection is established before any exec starts.
  void ping();
  const handle = setInterval(() => void ping(), KEEPALIVE_INTERVAL_MS);

  logger.info({ projectId, containerUrl, machineId }, "Container keepalive started");

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    logger.info({ projectId }, "Container keepalive stopped");
  };
}
