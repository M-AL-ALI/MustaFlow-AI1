import { getAuthToken, requireAuthToken } from "./auth-client";

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
  OraConversationDetail,
  OraConversationSummary,
  SupportConversationSummary,
  OraMemory,
  OraMemoryUsed,
  OraAccountConsistency,
  OraMessage,
  OraProfile,
  OraProjectSummary,
  OraSession,
  OraUsage,
  OraVideo,
  OraxApprovalDecision,
  OraxApprovalWithArtifact,
  OraxCapabilities,
  OraxDraftPatchResult,
  OraxGithubConnectResult,
  OraxReadFilesResult,
  OraxRepository,
  OraxScan,
  OraxTask,
  OraxTaskApproval,
  OraxTaskArtifact,
  OraxTaskMessage,
  PaymentMethodInfo,
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
const DOMAIN = process.env.EXPO_PUBLIC_DOMAIN || "www.mustaflow.com";
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
    path.startsWith("/api/me/") ||
    path.startsWith("/api/orax/") ||
    path.startsWith("/api/billing/subscription") ||
    path === "/api/public-ai/session" ||
    path === "/api/public-ai/chat" ||
    path === "/api/public-ai/usage" ||
    path.startsWith("/api/public-ai/realtime/session")
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
  const res = await jsonRequest<{ fileName: string; fileData: string; mimeType: string }>(
    "/api/public-ai/export-file",
    { method: "POST", body: JSON.stringify(req) },
  );
  return { ...res, format: req.format };
}

export function sendChat(req: ChatRequest): Promise<ChatResponse> {
  return jsonRequest<ChatResponse>("/api/public-ai/chat", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/**
 * Result of a native streaming attempt. Discriminated union:
 *
 * null
 *   ReadableStream is unavailable or the network request failed before any
 *   SSE connection was established. No pre-increment occurred.
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
    }
  | { ok: false; firstToken: false; fallbackToken?: string }
  | { ok: false; firstToken: true; reply: string };

export async function streamChatNative(
  req: ChatRequest,
  onToken: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamChatNativeResult> {
  // When the streaming feature flag is disabled, return null immediately so
  // the caller falls through to the regular sendChat path — no probe request.
  if (process.env.EXPO_PUBLIC_ORA_STREAMING_ENABLED !== "true") return null;
  if (typeof ReadableStream === "undefined") return null;

  const headers = await authHeadersRequired({ "Content-Type": "application/json" });
  let res: Response;
  try {
    res = await fetch(url("/api/public-ai/chat/stream"), {
      method: "POST",
      body: JSON.stringify(req),
      headers,
      credentials: "include",
      signal,
    });
  } catch {
    return null;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("text/event-stream")) return null;
  if (!res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: StreamDonePayload | null = null;
  // Track whether at least one token arrived. An SSE `error` before the first
  // token triggers a silent /chat fallback; after means interrupted mid-reply.
  let firstTokenReceived = false;
  let accumulated = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

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

        if (type === "start") {
          // Connection confirmed — no action needed.
        } else if (type === "token") {
          const text = (parsed as { text?: string }).text ?? "";
          firstTokenReceived = true;
          accumulated += text;
          onToken(text);
          // Yield ~55ms between tokens (mirrors web use-ora-chat.ts) so batched
          // SSE frames render progressively, word-by-word, instead of all at once.
          await new Promise<void>((resolve) => setTimeout(resolve, 55));
        } else if (type === "done") {
          donePayload = (parsed as { payload: StreamDonePayload }).payload;
        } else if (type === "error") {
          const code = (parsed as { code?: string }).code;
          const fallbackToken = (parsed as { fallbackToken?: string }).fallbackToken;
          if (!firstTokenReceived || code === "stream_failed") {
            // Pre-first-token failure — carry the signed token so the caller
            // can present it to /chat to avoid double-charging the quota.
            return { ok: false, firstToken: false, fallbackToken };
          }
          // Post-first-token interruption — partial text already forwarded.
          // Do NOT auto-fallback; preserve what the user has seen.
          return { ok: false, firstToken: true, reply: accumulated };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!donePayload) return null;
  return {
    ok: true,
    reply: donePayload.reply ?? "",
    msgCount: donePayload.msgCount,
    msgLimit: donePayload.msgLimit,
    isRealStreaming: donePayload.isRealStreaming,
    suggestions: donePayload.suggestions,
    videos: donePayload.videos,
    memorySaveCandidate: donePayload.memorySaveCandidate,
    memorySaveCandidateConfidence: donePayload.memorySaveCandidateConfidence,
    memorySaveCandidateSensitive: donePayload.memorySaveCandidateSensitive,
    memoriesUsed: donePayload.memoriesUsed,
    conversationSummary: donePayload.conversationSummary,
  };
}

export async function uploadFile(file: {
  uri: string;
  name: string;
  type: string;
}): Promise<UploadResponse> {
  const form = new FormData();
  // React Native FormData accepts { uri, name, type } file objects.
  form.append("file", {
    uri: file.uri,
    name: file.name,
    type: file.type,
  } as unknown as Blob);
  const headers = await authHeaders();
  const res = await fetchOrThrow(url("/api/public-ai/upload"), {
    method: "POST",
    body: form,
    headers,
    credentials: "include",
  });
  if (!res.ok) await parseError(res);
  return (await res.json()) as UploadResponse;
}

export function analyzeImage(
  imageRef: string,
  message: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<AnalysisResponse> {
  return jsonRequest<AnalysisResponse>("/api/public-ai/image-analysis", {
    method: "POST",
    body: JSON.stringify({ imageRef, message, messages, language }),
  });
}

export function analyzeDataset(
  fileRef: string,
  message: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<DatasetAnalysisResponse> {
  return jsonRequest<DatasetAnalysisResponse>("/api/public-ai/dataset-analysis", {
    method: "POST",
    body: JSON.stringify({ fileRef, message, messages, language }),
  });
}

export function analyzeDocument(
  fileRef: string,
  message: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  language?: string,
): Promise<AnalysisResponse> {
  return jsonRequest<AnalysisResponse>("/api/public-ai/file-analysis", {
    method: "POST",
    body: JSON.stringify({ fileRef, message, messages, language }),
  });
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

export async function listMemories(): Promise<OraMemory[]> {
  const data = await jsonRequest<{ memories: OraMemory[] }>("/api/ora/memories");
  return data.memories ?? [];
}

export function createMemory(title: string, content: string): Promise<unknown> {
  return jsonRequest("/api/ora/memories", {
    method: "POST",
    body: JSON.stringify({ title, content }),
  });
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
export async function saveOraMemory(fact: string): Promise<string[]> {
  const content = fact.trim();
  if (!content) throw new Error("Cannot save an empty memory");
  const data = await jsonRequest<{ superseded?: { title: string }[] }>("/api/ora/memories", {
    method: "POST",
    body: JSON.stringify({ title: deriveMemoryTitle(content), content }),
  });
  return (data.superseded ?? []).map((s) => s.title).filter((t) => t.trim().length > 0);
}

export function updateMemory(
  id: number,
  patch: Partial<Pick<OraMemory, "title" | "content" | "enabled">>,
): Promise<unknown> {
  return jsonRequest(`/api/ora/memories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteMemory(id: number): Promise<unknown> {
  return jsonRequest(`/api/ora/memories/${id}`, { method: "DELETE" });
}

export async function listConversations(): Promise<OraConversationSummary[]> {
  const data = await jsonRequest<{ conversations: OraConversationSummary[] }>(
    "/api/ora/conversations",
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

// Move a conversation to a project (`projectId`) or back to standalone (`null`),
// mirroring the website's per-conversation "Move to" menu. The server validates
// project ownership. Backend: PATCH /api/ora/conversations/:id { projectId }.
export function moveConversation(id: number, projectId: number | null): Promise<unknown> {
  return jsonRequest(`/api/ora/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ projectId }),
  });
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
): Promise<{ repository: OraxRepository; scan: OraxScan }> {
  return jsonRequest(`/api/orax/repositories/${repositoryId}/scan`, { method: "POST" });
}

export async function listTaskMessages(taskId: number): Promise<OraxTaskMessage[]> {
  const data = await jsonRequest<{ messages: OraxTaskMessage[] }>(
    `/api/orax/tasks/${taskId}/messages`,
  );
  return data.messages ?? [];
}

export async function sendTaskMessage(taskId: number, content: string): Promise<OraxTaskMessage[]> {
  const data = await jsonRequest<{ messages: OraxTaskMessage[] }>(
    `/api/orax/tasks/${taskId}/messages`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
  return data.messages ?? [];
}

export async function listTaskApprovals(taskId: number): Promise<OraxTaskApproval[]> {
  const data = await jsonRequest<{ approvals: OraxTaskApproval[] }>(
    `/api/orax/tasks/${taskId}/approvals`,
  );
  return data.approvals ?? [];
}

export async function listTaskArtifacts(taskId: number): Promise<OraxTaskArtifact[]> {
  const data = await jsonRequest<{ artifacts: OraxTaskArtifact[] }>(
    `/api/orax/tasks/${taskId}/artifacts`,
  );
  return data.artifacts ?? [];
}

export function createTask(input: {
  repositoryId: number;
  kind: "analyze" | "coding";
  prompt: string;
  title?: string;
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
  return jsonRequest("/help/support/chat", {
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
  return jsonRequest("/help/support/escalate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listSupportConversations(): Promise<SupportConversationSummary[]> {
  const data = await jsonRequest<{ conversations?: SupportConversationSummary[] }>(
    "/help/support/conversations",
  );
  return data.conversations ?? [];
}

export async function getSupportConversation(
  id: number,
): Promise<{ id: number; title: string | null; messages: SupportMessage[]; lastMessageAt: string }> {
  return jsonRequest(`/help/support/conversations/${id}`);
}

export async function listSupportTickets(): Promise<SupportTicketSummary[]> {
  const data = await jsonRequest<{ tickets?: SupportTicketSummary[] }>("/help/support/tickets");
  return data.tickets ?? [];
}

export function getSupportTicket(id: number): Promise<SupportTicketDetail> {
  return jsonRequest<SupportTicketDetail>(`/help/support/tickets/${id}`);
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

export function generateDraftPatch(
  taskId: number,
  approvalId: number,
  instructions?: string,
): Promise<OraxDraftPatchResult> {
  return jsonRequest(`/api/orax/tasks/${taskId}/draft-patch`, {
    method: "POST",
    body: JSON.stringify({ approvalId, ...(instructions ? { instructions } : {}) }),
  });
}

export function requestSandboxApproval(
  taskId: number,
  artifactId: number,
  reason?: string,
): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/tasks/${taskId}/sandbox-approvals`, {
    method: "POST",
    body: JSON.stringify({ artifactId, ...(reason ? { reason } : {}) }),
  });
}

export function requestCommandApproval(
  taskId: number,
  artifactId: number,
  commands?: string[],
  reason?: string,
): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/tasks/${taskId}/command-approvals`, {
    method: "POST",
    body: JSON.stringify({
      artifactId,
      ...(commands?.length ? { commands } : {}),
      ...(reason ? { reason } : {}),
    }),
  });
}

export function requestGithubPrApproval(
  taskId: number,
  artifactId: number,
  opts?: { title?: string; body?: string; reason?: string },
): Promise<{ approval: OraxTaskApproval }> {
  return jsonRequest(`/api/orax/tasks/${taskId}/github-pr-approvals`, {
    method: "POST",
    body: JSON.stringify({
      artifactId,
      confirmationText: "CREATE PR",
      ...(opts?.title ? { title: opts.title } : {}),
      ...(opts?.body ? { body: opts.body } : {}),
      ...(opts?.reason ? { reason: opts.reason } : {}),
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
