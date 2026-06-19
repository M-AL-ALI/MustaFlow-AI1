import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { useUser } from "@clerk/react";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import { authFetch } from "@/lib/api-fetch";
import { useOraConversationsOptional } from "@/hooks/ora-conversations-context";
import { getReferenceSavedMemories, getReferenceChatHistory } from "@/lib/ora-memory-settings";

export type FileFormat = "csv" | "xlsx" | "docx" | "pdf" | "pptx";

export interface GeneratedFile {
  fileName: string;
  /**
   * Raw base64 bytes for an in-session generated file. Intentionally NOT
   * persisted to conversation storage (it would bloat the row), so a message
   * reloaded from the server has the file metadata but no `fileData`. Download
   * cards must guard on this being present and degrade gracefully when absent.
   */
  fileData?: string;
  mimeType: string;
  format: FileFormat;
}

export interface OraSource {
  title: string;
  url: string;
}

/** A real image found on the web during search, shown inline in the chat. */
export interface OraImage {
  url: string;
  title?: string;
  /** The page the image was found on, so the user can verify the context. */
  source?: string;
}

/** A relevant video found on the web during search, shown as a link card. */
export interface OraVideo {
  url: string;
  title?: string;
  thumbnailUrl?: string;
}

/**
 * A saved Ora memory that shaped a given reply. Surfaced (Ora-scoped only) so
 * the chat can show an unobtrusive "based on your saved memories" indicator
 * that deep-links to the Memory Center.
 */
export interface OraMemoryUsed {
  id: number;
  title: string;
}

export interface OraMessage {
  role: "user" | "assistant";
  content: string;
  datasetResult?: DatasetAnalysisResult;
  suggestions?: string[];
  messageKind?: "image-analysis" | "document-analysis";
  hadAttachment?: boolean;
  /**
   * Lightweight metadata about the file the user attached to this message, so
   * the upload stays visible in the thread (and after reload). We persist only
   * the display fields — never the file bytes.
   */
  attachment?: {
    filename: string;
    fileType: string;
    isImage?: boolean;
    isDataset?: boolean;
  };
  editedFrom?: boolean;
  generatedFile?: GeneratedFile;
  imageUrl?: string;
  /** generated_images id for an Ora-generated image — present when editable. */
  imageId?: number;
  /** Edit instruction that produced this derived image (lineage display). */
  editInstruction?: string;
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  /** True when the candidate looks like PII/credentials — never auto-saved. */
  memorySaveCandidateSensitive?: boolean;
  memorySaved?: boolean;
  /**
   * Present on a document-analysis reply for signed-in users: lets the user
   * opt in to persisting a concise summary of the analyzed file into Ora's
   * memory. Carries only the ephemeral file ref + display name — never bytes.
   */
  documentMemory?: { fileRef: string; filename: string };
  /** True once the document summary has been saved to memory. */
  documentMemorySaved?: boolean;
  /**
   * Titles of earlier memories this save replaced (a contradicting update like
   * "dark mode" → "light mode"). Drives the inline "Updated your memory" note.
   */
  memorySupersededTitles?: string[];
  sources?: OraSource[];
  /** Real images found on the web, rendered inline as a gallery. */
  images?: OraImage[];
  /** Relevant videos found on the web, rendered as clickable link cards. */
  videos?: OraVideo[];
  /** Saved Ora memories that shaped this reply (Ora-scoped only). */
  memoriesUsed?: OraMemoryUsed[];
  /** rolling conversation summary for this conversation. */
  conversationSummary?: string;
  /** True while this assistant message is still being streamed token-by-token. */
  isStreaming?: boolean;
  /**
   * True when this assistant reply did NOT use real provider-level token
   * streaming — either because the SSE stream endpoint fell back to the plain
   * /chat API, or because the upstream AI provider does not support incremental
   * token delivery. Useful for developer monitoring of real vs fallback ratios.
   */
  viaFallback?: boolean;
}

export interface OraSession {
  sessionId: string;
  msgCount: number;
  msgLimit: number;
  fileCount: number;
  fileLimit: number;
  imageCount?: number;
  imageLimit?: number;
  imageAnalysisCount?: number;
  imageAnalysisLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
}

export type UploadState = "idle" | "uploading" | "attached" | "error";

export type OraStatus =
  | "idle"
  | "thinking"
  | "replying"
  | "uploading"
  | "reading"
  | "analyzing"
  | "analyzing-image";

export interface AttachedFile {
  fileRef: string;
  filename: string;
  fileType: string;
  charCount: number;
  isDataset: boolean;
  isImage?: boolean;
  sizeBytes?: number;
  width?: number;
  height?: number;
  rowCount?: number;
  colCount?: number;
  truncated?: boolean;
  sanitizedCells?: number;
  hiddenSheetsSkipped?: number;
}

export type OraMode = "instant" | "deep";

export interface UseOraChatReturn {
  messages: OraMessage[];
  session: OraSession | null;
  isLoading: boolean;
  error: string | null;
  atLimit: boolean;
  language: string;
  setLanguage: (lang: string) => void;
  mode: OraMode;
  setMode: (mode: OraMode) => void;
  sendMessage: (
    content: string,
    opts?: { truncateTo?: number; editedFrom?: boolean },
  ) => Promise<void>;
  generateFile: (content: string, format: FileFormat) => Promise<void>;
  editInlineImage: (sourceImageId: number, instruction: string) => Promise<void>;
  clearError: () => void;
  uploadFile: (file: File) => Promise<void>;
  clearAttachment: () => void;
  attachedFile: AttachedFile | null;
  uploadState: UploadState;
  uploadError: string | null;
  clearUploadError: () => void;
  oraStatus: OraStatus;
  clearConversation: () => Promise<void>;
  sessionExpired: boolean;
  dismissSessionExpired: () => void;
  markMemorySaved: (candidate: string, content: string, supersededTitles?: string[]) => void;
  markDocumentMemorySaved: (fileRef: string) => void;
  /** Whether the current session is a temporary ("incognito") chat. */
  temporary: boolean;
  /** Toggle temporary mode; always resets to a clean conversation. */
  setTemporary: (value: boolean) => void;
  /**
   * Resend the last user message, removing any partial/failed assistant reply
   * that followed it. No-op when there is no user message or a request is
   * already in flight.
   */
  retryLastMessage: () => Promise<void>;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "ora_session_id";
const TRANSCRIPT_STORAGE_KEY = "ora_transcript";

const FILE_LIMIT = 3;
const IMAGE_LIMIT = 2;

// Number of most-recent messages sent verbatim as the chat context window.
// Turns older than this are condensed into a rolling summary so long
// conversations stay coherent without unbounded token growth. Mirrors the
// backend's ORA_RECENT_WINDOW.
const RECENT_WINDOW = 20;
// Cap on how many overflow turns we ship to be folded into the summary in a
// single request (mirrors the backend ORA_SUMMARIZE_BATCH_MAX). Normally only a
// couple overflow per turn; this bounds the one-time backlog after a reload.
const SUMMARIZE_BATCH_MAX = 40;

// Usage fields any metered Ora endpoint may return alongside its result. The
// rolling-window backend echoes message + image counts and the personal
// window's resetsAt/windowHours so the sidebar countdown and remaining-quota
// indicators stay in sync after every action.
interface OraUsagePayload {
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
}

// Merge a usage payload into the current session, preserving fields the payload
// doesn't carry (sessionId, file/image-analysis counts). Used by every
// setSession update path so resetsAt/windowHours/image counts propagate.
function mergeUsage(prev: OraSession | null, data: OraUsagePayload): OraSession {
  const base: OraSession = prev ?? {
    sessionId: "",
    msgCount: data.msgCount,
    msgLimit: data.msgLimit,
    fileCount: 0,
    fileLimit: FILE_LIMIT,
  };
  return {
    ...base,
    msgCount: data.msgCount,
    msgLimit: data.msgLimit,
    ...(data.imageCount != null ? { imageCount: data.imageCount } : {}),
    ...(data.imageLimit != null ? { imageLimit: data.imageLimit } : {}),
    ...(data.resetsAt !== undefined ? { resetsAt: data.resetsAt } : {}),
    ...(data.windowHours != null ? { windowHours: data.windowHours } : {}),
  };
}

const DOC_ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".xlsx", ".pptx"];
const IMAGE_ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const ALLOWED_EXTENSIONS = [...DOC_ALLOWED_EXTENSIONS, ...IMAGE_ALLOWED_EXTENSIONS];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB for documents
const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4 MB hard cap (after compression)

function isImageExt(ext: string): boolean {
  return IMAGE_ALLOWED_EXTENSIONS.includes(ext);
}

/**
 * Compress an image file client-side before upload.
 * Downscales to ≤ 1920 px on either side and re-encodes as JPEG (q=0.88).
 * Resolves to the original File if it is already small or can't be decoded.
 */
async function compressImageForUpload(file: File): Promise<Blob> {
  const MAX_PX = 1920;
  const QUALITY = 0.88;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const needsScale = width > MAX_PX || height > MAX_PX;
      if (!needsScale && file.size <= MAX_IMAGE_SIZE) {
        resolve(file);
        return;
      }
      if (needsScale) {
        const scale = Math.min(MAX_PX / width, MAX_PX / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      // Use image/jpeg for photos; preserve png for images that need transparency
      const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
      canvas.toBlob((b) => resolve(b ?? file), outType, QUALITY);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

function getStoredLanguage(): string {
  try {
    return sessionStorage.getItem("ora_language") ?? "auto";
  } catch {
    return "auto";
  }
}

function getStoredMode(): OraMode {
  try {
    return sessionStorage.getItem("ora_mode") === "deep" ? "deep" : "instant";
  } catch {
    return "instant";
  }
}

function storeSessionId(sessionId: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    /* ignore */
  }
}

function getStoredSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearStoredSessionId(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function storeTranscript(messages: OraMessage[]): void {
  try {
    sessionStorage.setItem(TRANSCRIPT_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    /* ignore */
  }
}

function getStoredTranscript(): OraMessage[] {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OraMessage[];
  } catch {
    return [];
  }
}

function clearStoredTranscript(): void {
  try {
    sessionStorage.removeItem(TRANSCRIPT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  // authFetch (not raw fetch) so a fresh Clerk bearer token is attached: the
  // dev-mode JWT cookie expires ~60s and is unreliable in the preview iframe,
  // and /public-ai/chat resolves auth from getAuth(req). A cookie-only call
  // makes a signed-in user look anonymous, so Ora wrongly hedges "sign in first".
  const res = await authFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
    method: "GET",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

async function apiDelete(path: string): Promise<void> {
  const res = await authFetch(`${BASE}${path}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
}

function isDatasetFileType(fileType: string, filename: string): boolean {
  const ft = fileType.toLowerCase();
  const name = filename.toLowerCase();
  return ft === "csv" || ft === "xlsx" || name.endsWith(".csv") || name.endsWith(".xlsx");
}

function deriveOraStatus(
  isLoading: boolean,
  uploadState: UploadState,
  attachedFile: AttachedFile | null,
  pendingImageAnalysis: boolean,
  messages: OraMessage[],
): OraStatus {
  if (uploadState === "uploading") return "uploading";
  if (isLoading) {
    if (pendingImageAnalysis) return "analyzing-image";
    if (attachedFile) {
      if (isDatasetFileType(attachedFile.fileType, attachedFile.filename)) return "analyzing";
      return "reading";
    }
    // Show "thinking" while the current streaming placeholder is still empty
    // (no content yet); transition to "replying" once the first token of THIS
    // turn arrives. Check the trailing streaming message specifically — checking
    // any assistant message would report "replying" over an empty new bubble in
    // a multi-turn conversation where earlier replies already have content.
    const last = messages[messages.length - 1];
    const streamingHasContent =
      last?.role === "assistant" && last.isStreaming === true && last.content.trim().length > 0;
    return streamingHasContent ? "replying" : "thinking";
  }
  return "idle";
}

function serializeForStorage(messages: OraMessage[]): Array<{
  role: string;
  content: string;
  messageKind?: string;
  suggestions?: string[];
  hadAttachment?: boolean;
  attachment?: { filename: string; fileType: string; isImage?: boolean; isDataset?: boolean };
  editedFrom?: boolean;
  generatedFile?: GeneratedFile;
  datasetResult?: DatasetAnalysisResult;
  imageUrl?: string;
  imageId?: number;
  editInstruction?: string;
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  memorySaved?: boolean;
  documentMemory?: { fileRef: string; filename: string };
  documentMemorySaved?: boolean;
  memorySupersededTitles?: string[];
  sources?: OraSource[];
  images?: OraImage[];
  videos?: OraVideo[];
  memoriesUsed?: OraMemoryUsed[];
  conversationSummary?: string;
}> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.messageKind !== undefined ? { messageKind: m.messageKind } : {}),
    ...(m.suggestions && m.suggestions.length > 0 ? { suggestions: m.suggestions } : {}),
    ...(m.hadAttachment ? { hadAttachment: true } : {}),
    // Persist the attachment metadata so the upload stays visible after reload.
    ...(m.attachment ? { attachment: m.attachment } : {}),
    ...(m.editedFrom ? { editedFrom: true } : {}),
    // Include generatedFile so the download card persists across re-renders
    ...(m.generatedFile ? { generatedFile: m.generatedFile } : {}),
    ...(m.datasetResult !== undefined ? { datasetResult: m.datasetResult } : {}),
    // Persist inline image + memory-save candidate so they survive reload
    ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}),
    ...(m.imageId != null ? { imageId: m.imageId } : {}),
    ...(m.editInstruction ? { editInstruction: m.editInstruction } : {}),
    ...(m.memorySaveCandidate ? { memorySaveCandidate: m.memorySaveCandidate } : {}),
    ...(m.memorySaveCandidateConfidence
      ? { memorySaveCandidateConfidence: m.memorySaveCandidateConfidence }
      : {}),
    ...(m.memorySaveCandidateSensitive ? { memorySaveCandidateSensitive: true } : {}),
    ...(m.memorySaved ? { memorySaved: true } : {}),
    // Persist the document-memory affordance + saved state so the "Remember
    // this document" chip survives reload. Only the file ref + name — no bytes.
    ...(m.documentMemory ? { documentMemory: m.documentMemory } : {}),
    ...(m.documentMemorySaved ? { documentMemorySaved: true } : {}),
    ...(m.memorySupersededTitles && m.memorySupersededTitles.length > 0
      ? { memorySupersededTitles: m.memorySupersededTitles }
      : {}),
    // Persist cited web-search sources so the source cards survive reload
    ...(m.sources && m.sources.length > 0 ? { sources: m.sources } : {}),
    // Persist web-found media so the gallery + video cards survive reload
    ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
    ...(m.videos && m.videos.length > 0 ? { videos: m.videos } : {}),
    // Persist which saved memories shaped the reply so the indicator survives reload
    ...(m.memoriesUsed && m.memoriesUsed.length > 0 ? { memoriesUsed: m.memoriesUsed } : {}),
    // Persist the rolling summary so it can be re-sent after a reload
    ...(m.conversationSummary ? { conversationSummary: m.conversationSummary } : {}),
  }));
}

// ── SSE stream types (mirror backend stream-adapter.ts) ─────────────────────

interface StreamDonePayload {
  reply: string;
  suggestions?: string[];
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  conversationSummary?: string;
  memoriesUsed?: OraMemoryUsed[];
  videos?: OraVideo[];
  mode?: "instant" | "deep";
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  isRealStreaming?: boolean;
}

/**
 * Consume the /api/public-ai/chat/stream SSE endpoint.
 *
 * Calls `onToken` for each incremental text delta. Resolves with the full
 * `done` payload on completion.
 *
 * Error semantics:
 * - `{ streamingFallback: true }` — feature disabled (503) or specialist-tool
 *   JSON signal, OR SSE `error` event before the first token arrived.
 *   Caller should silently retry via /api/public-ai/chat.
 * - `{ partialContent: string }` — SSE `error` event arrived AFTER one or more
 *   tokens were already emitted. The partial text has already been appended via
 *   `onToken`; caller should preserve it rather than discarding the placeholder.
 * - `AbortError` — caller aborted (navigation); clean up silently.
 * - `{ status: number }` — HTTP-level error (401, 429, …); surface to the user.
 */
async function consumeOraStream(
  base: string,
  body: Record<string, unknown>,
  onToken: (delta: string) => void,
  signal: AbortSignal,
): Promise<StreamDonePayload> {
  const res = await authFetch(`${base}/api/public-ai/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      streamingFallback?: boolean;
    };
    if (res.status === 503 || data.streamingFallback) {
      throw Object.assign(new Error("streaming_unavailable"), { streamingFallback: true });
    }
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json().catch(() => ({}))) as {
      streamingFallback?: boolean;
      error?: string;
    };
    throw Object.assign(new Error(data.error ?? "streaming_unavailable"), {
      streamingFallback: true,
    });
  }

  if (!res.body) {
    throw Object.assign(new Error("streaming_unavailable"), { streamingFallback: true });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: StreamDonePayload | null = null;
  // Track whether at least one token has been received. An SSE `error` before
  // the first token triggers a silent /chat fallback; after the first token it
  // means the stream was interrupted mid-reply (preserve partial content).
  let firstTokenReceived = false;
  // Accumulate tokens so we can attach partialContent to a mid-stream error.
  let accumulated = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by double newlines. Each frame may carry an
    // `event: <type>` line (RFC 8895) followed by `data: <json>`. The type is
    // also embedded in the JSON for backward compatibility with readers that
    // only inspect the data line.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      let eventTypeLine: string | null = null;
      let dataLine: string | null = null;

      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) {
          eventTypeLine = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLine = line.slice(6).trim();
        }
      }

      if (!dataLine) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(dataLine) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Resolve type: prefer the `event:` line; fall back to JSON-embedded type.
      const eventType = eventTypeLine ?? (parsed.type as string | undefined);
      if (!eventType) continue;

      if (eventType === "start") {
        // Connection confirmed — no action needed, just a liveness signal.
      } else if (eventType === "token") {
        const text = (parsed as { text: string }).text;
        firstTokenReceived = true;
        accumulated += text;
        onToken(text);
        // Yield to the browser paint loop so each token renders visibly before
        // the next one is processed. flushSync commits the DOM change but does
        // NOT force a browser repaint — all flushSync calls inside the same JS
        // task still only produce one visible frame at the end. The Replit dev
        // proxy batches all SSE frames into a single TCP delivery, so without
        // this yield every token lands in the same task and the user sees the
        // complete response appear at once instead of word-by-word.
        await new Promise<void>((resolve) => setTimeout(resolve, 55));
      } else if (eventType === "done") {
        donePayload = (parsed as { payload: StreamDonePayload }).payload;
      } else if (eventType === "error") {
        const message =
          (parsed as { message: string }).message ?? "Ora is temporarily unavailable.";
        if (!firstTokenReceived) {
          // No tokens yet — silently fall back to /chat (same as 503).
          // Carry the server-signed fallback token so /chat can acknowledge
          // the pre-increment without double-charging the session quota.
          const token = (parsed as { fallbackToken?: string }).fallbackToken;
          throw Object.assign(new Error("streaming_unavailable"), {
            streamingFallback: true,
            ...(token ? { streamFallbackToken: token } : {}),
          });
        }
        // Tokens were already sent; preserve the partial reply.
        throw Object.assign(new Error(message), { partialContent: accumulated });
      }
    }
  }

  if (!donePayload) {
    throw new Error("Stream ended without a done event");
  }
  return donePayload;
}

export function useOraChat(): UseOraChatReturn {
  const { isLoaded, isSignedIn } = useUser();
  const [messages, setMessages] = useState<OraMessage[]>([]);
  const [session, setSession] = useState<OraSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguageState] = useState<string>(getStoredLanguage);
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingImageAnalysis, setPendingImageAnalysis] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [mode, setModeState] = useState<OraMode>(getStoredMode);
  // Temporary ("incognito") chat: when on, this session reads/writes zero
  // long-term memory and is never persisted to the conversation store. Kept in a
  // ref too so the debounced saver and the request body can read the latest
  // value without being in their dependency arrays.
  const [temporary, setTemporaryState] = useState(false);
  const temporaryRef = useRef(false);
  temporaryRef.current = temporary;

  // Conversation context is present only on the standalone /ora page (signed-in,
  // per-conversation persistence). On the public landing trial the provider is
  // absent, so `conv` is null and the hook keeps its legacy single-transcript
  // behavior (sessionStorage + /api/ora/transcript).
  const conv = useOraConversationsOptional();
  const convRef = useRef(conv);
  convRef.current = conv;
  const conversationMode = conv != null;

  const sessionInitRef = useRef(false);
  const transcriptRestoredRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Session-local object URLs created for edited images in dev (auth-walled file
  // route). Tracked so we can revoke them on unmount / conversation clear and
  // avoid leaking blob memory across repeated edits.
  const objectUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
      // Abort any in-flight SSE stream so navigation never leaves a dangling
      // fetch that would try to update unmounted state.
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, []);
  // Tracks the conversation id whose messages are currently loaded, so the load
  // effect can skip re-fetching a conversation we just created locally.
  const loadedConvRef = useRef<number | null>(null);
  // Bumped on every local edit (each saveToServer call). An in-flight load
  // captures this value and discards its server result if a local edit happened
  // while the fetch was outstanding — prevents a stale GET clobbering new input.
  const editGenRef = useRef(0);
  // Refs of documents (PDF/DOCX/TXT/etc.) uploaded earlier in THIS conversation.
  // Their extracted text lives only in the server's ephemeral session-scoped
  // store, so we re-send the recent refs on each plain chat turn to let Ora
  // answer follow-up questions about an earlier upload. Reset on new/changed
  // conversation. In-memory only — not persisted (the store expires in 30 min).
  const documentRefsRef = useRef<string[]>([]);

  // Rolling conversation summary for THIS conversation. As the chat grows past
  // the recent-message window, older turns are condensed into this running
  // summary (maintained server-side, returned each reply) and re-sent so long
  // conversations stay coherent. `summarizedUpToRef` tracks how many leading
  // messages have already been folded in, so each turn only ships the NEW
  // overflow (bounded cost). Reset on new/changed/cleared conversation. Kept
  // in-memory only — recomputed once after a reload from the persisted turns.
  const conversationSummaryRef = useRef<string>("");
  const summarizedUpToRef = useRef<number>(0);

  const setLanguage = useCallback((lang: string) => {
    setLanguageState(lang);
    try {
      sessionStorage.setItem("ora_language", lang);
    } catch {
      /* ignore */
    }
  }, []);

  const setMode = useCallback((next: OraMode) => {
    setModeState(next);
    try {
      sessionStorage.setItem("ora_mode", next);
    } catch {
      /* ignore */
    }
  }, []);

  // Persist a message snapshot to a specific conversation. `targetId` is captured
  // at schedule time (NOT resolved from the mutable context at flush time) so
  // switching conversations during the debounce window can never write one
  // conversation's messages into another. When `targetId` is null the snapshot
  // belongs to a brand-new chat: create it — but only if the user is still on a
  // new chat (currentConversationId === null). If they navigated to an existing
  // conversation meanwhile, drop the save rather than clobber that conversation.
  const saveToConversation = useCallback(async (msgs: OraMessage[], targetId: number | null) => {
    const c = convRef.current;
    if (!c) return;
    let id = targetId;
    if (id == null) {
      if (c.currentConversationId != null) return;
      const firstUser = msgs.find((m) => m.role === "user");
      id = await c.ensureConversation(firstUser?.content ?? "New chat");
    }
    if (id == null) return;
    // Skip the load effect re-fetching the conversation we are actively writing.
    loadedConvRef.current = id;
    try {
      const res = await authFetch(`${BASE}/api/ora/conversations/${id}/messages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: serializeForStorage(msgs) }),
      });
      if (res.ok) c.notifyPersisted();
    } catch {
      /* best-effort; silent on failure */
    }
  }, []);

  const saveToServer = useCallback(
    (msgs: OraMessage[]) => {
      // Temporary ("incognito") chats are never persisted — drop the save and
      // cancel any pending one entirely.
      if (temporaryRef.current) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        return;
      }
      editGenRef.current += 1;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const c = convRef.current;
      if (c) {
        // Snapshot the target conversation id NOW, before the debounce window.
        const targetId = c.currentConversationId;
        saveTimerRef.current = setTimeout(() => {
          void saveToConversation(msgs, targetId);
        }, 800);
      } else {
        saveTimerRef.current = setTimeout(() => {
          apiPost("/api/ora/transcript", { messages: serializeForStorage(msgs) }).catch(() => {
            /* best-effort; silent on failure */
          });
        }, 800);
      }
    },
    [saveToConversation],
  );

  // Phase 1: Session init — runs once on mount regardless of auth state
  useEffect(() => {
    if (sessionInitRef.current) return;
    sessionInitRef.current = true;

    const storedSessionId = getStoredSessionId();

    const init = async () => {
      if (storedSessionId) {
        try {
          const data = await apiGet<{
            sessionId: string;
            msgCount: number;
            msgLimit: number;
            fileCount?: number;
            fileLimit?: number;
            imageCount?: number;
            imageLimit?: number;
            imageAnalysisCount?: number;
            imageAnalysisLimit?: number;
            resetsAt?: string | null;
            windowHours?: number;
          }>("/api/public-ai/session");
          setSession({
            sessionId: data.sessionId,
            msgCount: data.msgCount,
            msgLimit: data.msgLimit,
            fileCount: data.fileCount ?? 0,
            fileLimit: data.fileLimit ?? FILE_LIMIT,
            imageCount: data.imageCount ?? 0,
            imageLimit: data.imageLimit ?? IMAGE_LIMIT,
            imageAnalysisCount: data.imageAnalysisCount ?? 0,
            imageAnalysisLimit: data.imageAnalysisLimit ?? 2,
            resetsAt: data.resetsAt ?? null,
            windowHours: data.windowHours,
          });
          if (!convRef.current) {
            const stored = getStoredTranscript();
            if (stored.length > 0) {
              setMessages(stored);
            }
          }
          return;
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          if (status === 401) {
            // Clear only the expired session ID — the transcript is still valid
            // and will be shown from sessionStorage while the new session is created.
            clearStoredSessionId();
            // Notify the UI so it can warn non-signed-in users that their
            // session expired and they should sign in to keep their history.
            // The panel gates display on !isSignedIn so this is safe for guests only.
            setSessionExpired(true);
          }
        }
      }

      // No valid session — create one.
      // Also restore any prior transcript: it may exist because the session
      // JWT expired (inactivity) while the conversation history is still in
      // sessionStorage and completely valid.
      try {
        const data = await apiPost<{
          sessionId: string;
          msgCount: number;
          msgLimit: number;
          fileCount?: number;
          fileLimit?: number;
          imageCount?: number;
          imageLimit?: number;
          resetsAt?: string | null;
          windowHours?: number;
        }>("/api/public-ai/session", {});
        storeSessionId(data.sessionId);
        setSession({
          sessionId: data.sessionId,
          msgCount: data.msgCount,
          msgLimit: data.msgLimit,
          fileCount: data.fileCount ?? 0,
          fileLimit: data.fileLimit ?? FILE_LIMIT,
          imageCount: data.imageCount ?? 0,
          imageLimit: data.imageLimit ?? IMAGE_LIMIT,
          resetsAt: data.resetsAt ?? null,
          windowHours: data.windowHours,
        });
        if (!convRef.current) {
          const stored = getStoredTranscript();
          if (stored.length > 0) {
            setMessages(stored);
          }
        }
      } catch (err: unknown) {
        const msg = (err as Error).message ?? "Could not start Ora session.";
        setError(msg);
      }
    };

    void init();
  }, []);

  // Phase 2: Server transcript restore — runs once Clerk confirms the user is
  // signed in. Skipped in conversation mode (the load effect below is the source
  // of truth for per-conversation message history).
  useEffect(() => {
    if (conversationMode || !isLoaded || !isSignedIn || transcriptRestoredRef.current) return;
    transcriptRestoredRef.current = true;

    const restoreTranscript = async () => {
      try {
        const data = await apiGet<{ messages: OraMessage[] }>("/api/ora/transcript");
        if (data.messages.length > 0) {
          // Merge: only overwrite local state if the server transcript has equal-or-more
          // messages. If the user sent messages between Phase 1 init and sign-in
          // confirmation, those local-only messages are appended after the server transcript.
          setMessages((localMsgs) => {
            if (data.messages.length >= localMsgs.length) {
              storeTranscript(data.messages);
              return data.messages;
            }
            // Local state has newer messages — append them after the server transcript
            const serverIds = new Set(
              data.messages.map((m) => `${m.role}:${m.content.slice(0, 50)}`),
            );
            const localOnly = localMsgs.filter(
              (m) => !serverIds.has(`${m.role}:${m.content.slice(0, 50)}`),
            );
            const merged = [...data.messages, ...localOnly];
            storeTranscript(merged);
            return merged;
          });
        }
      } catch {
        // Best-effort — sessionStorage messages (set in Phase 1) remain as fallback
      }
    };

    void restoreTranscript();
  }, [isLoaded, isSignedIn, conversationMode]);

  // Conversation mode: load the selected conversation's messages whenever the
  // current id changes. A null id (new chat) clears the transcript. The
  // conversation we just created locally is skipped via loadedConvRef so a fresh
  // first-message exchange isn't clobbered by a server re-fetch.
  useEffect(() => {
    if (!conv) return;
    // Temporary ("incognito") mode never reads persisted conversation history —
    // even if the user selects a prior conversation, we keep a blank slate so
    // long-term content can't leak into an incognito turn (it would otherwise be
    // re-sent as `body.messages`).
    if (temporaryRef.current) {
      loadedConvRef.current = null;
      documentRefsRef.current = [];
      conversationSummaryRef.current = "";
      summarizedUpToRef.current = 0;
      setMessages([]);
      return;
    }
    const id = conv.currentConversationId;
    if (id == null) {
      loadedConvRef.current = null;
      documentRefsRef.current = [];
      conversationSummaryRef.current = "";
      summarizedUpToRef.current = 0;
      setMessages([]);
      return;
    }
    if (id === loadedConvRef.current) return;
    loadedConvRef.current = id;
    // Switching conversations: the prior conversation's upload refs and rolling
    // summary no longer apply (they belong to a different transcript).
    documentRefsRef.current = [];
    conversationSummaryRef.current = "";
    summarizedUpToRef.current = 0;
    // Snapshot the edit generation before fetching. If the user types/sends a
    // message while this GET is in flight, editGenRef advances and we discard the
    // (now stale) server payload rather than overwriting the unsaved local edit.
    const genAtStart = editGenRef.current;

    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`${BASE}/api/ora/conversations/${id}`);
        if (!res.ok) return;
        const data = (await res.json()) as { conversation: { messages: OraMessage[] } };
        if (!cancelled && loadedConvRef.current === id && editGenRef.current === genAtStart) {
          setMessages(data.conversation.messages ?? []);
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conv, conv?.currentConversationId]);

  const uploadFile = useCallback(
    async (file: File) => {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setUploadState("error");
        setUploadError(
          `Unsupported file type "${ext}". Please upload a PDF, DOCX, PPTX, TXT, CSV, XLSX, PNG, JPG, or WEBP file.`,
        );
        return;
      }

      const isImg = isImageExt(ext);

      if (isImg) {
        // Anonymous-session image cap applies ONLY to not-signed-in visitors.
        // Signed-in users are unlimited on the backend, so don't block them on
        // the per-session counter here.
        if (
          !isSignedIn &&
          session &&
          (session.imageCount ?? 0) >= (session.imageLimit ?? IMAGE_LIMIT)
        ) {
          setUploadState("error");
          setUploadError(
            `Image limit reached (${session.imageLimit ?? IMAGE_LIMIT}/${session.imageLimit ?? IMAGE_LIMIT}). Start a new session to upload more images.`,
          );
          return;
        }
      } else {
        // File size cap applies to everyone (signed-in or not).
        if (file.size > MAX_FILE_SIZE) {
          setUploadState("error");
          setUploadError(
            `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 10 MB.`,
          );
          return;
        }
        // Anonymous-session file count cap applies ONLY to not-signed-in visitors.
        if (!isSignedIn && session && session.fileCount >= session.fileLimit) {
          setUploadState("error");
          setUploadError(
            `File limit reached (${session.fileLimit}/${session.fileLimit}). Start a new session to upload more files.`,
          );
          return;
        }
      }

      setUploadState("uploading");
      setUploadError(null);

      try {
        // Compress images client-side before upload so large phone photos (4-6 MB)
        // are automatically resized to ≤ 1920 px and re-encoded at high quality.
        const uploadBlob = isImg ? await compressImageForUpload(file) : file;

        // Final size check after compression — catches truly enormous files
        if (isImg && uploadBlob.size > MAX_IMAGE_SIZE) {
          setUploadState("error");
          setUploadError(
            `Image is too large even after compression (${(uploadBlob.size / 1024 / 1024).toFixed(1)} MB). Please crop it first.`,
          );
          return;
        }

        // When compressImageForUpload re-encodes a .webp as image/jpeg, the
        // server's magic-byte validator would reject JPEG bytes under a .webp
        // name. Rename the file to .jpg in that case so the extension matches.
        const uploadName = (() => {
          if (uploadBlob === (file as Blob)) return file.name;
          if (uploadBlob.type === "image/jpeg" && !/\.(jpe?g)$/i.test(file.name)) {
            return file.name.replace(/\.[^.]+$/, ".jpg");
          }
          return file.name;
        })();

        const formData = new FormData();
        formData.append("file", uploadBlob, uploadName);

        const res = await authFetch(`${BASE}/api/public-ai/upload`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Upload failed (HTTP ${res.status})`);
        }

        const data = (await res.json()) as {
          fileRef?: string;
          imageRef?: string;
          filename: string;
          fileType: string;
          charCount?: number;
          rowCount?: number;
          colCount?: number;
          truncated?: boolean;
          sanitizedCells?: number;
          hiddenSheetsSkipped?: number;
          fileCount?: number;
          fileLimit?: number;
          imageCount?: number;
          imageLimit?: number;
          sizeBytes?: number;
          width?: number;
          height?: number;
        };

        if (data.fileType === "image") {
          setAttachedFile({
            fileRef: data.imageRef ?? "",
            filename: data.filename,
            fileType: data.fileType,
            charCount: 0,
            isDataset: false,
            isImage: true,
            sizeBytes: data.sizeBytes,
            width: data.width,
            height: data.height,
          });
          setUploadState("attached");
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  imageCount: data.imageCount ?? (prev.imageCount ?? 0) + 1,
                  imageLimit: data.imageLimit ?? prev.imageLimit ?? IMAGE_LIMIT,
                }
              : null,
          );
        } else {
          const isDataset = data.fileType === "csv" || data.fileType === "xlsx";
          setAttachedFile({
            fileRef: data.fileRef ?? "",
            filename: data.filename,
            fileType: data.fileType,
            charCount: data.charCount ?? 0,
            isDataset,
            rowCount: data.rowCount,
            colCount: data.colCount,
            truncated: data.truncated,
            sanitizedCells: data.sanitizedCells,
            hiddenSheetsSkipped: data.hiddenSheetsSkipped,
          });
          setUploadState("attached");
          // Remember non-image upload refs (documents AND datasets) so later
          // plain chat turns can re-hydrate them for follow-up questions. Keep
          // only the most recent few (server caps re-hydration at 5).
          if (data.fileRef) {
            const next = [...documentRefsRef.current, data.fileRef];
            documentRefsRef.current = next.slice(-5);
          }
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  fileCount: data.fileCount ?? prev.fileCount,
                  fileLimit: data.fileLimit ?? prev.fileLimit,
                }
              : null,
          );
        }
      } catch (err: unknown) {
        const msg = (err as Error).message ?? "Upload failed. Please try again.";
        setUploadState("error");
        setUploadError(msg);
      }
    },
    [session, isSignedIn],
  );

  const clearAttachment = useCallback(() => {
    setAttachedFile(null);
    setUploadState("idle");
    setUploadError(null);
  }, []);

  const sendMessage = useCallback(
    async (content: string, opts?: { truncateTo?: number; editedFrom?: boolean }) => {
      if (!content.trim() || isLoading) return;

      const currentAttachment = attachedFile;
      const baseMessages =
        opts?.truncateTo !== undefined ? messages.slice(0, opts.truncateTo) : messages;

      const userMsg: OraMessage = {
        role: "user",
        content,
        ...(currentAttachment
          ? {
              hadAttachment: true,
              attachment: {
                filename: currentAttachment.filename,
                fileType: currentAttachment.fileType,
                ...(currentAttachment.isImage ? { isImage: true } : {}),
                ...(currentAttachment.isDataset ? { isDataset: true } : {}),
              },
            }
          : {}),
        ...(opts?.editedFrom ? { editedFrom: true } : {}),
      };
      setMessages(() => {
        const next = [...baseMessages, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setIsLoading(true);
      setError(null);

      const history = baseMessages
        .slice(-RECENT_WINDOW)
        .map((m) => ({ role: m.role, content: m.content }));

      // Rolling summary bookkeeping (plain-chat path only). `windowStart` is the
      // index in baseMessages where the recent window begins; everything before
      // it has scrolled out of context. The unsummarized overflow is the range
      // [overflowStart, windowStart); we fold it in OLDEST-FIRST, at most
      // SUMMARIZE_BATCH_MAX turns per request, and advance the pointer only by
      // what we actually processed. This drains a large backlog (e.g. after a
      // reload resets the pointer) over successive turns instead of permanently
      // skipping the earliest turns.
      // Editing/resending an earlier message rewinds the transcript, so reset
      // the summary if the truncation point predates what we've summarized.
      if (opts?.truncateTo !== undefined && opts.truncateTo < summarizedUpToRef.current) {
        conversationSummaryRef.current = "";
        summarizedUpToRef.current = 0;
      }
      const windowStart = Math.max(0, baseMessages.length - RECENT_WINDOW);
      const overflowStart = Math.min(summarizedUpToRef.current, windowStart);
      const overflowEnd = Math.min(overflowStart + SUMMARIZE_BATCH_MAX, windowStart);
      const overflow = baseMessages
        .slice(overflowStart, overflowEnd)
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));

      const executeApiCall = async (): Promise<void> => {
        if (currentAttachment) {
          setAttachedFile(null);
          setUploadState("idle");

          const body: Record<string, unknown> = {
            message: content,
            messages: history,
          };
          if (language && language !== "auto") {
            body.language = language;
          } else {
            body.languageHint = navigator.language;
          }

          if (currentAttachment.isImage) {
            setPendingImageAnalysis(true);
            body.imageRef = currentAttachment.fileRef;

            const data = await apiPost<{
              reply: string;
              imageAnalysisCount: number;
              imageAnalysisLimit: number;
            }>("/api/public-ai/image-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.reply,
                  messageKind: "image-analysis" as const,
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    imageAnalysisCount: data.imageAnalysisCount,
                    imageAnalysisLimit: data.imageAnalysisLimit,
                  }
                : null,
            );
          } else if (currentAttachment.isDataset) {
            body.fileRef = currentAttachment.fileRef;
            const data = await apiPost<{
              result: DatasetAnalysisResult;
              msgCount: number;
              msgLimit: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/dataset-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.result.summary,
                  datasetResult: data.result,
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) => mergeUsage(prev, data));
          } else {
            body.fileRef = currentAttachment.fileRef;
            const data = await apiPost<{
              reply: string;
              msgCount: number;
              msgLimit: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/file-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.reply,
                  messageKind: "document-analysis" as const,
                  // Offer to persist a concise summary of this document to Ora's
                  // memory (opt-in). Only for signed-in users — anonymous
                  // visitors have no memory to save to. Carries only the
                  // ephemeral file ref + display name, never the bytes.
                  ...(isSignedIn && currentAttachment.fileRef
                    ? {
                        documentMemory: {
                          fileRef: currentAttachment.fileRef,
                          filename: currentAttachment.filename,
                        },
                      }
                    : {}),
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) => mergeUsage(prev, data));
          }
        } else {
          const useChatHistory = getReferenceChatHistory();
          const body: Record<string, unknown> = {
            message: content,
            messages: history,
            mode,
            referenceSavedMemories: getReferenceSavedMemories(),
            referenceChatHistory: useChatHistory,
          };
          // Temporary ("incognito") turn: the backend skips all memory/chat
          // history injection, cross-conversation recall, and memory-candidate
          // detection when this is set.
          if (temporaryRef.current) {
            body.temporary = true;
          }
          // Rolling summary: only relevant when chat history is on. Re-send the
          // current summary plus any newly overflowed turns to be folded into it.
          if (useChatHistory) {
            if (conversationSummaryRef.current) {
              body.conversationSummary = conversationSummaryRef.current;
            }
            if (overflow.length > 0) {
              body.summarizeMessages = overflow;
            }
          }
          // Anchor the chat to its Ora project (if any) so the backend can inject
          // that project's persistent memories. Prefer the conversation's own
          // project, falling back to the active route project.
          const activeConv = convRef.current;
          const chatOraProjectId =
            activeConv?.conversations.find((c) => c.id === activeConv.currentConversationId)
              ?.projectId ??
            activeConv?.activeProjectId ??
            null;
          if (typeof chatOraProjectId === "number") {
            body.oraProjectId = chatOraProjectId;
          }
          // Tell the backend which conversation this turn belongs to so
          // cross-conversation recall excludes the current conversation's own
          // summary (no self-recall).
          const currentConvId = activeConv?.currentConversationId;
          if (typeof currentConvId === "number") {
            body.conversationId = currentConvId;
          }
          if (documentRefsRef.current.length > 0) {
            body.documentRefs = documentRefsRef.current;
          }
          if (language && language !== "auto") {
            body.language = language;
          } else {
            body.languageHint = navigator.language;
          }
          type ChatResponseData = {
            reply: string;
            suggestions?: string[];
            fileName?: string;
            fileData?: string;
            mimeType?: string;
            imageUrl?: string;
            imageId?: number;
            memorySaveCandidate?: string;
            memorySaveCandidateConfidence?: "high" | "low";
            memorySaveCandidateSensitive?: boolean;
            sources?: OraSource[];
            images?: OraImage[];
            videos?: OraVideo[];
            conversationSummary?: string;
            memoriesUsed?: OraMemoryUsed[];
            msgCount: number;
            msgLimit: number;
            imageCount?: number;
            imageLimit?: number;
            resetsAt?: string | null;
            windowHours?: number;
          };

          const buildAssistantMsg = (d: ChatResponseData): OraMessage => ({
            role: "assistant",
            content: d.reply,
            suggestions: d.suggestions ?? [],
            ...(d.imageUrl ? { imageUrl: d.imageUrl } : {}),
            ...(d.imageId != null ? { imageId: d.imageId } : {}),
            ...(d.sources && d.sources.length > 0 ? { sources: d.sources } : {}),
            ...(d.images && d.images.length > 0 ? { images: d.images } : {}),
            ...(d.videos && d.videos.length > 0 ? { videos: d.videos } : {}),
            ...(d.memoriesUsed && d.memoriesUsed.length > 0
              ? { memoriesUsed: d.memoriesUsed }
              : {}),
            ...(d.conversationSummary ? { conversationSummary: d.conversationSummary } : {}),
            ...(d.memorySaveCandidate
              ? {
                  memorySaveCandidate: d.memorySaveCandidate,
                  ...(d.memorySaveCandidateConfidence
                    ? { memorySaveCandidateConfidence: d.memorySaveCandidateConfidence }
                    : {}),
                  ...(d.memorySaveCandidateSensitive ? { memorySaveCandidateSensitive: true } : {}),
                }
              : {}),
            ...(d.fileName && d.fileData && d.mimeType
              ? {
                  generatedFile: {
                    fileName: d.fileName,
                    fileData: d.fileData,
                    mimeType: d.mimeType,
                    format: d.fileName.split(".").pop() as GeneratedFile["format"],
                  } satisfies GeneratedFile,
                }
              : {}),
          });

          // Streaming-first: try /chat/stream, fall back to /chat on signal.
          // Abort any in-flight stream from a prior concurrent send.
          streamAbortRef.current?.abort();
          const streamAbort = new AbortController();
          streamAbortRef.current = streamAbort;

          let data: ChatResponseData;
          let usedStreaming = false;
          // Whether the AI provider delivered real incremental token streaming
          // (true = real SSE tokens, false = non-streaming provider wrapped in SSE).
          // Only meaningful when usedStreaming=true; irrelevant for /chat fallback.
          let isRealStreamingPayload = true;

          try {
            // Optimistically add a streaming placeholder that updates in real time.
            setMessages((prev) => [
              ...prev,
              { role: "assistant" as const, content: "", isStreaming: true },
            ]);

            const donePayload = await consumeOraStream(
              BASE,
              body,
              (delta) => {
                // flushSync forces React to commit this update synchronously,
                // bypassing automatic batching. Without it, when the Replit dev
                // proxy delivers all SSE frames in one TCP chunk, every onToken
                // call lands in the same event-loop turn and React 18 batches
                // them all into a single render — the entire response appears at
                // once instead of word-by-word.
                flushSync(() => {
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (!last || last.role !== "assistant" || !last.isStreaming) return prev;
                    return [
                      ...prev.slice(0, -1),
                      {
                        ...last,
                        content: last.content + delta,
                      },
                    ];
                  });
                });
              },
              streamAbort.signal,
            );

            isRealStreamingPayload = donePayload.isRealStreaming ?? true;
            data = donePayload as ChatResponseData;
            usedStreaming = true;
          } catch (streamErr: unknown) {
            const se = streamErr as {
              streamingFallback?: boolean;
              streamFallbackToken?: string;
              partialContent?: string;
              name?: string;
              status?: number;
            };

            if (se.name === "AbortError") {
              // Mid-stream navigation — abort cleanly, no error shown, and
              // remove any empty streaming placeholder.
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && last.isStreaming && !last.content)
                  return prev.slice(0, -1);
                return prev;
              });
              streamAbortRef.current = null;
              return;
            }

            if (se.partialContent !== undefined) {
              // SSE `error` event received after one or more tokens were already
              // emitted. Preserve the partial reply (mark it done) rather than
              // silently discarding it. Do NOT re-throw — the outer catch would
              // remove the user message too, leaving the thread with no trace.
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && last.isStreaming) {
                  return [...prev.slice(0, -1), { ...last, isStreaming: false }];
                }
                return prev;
              });
              setError("Ora's response was cut off. The partial reply above may be incomplete.");
              streamAbortRef.current = null;
              return; // Do not fall through to the outer catch
            }

            // Remove the empty streaming placeholder before any fallback/rethrow.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.isStreaming) return prev.slice(0, -1);
              return prev;
            });

            if (!se.streamingFallback) {
              // Real error (429, 401, network, etc.) — rethrow for the outer
              // catch block to surface the right message.
              streamAbortRef.current = null;
              throw streamErr;
            }

            // Streaming unavailable (503, specialist-tool signal, or error
            // before first token) — silently fall back to /chat.
            // streamFallbackToken (when present) proves to /chat that the
            // streaming route already pre-incremented the session counter so
            // it should not double-charge the anonymous-session slot.
            data = await apiPost<ChatResponseData>("/api/public-ai/chat", {
              ...body,
              ...(se.streamFallbackToken ? { streamFallbackToken: se.streamFallbackToken } : {}),
            });
          }

          streamAbortRef.current = null;

          // True when this reply bypassed real provider-level token streaming.
          // Covers both the /chat fallback path and SSE providers that wrap a
          // single non-streaming completion into the SSE envelope.
          const viaFallback = !usedStreaming || !isRealStreamingPayload;

          // Persist the rolling summary and advance the "already summarized"
          // pointer by exactly what we processed this turn (overflowEnd), so a
          // large backlog drains over successive turns without skipping the
          // earliest turns.
          if (data.conversationSummary !== undefined) {
            conversationSummaryRef.current = data.conversationSummary;
            summarizedUpToRef.current = overflowEnd;
          }

          if (usedStreaming) {
            // Patch the streaming placeholder with final metadata from the done event.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const finalMsg: OraMessage = {
                ...buildAssistantMsg(data),
                isStreaming: false,
                ...(viaFallback ? { viaFallback: true } : {}),
              };
              const next = [...prev.slice(0, -1), finalMsg];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
          } else {
            setMessages((prev) => {
              const next = [
                ...prev,
                { ...buildAssistantMsg(data), ...(viaFallback ? { viaFallback: true } : {}) },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
          }
          setSession((prev) => mergeUsage(prev, data));
        }
      };

      try {
        await executeApiCall();
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message;
        if (status === 429) {
          setError(msg ?? "You have reached the message limit for this session.");
        } else if (status === 401) {
          // Clear the expired session ID but keep the transcript — the conversation
          // history is still valid and will be re-sent with the new session.
          clearStoredSessionId();
          try {
            const data = await apiPost<{
              sessionId: string;
              msgCount: number;
              msgLimit: number;
              fileCount?: number;
              fileLimit?: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/session", {});
            storeSessionId(data.sessionId);
            setSession({
              sessionId: data.sessionId,
              msgCount: data.msgCount,
              msgLimit: data.msgLimit,
              fileCount: data.fileCount ?? 0,
              fileLimit: data.fileLimit ?? FILE_LIMIT,
              imageCount: data.imageCount ?? 0,
              imageLimit: data.imageLimit ?? IMAGE_LIMIT,
              resetsAt: data.resetsAt ?? null,
              windowHours: data.windowHours,
            });
            // Retry with the fresh session — return early so the user message
            // stays in state and no error is shown.
            await executeApiCall();
            return;
          } catch {
            // Retry failed; fall through to show error and remove user message.
          }
          setError(
            "Your session has expired. Please refresh the page to start a new conversation.",
          );
        } else if (status === 413) {
          setError("Your message is too large. Try breaking it into shorter parts.");
        } else if (status === 404 && currentAttachment) {
          setError(
            currentAttachment.isImage
              ? "This image has expired. Please upload it again."
              : "The attached file has expired. Please upload it again.",
          );
        } else {
          setError(msg ?? "Something went wrong. Please try again.");
          // For transient image-analysis failures (502, network, etc.) restore the chip
          // so the visitor can retry without re-uploading.
          if (currentAttachment?.isImage) {
            setAttachedFile(currentAttachment);
            setUploadState("attached");
          }
        }
        setMessages((prev) => {
          const next = prev.slice(0, -1);
          storeTranscript(next);
          return next;
        });
      } finally {
        setPendingImageAnalysis(false);
        setIsLoading(false);
      }
    },
    [isLoading, messages, language, attachedFile, isSignedIn, saveToServer, mode],
  );

  const generateFile = useCallback(
    async (content: string, format: FileFormat) => {
      if (!content.trim() || isLoading) return;

      const formatLabel = format.toUpperCase();
      const userMsg: OraMessage = {
        role: "user",
        content: `Create a ${formatLabel} file: ${content}`,
      };
      setMessages((prev) => {
        const next = [...prev, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setIsLoading(true);
      setError(null);

      try {
        const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
        const body: Record<string, unknown> = { message: content, messages: history, format };
        if (language && language !== "auto") {
          body.language = language;
        } else {
          body.languageHint = navigator.language;
        }
        // Carry any earlier-uploaded files so the file is built from real data.
        if (documentRefsRef.current.length > 0) {
          body.documentRefs = documentRefsRef.current;
        }

        const data = await apiPost<{
          reply: string;
          fileName: string;
          fileData: string;
          mimeType: string;
          msgCount: number;
          msgLimit: number;
          imageCount?: number;
          imageLimit?: number;
          resetsAt?: string | null;
          windowHours?: number;
        }>("/api/public-ai/generate-file", body);

        setMessages((prev) => {
          const next = [
            ...prev,
            {
              role: "assistant" as const,
              content: data.reply,
              generatedFile: {
                fileName: data.fileName,
                fileData: data.fileData,
                mimeType: data.mimeType,
                format,
              } satisfies GeneratedFile,
            },
          ];
          storeTranscript(next);
          if (isSignedIn) saveToServer(next);
          return next;
        });
        setSession((prev) => mergeUsage(prev, data));
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message;
        if (status === 429) {
          setError(msg ?? "You have reached the message limit for this session.");
        } else if (status === 401) {
          // Session expired — try refreshing the session cookie and retrying once.
          clearStoredSessionId();
          try {
            const refreshed = await apiPost<{
              sessionId: string;
              msgCount: number;
              msgLimit: number;
              fileCount?: number;
              fileLimit?: number;
            }>("/api/public-ai/session", {});
            storeSessionId(refreshed.sessionId);
            setSession({
              sessionId: refreshed.sessionId,
              msgCount: refreshed.msgCount,
              msgLimit: refreshed.msgLimit,
              fileCount: refreshed.fileCount ?? 0,
              fileLimit: refreshed.fileLimit ?? FILE_LIMIT,
            });
            // Retry the file generation with the fresh session
            const retryHistory = messages
              .slice(-10)
              .map((m) => ({ role: m.role, content: m.content }));
            const retryBody: Record<string, unknown> = {
              message: content,
              messages: retryHistory,
              format,
            };
            if (language && language !== "auto") {
              retryBody.language = language;
            } else {
              retryBody.languageHint = navigator.language;
            }
            // Carry any earlier-uploaded files so the file is built from real data.
            if (documentRefsRef.current.length > 0) {
              retryBody.documentRefs = documentRefsRef.current;
            }
            const retryData = await apiPost<{
              reply: string;
              fileName: string;
              fileData: string;
              mimeType: string;
              msgCount: number;
              msgLimit: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/generate-file", retryBody);
            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: retryData.reply,
                  generatedFile: {
                    fileName: retryData.fileName,
                    fileData: retryData.fileData,
                    mimeType: retryData.mimeType,
                    format,
                  } satisfies GeneratedFile,
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) => mergeUsage(prev, retryData));
            setIsLoading(false);
            return;
          } catch {
            // Retry failed; fall through to error state
          }
          setError(
            "Your session has expired. Please refresh the page to start a new conversation.",
          );
        } else {
          setError(msg ?? "File generation failed. Please try again.");
        }
        setMessages((prev) => {
          const next = prev.slice(0, -1);
          storeTranscript(next);
          return next;
        });
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, messages, language, isSignedIn, saveToServer],
  );

  // Inline image editing: refine an Ora-generated image with a text instruction.
  // Reuses the Image Studio edit pipeline (POST /images/:id/edit → poll status),
  // which records parent/source/instruction lineage while Ora consumes daily image quota.
  // The derived image carries its own generated_images id so it is re-editable.
  const editInlineImage = useCallback(
    async (sourceImageId: number, instruction: string) => {
      const trimmed = instruction.trim();
      if (!trimmed || isLoading) return;
      if (!isSignedIn) {
        setError("Sign in to edit images.");
        return;
      }

      const userMsg: OraMessage = { role: "user", content: `Edit image: ${trimmed}` };
      setMessages((prev) => {
        const next = [...prev, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setIsLoading(true);
      setError(null);

      try {
        const enqueueRes = await authFetch(`${BASE}/api/images/${sourceImageId}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: trimmed, quality: "standard", origin: "ora" }),
        });
        if (!enqueueRes.ok) {
          const data = (await enqueueRes.json().catch(() => ({}))) as { error?: string };
          throw Object.assign(new Error(data.error ?? `HTTP ${enqueueRes.status}`), {
            status: enqueueRes.status,
          });
        }
        const { jobId, imageId: newImageId } = (await enqueueRes.json()) as {
          jobId: string;
          imageId: number;
        };

        // Poll the in-process job until it completes (~90s ceiling).
        let fileUrl: string | null = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 1500));
          const statusRes = await authFetch(`${BASE}/api/images/status/${jobId}`);
          if (!statusRes.ok) continue;
          const s = (await statusRes.json()) as {
            status: string;
            fileUrl?: string | null;
            error?: string | null;
          };
          if (s.status === "completed") {
            fileUrl = s.fileUrl ?? null;
            break;
          }
          if (s.status === "failed") {
            throw new Error(s.error ?? "Image edit failed.");
          }
        }
        if (!fileUrl) throw new Error("Image edit timed out. Please try again.");

        // Always load the edited bytes through the authenticated file route
        // rather than trusting the returned fileUrl directly. The stored fileUrl
        // can be a private R2 S3 endpoint (when R2 is configured without a public
        // URL) which an <img src> cannot fetch — that produced a "completed" edit
        // that rendered as a broken image. The /file route resolves the bytes
        // from whichever backend holds them (dev tmpdir or authenticated R2).
        const imgRes = await authFetch(`${BASE}/api/images/${newImageId}/file`);
        if (!imgRes.ok) throw new Error("Could not load the edited image.");
        const blob = await imgRes.blob();
        if (blob.size === 0) throw new Error("The edited image was empty. Please try again.");
        // Persist as a self-contained data URL (not a session-local object URL)
        // so the edited image renders immediately AND survives a transcript
        // reload — mirroring inline generation, which persists the provider data
        // URI. An object URL would be revoked/invalid after refresh.
        const displayUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Could not read the edited image."));
          reader.readAsDataURL(blob);
        });

        setMessages((prev) => {
          const next = [
            ...prev,
            {
              role: "assistant" as const,
              content: "Here's the edited image. Tap Edit to refine it further.",
              imageUrl: displayUrl,
              imageId: newImageId,
              editInstruction: trimmed,
            } satisfies OraMessage,
          ];
          storeTranscript(next);
          if (isSignedIn) saveToServer(next);
          return next;
        });
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message;
        if (status === 402) {
          setError(msg ?? "Your plan does not allow this image edit right now.");
        } else if (status === 429) {
          setError(msg ?? "Image limit reached. Please try again later.");
        } else if (status === 422) {
          setError(msg ?? "This image can't be edited.");
        } else {
          setError(msg ?? "Failed to edit the image. Please try again.");
        }
        // Roll back the optimistic user message so the failed edit doesn't linger.
        setMessages((prev) => {
          const next = prev.slice(0, -1);
          storeTranscript(next);
          return next;
        });
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, isSignedIn, saveToServer],
  );

  const clearConversation = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    // Free any session-local edited-image blob URLs before the transcript that
    // referenced them is dropped, so they don't leak for the rest of the session.
    for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
    objectUrlsRef.current = [];

    // Conversation mode: starting a new chat just resets to a blank conversation
    // (current id → null). The prior conversation stays in the sidebar; nothing
    // is deleted server-side and the rate-limit session is preserved.
    if (convRef.current) {
      loadedConvRef.current = null;
      documentRefsRef.current = [];
      conversationSummaryRef.current = "";
      summarizedUpToRef.current = 0;
      setMessages([]);
      setError(null);
      setSessionExpired(false);
      setAttachedFile(null);
      setUploadState("idle");
      setUploadError(null);
      convRef.current.newConversation();
      return;
    }

    clearStoredTranscript();
    clearStoredSessionId();
    documentRefsRef.current = [];
    conversationSummaryRef.current = "";
    summarizedUpToRef.current = 0;
    setMessages([]);
    setError(null);
    setSessionExpired(false);
    setAttachedFile(null);
    setUploadState("idle");
    setUploadError(null);
    if (isSignedIn) {
      try {
        await apiDelete("/api/ora/transcript");
      } catch {
        /* best-effort */
      }
    }
    transcriptRestoredRef.current = false;
    try {
      const data = await apiPost<{
        sessionId: string;
        msgCount: number;
        msgLimit: number;
        fileCount?: number;
        fileLimit?: number;
        imageCount?: number;
        imageLimit?: number;
        resetsAt?: string | null;
        windowHours?: number;
      }>("/api/public-ai/session", {});
      storeSessionId(data.sessionId);
      setSession({
        sessionId: data.sessionId,
        msgCount: data.msgCount,
        msgLimit: data.msgLimit,
        fileCount: data.fileCount ?? 0,
        fileLimit: data.fileLimit ?? FILE_LIMIT,
        imageCount: data.imageCount ?? 0,
        imageLimit: data.imageLimit ?? IMAGE_LIMIT,
        resetsAt: data.resetsAt ?? null,
        windowHours: data.windowHours,
      });
    } catch {
      /* best-effort */
    }
  }, [isSignedIn]);

  const atLimit = (session?.msgCount ?? 0) >= (session?.msgLimit ?? 20);

  // Mark a message's memory candidate as saved: flips memorySaved on, drops the
  // candidate so the inline save chip collapses to a confirmation, and persists
  // the transcript so the saved state survives reload.
  const markMemorySaved = useCallback(
    (candidate: string, content: string, supersededTitles: string[] = []) => {
      setMessages((prev) => {
        // Match by content identity, not array index: the transcript can be
        // truncated/rebased (edit flow) between scheduling a save and it
        // resolving, so an index captured earlier may point at a different
        // message by the time we mark it.
        const matchIdx = prev.findIndex(
          (m) =>
            m.role === "assistant" &&
            !m.memorySaved &&
            m.memorySaveCandidate === candidate &&
            m.content === content,
        );
        if (matchIdx === -1) return prev;
        const next = prev.map((m, i) =>
          i === matchIdx
            ? {
                ...m,
                memorySaved: true,
                memorySaveCandidate: undefined,
                ...(supersededTitles.length > 0
                  ? { memorySupersededTitles: supersededTitles }
                  : {}),
              }
            : m,
        );
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
    },
    [isSignedIn, saveToServer],
  );

  // Mark a document-analysis message's memory as saved: flips documentMemorySaved
  // on and persists the transcript so the "saved" state survives reload. Matched
  // by fileRef identity so a transcript edit/rebase can't target the wrong row.
  const markDocumentMemorySaved = useCallback(
    (fileRef: string) => {
      setMessages((prev) => {
        const matchIdx = prev.findIndex(
          (m) =>
            m.role === "assistant" &&
            !m.documentMemorySaved &&
            m.documentMemory?.fileRef === fileRef,
        );
        if (matchIdx === -1) return prev;
        const next = prev.map((m, i) => (i === matchIdx ? { ...m, documentMemorySaved: true } : m));
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
    },
    [isSignedIn, saveToServer],
  );

  // Toggling temporary mode always resets to a clean slate so an incognito
  // session never mixes with a persisted conversation (and vice-versa). Any
  // pending debounced save is cancelled first.
  const setTemporary = useCallback((value: boolean) => {
    setTemporaryState(value);
    temporaryRef.current = value;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    editGenRef.current += 1;
    loadedConvRef.current = null;
    documentRefsRef.current = [];
    conversationSummaryRef.current = "";
    summarizedUpToRef.current = 0;
    for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
    objectUrlsRef.current = [];
    setMessages([]);
    setError(null);
    setSessionExpired(false);
    setAttachedFile(null);
    setUploadState("idle");
    setUploadError(null);
    if (convRef.current) {
      convRef.current.newConversation();
    }
  }, []);

  const retryLastMessage = useCallback(async () => {
    if (isLoading) return;
    const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
    if (lastUserIdx === -1) return;
    const lastUserMsg = messages[lastUserIdx];
    if (!lastUserMsg?.content.trim()) return;
    setError(null);
    await sendMessage(lastUserMsg.content, { truncateTo: lastUserIdx });
  }, [messages, isLoading, sendMessage]);

  const oraStatus = deriveOraStatus(
    isLoading,
    uploadState,
    attachedFile,
    pendingImageAnalysis,
    messages,
  );

  return {
    messages,
    session,
    isLoading,
    error,
    atLimit,
    language,
    setLanguage,
    mode,
    setMode,
    sendMessage,
    generateFile,
    editInlineImage,
    clearError: () => setError(null),
    uploadFile,
    clearAttachment,
    attachedFile,
    uploadState,
    uploadError,
    clearUploadError: () => setUploadError(null),
    oraStatus,
    clearConversation,
    sessionExpired,
    dismissSessionExpired: () => setSessionExpired(false),
    markMemorySaved,
    markDocumentMemorySaved,
    temporary,
    setTemporary,
    retryLastMessage,
  };
}
