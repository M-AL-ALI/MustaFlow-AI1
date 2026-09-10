import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

export const PREVIEW_CAPTURE_HEADER = "x-nabuflow-preview-capture";
export const PREVIEW_CAPTURE_FORWARD_ORIGIN = "https://preview-capture-forward.nabuflow.internal";
export const PREVIEW_CAPTURE_PORT_HEADER = "x-nabuflow-preview-capture-port";
export const PREVIEW_CAPTURE_TTL_MS = 40_000;
export const PREVIEW_CAPTURE_PROVIDER_TIMEOUT_MS = 25_000;
export const PREVIEW_CAPTURE_FETCH_TIMEOUT_MS = 5_000;
export const PREVIEW_CAPTURE_MAX_PNG_BYTES = 4 * 1024 * 1024;
export const PREVIEW_CAPTURE_MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const CREDENTIAL_CONTEXT = "nabuflow.preview-capture/v1\n";

export class PreviewCaptureError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PreviewCaptureError";
  }
}

export interface PreviewCaptureInput {
  runtimeIdentity: string;
  manifestRevision: string;
  sealedArtifactSha256: string;
  route: string;
  viewport: { width: number; height: number };
}

export interface PreviewCaptureClaims extends Omit<PreviewCaptureInput, "viewport"> {
  purpose: "nabuflow-preview-capture";
  namespace: string;
  projectId: number;
  origin: string;
  port: number;
  witnessSha256: string;
  jti: string;
  iat: number;
  exp: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function validCapturePort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65_535 && port !== 3000;
}

/** Deliberately excludes encoded paths, selectors and general-purpose query forwarding. */
export function validateCaptureRoute(route: string): string {
  if (
    typeof route !== "string" ||
    route.length > 2048 ||
    !/^\/[A-Za-z0-9_./~@+-]*(?:\?[A-Za-z0-9_.~=&-]*)?$/u.test(route) ||
    route.startsWith("//") ||
    route.split("?")[0].includes("//") ||
    route
      .split("?")[0]
      .split("/")
      .some((part) => part === "." || part === "..") ||
    /^\/(?:_nabuflow|control|api|projects|runtimes|_platform|__clerk|sign-in|sign-up|\.well-known)(?:\/|$)/iu.test(
      route.split("?")[0],
    )
  ) {
    throw new PreviewCaptureError(
      400,
      "preview_capture_route_unsupported",
      "Unsupported capture route",
    );
  }
  const url = new URL(route, "https://capture.invalid");
  const keys = new Set(["v", "t", "ver", "version", "import", "raw", "inline", "url"]);
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!keys.has(key) || seen.has(key) || !/^[A-Za-z0-9_.~-]*$/u.test(value)) {
      throw new PreviewCaptureError(
        400,
        "preview_capture_route_unsupported",
        "Unsupported capture query",
      );
    }
    seen.add(key);
  }
  return route;
}

export function captureOrigin(url: URL): string {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^[A-Za-z0-9.-]+$/u.test(url.hostname)
  ) {
    throw new PreviewCaptureError(
      400,
      "preview_capture_origin_invalid",
      "Capture requires an HTTPS gateway origin",
    );
  }
  return url.origin;
}

export function parsePreviewCaptureInput(value: unknown): PreviewCaptureInput {
  if (
    !record(value) ||
    !exactKeys(value, [
      "runtimeIdentity",
      "manifestRevision",
      "sealedArtifactSha256",
      "route",
      "viewport",
    ]) ||
    !shortString(value.runtimeIdentity) ||
    !shortString(value.manifestRevision) ||
    typeof value.sealedArtifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sealedArtifactSha256) ||
    typeof value.route !== "string" ||
    !record(value.viewport) ||
    !exactKeys(value.viewport, ["width", "height"]) ||
    typeof value.viewport.width !== "number" ||
    !Number.isSafeInteger(value.viewport.width) ||
    value.viewport.width < 1 ||
    value.viewport.width > 1280 ||
    typeof value.viewport.height !== "number" ||
    !Number.isSafeInteger(value.viewport.height) ||
    value.viewport.height < 1 ||
    value.viewport.height > 900
  ) {
    throw new PreviewCaptureError(
      400,
      "preview_capture_invalid_request",
      "Invalid capture selectors or viewport",
    );
  }
  validateCaptureRoute(value.route);
  return {
    runtimeIdentity: value.runtimeIdentity,
    manifestRevision: value.manifestRevision,
    sealedArtifactSha256: value.sealedArtifactSha256,
    route: value.route,
    viewport: { width: value.viewport.width, height: value.viewport.height },
  };
}

function credentialMac(secret: string, payload: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new PreviewCaptureError(
      503,
      "preview_capture_configuration_unavailable",
      "Capture credentials are unavailable",
    );
  }
  return createHmac("sha256", secret).update(CREDENTIAL_CONTEXT).update(payload).digest();
}

export function signCaptureCredential(secret: string, claims: PreviewCaptureClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + credentialMac(secret, payload).toString("base64url");
}

export function verifyCaptureCredential(
  secret: string,
  token: string,
  origin: string,
  namespace: string,
  nowMs: number,
): PreviewCaptureClaims {
  const invalid = () =>
    new PreviewCaptureError(
      401,
      "preview_capture_credential_invalid",
      "Capture credential is invalid or expired",
    );
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) throw invalid();
  const [payload, signature] = token.split(".");
  const signatureBytes = Buffer.from(signature, "base64url");
  const expected = credentialMac(secret, payload);
  if (signatureBytes.length !== expected.length || !timingSafeEqual(signatureBytes, expected))
    throw invalid();
  let claims: unknown;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (
      bytes.toString("base64url") !== payload ||
      signatureBytes.toString("base64url") !== signature
    )
      throw invalid();
    claims = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !record(claims) ||
    !exactKeys(claims, [
      "runtimeIdentity",
      "manifestRevision",
      "sealedArtifactSha256",
      "route",
      "purpose",
      "namespace",
      "projectId",
      "origin",
      "port",
      "witnessSha256",
      "jti",
      "iat",
      "exp",
    ]) ||
    claims.purpose !== "nabuflow-preview-capture" ||
    claims.origin !== origin ||
    claims.namespace !== namespace ||
    !shortString(claims.runtimeIdentity) ||
    !shortString(claims.manifestRevision) ||
    typeof claims.sealedArtifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(claims.sealedArtifactSha256) ||
    typeof claims.witnessSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(claims.witnessSha256) ||
    typeof claims.projectId !== "number" ||
    !Number.isSafeInteger(claims.projectId) ||
    claims.projectId < 1 ||
    typeof claims.port !== "number" ||
    !validCapturePort(claims.port) ||
    typeof claims.jti !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(claims.jti) ||
    typeof claims.iat !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > nowMs ||
    claims.exp <= nowMs ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > PREVIEW_CAPTURE_TTL_MS ||
    typeof claims.route !== "string"
  )
    throw invalid();
  try {
    validateCaptureRoute(claims.route);
  } catch {
    throw invalid();
  }
  return claims as unknown as PreviewCaptureClaims;
}

export function captureMarker(
  claims: PreviewCaptureClaims,
  kind: "document" | "failed" | "closed",
): string {
  return "preview-capture:v1:" + claims.jti + ":" + kind;
}

/** Allowlist, not a denylist: no cookies, auth, control, forwarding or platform headers survive. */
export function captureUpstreamHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const name of ["accept", "accept-language"]) {
    const value = headers.get(name);
    if (value !== null) result.set(name, value);
  }
  result.set("accept-encoding", "identity");
  return result;
}

export function assertCaptureRead(request: Request): void {
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    request.headers.has("upgrade") ||
    /(?:^|,)\s*upgrade\s*(?:,|$)/iu.test(request.headers.get("connection") ?? "") ||
    (request.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream")
  ) {
    throw new PreviewCaptureError(
      405,
      "preview_capture_request_blocked",
      "Capture only supports ordinary GET and HEAD requests",
    );
  }
  const destination = request.headers.get("sec-fetch-dest");
  if (
    destination &&
    !["document", "empty", "script", "style", "image", "font"].includes(destination)
  ) {
    throw new PreviewCaptureError(
      403,
      "preview_capture_request_blocked",
      "Unsupported capture resource type",
    );
  }
}

export async function captureDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PreviewCaptureError(
                504,
                "preview_capture_timeout",
                "Capture exceeded its time limit",
                true,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readCaptureBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    return await captureDeadline(
      (async () => {
        if (Number(response.headers.get("content-length") ?? 0) > limit) {
          throw new PreviewCaptureError(
            502,
            "preview_capture_size_exceeded",
            "Capture response exceeds its byte limit",
          );
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit || chunks.length >= 8192) {
            throw new PreviewCaptureError(
              502,
              "preview_capture_size_exceeded",
              "Capture response exceeds its byte limit",
            );
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      })(),
      PREVIEW_CAPTURE_FETCH_TIMEOUT_MS,
    );
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
