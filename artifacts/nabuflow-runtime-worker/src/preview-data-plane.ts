import { getSandbox } from "@cloudflare/sandbox";
import {
  PREVIEW_DATA_PREFIX,
  PREVIEW_GRANT_QUERY_PARAM,
  parseRuntimeIdentityForNamespace,
  verifyPreviewGrant,
  type PreviewGrantClaims,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { ControlAuditRecord, ControlCoordinator } from "./model";
import { NabuflowSandbox } from "./runtime-backend";

const PREVIEW_COOKIE_PREFIX = "__Host-nabuflow_preview_";
const PREVIEW_EMBEDDING_POLICY = "same-site";
const CLOCK_SKEW_SECONDS = 5;
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

interface PreviewSandbox {
  containerFetch(request: Request, port: number): Promise<Response>;
  wsConnect(request: Request, port: number): Promise<Response>;
}

export interface PreviewDataPlaneDependencies {
  coordinator: ControlCoordinator;
  sandbox?: PreviewSandbox;
  nowMs?: number;
  requestId?: string;
}

interface PreviewRoute {
  identity: string;
  appPath: string;
}

class PreviewHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function handlePreviewDataPlaneRequest(
  request: Request,
  env: WorkerBindings,
  dependencies: PreviewDataPlaneDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = matchPreviewRoute(url.pathname);
  if (route === null) return null;

  const requestId = dependencies.requestId ?? crypto.randomUUID();
  const nowMs = dependencies.nowMs ?? Date.now();
  const cookieName = previewCookieName(route.identity);
  const grants = url.searchParams.getAll(PREVIEW_GRANT_QUERY_PARAM);
  const websocketUpgrade = isWebSocketUpgrade(request);

  try {
    if (grants.length > 0) {
      if (request.method !== "GET" || grants.length !== 1) {
        throw new PreviewHttpError(
          400,
          "invalid_preview_grant_request",
          "Preview grants may only be redeemed once with a GET request",
        );
      }
      const claims = await authenticateGrant(grants[0], route.identity, url.origin, env, nowMs);
      const nonce = previewNonce(claims.jti);
      if (!(await dependencies.coordinator.consumeOnce(nonce, claims.exp * 1_000))) {
        await recordPreviewAudit(dependencies.coordinator, requestId, request, claims, {
          status: 409,
          outcome: "preview_grant_replayed",
        });
        throw new PreviewHttpError(
          409,
          "preview_grant_replayed",
          "This preview grant has already been redeemed",
        );
      }
      await recordPreviewAudit(dependencies.coordinator, requestId, request, claims, {
        status: 302,
        outcome: "preview_grant_redeemed",
      });
      url.searchParams.delete(PREVIEW_GRANT_QUERY_PARAM);
      return new Response(null, {
        status: 302,
        headers: {
          "cache-control": "no-store",
          "cross-origin-resource-policy": PREVIEW_EMBEDDING_POLICY,
          location: url.toString(),
          "referrer-policy": "no-referrer",
          "set-cookie": buildSessionCookie(cookieName, grants[0], claims.exp, nowMs),
        },
      });
    }

    const cookieHeader = request.headers.get("cookie");
    const grant = readCookie(cookieHeader, cookieName);
    if (grant === null) {
      throw new PreviewHttpError(
        401,
        "preview_auth_required",
        "A redeemed preview session is required",
      );
    }
    const claims = await authenticateGrant(grant, route.identity, url.origin, env, nowMs);
    if (!(await dependencies.coordinator.isConsumedOnce(previewNonce(claims.jti), nowMs))) {
      throw new PreviewHttpError(
        401,
        "preview_grant_not_redeemed",
        "The preview grant has not been redeemed",
      );
    }

    const runtime = await dependencies.coordinator.getRuntime(route.identity);
    if (runtime === null || runtime.descriptor.status !== "running") {
      throw new PreviewHttpError(
        503,
        "preview_runtime_unavailable",
        "The preview runtime is not running",
      );
    }
    if (
      runtime.manifest.servicePort !== claims.port ||
      runtime.descriptor.servicePort !== claims.port
    ) {
      throw new PreviewHttpError(
        409,
        "preview_port_mismatch",
        "The preview grant does not match the active runtime port",
      );
    }

    const sandbox = dependencies.sandbox ?? runtimeSandbox(env, route.identity);
    if (websocketUpgrade) {
      // Workerd attaches upgrade state to the inbound Request. Cloning it or
      // mutating its headers makes @cloudflare/sandbox wsConnect throw. Grant
      // and redeemed-session authentication has completed above, so preserve
      // the original request byte-for-byte for the upgrade. Accepted trade-off:
      // the tenant WebSocket handshake sees the preview/platform cookies and
      // client forwarding headers; HTTP traffic still receives full hygiene.
      return await sandbox.wsConnect(request, claims.port);
    }

    const headers = new Headers(request.headers);
    sanitizeRequestHeaders(headers, url, cookieName);
    const upstreamUrl = new URL(`${route.appPath}${url.search}`, "https://tenant.preview.invalid");
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      ...(body === null ? {} : ({ duplex: "half" } as RequestInit & { duplex: "half" })),
    });
    return sanitizeUpstreamResponse(await sandbox.containerFetch(upstreamRequest, claims.port));
  } catch (error) {
    if (!(error instanceof PreviewHttpError)) throw error;
    await recordPreviewAudit(dependencies.coordinator, requestId, request, null, {
      status: error.status,
      outcome: error.code,
    });
    return previewErrorResponse(error.status, error.code, error.message, requestId);
  }
}

function matchPreviewRoute(pathname: string): PreviewRoute | null {
  if (!pathname.startsWith(`${PREVIEW_DATA_PREFIX}/`)) return null;
  const remainder = pathname.slice(PREVIEW_DATA_PREFIX.length + 1);
  const slash = remainder.indexOf("/");
  const identity = slash === -1 ? remainder : remainder.slice(0, slash);
  const appPath = slash === -1 ? "/" : remainder.slice(slash) || "/";
  if (!identity) return null;
  return { identity, appPath };
}

async function authenticateGrant(
  grant: string,
  expectedIdentity: string,
  expectedAudience: string,
  env: WorkerBindings,
  nowMs: number,
): Promise<PreviewGrantClaims> {
  const verification = await verifyPreviewGrant(env.CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY, grant);
  if (!verification.ok) {
    throw new PreviewHttpError(
      401,
      verification.reason === "malformed" ? "malformed_preview_grant" : "invalid_preview_grant",
      "The preview grant is invalid",
    );
  }
  const { claims } = verification;
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new PreviewHttpError(401, "preview_grant_expired", "The preview grant has expired");
  }
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new PreviewHttpError(
      401,
      "preview_grant_not_yet_valid",
      "The preview grant is not yet valid",
    );
  }
  if (claims.aud !== expectedAudience || claims.sub !== expectedIdentity) {
    throw new PreviewHttpError(
      401,
      "preview_grant_scope_mismatch",
      "The preview grant does not match this gateway route",
    );
  }
  let identity;
  try {
    identity = await parseRuntimeIdentityForNamespace(
      claims.sub,
      env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    );
  } catch {
    throw new PreviewHttpError(
      401,
      "preview_grant_scope_mismatch",
      "The preview grant runtime identity is invalid",
    );
  }
  if (identity.role !== "preview" || identity.slot !== "primary") {
    throw new PreviewHttpError(
      403,
      "preview_runtime_required",
      "Only scratch preview runtimes may use this data plane",
    );
  }
  return claims;
}

function previewCookieName(identity: string): string {
  return `${PREVIEW_COOKIE_PREFIX}${identity}`;
}

function previewNonce(jti: string): string {
  return `preview-grant:${jti}`;
}

function buildSessionCookie(name: string, grant: string, expiresAtSeconds: number, nowMs: number) {
  const maxAge = Math.max(1, expiresAtSeconds - Math.floor(nowMs / 1_000));
  return `${name}=${grant}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}; Path=/`;
}

function readCookie(cookieHeader: string | null, expectedName: string): string | null {
  if (cookieHeader === null) return null;
  const matches: string[] = [];
  for (const pair of cookieHeader.split(";")) {
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    if (pair.slice(0, equals).trim() === expectedName) matches.push(pair.slice(equals + 1).trim());
  }
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function isPlatformCookie(name: string, previewCookieNameValue: string): boolean {
  const lower = name.toLowerCase();
  return (
    name === previewCookieNameValue ||
    PLATFORM_COOKIE_NAMES.has(lower) ||
    lower.startsWith("__clerk") ||
    lower.startsWith("__host-__clerk") ||
    lower.startsWith("__secure-__clerk") ||
    lower.startsWith("mustaflow_") ||
    lower.startsWith("nabuflow_")
  );
}

function sanitizeCookieHeader(value: string | null, previewCookieNameValue: string): string | null {
  if (value === null) return null;
  const retained = value
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      const equals = pair.indexOf("=");
      return equals > 0 && !isPlatformCookie(pair.slice(0, equals).trim(), previewCookieNameValue);
    });
  return retained.length > 0 ? retained.join("; ") : null;
}

function sanitizeRequestHeaders(
  headers: Headers,
  requestUrl: URL,
  previewCookieNameValue: string,
): void {
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
  const cookies = sanitizeCookieHeader(headers.get("cookie"), previewCookieNameValue);
  if (cookies === null) headers.delete("cookie");
  else headers.set("cookie", cookies);

  const protocol = requestUrl.protocol.slice(0, -1);
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-port", requestUrl.port || (protocol === "https" ? "443" : "80"));
  headers.set("x-forwarded-proto", protocol);
  if (connectingIp) {
    headers.set("x-forwarded-for", connectingIp);
    headers.set(
      "forwarded",
      `for="${connectingIp.replace(/[\\"]+/g, "")}";proto=${protocol};host="${requestUrl.host.replace(/[\\"]+/g, "")}"`,
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
  headers.set("cross-origin-resource-policy", PREVIEW_EMBEDDING_POLICY);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function previewErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return Response.json(
    { ok: false, code, message, requestId },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "cross-origin-resource-policy": PREVIEW_EMBEDDING_POLICY,
        "content-type": "application/json; charset=utf-8",
        ...(status === 401 ? { "www-authenticate": 'Preview realm="nabuflow-staging"' } : {}),
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

async function recordPreviewAudit(
  coordinator: ControlCoordinator,
  requestId: string,
  request: Request,
  claims: PreviewGrantClaims | null,
  result: { status: number; outcome: string },
): Promise<void> {
  let projectId: number | null = null;
  if (claims !== null) {
    const match = /-p([1-9][0-9]*)-preview-primary$/.exec(claims.sub);
    projectId = match ? Number(match[1]) : null;
  }
  await coordinator.recordAudit({
    requestId,
    timestamp: new Date().toISOString(),
    method: request.method,
    endpoint: "preview_data_plane",
    stage: "authentication",
    outcome: result.outcome,
    projectId,
    role: projectId === null ? null : "preview",
    slot: projectId === null ? null : "primary",
    status: result.status,
  } satisfies ControlAuditRecord);
}
