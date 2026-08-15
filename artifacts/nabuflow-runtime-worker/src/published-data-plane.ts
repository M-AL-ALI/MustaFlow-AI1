import { getSandbox } from "@cloudflare/sandbox";
import {
  parseRuntimeIdentityForNamespace,
  publishedHostnameSchema,
  verifyStagingHostOverride,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { ControlCoordinator } from "./model";
import { NabuflowSandbox } from "./runtime-backend";

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
  containerFetch(request: Request, port: number): Promise<Response>;
  wsConnect(request: Request, port: number): Promise<Response>;
}

export interface PublishedDataPlaneDependencies {
  coordinator: ControlCoordinator;
  sandbox?: PublishedSandbox;
  nowMs?: number;
  requestId?: string;
}

class PublishedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
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
      parsedIdentity.slot !== "blue" ||
      route.role !== "production" ||
      route.activeSlot !== "blue"
    ) {
      throw new PublishedHttpError(
        503,
        "published_runtime_unavailable",
        "Published application is temporarily unavailable",
        true,
      );
    }

    const runtime = await dependencies.coordinator.getRuntime(route.sandboxIdentity);
    if (
      runtime === null ||
      runtime.descriptor.status !== "running" ||
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
      );
    }

    const sandbox = dependencies.sandbox ?? runtimeSandbox(env, route.sandboxIdentity);
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
      return await sandbox.wsConnect(request, route.servicePort);
    }

    const headers = new Headers(request.headers);
    sanitizeRequestHeaders(headers, url, hostname);
    const upstreamUrl = new URL(`${url.pathname}${url.search}`, "https://tenant.published.invalid");
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      ...(body === null ? {} : ({ duplex: "half" } as RequestInit & { duplex: "half" })),
    });
    return sanitizeUpstreamResponse(
      await sandbox.containerFetch(upstreamRequest, route.servicePort),
    );
  } catch (error) {
    if (!(error instanceof PublishedHttpError)) throw error;
    return publishedErrorResponse(error, requestId);
  }
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

function runtimeSandbox(env: WorkerBindings, identity: string): NabuflowSandbox {
  return getSandbox(env.NABUFLOW_SANDBOX, identity, {
    keepAlive: true,
    sleepAfter: env.NABUFLOW_RUNTIME_SLEEP_AFTER,
    enableDefaultSession: true,
  }) as NabuflowSandbox;
}
