import { getAuthToken, requireAuthToken, TokenUnavailableError } from "./auth-client";

import type {
  AnalysisResponse,
  BillingSubscription,
  ChatRequest,
  ChatResponse,
  DatasetAnalysisResponse,
  FileFormat,
  GeneratedFile,
  HelpArticle,
  OraAssetsResponse,
  OraAssetVersionsResponse,
  RestoreAssetVersionResponse,
  OraConversationDetail,
  OraConversationSummary,
  SupportConversationSummary,
  MemoryUsage,
  OraMemory,
  OraMemoryUsed,
  OraAccountConsistency,
  OraMessage,
  OraProfile,
  OraProjectSummary,
  OraSession,
  OraUsage,
  OraVideo,
  OraxApproval,
  OraxApprovalDecision,
  OraxApprovalWithArtifact,
  OraxArtifact,
  OraxCapabilities,
  OraxComposerMetadata,
  OraxDraftPatchResult,
  OraxGithubConnectResult,
  OraxReadFilesResult,
  OraxHostSummary,
  OraxPairingCode,
  OraxRepository,
  OraxScan,
  OraxTask,
  OraxTaskApproval,
  OraxTaskKind,
  OraxTaskMessage,
  OraxTaskRunnerResult,
  PaymentMethodInfo,
  RedeemPairingPayload,
  RealtimeDiagnostics,
  RealtimeHeartbeatResult,
  RealtimeSessionContext,
  RealtimeSessionResult,
  StreamDonePayload,
  SupportAttachment,
  SupportMessage,
  SupportTicketDetail,
  SupportTicketSummary,
  UploadResponse,
  UserPreferences,
} from "./types";

/**
 * Base URL for the existing production API. On device there is no browser
 * cookie jar, so every call attaches a fresh Clerk bearer token via
 * getAuthToken() (registered in (home)/_layout.tsx). Pre-auth Ora endpoints
 * (`public-ai/*`) work even when the token is null.
 */
export const DOMAIN = process.env.EXPO_PUBLIC_DOMAIN || "www.mustaflow.com";
export const API_BASE = `https://${DOMAIN}`;

export class ApiRequestError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Raised when a request fails before any HTTP response arrives — React Native
 * throws a TypeError ("Network request failed") when the device is offline or
 * DNS fails. Callers can surface `message` directly to the user.
 */
export class NetworkError extends Error {
  constructor(message = "You appear to be offline. Check your connection and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * The device's IANA timezone (e.g. "America/New_York"). Wrapped in try/catch
 * because Hermes' Intl can throw or be absent on some builds. Sent with every
 * Ora chat/realtime request so the backend renders the user's local date/time
 * in the authoritative date/time block. Returns undefined when unavailable —
 * the field is optional server-side and simply omitted from the payload.
 */
export function clientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function authHeaders(extra?: Record<string, string>): Promise<Headers> {
  const headers = new Headers(extra);
  const token = await getAuthToken();
  if (token && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

/**
 * Like authHeaders, but uses requireAuthToken() so a signed-in user with a
 * temporarily unavailable Clerk token fails closed (throws TokenUnavailableError)
 * instead of silently downgrading to anonymous mode.
 */
async function authHeadersRequired(extra?: Record<string, string>): Promise<Headers> {
  const headers = new Headers(extra);
  const token = await requireAuthToken();
  if (token && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function url(path: string): string {
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

/**
 * fetch() that converts a pre-response network failure into a typed, friendly
 * NetworkError. HTTP errors still resolve to a normal Response so callers can
 * handle them via parseError(). Streaming uses its own fallback and does not
 * go through here.
 */
async function fetchOrThrow(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof NetworkError) throw err;
    // Preserve the original platform-level message (e.g. "Network request failed",
    // "SSL certificate issue") so callers and diagnostics can surface it.
    const detail = err instanceof Error ? err.message : String(err);
    throw new NetworkError(`You appear to be offline or the server is unreachable. (${detail})`);
  }
}

async function parseError(res: Response): Promise<never> {
  let body: unknown = null;
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
        const b = body as Record<string, unknown>;
        message =
          (typeof b.detail === "string" && b.detail) ||
          (typeof b.message === "string" && b.message) ||
          (typeof b.error === "string" && b.error) ||
          message;
      } catch {
        body = text;
        message = text.slice(0, 200);
      }
    }
  } catch {
    /* ignore */
  }
  throw new ApiRequestError(res.status, message, body);
}

/**
 * Returns true for routes that MUST NOT silently fall through to anonymous
 * mode when the user is signed in. Matched paths use authHeadersRequired()
 * which throws TokenUnavailableError (signed-in + no token) instead of
 * proceeding without a bearer.
 */
function pathRequiresAuth(path: string): boolean {
  return (
    path.startsWith("/api/ora/") ||
    path === "/api/me" ||
    path.startsWith("/api/me/") ||
    path.startsWith("/api/orax/") ||
    path.startsWith("/api/billing/subscription") ||
    path.startsWith("/api/help/support/") ||
    path === "/api/public-ai/session" ||
    path === "/api/public-ai/chat" ||
    path === "/api/public-ai/usage" ||
    path.startsWith("/api/public-ai/realtime/session") ||
    path === "/api/public-ai/realtime/client-diag" ||
    // File create/read/analysis routes: a signed-in user must attach a bearer so
    // the request is metered + persisted under their account, never silently as
    // anonymous. requireAuthToken() still returns null for truly signed-out
    // users, so anonymous uploads/exports keep working.
    path === "/api/public-ai/upload" ||
    path === "/api/public-ai/file-analysis" ||
    path === "/api/public-ai/dataset-analysis" ||
    path === "/api/public-ai/image-analysis" ||
    path === "/api/public-ai/export-file" ||
    path === "/api/public-ai/generate-file"
  );
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const buildHeaders = pathRequiresAuth(path) ? authHeadersRequired : authHeaders;
  const headers = await buildHeaders(
    init.body ? { "Content-Type": "application/json" } : undefined,
  );
  const res = await fetchOrThrow(url(path), {
    ...init,
    headers: mergeHeaders(headers, init.headers),
    credentials: "include",
  });
  if (!res.ok) await parseError(res);
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

function mergeHeaders(base: Headers, extra?: HeadersInit): Headers {
  if (!extra) return base;
  new Headers(extra).forEach((v, k) => base.set(k, v));
  return base;
}

// ---------------------------------------------------------------------------
// Ora session + chat (pre-auth; token attached when available)
// ---------------------------------------------------------------------------

export function getOraSession(): Promise<OraSession> {
  return jsonRequest<OraSession>("/api/public-ai/session", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// ─── Silent expired-session recovery ─────────────────────────────────────────
//
// Ora sessions are 30-minute cookies that the OS cookie jar deletes on expiry.
// The app creates one when the chat screen mounts, so a device left idle or
// backgrounded past the TTL sends its next request with NO session cookie and
// the server 401s with "No active session. Please start a session first."
// (or "Session expired. Please start a new session." for a stale-but-present
// cookie). ChatGPT-like behavior: never surface that raw error — mint a fresh
// session and transparently retry the EXACT same request once. The retry
// closure re-sends the identical body, so every field (message, history, mode,
// language/timeZone, documentRefs, forceSearch, oraProjectId, file refs, and
// any generation/edit context) is preserved automatically.

/** Friendly copy shown only when automatic recovery itself failed. */
export const ORA_SESSION_RETRY_FAILED_MESSAGE =
  "Your session refreshed, but the message could not be sent. Please try again.";

/**
 * True when `err` is the server rejecting a request for a missing/expired Ora
 * session (401/403 with the known session phrasing) — the only failure class
 * that silent session recovery may retry.
 */
export function isOraSessionExpiredError(err: unknown): err is ApiRequestError {
  return (
    err instanceof ApiRequestError &&
    (err.status === 401 || err.status === 403) &&
    /no active session|session (has )?expired|start a (new )?session/i.test(err.message)
  );
}

/**
 * Maps an error from an Ora send path to the message the chat UI may render.
 * Session-expiry phrasing must never reach the user — by the time an error
 * escapes withOraSessionRecovery() it has already been rewritten, but this
 * guard also covers any unwrapped path (e.g. future call sites).
 */
export function friendlyOraSendErrorMessage(err: unknown, fallback: string): string {
  if (isOraSessionExpiredError(err)) return ORA_SESSION_RETRY_FAILED_MESSAGE;
  return err instanceof Error ? err.message : fallback;
}

let _onOraSessionRecovered: ((session: OraSession) => void) | null = null;

/**
 * index.tsx registers a callback so a silently recovered session also updates
 * the on-screen session state (tier accent, message counters). Pass null to
 * unregister.
 */
export function setOnOraSessionRecovered(cb: ((session: OraSession) => void) | null): void {
  _onOraSessionRecovered = cb;
}

/**
 * Runs `request`; if it fails because the Ora session is missing/expired,
 * creates a fresh session and retries the same request exactly once.
 *
 * Failure handling:
 * - Non-session errors (quota CTAs, retryable search 503s, validation) pass
 *   through untouched, first time and on retry.
 * - TokenUnavailableError / NetworkError from the session mint keep their own
 *   dedicated UX (re-sync banner, offline copy) and are rethrown as-is.
 * - Any other recovery failure — session mint failed, or the retry hit the
 *   session wall again — surfaces ORA_SESSION_RETRY_FAILED_MESSAGE instead of
 *   the raw server error.
 */
async function withOraSessionRecovery<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (!isOraSessionExpiredError(err)) throw err;
    try {
      const fresh = await getOraSession();
      _onOraSessionRecovered?.(fresh);
    } catch (mintErr) {
      if (mintErr instanceof TokenUnavailableError || mintErr instanceof NetworkError) {
        throw mintErr;
      }
      throw new ApiRequestError(err.status, ORA_SESSION_RETRY_FAILED_MESSAGE, err.body);
    }
    try {
      return await request();
    } catch (retryErr) {
      if (isOraSessionExpiredError(retryErr)) {
        throw new ApiRequestError(retryErr.status, ORA_SESSION_RETRY_FAILED_MESSAGE, retryErr.body);
      }
      throw retryErr;
    }
  }
}

export function getOraUsage(): Promise<OraUsage> {
  return jsonRequest<OraUsage>("/api/public-ai/usage");
}

/**
 * Mint a short-lived ephemeral OpenAI Realtime client secret for a TRUE
 * realtime "Talk to Ora" voice session over WebRTC. The real OPENAI_API_KEY
 * never reaches the device — only the single-use `ek_...` token is returned.
 * All Ora rules (tier, spend cap, kill switch, language, project/conversation
 * context, memory/profile, Builder isolation) are enforced server-side.
 */
export function createRealtimeSession(ctx: RealtimeSessionContext): Promise<RealtimeSessionResult> {
  return jsonRequest<RealtimeSessionResult>("/api/public-ai/realtime/session", {
    method: "POST",
    body: JSON.stringify({
      language: ctx.language,
      languageHint: ctx.languageHint,
      timeZone: ctx.timeZone ?? clientTimeZone(),
      temporary: ctx.temporary,
      referenceSavedMemories: ctx.referenceSavedMemories,
      oraProjectId: ctx.oraProjectId ?? null,
      conversationId: ctx.conversationId ?? null,
      message: ctx.message,
      focusMode: ctx.focusMode,
      voicePreset: ctx.voicePreset,
    }),
  });
}

/**
 * Beat the live-voice budget: charge the elapsed seconds for this session to the
 * per-plan minute window and re-sync the remaining time. Reports ONLY the session
 * id + client-measured elapsed seconds — never audio or transcript text. The
 * server clock stays authoritative; a 503 means metering is unavailable
 * (fail-closed) and a 404/`ended:true`/remaining<=0 means the budget is spent.
 */
export function heartbeatRealtimeSession(
  realtimeSessionId: string,
  durationSeconds: number,
): Promise<RealtimeHeartbeatResult> {
  return jsonRequest<RealtimeHeartbeatResult>("/api/public-ai/realtime/heartbeat", {
    method: "POST",
    body: JSON.stringify({ realtimeSessionId, durationSeconds }),
  });
}

/**
 * Finalize the live-voice session so its minutes are charged promptly instead of
 * waiting for the server's stale-session expiry. Idempotent and best-effort:
 * reports only the session id + elapsed seconds (never audio/transcript).
 */
export function endRealtimeSession(
  realtimeSessionId: string,
  durationSeconds?: number,
): Promise<void> {
  return jsonRequest<void>("/api/public-ai/realtime/end", {
    method: "POST",
    body: JSON.stringify({ realtimeSessionId, durationSeconds }),
  });
}

/**
 * Report a single privacy-safe live-voice lifecycle SIGNAL (connection drop,
 * reconnect success, or legacy fallback) so support can see when a "Talk to Ora"
 * session got stuck or gave up — previously invisible server-side. Only a bounded
 * reason + counts are sent; never audio or transcript. Best-effort and non-charging.
 */
export function reportRealtimeClientDiag(payload: {
  reason: "connection_drop" | "reconnect_succeeded" | "legacy_fallback";
  realtimeSessionId?: string;
  drops?: number;
  networkQuality?: "good" | "degraded" | "reconnecting" | "legacy";
}): Promise<void> {
  return jsonRequest<void>("/api/public-ai/realtime/client-diag", {
    method: "POST",
    body: JSON.stringify({ surface: "mobile", ...payload }),
  });
}

/**
 * Non-charging realtime diagnostics for the Settings card: server enable/config
 * state, kill switch, the default product voice (preset + label), the available
 * product voices, resolved tier, the per-tier max session length, and the
 * per-plan voice budget (used/remaining/limit seconds + reset time). The
 * underlying model and raw provider voice id are never returned. Does NOT mint a
 * token or consume any Ora quota.
 */
export function getRealtimeDiagnostics(): Promise<RealtimeDiagnostics> {
  return jsonRequest<RealtimeDiagnostics>("/api/public-ai/realtime/diagnostics");
}

/**
 * Privacy-safe account-consistency diagnostics for the Settings "Account sync"
 * rows. Confirms this device resolves to the SAME server-side identity, plan,
 * and per-user counts as the website for the same Clerk user. Returns only a
 * sha256 fingerprint + last-4 of the id (never the raw id), never message or
 * memory content, and no payment details. Protected route (requires a token).
 */
export function getAccountConsistency(): Promise<OraAccountConsistency> {
  return jsonRequest<OraAccountConsistency>("/api/ora/account-consistency");
}

export interface DeleteAccountResult {
  ok?: boolean;
  deleted?: boolean;
  credentialsDeleted?: boolean;
  note?: string;
}

/**
 * Permanently delete the signed-in user's account and all associated data.
 * Calls DELETE /api/me (GDPR erasure). Requires a bearer token — the exact
 * "/api/me" path (no trailing slash) is registered in pathRequiresAuth().
 */
export function deleteAccount(): Promise<DeleteAccountResult> {
  return jsonRequest<DeleteAccountResult>("/api/me", { method: "DELETE" });
}

export interface ExportFileRequest {
  format: FileFormat;
  content: string;
  title?: string;
  filename?: string;
}

/**
 * Server-side real Office/PDF export. Sends Markdown the client already has and
 * receives a real .docx/.xlsx/.pptx/.pdf (base64) built by the same
 * deterministic builders the website uses. No Ora quota is consumed.
 */
export async function exportFile(req: ExportFileRequest): Promise<GeneratedFile> {
  const res = await withOraSessionRecovery(() =>
    jsonRequest<{ fileName: string; fileData: string; mimeType: string }>(
      "/api/public-ai/export-file",
      { method: "POST", body: JSON.stringify(req) },
    ),
  );
  return { ...res, format: req.format };
}

export function sendChat(req: ChatRequest): Promise<ChatResponse> {
  return withOraSessionRecovery(() =>
    jsonRequest<ChatResponse>("/api/public-ai/chat", {
      method: "POST",
      body: JSON.stringify(req),
    }),
  );
}

export interface GenerateFileRequest {
  /** The user's current-turn request describing the file to create. */
  message: string;
  /** Recent conversation history for context (server caps at 20). */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  format: FileFormat;
  language?: string;
  /**
   * UUID refs of documents/datasets uploaded earlier this conversation. When
   * present the server re-hydrates their real content so creation transforms
   * actual data instead of fabricating it. Server caps at 5.
   */
  documentRefs?: string[];
}

/**
 * Ask Ora to author a brand-new file (csv/xlsx/docx/pdf/pptx) from a prompt.
 * Mirrors the website "Create file" flow. Returns the same shape as a chat
 * reply: a short `reply` plus the generated file's bytes and, for signed-in
 * users, a durable `assetId` so the download card survives a reload. Draws on
 * the rolling-window message quota (server-enforced).
 */
export function generateFile(req: GenerateFileRequest): Promise<ChatResponse> {
  return withOraSessionRecovery(() =>
    jsonRequest<ChatResponse>("/api/public-ai/generate-file", {
      method: "POST",
      body: JSON.stringify({
        message: req.message,
        messages: req.messages,
        format: req.format,
        ...(req.language ? { language: req.language } : {}),
        documentRefs: req.documentRefs ?? [],
      }),
    }),
  );
}

// ─── Stream diagnostics ──────────────────────────────────────────────────────

/**
 * Captures every observable signal from the last streamChatNative() call.
 * Written to a module-level record so Settings can display it on-demand as a
 * screenshot-able diagnostic for TestFlight QA. Read via getLastStreamDiagnostics().
 */
export interface StreamChatDiagnostics {
  /** True if `typeof ReadableStream !== "undefined"` at call time (informational only). */
  readableStreamAvailable: boolean;
  /** True if the EXPO_PUBLIC_ORA_STREAMING_ENABLED="false" kill switch fired. */
  killSwitchActive: boolean;
  /** Outcome of authHeadersRequired(). */
  authResult: "ok" | "threw" | "not_attempted";
  /** ms spent obtaining auth headers, or null if not attempted. */
  authMs: number | null;
  /** True when an XHR request was initiated (false if function returned early). */
  xhrUsed: boolean;
  /** Full endpoint URL that was requested, or null if no request was made. */
  endpointUrl: string | null;
  /** HTTP status code, or null if the request failed before a response. */
  httpStatus: number | null;
  /** Content-Type header from the server response, or null. */
  contentType: string | null;
  /** ms from call start to XHR readyState=2 (headers received), or null. */
  headersMs: number | null;
  /** ms from call start to first SSE `token` event, or null. */
  firstTokenMs: number | null;
  /** Number of SSE `token` events received. */
  tokenCount: number;
  /** True if a `done` SSE event was received. */
  doneArrived: boolean;
  /** What streamChatNative() returned. */
  returnValue:
    | "null_killswitch"
    | "null_auth_threw"
    | "null_request_failed"
    | "null_bad_response"
    | "null_no_done"
    | "ok"
    | "fail_pre_token"
    | "fail_post_token"
    | "exception";
  /** True when index.tsx fell back to sendChat() after a null or fail_pre result. */
  fallbackCalled: boolean;
  /** Unix ms when this record was captured. */
  capturedAt: number;
  // ── Server-reported timing (populated from the SSE done payload) ──────────
  /** Server-measured TTFT in ms (t0 to first token). */
  serverTtftMs?: number | null;
  /** Server-measured total request time in ms (t0 to stream end). */
  serverTotalMs?: number | null;
  /** Provider that served the response (e.g. "gemini", "openai"). */
  serverProvider?: string | null;
  /** Route tier chosen by the server (fast / premium / deep). */
  serverRouteTier?: string | null;
  /** True when the server took the fast-lane path (classifier skipped). */
  serverFastLane?: boolean | null;
}

let _lastStreamDiag: StreamChatDiagnostics | null = null;

/** Returns diagnostics from the most recent streamChatNative() call, or null. */
export function getLastStreamDiagnostics(): StreamChatDiagnostics | null {
  return _lastStreamDiag;
}

/**
 * Called by index.tsx immediately before the sendChat() fallback so Settings
 * can show that the caller did NOT stream (streamChatNative returned null or
 * fail_pre_token).
 */
export function notifyStreamFallbackCalled(): void {
  if (_lastStreamDiag) {
    _lastStreamDiag = { ..._lastStreamDiag, fallbackCalled: true };
  }
}

// ─── XHR-based SSE transport ─────────────────────────────────────────────────

/**
 * Posts `bodyStr` to `endpoint` and calls `onRawChunk` progressively as the
 * server pushes SSE data. React Native's XMLHttpRequest.responseText grows
 * incrementally on each readyState=3 callback, so callers receive new bytes as
 * they arrive — instead of the entire body at once like Hermes fetch/ReadableStream.
 * This is the same mechanism used by react-native-sse and similar libraries.
 */
function sseViaXHR(
  endpoint: string,
  headers: Headers,
  bodyStr: string,
  signal: AbortSignal | undefined,
  onHeadersReceived: (ms: number) => void,
  onRawChunk: (chunk: string) => void,
): Promise<{ ok: boolean; status: number; contentType: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint, true);
    headers.forEach((v, k) => xhr.setRequestHeader(k, v));

    const start = Date.now();
    let offset = 0;
    let settled = false;
    let headersFired = false;

    function settle(ok: boolean, status: number, ct: string) {
      if (settled) return;
      settled = true;
      resolve({ ok, status, contentType: ct });
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState === 2 && !headersFired) {
        headersFired = true;
        onHeadersReceived(Date.now() - start);
      }
      if (xhr.readyState >= 3) {
        const rt: string = (xhr.responseText as string | null) ?? "";
        if (rt.length > offset) {
          onRawChunk(rt.slice(offset));
          offset = rt.length;
        }
      }
      if (xhr.readyState === 4) {
        settle(
          xhr.status >= 200 && xhr.status < 300,
          xhr.status,
          xhr.getResponseHeader("content-type") ?? "",
        );
      }
    };

    xhr.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error("XHR network error"));
      }
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        xhr.abort();
        if (!settled) {
          settled = true;
          reject(new Error("AbortError"));
        }
      });
    }

    xhr.send(bodyStr);
  });
}

// ─── Stream result type ──────────────────────────────────────────────────────

/**
 * Result of a native streaming attempt. Discriminated union:
 *
 * null
 *   Streaming could not be initiated (kill switch, auth failure, network error,
 *   or bad server response). No pre-increment occurred.
 *
 * { ok: true }
 *   Stream completed normally. Use `reply` (or `streamedContent`) as the
 *   assistant message.
 *
 * { ok: false; firstToken: false }
 *   Stream connected and pre-incremented the session, but failed before the
 *   first token arrived. The caller should retry via `/chat` and include
 *   `fallbackToken` (when present) so the server acknowledges the pre-increment
 *   without double-charging the anonymous-session slot.
 *
 * { ok: false; firstToken: true }
 *   Stream failed after one or more tokens were already forwarded to `onToken`.
 *   Preserve the partial reply already accumulated by the caller; do NOT retry.
 */
export type StreamChatNativeResult =
  | null
  | {
      ok: true;
      reply: string;
      msgCount?: number;
      msgLimit?: number;
      isRealStreaming?: boolean;
      suggestions?: string[];
      videos?: OraVideo[];
      memorySaveCandidate?: string;
      memorySaveCandidateConfidence?: "high" | "low";
      memorySaveCandidateSensitive?: boolean;
      memoriesUsed?: OraMemoryUsed[];
      conversationSummary?: string;
      // Present only when the server's false-delivery safety net generated a
      // real file after the streamed reply claimed one was attached.
      fileName?: string;
      fileData?: string;
      mimeType?: string;
      assetId?: number;
    }
  | { ok: false; firstToken: false; fallbackToken?: string }
  | { ok: false; firstToken: true; reply: string };

export async function streamChatNative(
  req: ChatRequest,
  onToken: (delta: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<StreamChatNativeResult> {
  const callStart = Date.now();
  const diag: StreamChatDiagnostics = {
    readableStreamAvailable: typeof ReadableStream !== "undefined",
    killSwitchActive: false,
    authResult: "not_attempted",
    authMs: null,
    xhrUsed: false,
    endpointUrl: null,
    httpStatus: null,
    contentType: null,
    headersMs: null,
    firstTokenMs: null,
    tokenCount: 0,
    doneArrived: false,
    returnValue: "exception",
    fallbackCalled: false,
    capturedAt: callStart,
  };

  function finish(rv: StreamChatDiagnostics["returnValue"]): void {
    diag.returnValue = rv;
    _lastStreamDiag = { ...diag };
  }

  try {
    // Kill switch: set EXPO_PUBLIC_ORA_STREAMING_ENABLED="false" to opt out.
    if (process.env.EXPO_PUBLIC_ORA_STREAMING_ENABLED === "false") {
      diag.killSwitchActive = true;
      finish("null_killswitch");
      return null;
    }

    // Auth headers — fail closed: a signed-in user with no token must NOT
    // silently downgrade to anonymous mode on a streaming request.
    const authStart = Date.now();
    let headers: Headers;
    try {
      headers = await authHeadersRequired({ "Content-Type": "application/json" });
      diag.authResult = "ok";
      diag.authMs = Date.now() - authStart;
    } catch {
      diag.authResult = "threw";
      diag.authMs = Date.now() - authStart;
      finish("null_auth_threw");
      return null;
    }

    const endpoint = url("/api/public-ai/chat/stream");
    diag.endpointUrl = endpoint;
    diag.xhrUsed = true;
    const bodyStr = JSON.stringify(req);

    // SSE parse state
    let sseBuffer = "";
    let donePayload: StreamDonePayload | null = null;
    let firstTokenReceived = false;
    let accumulated = "";
    let earlyError:
      | { ok: false; firstToken: false; fallbackToken?: string }
      | { ok: false; firstToken: true; reply: string }
      | null = null;

    // Promise chain for word-by-word rendering: each token appends a 55 ms step.
    // Even when XHR delivers multiple SSE tokens in a single readyState=3 callback
    // (Hermes can batch chunks), the chain drains one token at a time so the UI
    // paints incrementally — independent of how bytes physically arrive.
    let renderChain = Promise.resolve();

    function processRawChunk(raw: string): void {
      sseBuffer += raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const parts = sseBuffer.split("\n\n");
      sseBuffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        let eventTypeLine: string | null = null;
        let dataLine: string | null = null;

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) eventTypeLine = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
        }
        if (!dataLine) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(dataLine) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = eventTypeLine ?? (parsed.type as string | undefined);
        if (!type) continue;

        if (type === "token") {
          const text = (parsed as { text?: string }).text ?? "";
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            diag.firstTokenMs = Date.now() - callStart;
          }
          diag.tokenCount += 1;
          accumulated += text;
          // Enqueue: each token renders with a ~55 ms gap so React Native
          // paints word-by-word even when chunks arrive in bursts.
          renderChain = renderChain.then(async () => {
            await Promise.resolve(onToken(text));
            await new Promise<void>((resolve) => setTimeout(resolve, 55));
          });
        } else if (type === "done") {
          donePayload = (parsed as { payload: StreamDonePayload }).payload;
          diag.doneArrived = true;
          // Capture server-side timing from the done payload so settings can
          // show provider, route tier, and server-measured latency.
          if (donePayload?.serverDiag) {
            diag.serverTtftMs = donePayload.serverDiag.ttftMs;
            diag.serverTotalMs = donePayload.serverDiag.totalMs;
            diag.serverProvider = donePayload.serverDiag.provider;
            diag.serverRouteTier = donePayload.serverDiag.routeTier;
            diag.serverFastLane = donePayload.serverDiag.fastLane;
          }
        } else if (type === "error") {
          const code = (parsed as { code?: string }).code;
          const fallbackToken = (parsed as { fallbackToken?: string }).fallbackToken;
          if (!firstTokenReceived || code === "stream_failed") {
            earlyError = { ok: false, firstToken: false, fallbackToken };
          } else {
            earlyError = { ok: false, firstToken: true, reply: accumulated };
          }
        }
      }
    }

    // XHR streams responseText progressively in React Native (readyState=3
    // callbacks carry new bytes as they arrive). This bypasses the Hermes
    // fetch/ReadableStream limitation where the entire body is buffered before
    // any read() yields — which caused the "all at once" symptom on device.
    let xhrResult: { ok: boolean; status: number; contentType: string };
    try {
      xhrResult = await sseViaXHR(
        endpoint,
        headers,
        bodyStr,
        signal,
        (ms) => {
          diag.headersMs = ms;
        },
        processRawChunk,
      );
    } catch {
      finish("null_request_failed");
      return null;
    }

    diag.httpStatus = xhrResult.status;
    diag.contentType = xhrResult.contentType;

    if (!xhrResult.ok || !xhrResult.contentType.includes("text/event-stream")) {
      finish("null_bad_response");
      return null;
    }

    // Drain the render chain: wait for all token callbacks + 55 ms gaps before
    // returning. Callers can inspect `streamedContent` immediately after await.
    await renderChain;

    // TypeScript's control-flow analysis narrows callback-captured `let`s to
    // their initial values across async boundaries. Re-read via explicit casts
    // so the compiler trusts the runtime values that processRawChunk wrote.
    const resolvedError = earlyError as
      | { ok: false; firstToken: false; fallbackToken?: string }
      | { ok: false; firstToken: true; reply: string }
      | null;
    const resolvedDone = donePayload as StreamDonePayload | null;

    if (resolvedError != null) {
      finish(resolvedError.firstToken ? "fail_post_token" : "fail_pre_token");
      return resolvedError;
    }

    if (resolvedDone == null) {
      finish("null_no_done");
      return null;
    }

    finish("ok");
    return {
      ok: true,
      reply: resolvedDone.reply ?? "",
      msgCount: resolvedDone.msgCount,
      msgLimit: resolvedDone.msgLimit,
      isRealStreaming: resolvedDone.isRealStreaming,
      suggestions: resolvedDone.suggestions,
      videos: resolvedDone.videos,
      memorySaveCandidate: resolvedDone.memorySaveCandidate,
      memorySaveCandidateConfidence: resolvedDone.memorySaveCandidateConfidence,
      memorySaveCandidateSensitive: resolvedDone.memorySaveCandidateSensitive,
      memoriesUsed: resolvedDone.memoriesUsed,
      conversationSummary: resolvedDone.conversationSummary,
      fileName: resolvedDone.fileName,
      fileData: resolvedDone.fileData,
      mimeType: resolvedDone.mimeType,
      assetId: resolvedDone.assetId,
    };
  } catch {
    finish("exception");
    return null;
  }
}

export function uploadFile(file: {
  uri: string;
  name: string;
  type: string;
}): Promise<UploadResponse> {
  return withOraSessionRecovery(async () => {
    // Rebuilt inside the retry closure — RN FormData may not be re-sendable
    // after a failed request.
    const form = new FormData();
    // React Native FormData accepts { uri, name, type } file objects.
    form.append("file", {
      uri: file.uri,
      name: file.name,
      type: file.type,
    } as unknown as Blob);
    // Multipart upload bypasses jsonRequest(), so it must opt into the same
    // fail-closed auth as the other file routes in pathRequiresAuth(): a signed-in
    // user with a temporarily-missing token throws instead of uploading as anon.
    const headers = await authHeadersRequired();
    const res = await fetchOrThrow(url("/api/public-ai/upload"), {
      method: "POST",
      body: form,
      headers,
      credentials: "include",
    });
    if (!res.ok) await parseError(res);
    return (await res.json()) as UploadResponse;
  });
}

export function analyzeImage(
  imageRef: string,
  message: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<AnalysisResponse> {
  return withOraSessionRecovery(() =>
    jsonRequest<AnalysisResponse>("/api/public-ai/image-analysis", {
      method: "POST",
      body: JSON.stringify({ imageRef, message, messages, language }),
    }),
  );
}

export function analyzeDataset(
  fileRef: string,
  message: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<DatasetAnalysisResponse> {
  return withOraSessionRecovery(() =>
    jsonRequest<DatasetAnalysisResponse>("/api/public-ai/dataset-analysis", {
      method: "POST",
      body: JSON.stringify({ fileRef, message, messages, language }),
    }),
  );
}

export function analyzeDocument(
  fileRef: string,
  message: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<AnalysisResponse> {
  return withOraSessionRecovery(() =>
    jsonRequest<AnalysisResponse>("/api/public-ai/file-analysis", {
      method: "POST",
      body: JSON.stringify({ fileRef, message, messages, language }),
    }),
  );
}

/** Transcribe raw audio bytes (Whisper). Returns recognized text. */
export async function transcribeAudio(uri: string, format: string, lang?: string): Promise<string> {
  const bytes = await (await fetch(uri)).arrayBuffer();
  const params = new URLSearchParams({ format });
  if (lang) params.set("lang", lang);
  const headers = await authHeaders({ "Content-Type": "application/octet-stream" });
  const res = await fetchOrThrow(url(`/api/public-ai/transcribe?${params.toString()}`), {
    method: "POST",
    body: bytes,
    headers,
    credentials: "include",
  });
  if (!res.ok) await parseError(res);
  const data = (await res.json()) as { text: string };
  return data.text;
}

/** Returns a data: URI for the synthesized speech audio (audio/mpeg). */
export async function synthesizeSpeech(
  text: string,
  voice = "nova",
  language?: string,
): Promise<string> {
  const headers = await authHeaders({ "Content-Type": "application/json" });
  const res = await fetchOrThrow(url("/api/public-ai/tts"), {
    method: "POST",
    body: JSON.stringify({ text, voice, language }),
    headers,
    credentials: "include",
  });
  if (!res.ok) await parseError(res);
  const buf = await res.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  return `data:audio/mpeg;base64,${base64}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // global.btoa exists in Hermes via the structured-clone/polyfill setup.
  return globalThis.btoa(binary);
}

// ---------------------------------------------------------------------------
// Ora profile / memories / conversations / assets (auth required)
// ---------------------------------------------------------------------------

export async function getProfile(): Promise<OraProfile> {
  const data = await jsonRequest<{ profile: OraProfile } | OraProfile>("/api/ora/profile");
  return (data as { profile?: OraProfile }).profile ?? (data as OraProfile);
}

export function updateProfile(profile: Partial<OraProfile>): Promise<unknown> {
  return jsonRequest("/api/ora/profile", {
    method: "PUT",
    body: JSON.stringify(profile),
  });
}

export async function listMemories(oraProjectId?: number | null): Promise<OraMemory[]> {
  const url =
    typeof oraProjectId === "number"
      ? `/api/ora/memories?oraProjectId=${oraProjectId}`
      : "/api/ora/memories";
  const data = await jsonRequest<{ memories: OraMemory[] }>(url);
  return data.memories ?? [];
}

export function getMemoryUsage(): Promise<MemoryUsage> {
  return jsonRequest<MemoryUsage>("/api/ora/memories/usage");
}

export function createMemory(
  title: string,
  content: string,
  oraProjectId?: number | null,
  category?: string | null,
): Promise<unknown> {
  return jsonRequest("/api/ora/memories", {
    method: "POST",
    body: JSON.stringify({
      title,
      content,
      ...(oraProjectId != null ? { oraProjectId } : {}),
      ...(category ? { category } : {}),
    }),
  });
}

export function clearAllMemories(): Promise<unknown> {
  return jsonRequest("/api/ora/memories", { method: "DELETE" });
}

/** Derive a short memory title from a fact (mirrors the web deriveTitle). */
function deriveMemoryTitle(fact: string): string {
  const firstLine = fact.split(/[.\n]/)[0]?.trim() || fact.trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

/**
 * Persist an Ora-detected memory candidate through the Ora endpoint
 * (origin="ora") — never POST /api/knowledge, which would misfile the save into
 * the AI Builder Knowledge Vault. Returns the titles of any earlier memories
 * this save superseded so the chat can name exactly what changed. Throws on a
 * non-2xx response so callers leave the candidate unsaved.
 */
export async function saveOraMemory(fact: string, oraProjectId?: number | null): Promise<string[]> {
  const content = fact.trim();
  if (!content) throw new Error("Cannot save an empty memory");
  const data = await jsonRequest<{ superseded?: { title: string }[] }>("/api/ora/memories", {
    method: "POST",
    body: JSON.stringify({
      title: deriveMemoryTitle(content),
      content,
      ...(oraProjectId != null ? { oraProjectId } : {}),
    }),
  });
  return (data.superseded ?? []).map((s) => s.title).filter((t) => t.trim().length > 0);
}

export function updateMemory(
  id: number,
  patch: Partial<Pick<OraMemory, "title" | "content" | "enabled" | "category">>,
): Promise<unknown> {
  return jsonRequest(`/api/ora/memories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteMemory(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/memories/${id}`, { method: "DELETE" });
}

/**
 * Restore a superseded memory: clears superseded_by and re-enables the row.
 * PATCH cannot clear superseded_by; the backend exposes a dedicated endpoint.
 */
export function restoreMemory(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/memories/${id}/restore`, { method: "POST" });
}

export interface ListConversationsOptions {
  q?: string;
  limit?: number;
  offset?: number;
  archived?: boolean;
}

function conversationListPath(options?: ListConversationsOptions): string {
  const params = new URLSearchParams();
  const q = options?.q?.trim();
  if (q) params.set("q", q);
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.offset != null) params.set("offset", String(options.offset));
  if (options?.archived === true) params.set("archived", "true");
  const query = params.toString();
  return `/api/ora/conversations${query ? `?${query}` : ""}`;
}

export async function listConversations(
  options?: ListConversationsOptions,
): Promise<OraConversationSummary[]> {
  const data = await jsonRequest<{ conversations: OraConversationSummary[] }>(
    conversationListPath(options),
  );
  return data.conversations ?? [];
}

export function createConversation(
  title: string,
  projectId: number | null = null,
): Promise<{ conversation: { id: number } }> {
  return jsonRequest("/api/ora/conversations", {
    method: "POST",
    body: JSON.stringify({ title, projectId }),
  });
}

export async function getConversation(id: number): Promise<OraConversationDetail> {
  const data = await jsonRequest<{ conversation: OraConversationDetail }>(
    `/api/ora/conversations/${id}`,
  );
  return data.conversation;
}

export function saveConversationMessages(id: number, messages: OraMessage[]): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}/messages`, {
    method: "PUT",
    body: JSON.stringify({ messages }),
  });
}

export function deleteConversation(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}`, { method: "DELETE" });
}

export function restoreConversation(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}/restore`, { method: "PATCH" });
}

export function permanentDeleteConversation(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}?permanent=true`, { method: "DELETE" });
}

export function pinConversation(id: number, pinned: boolean): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ pinned }),
  });
}

export async function listArchivedConversations(
  options?: Omit<ListConversationsOptions, "archived">,
): Promise<OraConversationSummary[]> {
  const data = await jsonRequest<{ conversations: OraConversationSummary[] }>(
    conversationListPath({ ...options, archived: true }),
  );
  return data.conversations ?? [];
}

export async function getOraUserSettings(): Promise<{ lastConversationId?: number | null }> {
  const data = await jsonRequest<{ settings: { lastConversationId?: number | null } }>(
    "/api/ora/settings",
  );
  return data.settings ?? {};
}

export function patchOraUserSettings(settings: {
  lastConversationId?: number | null;
}): Promise<unknown> {
  return jsonRequest("/api/ora/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
  });
}

// Move a conversation to a project (`projectId`) or back to standalone (`null`),
// mirroring the website's per-conversation "Move to" menu. The server validates
// project ownership. Backend: PATCH /api/ora/conversations/:id { projectId }.
export function moveConversation(id: number, projectId: number | null): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ projectId }),
  });
}

export function renameConversation(id: number, title: string): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function clearAllConversations(): Promise<unknown> {
  return jsonRequest("/api/ora/conversations", { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Ora projects (auth required). Conversations scope to a project via
// `projectId`; null = standalone ("Recent"). Deleting a project detaches its
// conversations (they become standalone) — handled entirely server-side.
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<OraProjectSummary[]> {
  const data = await jsonRequest<{ projects: OraProjectSummary[] }>("/api/ora/projects");
  return data.projects ?? [];
}

export async function createProject(
  name: string,
  description?: string,
): Promise<OraProjectSummary> {
  const data = await jsonRequest<{ project: OraProjectSummary }>("/api/ora/projects", {
    method: "POST",
    body: JSON.stringify(description ? { name, description } : { name }),
  });
  return data.project;
}

export async function renameProject(id: number, name: string): Promise<OraProjectSummary> {
  const data = await jsonRequest<{ project: OraProjectSummary }>(`/api/ora/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  return data.project;
}

export function deleteProject(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/projects/${id}`, { method: "DELETE" });
}

export function getAssets(): Promise<OraAssetsResponse> {
  return jsonRequest<OraAssetsResponse>("/api/ora/assets");
}

export function deleteAsset(id: string | number): Promise<unknown> {
  return jsonRequest(`/api/ora/assets/${id}`, { method: "DELETE" });
}

/**
 * List the full revision chain for a file asset. Accepts any asset id in the
 * chain and returns all versions ordered v1-first, plus the current head id.
 */
export function listAssetVersions(id: number): Promise<OraAssetVersionsResponse> {
  return jsonRequest<OraAssetVersionsResponse>(`/api/ora/assets/${id}/versions`);
}

/**
 * Restore an older version: the server copies its bytes into a NEW head asset
 * (history is never rewritten) and relinks the durable file context so a
 * follow-up "Revise ..." targets the restored content.
 */
export function restoreAssetVersion(
  versionAssetId: number,
): Promise<RestoreAssetVersionResponse> {
  return jsonRequest<RestoreAssetVersionResponse>(`/api/ora/assets/${versionAssetId}/restore`, {
    method: "POST",
  });
}

/**
 * Enqueue an image edit job, poll until complete, then fetch the result bytes
 * through the authenticated /file route (avoids private R2 endpoint issues).
 * Returns a data URL suitable for <Image source={{ uri }} />.
 */
export async function editImage(
  imageId: number,
  instruction: string,
): Promise<{ displayUrl: string; newImageId: number }> {
  const { jobId, imageId: newImageId } = await jsonRequest<{ jobId: string; imageId: number }>(
    `/api/images/${imageId}/edit`,
    { method: "POST", body: JSON.stringify({ instruction, quality: "standard", origin: "ora" }) },
  );

  let completed = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const s = await jsonRequest<{ status: string; error?: string | null }>(
        `/api/images/status/${jobId}`,
      );
      if (s.status === "completed") {
        completed = true;
        break;
      }
      if (s.status === "failed") throw new Error(s.error ?? "Image edit failed.");
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "Image edit failed.") throw err;
      // transient poll error — continue
    }
  }
  if (!completed) throw new Error("Image edit timed out. Please try again.");

  const res = await fetchOrThrow(url(`/api/images/${newImageId}/file`));
  if (!res.ok) throw new Error("Could not load the edited image.");
  const blob = await res.blob();
  if (blob.size === 0) throw new Error("The edited image was empty. Please try again.");

  const displayUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the edited image."));
    reader.readAsDataURL(blob);
  });

  return { displayUrl, newImageId };
}

// ---------------------------------------------------------------------------
// Orax (auth required)
// ---------------------------------------------------------------------------

export function getOraxCapabilities(): Promise<OraxCapabilities> {
  return jsonRequest<OraxCapabilities>("/api/orax/capabilities");
}

export async function listRepositories(): Promise<OraxRepository[]> {
  const data = await jsonRequest<{ repositories: OraxRepository[] }>("/api/orax/repositories");
  return data.repositories ?? [];
}

export function addRepository(
  repositoryUrl: string,
  defaultBranch?: string,
): Promise<{ repository: OraxRepository }> {
  return jsonRequest("/api/orax/repositories", {
    method: "POST",
    body: JSON.stringify({ repositoryUrl, defaultBranch }),
  });
}

export async function listTasks(): Promise<OraxTask[]> {
  const data = await jsonRequest<{ tasks: OraxTask[] }>("/api/orax/tasks");
  return data.tasks ?? [];
}

export async function listRepositoryScans(repositoryId: number): Promise<OraxScan[]> {
  const data = await jsonRequest<{ scans: OraxScan[] }>(
    `/api/orax/repositories/${repositoryId}/scans`,
  );
  return data.scans ?? [];
}

export function scanRepository(
  repositoryId: number,
  branch?: string,
): Promise<{ repository: OraxRepository; scan: OraxScan }> {
  return jsonRequest(`/api/orax/repositories/${repositoryId}/scan`, {
    method: "POST",
    body: JSON.stringify(branch ? { branch } : {}),
  });
}

export async function listTaskMessages(taskId: number): Promise<OraxTaskMessage[]> {
  const data = await jsonRequest<{ messages: OraxTaskMessage[] }>(
    `/api/orax/tasks/${taskId}/messages`,
  );
  return data.messages ?? [];
}

export async function sendTaskMessage(
  taskId: number,
  content: string,
  metadata?: OraxComposerMetadata,
): Promise<OraxTaskMessage[]> {
  const data = await jsonRequest<{ messages: OraxTaskMessage[] }>(
    `/api/orax/tasks/${taskId}/messages`,
    { method: "POST", body: JSON.stringify(metadata ? { content, metadata } : { content }) },
  );
  return data.messages ?? [];
}

export function appendTaskMessage(
  taskId: number,
  content: string,
  metadata?: OraxComposerMetadata,
): Promise<{ messages: OraxTaskMessage[] }> {
  return jsonRequest(`/api/orax/tasks/${taskId}/messages`, {
    method: "POST",
    body: JSON.stringify(metadata ? { content, metadata } : { content }),
  });
}

export async function listTaskApprovals(taskId: number): Promise<OraxApproval[]> {
  const data = await jsonRequest<{ approvals: OraxApproval[] }>(
    `/api/orax/tasks/${taskId}/approvals`,
  );
  return data.approvals ?? [];
}

export async function listTaskArtifacts(taskId: number): Promise<OraxArtifact[]> {
  const data = await jsonRequest<{ artifacts: OraxArtifact[] }>(
    `/api/orax/tasks/${taskId}/artifacts`,
  );
  return data.artifacts ?? [];
}

export function continueTask(taskId: number): Promise<OraxTaskRunnerResult> {
  return jsonRequest(`/api/orax/tasks/${taskId}/continue`, {
    method: "POST",
  });
}

export function requestFileReadApproval(input: {
  taskId: number;
  paths: string[];
  branch?: string;
  reason?: string;
}): Promise<{ approval: OraxApproval }> {
  return jsonRequest(`/api/orax/tasks/${input.taskId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      action: "read_files",
      paths: input.paths,
      branch: input.branch,
      reason: input.reason,
    }),
  });
}

export function createTask(input: {
  repositoryId: number;
  kind: OraxTaskKind;
  prompt: string;
  title?: string;
  startThread?: boolean;
}): Promise<{ task: OraxTask }> {
  return jsonRequest("/api/orax/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Preferences + billing (auth required)
// ---------------------------------------------------------------------------

export function getPreferences(): Promise<UserPreferences> {
  return jsonRequest<UserPreferences>("/api/me/preferences");
}

export function updatePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
  return jsonRequest<UserPreferences>("/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getSubscription(): Promise<BillingSubscription | null> {
  const data = await jsonRequest<{ subscription?: BillingSubscription } | BillingSubscription>(
    "/api/billing/subscription",
  );
  return (
    (data as { subscription?: BillingSubscription }).subscription ?? (data as BillingSubscription)
  );
}

export function getPaymentMethod(): Promise<PaymentMethodInfo> {
  return jsonRequest<PaymentMethodInfo>("/api/billing/payment-method");
}

export function startOraSubscriptionCheckout(input: {
  tier: "core" | "wave";
  successUrl: string;
  cancelUrl: string;
}): Promise<{ checkoutUrl?: string; setupRequired?: boolean; error?: string; message?: string }> {
  return jsonRequest("/api/billing/subscription/checkout", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function openBillingPortal(input: {
  returnUrl: string;
}): Promise<{ url?: string; setupRequired?: boolean; error?: string }> {
  return jsonRequest("/api/billing/portal", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function startPaymentMethodSetup(input: {
  returnUrl: string;
}): Promise<{ url?: string; setupRequired?: boolean; error?: string }> {
  return jsonRequest("/api/billing/payment-method/setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Help Center + Ora Support Mode
// ---------------------------------------------------------------------------

export async function listHelpArticles(
  query?: string,
  category?: string,
): Promise<{ articles: HelpArticle[]; faqs: HelpArticle[] }> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("q", query.trim());
  if (category?.trim()) params.set("category", category.trim());
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await jsonRequest<{ articles?: HelpArticle[]; faqs?: HelpArticle[] }>(
    `/help/articles${suffix}`,
  );
  return { articles: data.articles ?? [], faqs: data.faqs ?? [] };
}

export async function sendSupportChat(input: {
  message: string;
  messages: SupportMessage[];
  category?: string;
  language?: string;
}): Promise<{ reply: string; canEscalate?: boolean }> {
  return jsonRequest("/api/help/support/chat", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function escalateSupport(input: {
  subject: string;
  category?: string;
  transcript: SupportMessage[];
  deviceInfo?: Record<string, unknown> | null;
  attachments?: SupportAttachment[];
}): Promise<{ ticketId: number; emailStatus?: string; supportEmailUsed?: string }> {
  return jsonRequest("/api/help/support/escalate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listSupportConversations(): Promise<SupportConversationSummary[]> {
  const data = await jsonRequest<{ conversations?: SupportConversationSummary[] }>(
    "/api/help/support/conversations",
  );
  return data.conversations ?? [];
}

export async function getSupportConversation(id: number): Promise<{
  id: number;
  title: string | null;
  messages: SupportMessage[];
  lastMessageAt: string;
}> {
  return jsonRequest(`/api/help/support/conversations/${id}`);
}

export async function listSupportTickets(): Promise<SupportTicketSummary[]> {
  const data = await jsonRequest<{ tickets?: SupportTicketSummary[] }>("/api/help/support/tickets");
  return data.tickets ?? [];
}

export function getSupportTicket(id: number): Promise<SupportTicketDetail> {
  return jsonRequest<SupportTicketDetail>(`/api/help/support/tickets/${id}`);
}

// ---------------------------------------------------------------------------
// ORAX extended actions (auth required)
// ---------------------------------------------------------------------------

export function connectGithubToken(
  repositoryId: number,
  token: string,
): Promise<OraxGithubConnectResult> {
  return jsonRequest(`/api/orax/repositories/${repositoryId}/github/connect`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function patchApproval(
  approvalId: number,
  decision: OraxApprovalDecision,
): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/approvals/${approvalId}`, {
    method: "PATCH",
    body: JSON.stringify({ decision }),
  });
}

export function readApprovedFiles(approvalId: number): Promise<OraxReadFilesResult> {
  return jsonRequest(`/api/orax/approvals/${approvalId}/read-files`, { method: "POST" });
}

export function generateDraftPatch(input: {
  taskId: number;
  approvalId: number;
  instructions?: string;
}): Promise<OraxDraftPatchResult> {
  return jsonRequest(`/api/orax/tasks/${input.taskId}/draft-patch`, {
    method: "POST",
    body: JSON.stringify({
      approvalId: input.approvalId,
      ...(input.instructions ? { instructions: input.instructions } : {}),
    }),
  });
}

export function requestSandboxApproval(input: {
  taskId: number;
  artifactId: number;
  reason?: string;
}): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/tasks/${input.taskId}/sandbox-approvals`, {
    method: "POST",
    body: JSON.stringify({
      artifactId: input.artifactId,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  });
}

export function requestCommandApproval(input: {
  taskId: number;
  artifactId: number;
  commands?: string[];
  reason?: string;
}): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/tasks/${input.taskId}/command-approvals`, {
    method: "POST",
    body: JSON.stringify({
      artifactId: input.artifactId,
      ...(input.commands?.length ? { commands: input.commands } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  });
}

export function requestGithubPrApproval(input: {
  taskId: number;
  artifactId: number;
  title?: string;
  body?: string;
  reason?: string;
}): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/tasks/${input.taskId}/github-pr-approvals`, {
    method: "POST",
    body: JSON.stringify({
      artifactId: input.artifactId,
      confirmationText: "CREATE PR",
      ...(input.title ? { title: input.title } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  });
}

export function runSandbox(approvalId: number): Promise<OraxApprovalWithArtifact> {
  return jsonRequest(`/api/orax/approvals/${approvalId}/run-sandbox`, { method: "POST" });
}

export function runCommands(approvalId: number): Promise<OraxApprovalWithArtifact> {
  return jsonRequest(`/api/orax/approvals/${approvalId}/run-commands`, { method: "POST" });
}

export function createGithubPR(approvalId: number): Promise<OraxApprovalWithArtifact> {
  return jsonRequest(`/api/orax/approvals/${approvalId}/create-github-pr`, { method: "POST" });
}

export function connectRepositoryGithubToken(
  repositoryId: number,
  token: string,
): Promise<{ repository: OraxRepository }> {
  return connectGithubToken(repositoryId, token);
}

export function decideApproval(
  approvalId: number,
  decision: OraxApprovalDecision,
): Promise<{ approval: OraxApproval }> {
  return patchApproval(approvalId, decision);
}

export function runApprovedFileRead(
  approvalId: number,
): Promise<{ approval: OraxApproval; files: unknown[]; skipped: unknown[] }> {
  return readApprovedFiles(approvalId);
}

export function runApprovedSandbox(approvalId: number): Promise<OraxApprovalWithArtifact> {
  return runSandbox(approvalId);
}

export function runApprovedCommands(approvalId: number): Promise<OraxApprovalWithArtifact> {
  return runCommands(approvalId);
}

export function createApprovedGithubPr(approvalId: number): Promise<OraxApprovalWithArtifact> {
  return createGithubPR(approvalId);
}

// ── Orax Desktop host and pairing ─────────────────────────────────────────────

export function listOraxHosts(): Promise<{ hosts: OraxHostSummary[] }> {
  return jsonRequest<{ hosts: OraxHostSummary[] }>("/api/orax/hosts");
}

export function getOraxHost(hostId: string): Promise<{ host: OraxHostSummary }> {
  return jsonRequest<{ host: OraxHostSummary }>(`/api/orax/hosts/${hostId}`);
}

export function updateOraxHost(
  hostId: string,
  patch: { deviceName?: string; permissionMode?: string },
): Promise<{ host: OraxHostSummary }> {
  return jsonRequest<{ host: OraxHostSummary }>(`/api/orax/hosts/${hostId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function revokeOraxHost(hostId: string): Promise<void> {
  return jsonRequest<void>(`/api/orax/hosts/${hostId}`, { method: "DELETE" });
}

export function createOraxPairingCode(hostId: string): Promise<OraxPairingCode> {
  return jsonRequest<OraxPairingCode>("/api/orax/pairing-codes", {
    method: "POST",
    body: JSON.stringify({ hostId }),
  });
}

export function cancelOraxPairingCode(code: string): Promise<void> {
  return jsonRequest<void>(`/api/orax/pairing-codes/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
}

export function redeemOraxPairingCode(payload: RedeemPairingPayload): Promise<{ device: unknown }> {
  return jsonRequest<{ device: unknown }>("/api/orax/pairing-codes/redeem", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createDesktopAction(
  hostId: string,
  type: "ping_desktop" | "get_desktop_status" | "list_local_projects",
  payload?: Record<string, unknown>,
): Promise<{ action: { id: string; status: string; type: string } }> {
  return jsonRequest<{ action: { id: string; status: string; type: string } }>(
    `/api/orax/hosts/${hostId}/actions`,
    {
      method: "POST",
      body: JSON.stringify({ type, payload: payload ?? {} }),
    },
  );
}

export function getDesktopActions(hostId: string): Promise<{
  actions: Array<{ id: string; status: string; type: string; result: unknown }>;
}> {
  return jsonRequest<{
    actions: Array<{ id: string; status: string; type: string; result: unknown }>;
  }>(`/api/orax/hosts/${hostId}/actions`);
}

export function requestDesktopCommandApproval(
  hostId: string,
  payload: { command: string; reason: string; cwd?: string; threadId?: string },
): Promise<{ approval: { id: string; command: string; status: string; riskLevel: string } }> {
  return jsonRequest<{
    approval: { id: string; command: string; status: string; riskLevel: string };
  }>(`/api/orax/hosts/${hostId}/command-approvals`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resolveDesktopCommandApproval(
  approvalId: string,
  decision: "approved" | "denied",
): Promise<{ approval: { id: string; status: string }; action?: { id: string } }> {
  return jsonRequest<{ approval: { id: string; status: string }; action?: { id: string } }>(
    `/api/orax/approvals/${approvalId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
  );
}

export function getDesktopApproval(approvalId: string): Promise<{
  approval: { id: string; status: string; command: string | null; expiresAt: string | null };
}> {
  return jsonRequest<{
    approval: { id: string; status: string; command: string | null; expiresAt: string | null };
  }>(`/api/orax/approvals/${approvalId}`);
}

// ── Orax Cloud Projects ─────────────────────────────────────────────────────

export interface OraxCloudProject {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  sources: OraxProjectSource[];
}

export interface OraxProjectSource {
  id: string;
  projectId: string;
  kind: "local_folder" | "github_repo";
  localPath: string | null;
  githubRepoUrl: string | null;
  displayName: string | null;
  createdAt: string;
}

export function listOraxProjects(): Promise<{ projects: OraxCloudProject[] }> {
  return jsonRequest<{ projects: OraxCloudProject[] }>("/api/orax/projects");
}

export function createOraxProject(
  name: string,
  description?: string,
): Promise<{ project: OraxCloudProject }> {
  return jsonRequest<{ project: OraxCloudProject }>("/api/orax/projects", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export function getOraxProject(projectId: string): Promise<{ project: OraxCloudProject }> {
  return jsonRequest<{ project: OraxCloudProject }>(`/api/orax/projects/${projectId}`);
}

export function listOraxProjectThreads(projectId: string): Promise<{ threads: unknown[] }> {
  return jsonRequest<{ threads: unknown[] }>(`/api/orax/projects/${projectId}/threads`);
}

export function createOraxProjectThread(
  projectId: string,
  body: { prompt: string; executionSourceId?: string },
): Promise<{ thread: unknown }> {
  return jsonRequest<{ thread: unknown }>(`/api/orax/projects/${projectId}/threads`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function sendProjectThreadMessage(
  projectId: string,
  threadId: string,
  content: string,
): Promise<{ message: unknown }> {
  return jsonRequest<{ message: unknown }>(
    `/api/orax/projects/${projectId}/threads/${threadId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ content, role: "user" }),
    },
  );
}

export function continueProjectThread(
  projectId: string,
  threadId: string,
  body: { userMessage?: string; executionSourceId?: string },
): Promise<{
  context: {
    canExecute: boolean;
    mode: string;
    blockReason: string | null;
    host: { deviceName: string } | null;
  };
  action: unknown;
  message: { content: string; role: string; id: string } | null;
}> {
  return jsonRequest<{
    context: {
      canExecute: boolean;
      mode: string;
      blockReason: string | null;
      host: { deviceName: string } | null;
    };
    action: unknown;
    message: { content: string; role: string; id: string } | null;
  }>(`/api/orax/projects/${projectId}/threads/${threadId}/continue`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getProjectThreadContext(
  projectId: string,
  threadId: string,
): Promise<{
  context: {
    canExecute: boolean;
    mode: string;
    blockReason: string | null;
    host: { deviceName: string } | null;
  };
  threadMode: string;
}> {
  return jsonRequest<{
    context: {
      canExecute: boolean;
      mode: string;
      blockReason: string | null;
      host: { deviceName: string } | null;
    };
    threadMode: string;
  }>(`/api/orax/projects/${projectId}/threads/${threadId}/context`);
}
