import { getAuthToken } from "@workspace/api-client-react";

import type {
  AnalysisResponse,
  BillingSubscription,
  ChatRequest,
  ChatResponse,
  OraAssetsResponse,
  OraConversationDetail,
  OraConversationSummary,
  OraMemory,
  OraMessage,
  OraProfile,
  OraSession,
  OraUsage,
  OraxCapabilities,
  OraxRepository,
  OraxTask,
  UploadResponse,
  UserPreferences,
} from "./types";

/**
 * Base URL for the existing production API. On device there is no browser
 * cookie jar, so every call attaches a fresh Clerk bearer token via
 * getAuthToken() (registered in (home)/_layout.tsx). Pre-auth Ora endpoints
 * (`public-ai/*`) work even when the token is null.
 */
const DOMAIN = process.env.EXPO_PUBLIC_DOMAIN;
export const API_BASE = DOMAIN ? `https://${DOMAIN}` : "";

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

async function authHeaders(extra?: Record<string, string>): Promise<Headers> {
  const headers = new Headers(extra);
  const token = await getAuthToken();
  if (token && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

function url(path: string): string {
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
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

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = await authHeaders(init.body ? { "Content-Type": "application/json" } : undefined);
  const res = await fetch(url(path), {
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
  | { ok: true; reply: string; msgCount?: number; msgLimit?: number }
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

  const headers = await authHeaders({ "Content-Type": "application/json" });
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
  let donePayload: { reply: string; msgCount?: number; msgLimit?: number } | null = null;
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
        let eventType: string | null = null;
        let dataLine: string | null = null;

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
        }
        if (!dataLine) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(dataLine) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = eventType ?? (parsed.type as string | undefined);
        if (type === "token") {
          const text = (parsed as { text?: string }).text ?? "";
          firstTokenReceived = true;
          accumulated += text;
          onToken(text);
        } else if (type === "done") {
          const p = ((parsed as { payload?: unknown }).payload ?? parsed) as Record<
            string,
            unknown
          >;
          donePayload = {
            reply: (p.reply as string | undefined) ?? "",
            msgCount: p.msgCount as number | undefined,
            msgLimit: p.msgLimit as number | undefined,
          };
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

  return donePayload ? { ok: true, ...donePayload } : null;
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
  const res = await fetch(url("/api/public-ai/upload"), {
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
): Promise<AnalysisResponse> {
  return jsonRequest<AnalysisResponse>("/api/public-ai/dataset-analysis", {
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
  const res = await fetch(url(`/api/public-ai/transcribe?${params.toString()}`), {
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
  const res = await fetch(url("/api/public-ai/tts"), {
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

export function getAssets(): Promise<OraAssetsResponse> {
  return jsonRequest<OraAssetsResponse>("/api/ora/assets");
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
  const data = await jsonRequest<{ subscription: BillingSubscription }>(
    "/api/billing/subscription",
  );
  return data.subscription ?? null;
}
