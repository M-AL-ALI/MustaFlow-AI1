import {
  canonicalJson,
  PUBLISHED_RUNTIME_RECOVERY_MAX_FAILED_TERMINALS,
  parseRuntimeIdentityForNamespace,
  publishedHostnameSchema,
  sha256Hex,
  verifyStagingHostOverride,
  type StartRuntimeRequest,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type {
  ControlCoordinator,
  DurableOperationQueueMessage,
  StoredRuntime,
  StoredRuntimeStartJob,
} from "./model";
import {
  CloudflareSandboxBackend,
  PUBLISHED_RUNTIME_FORWARD_ORIGIN,
  PUBLISHED_RUNTIME_FORWARD_PORT_HEADER,
  PUBLISHED_RUNTIME_FORWARD_TIMEOUT_HEADER,
  readPublishedRuntimeForwardFailure,
  runtimeSandboxStub,
  runtimeSandboxWebSocketConnect,
  type BackendAvailabilityResult,
  type PublishedRuntimeForwardFailure,
  type RuntimeHealthProbeInput,
  type RuntimeHealthProbeResult,
} from "./runtime-backend";

export const PUBLISHED_UPSTREAM_HEADER_TIMEOUT_MS = 10_000;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PLATFORM_COOKIE_NAMES = new Set([
  "__prs",
  "__session",
  "__client_uat",
  "__cf_bm",
  "cf_clearance",
]);
const FORBIDDEN_COOKIE_DOMAINS = ["mustaflow.com", "mustaflow.app"] as const;
const OVERRIDE_HEADERS = {
  hostname: "x-nabuflow-staging-host-override",
  timestamp: "x-nabuflow-staging-timestamp",
  nonce: "x-nabuflow-staging-nonce",
  signature: "x-nabuflow-staging-signature",
} as const;

interface PublishedSandbox {
  fetch(request: Request): Promise<Response>;
  probeRuntimeHealth(input: RuntimeHealthProbeInput): Promise<RuntimeHealthProbeResult>;
  wsConnect(request: Request, port: number): Promise<Response>;
}

export interface PublishedDataPlaneDependencies {
  coordinator: ControlCoordinator;
  sandbox?: PublishedSandbox;
  runtimeStatus?: (
    runtime: StoredRuntime,
  ) => Promise<{ running: boolean; lastError: string | null }>;
  runtimeAvailability?: (runtime: StoredRuntime) => Promise<BackendAvailabilityResult>;
  recoverRuntime?: (runtime: StoredRuntime) => Promise<PublishedRecoveryResult>;
  upstreamHeaderTimeoutMs?: number;
  nowMs?: number;
  requestId?: string;
}

export type PublishedRecoveryResult = "scheduled" | "unavailable" | "exhausted";

interface PublishedTerminalEvidence {
  stage: string;
  cause: string;
  status: number | null;
  errorClass: string | null;
}

class PublishedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly evidence: PublishedTerminalEvidence | null = null,
  ) {
    super(message);
  }
}

export async function handlePublishedDataPlaneRequest(
  request: Request,
  env: WorkerBindings,
  dependencies: PublishedDataPlaneDependencies,
): Promise<Response> {
  const requestId = dependencies.requestId ?? crypto.randomUUID();
  const nowMs = dependencies.nowMs ?? Date.now();
  const url = new URL(request.url);

  try {
    const hostname = await resolvePublishedHostname(request, env, dependencies.coordinator, nowMs);
    const route = await dependencies.coordinator.getRoute(hostname);
    if (route === null) {
      throw new PublishedHttpError(
        404,
        "published_route_not_found",
        "Published application not found",
      );
    }

    const parsedIdentity = await parseRuntimeIdentityForNamespace(
      route.sandboxIdentity,
      env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    ).catch(() => null);
    if (
      parsedIdentity === null ||
      parsedIdentity.projectId !== route.projectId ||
      parsedIdentity.role !== "production" ||
      (parsedIdentity.slot !== "blue" && parsedIdentity.slot !== "green") ||
      route.role !== "production" ||
      route.activeSlot !== parsedIdentity.slot
    ) {
      throw new PublishedHttpError(
        503,
        "published_runtime_unavailable",
        "Published application is temporarily unavailable",
        true,
        publishedTerminalEvidence("route", "identity_mismatch", null, null),
      );
    }

    const runtime = await dependencies.coordinator.getRuntime(route.sandboxIdentity);
    if (
      runtime === null ||
      runtime.descriptor.manifestRevision !== route.manifestRevision ||
      runtime.manifest.revision !== route.manifestRevision ||
      runtime.descriptor.servicePort !== route.servicePort ||
      runtime.manifest.servicePort !== route.servicePort
    ) {
      throw new PublishedHttpError(
        503,
        "published_runtime_unavailable",
        "Published application is temporarily unavailable",
        true,
        publishedTerminalEvidence("route", "runtime_mismatch", null, null),
      );
    }

    if (isWebSocketUpgrade(request)) {
      if (env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== "staging") {
        throw new PublishedHttpError(
          501,
          "published_websocket_unavailable",
          "Published WebSockets are unavailable until the sanitized upgrade boundary is enabled",
        );
      }
      if (request.headers.has(OVERRIDE_HEADERS.hostname)) {
        throw new PublishedHttpError(
          400,
          "staging_host_override_websocket_unsupported",
          "Staging host override is not supported for WebSocket upgrades",
        );
      }
      // PG-2 (staging only): workerd requires the original Request object for
      // wsConnect. Rebuilding it to strip cookies or forwarding headers drops
      // internal upgrade state. Published WebSockets must not receive traffic
      // in production until PG-2 provides a sanitized upgrade boundary.
      await requireRuntimeProcess(runtime, env, dependencies);
      const sandbox = dependencies.sandbox ?? runtimeSandbox(env, route.sandboxIdentity);
      return await sandbox.wsConnect(request, route.servicePort);
    }

    const availability = await observePublishedRuntimeAvailability(runtime, env, dependencies);
    if (availability !== null && !availability.ready) {
      const evidence = publishedTerminalEvidence(
        availability.stage,
        availability.cause,
        availability.status,
        null,
      );
      await recordPublishedAvailabilityFailure(
        dependencies.coordinator,
        runtime.descriptor.identity,
        requestId,
        evidence,
      );
      throw publishedRecoveryError(
        await schedulePublishedRuntimeRecovery(runtime, env, dependencies),
        evidence,
      );
    }
    const sandbox = dependencies.sandbox ?? runtimeSandbox(env, route.sandboxIdentity);

    const headers = new Headers(request.headers);
    sanitizeRequestHeaders(headers, url, hostname);
    headers.set(PUBLISHED_RUNTIME_FORWARD_PORT_HEADER, String(route.servicePort));
    headers.set(
      PUBLISHED_RUNTIME_FORWARD_TIMEOUT_HEADER,
      String(dependencies.upstreamHeaderTimeoutMs ?? PUBLISHED_UPSTREAM_HEADER_TIMEOUT_MS),
    );
    const upstreamUrl = new URL(`${url.pathname}${url.search}`, PUBLISHED_RUNTIME_FORWARD_ORIGIN);
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    let upstreamRequest: Request;
    try {
      upstreamRequest = new Request(upstreamUrl, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        ...(body === null ? {} : ({ duplex: "half" } as RequestInit & { duplex: "half" })),
      });
    } catch (error) {
      const evidence = publishedTerminalEvidence(
        "request",
        "pre_dispatch",
        null,
        safePublishedErrorClass(error),
      );
      await recordPublishedAvailabilityFailure(
        dependencies.coordinator,
        runtime.descriptor.identity,
        requestId,
        evidence,
      );
      throw new PublishedHttpError(
        500,
        "published_upstream_pre_dispatch_failed",
        "Published request could not be prepared",
        false,
        evidence,
      );
    }

    let upstream: Response;
    try {
      upstream = await sandbox.fetch(upstreamRequest);
    } catch (error) {
      await throwPublishedForwardFailure(runtime, env, dependencies, requestId, {
        stage: "request",
        cause: "transport",
        errorClass: safePublishedErrorClass(error),
      });
    }
    const forwardingFailure = readPublishedRuntimeForwardFailure(upstream!);
    if (forwardingFailure !== null) {
      await upstream!.body?.cancel().catch(() => undefined);
      await throwPublishedForwardFailure(runtime, env, dependencies, requestId, forwardingFailure);
    }
    return sanitizeUpstreamResponse(upstream!);
  } catch (error) {
    if (!(error instanceof PublishedHttpError)) throw error;
    return publishedErrorResponse(error, requestId);
  }
}

async function requireRuntimeProcess(
  runtime: StoredRuntime,
  env: WorkerBindings,
  dependencies: PublishedDataPlaneDependencies,
): Promise<void> {
  const runtimeStatus =
    dependencies.runtimeStatus ??
    (dependencies.sandbox === undefined
      ? (candidate: StoredRuntime) => new CloudflareSandboxBackend(env).status(candidate)
      : null);
  if (runtimeStatus === null) return;
  const status = await runtimeStatus(runtime);
  if (status.running) return;
  const recovery = await schedulePublishedRuntimeRecovery(runtime, env, dependencies);
  throw publishedRecoveryError(
    recovery,
    publishedTerminalEvidence(
      "process",
      status.lastError === null ? "process_not_running" : "process_check_failed",
      null,
      null,
    ),
  );
}

async function observePublishedRuntimeAvailability(
  runtime: StoredRuntime,
  env: WorkerBindings,
  dependencies: PublishedDataPlaneDependencies,
): Promise<BackendAvailabilityResult | null> {
  if (dependencies.runtimeAvailability !== undefined) {
    return dependencies.runtimeAvailability(runtime);
  }
  if (dependencies.runtimeStatus !== undefined) {
    const status = await dependencies.runtimeStatus(runtime);
    return {
      ready: status.running,
      stage: "process",
      cause: status.running
        ? "ready"
        : status.lastError === null
          ? "process_not_running"
          : "process_check_failed",
      status: null,
    };
  }
  if (dependencies.sandbox !== undefined) {
    if (runtime.processId === null) {
      return { ready: false, stage: "process", cause: "process_not_running", status: null };
    }
    return dependencies.sandbox.probeRuntimeHealth({
      servicePort: runtime.manifest.servicePort,
      healthPath: runtime.manifest.healthPath,
      timeoutMs: PUBLISHED_UPSTREAM_HEADER_TIMEOUT_MS,
    });
  }
  return new CloudflareSandboxBackend(env).availability(runtime);
}

async function throwPublishedForwardFailure(
  runtime: StoredRuntime,
  env: WorkerBindings,
  dependencies: PublishedDataPlaneDependencies,
  requestId: string,
  failure: PublishedRuntimeForwardFailure,
): Promise<never> {
  const forwardingEvidence = publishedTerminalEvidence(
    failure.stage,
    failure.cause,
    null,
    failure.errorClass,
  );
  await recordPublishedAvailabilityFailure(
    dependencies.coordinator,
    runtime.descriptor.identity,
    requestId,
    forwardingEvidence,
  );

  if (failure.cause === "pre_dispatch") {
    throw new PublishedHttpError(
      500,
      "published_upstream_pre_dispatch_failed",
      "Published request could not be prepared",
      false,
      forwardingEvidence,
    );
  }

  const availability = await observePublishedRuntimeAvailability(runtime, env, dependencies);
  if (availability !== null && !availability.ready) {
    const availabilityEvidence = publishedTerminalEvidence(
      availability.stage,
      availability.cause,
      availability.status,
      null,
    );
    await recordPublishedAvailabilityFailure(
      dependencies.coordinator,
      runtime.descriptor.identity,
      requestId,
      availabilityEvidence,
    );
    throw publishedRecoveryError(
      await schedulePublishedRuntimeRecovery(runtime, env, dependencies),
      availabilityEvidence,
    );
  }

  if (failure.cause === "timeout") {
    throw new PublishedHttpError(
      503,
      "published_upstream_timeout",
      "Published application did not respond in time",
      true,
      forwardingEvidence,
    );
  }
  throw new PublishedHttpError(
    503,
    "published_upstream_transport_unavailable",
    "Published application transport is temporarily unavailable",
    true,
    forwardingEvidence,
  );
}

async function recordPublishedAvailabilityFailure(
  coordinator: ControlCoordinator,
  runtimeIdentity: string,
  requestId: string,
  evidence: PublishedTerminalEvidence,
): Promise<void> {
  try {
    await coordinator.appendSystemLog(
      runtimeIdentity,
      `Published availability failed (requestId=${requestId}, stage=${evidence.stage}, cause=${evidence.cause}${evidence.status === null ? "" : `, status=${evidence.status}`}${evidence.errorClass === null ? "" : `, class=${evidence.errorClass}`}).`,
    );
  } catch {
    // Availability evidence must never mask the typed public terminal or recovery nudge.
  }
}

function publishedTerminalEvidence(
  stage: string,
  cause: string,
  status: number | null,
  errorClass: string | null,
): PublishedTerminalEvidence {
  return { stage, cause, status, errorClass };
}

function safePublishedErrorClass(error: unknown): PublishedRuntimeForwardFailure["errorClass"] {
  if (!(error instanceof Error)) return "unknown";
  return ["AbortError", "Error", "NetworkError", "TimeoutError", "TypeError"].includes(error.name)
    ? (error.name as PublishedRuntimeForwardFailure["errorClass"])
    : "Error";
}

export async function schedulePublishedRuntimeRecovery(
  runtime: StoredRuntime,
  env: WorkerBindings,
  dependencies: PublishedDataPlaneDependencies,
): Promise<PublishedRecoveryResult> {
  if (dependencies.recoverRuntime !== undefined) return dependencies.recoverRuntime(runtime);
  if (runtime.artifactRevision === null || runtime.artifactSha256 === null) return "unavailable";

  const request: StartRuntimeRequest = {
    locator: {
      projectId: runtime.descriptor.projectId,
      role: runtime.descriptor.role,
      slot: runtime.descriptor.slot,
    },
    expectedDeploymentVersion: env.CF_VERSION_METADATA.id,
    artifactRevision: runtime.artifactRevision,
    artifactSha256: runtime.artifactSha256,
  };
  const fingerprint = await sha256Hex(canonicalJson(request));
  const baseIdentity = await sha256Hex(
    canonicalJson({
      version: "published-runtime-recovery-v2",
      runtimeIdentity: runtime.descriptor.identity,
      artifactRevision: runtime.artifactRevision,
      artifactSha256: runtime.artifactSha256,
    }),
  );
  const latest = await dependencies.coordinator.getLatestDurableOperation(
    "runtime-start",
    runtime.descriptor.identity,
    "start",
  );
  let recoveryIdentity: string;
  let generation = 0;
  if (latest?.kind === "runtime-start" && latest.state === "active") {
    const sameArtifact =
      latest.request.artifactRevision === runtime.artifactRevision &&
      latest.request.artifactSha256 === runtime.artifactSha256;
    if (!sameArtifact) return "unavailable";
    await nudgePublishedRuntimeRecovery(latest, env, dependencies);
    return "scheduled";
  }
  if (
    latest?.kind === "runtime-start" &&
    latest.state === "failed" &&
    latest.publishedRecoveryIdentity !== undefined &&
    latest.publishedRecoveryGeneration !== undefined &&
    latest.request.artifactRevision === runtime.artifactRevision &&
    latest.request.artifactSha256 === runtime.artifactSha256
  ) {
    generation = latest.publishedRecoveryGeneration + 1;
    if (generation >= PUBLISHED_RUNTIME_RECOVERY_MAX_FAILED_TERMINALS) return "exhausted";
    recoveryIdentity = latest.publishedRecoveryIdentity;
  } else {
    // A successful recovery starts a new bounded series only if the runtime later
    // becomes unavailable. Chaining to its durable job identity avoids transient clocks.
    recoveryIdentity = await sha256Hex(
      canonicalJson({
        baseIdentity,
        predecessor:
          latest?.kind === "runtime-start" && latest.state === "succeeded"
            ? latest.jobKey
            : "initial",
      }),
    );
  }
  const claim = await dependencies.coordinator.registerDurableOperation({
    key: `published-runtime-recovery:v2:${recoveryIdentity}:generation-${generation}`,
    fingerprint,
    kind: "runtime-start",
    runtimeIdentity: runtime.descriptor.identity,
    subjectKey: "start",
    request,
    publishedRecoveryIdentity: recoveryIdentity,
    publishedRecoveryGeneration: generation,
    expectedDeploymentVersion: env.CF_VERSION_METADATA.id,
    nowMs: dependencies.nowMs ?? Date.now(),
  });
  if (claim.state !== "new" && claim.state !== "pending") return "unavailable";
  const job =
    claim.job ??
    (await dependencies.coordinator.getLatestDurableOperation(
      "runtime-start",
      runtime.descriptor.identity,
      "start",
    ));
  if (job === null || job.kind !== "runtime-start") return "unavailable";

  await nudgePublishedRuntimeRecovery(job, env, dependencies);
  return "scheduled";
}

async function nudgePublishedRuntimeRecovery(
  job: StoredRuntimeStartJob,
  env: WorkerBindings,
  dependencies: PublishedDataPlaneDependencies,
): Promise<void> {
  const nowMs = dependencies.nowMs ?? Date.now();
  await dependencies.coordinator.recordDurableOperationNudge(job.jobKey, nowMs);
  try {
    const message: DurableOperationQueueMessage = {
      schemaVersion: 1,
      jobKey: job.jobKey,
      runtimeIdentity: job.runtimeIdentity,
      subjectKey: job.subjectKey,
      kind: job.kind,
    };
    await env.DURABLE_OPERATION_QUEUE?.send(message);
  } catch {
    // The coordinator watchdog owns redelivery when the immediate nudge encounters weather.
    // eslint-disable-next-line no-console -- metadata-only recovery evidence
    console.error(
      JSON.stringify({
        event: "published.runtime_recovery_queue_nudge_failed",
        kind: job.kind,
        checkpoint: job.checkpoint,
        attempt: job.attempt,
      }),
    );
  }
}

function publishedRecoveryError(
  recovery: PublishedRecoveryResult,
  evidence: PublishedTerminalEvidence | null = null,
): PublishedHttpError {
  if (recovery === "scheduled") {
    return new PublishedHttpError(
      503,
      "published_runtime_recovering",
      "Published application is restarting",
      true,
      evidence,
    );
  }
  if (recovery === "exhausted") {
    return new PublishedHttpError(
      503,
      "published_runtime_recovery_exhausted",
      "Published application recovery reached its retry cap",
      false,
      evidence,
    );
  }
  return new PublishedHttpError(
    503,
    "published_runtime_unavailable",
    "Published application is temporarily unavailable",
    true,
    evidence,
  );
}

async function resolvePublishedHostname(
  request: Request,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
  nowMs: number,
): Promise<string> {
  const url = new URL(request.url);
  const actualHost = publishedHostnameSchema.safeParse(url.hostname);
  if (!actualHost.success) {
    throw new PublishedHttpError(
      404,
      "published_route_not_found",
      "Published application not found",
    );
  }
  const overrideHost = request.headers.get(OVERRIDE_HEADERS.hostname);
  if (overrideHost === null) return actualHost.data;
  if (
    env.NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED !== "true" ||
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== "staging" ||
    env.NABUFLOW_STAGING_WORKER_HOST !== actualHost.data
  ) {
    throw new PublishedHttpError(
      400,
      "staging_host_override_disabled",
      "Staging host override is disabled",
    );
  }
  const timestamp = request.headers.get(OVERRIDE_HEADERS.timestamp);
  const nonce = request.headers.get(OVERRIDE_HEADERS.nonce);
  const signature = request.headers.get(OVERRIDE_HEADERS.signature);
  if (timestamp === null || nonce === null || signature === null) {
    throw new PublishedHttpError(
      401,
      "invalid_staging_host_override",
      "Staging host override signature is invalid",
    );
  }
  const pathAndQuery = `${url.pathname}${url.search}`;
  const verification = await verifyStagingHostOverride(
    env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN,
    {
      method: request.method,
      pathAndQuery,
      timestamp,
      nonce,
      actualHost: actualHost.data,
      overrideHost,
      signature,
    },
    coordinator,
    { nowMs, maxClockSkewMs: 60_000 },
  );
  if (!verification.ok) {
    if (verification.reason === "replay") {
      throw new PublishedHttpError(
        409,
        "staging_host_override_replayed",
        "Staging host override was already used",
      );
    }
    if (verification.reason === "clock-skew") {
      throw new PublishedHttpError(
        401,
        "expired_staging_host_override",
        "Staging host override signature is expired",
      );
    }
    throw new PublishedHttpError(
      401,
      "invalid_staging_host_override",
      "Staging host override signature is invalid",
    );
  }
  return publishedHostnameSchema.parse(overrideHost);
}

function isPlatformCookie(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    PLATFORM_COOKIE_NAMES.has(lower) ||
    lower.startsWith("__clerk") ||
    lower.startsWith("__host-__clerk") ||
    lower.startsWith("__secure-__clerk") ||
    lower.startsWith("mustaflow_") ||
    lower.startsWith("nabuflow_")
  );
}

function sanitizeCookieHeader(value: string | null): string | null {
  if (value === null) return null;
  const retained = value
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      const equals = pair.indexOf("=");
      return equals > 0 && !isPlatformCookie(pair.slice(0, equals).trim());
    });
  return retained.length > 0 ? retained.join("; ") : null;
}

function sanitizeRequestHeaders(headers: Headers, requestUrl: URL, publishedHost: string): void {
  const connectingIp = headers.get("cf-connecting-ip");
  const connectionTokens = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const headerNames: string[] = [];
  headers.forEach((_value, name) => headerNames.push(name));
  for (const name of headerNames) {
    const lower = name.toLowerCase();
    const isHopByHop = HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.includes(lower);
    if (
      lower.startsWith("x-forwarded-") ||
      lower === "forwarded" ||
      lower.startsWith("x-nabuflow-") ||
      lower.startsWith("x-nrf-") ||
      lower === "idempotency-key" ||
      lower.startsWith("cf-") ||
      lower === "cdn-loop" ||
      isHopByHop
    ) {
      headers.delete(name);
    }
  }
  const cookies = sanitizeCookieHeader(headers.get("cookie"));
  if (cookies === null) headers.delete("cookie");
  else headers.set("cookie", cookies);

  const protocol = requestUrl.protocol.slice(0, -1);
  headers.set("x-forwarded-host", publishedHost);
  headers.set("x-forwarded-port", requestUrl.port || (protocol === "https" ? "443" : "80"));
  headers.set("x-forwarded-proto", protocol);
  if (connectingIp) {
    headers.set("x-forwarded-for", connectingIp);
    headers.set(
      "forwarded",
      `for="${connectingIp.replace(/[\\"]+/g, "")}";proto=${protocol};host="${publishedHost.replace(/[\\"]+/g, "")}"`,
    );
  } else {
    headers.delete("x-forwarded-for");
    headers.delete("forwarded");
  }
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function unsafeCookieDomain(setCookie: string): boolean {
  const domain = /(?:^|;)\s*domain\s*=\s*([^;]+)/i
    .exec(setCookie)?.[1]
    ?.trim()
    .replace(/^"|"$/g, "")
    .replace(/^\./, "")
    .toLowerCase();
  return (
    domain !== undefined &&
    FORBIDDEN_COOKIE_DOMAINS.some(
      (forbidden) => domain === forbidden || domain.endsWith(`.${forbidden}`),
    )
  );
}

function sanitizeUpstreamResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  const connectionTokens = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) headers.delete(name);
  const responseHeaderNames: string[] = [];
  headers.forEach((_value, name) => responseHeaderNames.push(name));
  for (const name of responseHeaderNames) {
    if (name.toLowerCase().startsWith("x-nabuflow-internal-")) headers.delete(name);
  }

  const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const setCookies = getSetCookie
    ? getSetCookie.call(upstream.headers)
    : upstream.headers.get("set-cookie")
      ? [upstream.headers.get("set-cookie")!]
      : [];
  headers.delete("set-cookie");
  for (const setCookie of setCookies) {
    if (!unsafeCookieDomain(setCookie)) headers.append("set-cookie", setCookie);
  }
  headers.set("cache-control", "private, no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function publishedErrorResponse(error: PublishedHttpError, requestId: string): Response {
  return Response.json(
    {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
      ...(error.evidence === null ? {} : { evidence: error.evidence }),
    },
    {
      status: error.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        ...(error.retryable ? { "retry-after": "1" } : {}),
      },
    },
  );
}

function runtimeSandbox(env: WorkerBindings, identity: string): PublishedSandbox {
  const sandbox = runtimeSandboxStub(env, identity);
  return {
    fetch: (request) => sandbox.fetch(request),
    probeRuntimeHealth: (input) => sandbox.probeRuntimeHealth(input),
    wsConnect: (request, port) => runtimeSandboxWebSocketConnect(sandbox, request, port),
  };
}
