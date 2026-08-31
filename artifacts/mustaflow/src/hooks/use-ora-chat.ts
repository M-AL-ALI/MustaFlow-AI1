import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { useUser } from "@clerk/react";
import type {
  OraFileEditQuality,
  OraClarificationKind,
  OraPendingClarification,
  OraUsedFile,
  OraFileCitation,
  OraFileAgentPreview,
  OraActivityStep,
  OraRealtimeToolWrittenResult,
} from "@workspace/ora-contracts";
import {
  oraActivityStep,
  oraActivityToolForRoutedTool,
  oraAnalyzingDatasetText,
  oraReadingFileText,
  parseOraActivityStep,
  ORA_ANALYZING_IMAGE_TEXT,
  isSuccessfulOraGeneratedFilePayload,
  isOraUploadedImageEditRequest,
  resolveOraFileFormatRequest,
} from "@workspace/ora-contracts";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import { authFetch } from "@/lib/api-fetch";
import { uploadAccountAsset } from "@/lib/asset-upload";
import { markOraActive } from "@/lib/ora-idle-reset";
import { useOraConversationsOptional } from "@/hooks/ora-conversations-context";
import { getReferenceSavedMemories, getReferenceChatHistory } from "@/lib/ora-memory-settings";
import {
  clearedOraActivity,
  reduceOraActivity,
  type OraActivityTraceStep,
} from "@/lib/ora-activity";

export type FileFormat = import("@workspace/ora-contracts").FileFormat;

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
  /**
   * Durable library asset id. Present for files generated while signed in and,
   * unlike `fileData`, persisted with the message — so a reloaded card can still
   * download via /api/ora/assets/:id/download when the inline bytes are gone.
   */
  assetId?: number;
  /**
   * Edit-quality transparency metadata for file edits (Phase A quality card).
   * Persisted with the message (small display fields only) so the card
   * survives reload alongside the file metadata.
   */
  editQuality?: OraFileEditQuality;
}

export interface OraSource {
  title: string;
  url: string;
  /** Publication/last-updated date reported by the search provider (display string). */
  date?: string;
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
  /** Generation profile surfaced for UI chips and persisted history. */
  imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };
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
  /** True when this assistant row represents a recoverable request failure. */
  error?: boolean;
  /** Saved Ora memories that shaped this reply (Ora-scoped only). */
  memoriesUsed?: OraMemoryUsed[];
  /**
   * Uploaded files this reply drew on and their planned roles (Phase 5
   * multi-file intelligence) — drives the "Used: report.docx + budget.xlsx"
   * chips under the reply. Metadata only, never bytes.
   */
  usedFiles?: OraUsedFile[];
  /**
   * Phase 8: verified uploaded-file citations (file + slide/sheet locator),
   * derived server-side against the injected file content — never
   * model-claimed. Drives the "From your files" chips under the reply.
   */
  fileCitations?: OraFileCitation[];
  fileAgentPreview?: OraFileAgentPreview;
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
  /**
   * Legacy flag from older transcripts where live web search failed but Ora
   * returned a general-knowledge answer. New search failures render an inline
   * retryable error bubble instead of an uncited fallback answer.
   */
  searchFallback?: boolean;
  /**
   * True when a live-search reply/error can be retried with the search tool
   * pinned instead of re-classifying the message.
   */
  searchRetryable?: boolean;
  /**
   * True when this assistant reply is a clarifying question about an ambiguous
   * uploaded-file edit request instead of an executed edit. The user's next
   * message is sent with the round-tripped pending task context so the server
   * can merge the answer with the original ask and execute it.
   */
  needsClarification?: boolean;
  /** Which ambiguity triggered the clarifying question (analytics/UI hints). */
  clarificationKind?: OraClarificationKind;
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

/**
 * The subset of chat context required to mint a "Talk to Ora" realtime session
 * with every Ora rule preserved (temporary chat, saved-memory opt-in, the active
 * Ora project for memory injection, the current conversation, and the selected
 * language). Derived from the exact same internal state the `/chat` body uses so
 * isolation/memory behavior stays in a single place.
 */
/**
 * The visitor's IANA timezone (e.g. "America/New_York"), resolved from the
 * browser and wrapped in try/catch because some engines can throw. Sent with
 * every Ora request so the backend renders the user's local date/time in the
 * authoritative date/time block. Returns undefined when unavailable — the field
 * is optional server-side and simply omitted from the JSON payload.
 */
export function clientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export interface OraRealtimeContext {
  temporary: boolean;
  referenceSavedMemories: boolean;
  oraProjectId: number | null;
  conversationId: number | null;
  /** Selected language code; omitted when the user is on "auto". */
  language?: string;
  /** Browser language label, sent only when no explicit language is selected. */
  languageHint?: string;
  /** IANA timezone resolved from the browser; used for local date/time. */
  timeZone?: string;
  /**
   * The most recent user utterance from the text conversation, forwarded ONLY as
   * a ranking hint for saved-memory recall (the realtime session has no "current
   * message" of its own at start). Omitted when there is no prior user turn.
   */
  message?: string;
  /**
   * A bounded snapshot of the recent text conversation so the spoken session
   * continues with the same context the user already sees. Seeded client-side as
   * lower-authority realtime conversation items, never as system instructions.
   */
  history?: { role: "user" | "assistant"; content: string }[];
  /** Uploaded-file refs available to the realtime file tool. */
  documentRefs?: string[];
}

export interface UseOraChatReturn {
  messages: OraMessage[];
  session: OraSession | null;
  isLoading: boolean;
  /** Live work narration from SSE `status` events (repo analysis etc.). */
  streamStatus: string | null;
  /**
   * Live activity trace for the in-flight turn: the animated, step-by-step
   * "what Ora is doing" line (web search, file generation, image generation,
   * repo analysis, file reading). Bounded, newest last; empty when idle.
   * Cleared on the first real answer token.
   */
  activitySteps: OraActivityTraceStep[];
  error: string | null;
  atLimit: boolean;
  language: string;
  setLanguage: (lang: string) => void;
  mode: OraMode;
  setMode: (mode: OraMode) => void;
  sendMessage: (
    content: string,
    opts?: { truncateTo?: number; editedFrom?: boolean; forceSearch?: boolean },
  ) => Promise<void>;
  generateFile: (content: string, format: string, activeAssetId?: number | null) => Promise<void>;
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
  /**
   * Append a finalized realtime-voice turn (a single message) to the transcript
   * WITHOUT a server inference call or per-message quota charge. "Talk to Ora"
   * realtime mode already has the model's spoken reply locally; this only
   * persists the turn into the existing conversation history (sessionStorage +
   * the race-safe debounced server save). No-op for blank content.
   */
  appendVoiceMessage: (role: "user" | "assistant", content: string) => void;
  /** Mirror a rich voice-tool result into the normal persisted chat thread. */
  appendVoiceToolResult: (result: OraRealtimeToolWrittenResult) => void;
  /**
   * Snapshot the current chat context (temporary mode, saved-memory opt-in,
   * active Ora project, conversation, and language) for minting a realtime
   * "Talk to Ora" session. Mirrors how the `/chat` request body is built so all
   * Ora memory/isolation rules are preserved without duplicating the logic.
   */
  getRealtimeContext: () => OraRealtimeContext;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "ora_session_id";
const TRANSCRIPT_STORAGE_KEY = "ora_transcript";

// Raw browser network failures ("Failed to fetch", "Load failed") are cryptic
// and alarming when shown verbatim in the error banner. Normalize them into
// one friendly, retryable message. Publishing restarts the server for a short
// window, so this is the error visitors are most likely to hit right after a
// deploy.
const NETWORK_ERROR_MESSAGE =
  "Could not reach Ora — please check your connection and try again in a moment.";

function isNetworkFetchError(err: unknown): boolean {
  // Caller-initiated aborts (navigation, unmount) are not network failures.
  if (err instanceof DOMException && err.name === "AbortError") return false;
  return (
    err instanceof TypeError ||
    (err instanceof Error &&
      /failed to fetch|load failed|networkerror|network request failed/i.test(err.message))
  );
}

/**
 * authFetch wrapper that converts low-level network rejections into a single
 * friendly error carrying `network: true`, so callers can distinguish "the
 * server never received this" (retryable) from an HTTP-level error.
 */
async function safeAuthFetch(input: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await authFetch(input, init);
  } catch (err: unknown) {
    if (isNetworkFetchError(err)) {
      throw Object.assign(new Error(NETWORK_ERROR_MESSAGE), { network: true });
    }
    throw err;
  }
}

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

const DOC_ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".xlsx", ".pptx", ".zip"];
const IMAGE_ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const ALLOWED_EXTENSIONS = [...DOC_ALLOWED_EXTENSIONS, ...IMAGE_ALLOWED_EXTENSIONS];

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB for documents
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

// Uploaded-document refs are persisted (cache-only) so a page reload doesn't
// lose track of which files a follow-up "Revise the deck ..." should target —
// without them the server regenerates from scratch instead of editing the
// user's original file. Keyed per conversation ("conv:<id>"), with
// "standalone" for non-conversation chat. Stale refs are harmless: the server
// skips refs it can't resolve.
const DOC_REFS_STORAGE_KEY = "ora_doc_refs";
const DOC_REFS_STANDALONE_KEY = "standalone";
const DOC_REFS_MAX_KEYS = 20;

function docRefsKey(conversationId: number | null | undefined): string {
  return typeof conversationId === "number" ? `conv:${conversationId}` : DOC_REFS_STANDALONE_KEY;
}

function readDocRefsMap(): Record<string, string[]> {
  try {
    const raw = sessionStorage.getItem(DOC_REFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        map[key] = value.filter((v): v is string => typeof v === "string");
      }
    }
    return map;
  } catch {
    return {};
  }
}

function getStoredDocumentRefs(key: string): string[] {
  return readDocRefsMap()[key] ?? [];
}

function storeDocumentRefs(key: string, refs: string[]): void {
  try {
    const map = readDocRefsMap();
    if (refs.length === 0) {
      delete map[key];
    } else {
      map[key] = refs.slice(-5);
    }
    // Cap tracked conversations so the map can't grow without bound.
    const keys = Object.keys(map);
    if (keys.length > DOC_REFS_MAX_KEYS) {
      for (const stale of keys.slice(0, keys.length - DOC_REFS_MAX_KEYS)) delete map[stale];
    }
    if (Object.keys(map).length === 0) {
      sessionStorage.removeItem(DOC_REFS_STORAGE_KEY);
    } else {
      sessionStorage.setItem(DOC_REFS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    /* ignore */
  }
}

function clearAllStoredDocumentRefs(): void {
  try {
    sessionStorage.removeItem(DOC_REFS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// Pending clarification context is persisted (cache-only, same keying as doc
// refs) so a reload between Ora's clarifying question and the user's answer
// doesn't lose the original task — without it the answer ("Keep the original
// layout...") would be executed as a brand-new standalone message.
const PENDING_CLARIFICATION_STORAGE_KEY = "ora_pending_clarification";

function readPendingClarificationMap(): Record<string, OraPendingClarification> {
  try {
    const raw = sessionStorage.getItem(PENDING_CLARIFICATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, OraPendingClarification> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { originalMessage?: unknown }).originalMessage === "string" &&
        typeof (value as { kind?: unknown }).kind === "string"
      ) {
        map[key] = value as OraPendingClarification;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function getStoredPendingClarification(key: string): OraPendingClarification | null {
  return readPendingClarificationMap()[key] ?? null;
}

function storePendingClarification(key: string, pending: OraPendingClarification | null): void {
  try {
    const map = readPendingClarificationMap();
    if (pending == null) {
      delete map[key];
    } else {
      map[key] = pending;
    }
    const keys = Object.keys(map);
    if (keys.length > DOC_REFS_MAX_KEYS) {
      for (const stale of keys.slice(0, keys.length - DOC_REFS_MAX_KEYS)) delete map[stale];
    }
    if (Object.keys(map).length === 0) {
      sessionStorage.removeItem(PENDING_CLARIFICATION_STORAGE_KEY);
    } else {
      sessionStorage.setItem(PENDING_CLARIFICATION_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    /* ignore */
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  // authFetch (not raw fetch) so a fresh Clerk bearer token is attached: the
  // dev-mode JWT cookie expires ~60s and is unreliable in the preview iframe,
  // and /public-ai/chat resolves auth from getAuth(req). A cookie-only call
  // makes a signed-in user look anonymous, so Ora wrongly hedges "sign in first".
  const res = await safeAuthFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      searchRetryable?: boolean;
    };
    // Carry searchRetryable so the caller can distinguish a recoverable
    // live-search double-failure (keep the message, offer Retry) from a hard error.
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), {
      status: res.status,
      ...(data.searchRetryable ? { searchRetryable: true } : {}),
    });
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await safeAuthFetch(`${BASE}${path}`, {
    method: "GET",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

async function apiDelete(path: string): Promise<void> {
  const res = await safeAuthFetch(`${BASE}${path}`, {
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
  imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };
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
  usedFiles?: OraUsedFile[];
  fileCitations?: OraFileCitation[];
  fileAgentPreview?: OraFileAgentPreview;
  conversationSummary?: string;
  searchFallback?: boolean;
  searchRetryable?: boolean;
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
    ...(m.imageMeta ? { imageMeta: m.imageMeta } : {}),
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
    // Persist which uploaded files the reply drew on so the chips survive reload
    ...(m.usedFiles && m.usedFiles.length > 0 ? { usedFiles: m.usedFiles } : {}),
    // Persist verified file citations so the "From your files" chips survive reload
    ...(m.fileCitations && m.fileCitations.length > 0 ? { fileCitations: m.fileCitations } : {}),
    // Persist file/data agent preview metadata so quality planning survives reload
    ...(m.fileAgentPreview ? { fileAgentPreview: m.fileAgentPreview } : {}),
    // Persist the rolling summary so it can be re-sent after a reload
    ...(m.conversationSummary ? { conversationSummary: m.conversationSummary } : {}),
    // Persist legacy search-fallback/retry flags so older transcripts survive reload
    ...(m.searchFallback ? { searchFallback: true } : {}),
    ...(m.searchRetryable ? { searchRetryable: true } : {}),
    // Persist the clarifying-question flags so the state survives reload
    ...(m.needsClarification ? { needsClarification: true } : {}),
    ...(m.clarificationKind ? { clarificationKind: m.clarificationKind } : {}),
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
  /** Phase 8: verified uploaded-file citations derived server-side. */
  fileCitations?: OraFileCitation[];
  mode?: "instant" | "deep";
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  isRealStreaming?: boolean;
  // Present only when the server's false-delivery safety net generated a real
  // file after the streamed reply claimed one was attached.
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  assetId?: number;
  // Server-reported timing (mirrors backend OraStreamDonePayload.serverDiag).
  serverDiag?: {
    ttftMs?: number | null;
    totalMs?: number | null;
    provider?: string | null;
    routeTier?: string | null;
    fastLane?: boolean | null;
    // Phase 3 route diagnostics (static templates/enums only, no user content).
    routedTool?: string | null;
    searchUsed?: boolean | null;
    classifierSkipped?: boolean | null;
    classifierMs?: number | null;
    routeReason?: string | null;
    inferredFileFormat?: string | null;
    conflictResolution?: string | null;
  };
}

// ── Per-response developer diagnostics ─────────────────────────────────────
// Mirrors the mobile StreamChatDiagnostics shape (artifacts/ora-mobile/lib/api.ts)
// so website, landing-page bubble, and mobile all surface the same signals.
export interface OraStreamDiagnostics {
  /** "instant" | "deep" | "unknown" — the mode sent to the backend. */
  mode: string;
  /** ms from send to the first streamed token (client-measured). */
  tapToFirstTokenMs: number | null;
  /** ms from send to the first sentence-ending token (client-measured). */
  firstSentenceMs: number | null;
  /** ms from send to stream completion (client-measured). */
  completeMs: number | null;
  /** Number of streamed token events received. */
  tokenCount: number;
  /** True when the reply came via the non-streaming /chat fallback. */
  viaFallback: boolean;
  /** Server-measured TTFT in ms (t0 to first token). */
  serverTtftMs: number | null;
  /** Server-measured total request time in ms. */
  serverTotalMs: number | null;
  /** Provider that served the response (e.g. "gemini", "openai"). */
  serverProvider: string | null;
  /** Route tier chosen by the server (fast / premium / deep). */
  serverRouteTier: string | null;
  /** True when the server took the fast-lane path (classifier skipped). */
  serverFastLane: boolean | null;
  /** Unix ms when this record was captured. */
  capturedAt: number;
}

/**
 * Pure mapper that assembles an {@link OraStreamDiagnostics} record from the
 * client-measured timings and the server-reported `serverDiag` block. Exported
 * for direct unit testing (SSE consumption is hard to test end-to-end).
 */
export function mapOraStreamDiagnostics(input: {
  mode?: unknown;
  tapToFirstTokenMs: number | null;
  firstSentenceMs: number | null;
  completeMs: number | null;
  tokenCount: number;
  viaFallback: boolean;
  serverDiag?: StreamDonePayload["serverDiag"];
  capturedAt?: number;
}): OraStreamDiagnostics {
  const sd = input.serverDiag;
  return {
    mode: typeof input.mode === "string" ? input.mode : "unknown",
    tapToFirstTokenMs: input.tapToFirstTokenMs,
    firstSentenceMs: input.firstSentenceMs,
    completeMs: input.completeMs,
    tokenCount: input.tokenCount,
    viaFallback: input.viaFallback,
    serverTtftMs: sd?.ttftMs ?? null,
    serverTotalMs: sd?.totalMs ?? null,
    serverProvider: sd?.provider ?? null,
    serverRouteTier: sd?.routeTier ?? null,
    serverFastLane: sd?.fastLane ?? null,
    capturedAt: input.capturedAt ?? Date.now(),
  };
}

let _lastOraStreamDiag: OraStreamDiagnostics | null = null;

/** Returns diagnostics from the most recent Ora chat turn, or null. */
export function getLastOraStreamDiagnostics(): OraStreamDiagnostics | null {
  return _lastOraStreamDiag;
}

/** Overwrites the last-turn diagnostics record (used by the chat hook). */
export function setLastOraStreamDiagnostics(diag: OraStreamDiagnostics | null): void {
  _lastOraStreamDiag = diag;
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
  onStatus?: (text: string) => void,
  onActivity?: (step: OraActivityStep) => void,
): Promise<StreamDonePayload> {
  const res = await safeAuthFetch(`${base}/api/public-ai/chat/stream`, {
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
      tool?: string;
    };
    // Specialist-tool bounce: the JSON signal names the tool the /chat retry is
    // about to run, so surface the matching "start" activity step now — the
    // trace shows "Searching the web…" / "Generating your file…" for the whole
    // non-streaming wait. Uses the shared wording map (web/mobile identical).
    const bouncedTool = oraActivityToolForRoutedTool(data.tool);
    if (data.streamingFallback && bouncedTool) {
      onActivity?.(oraActivityStep(bouncedTool, "start"));
    }
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
  // Client-measured diagnostics (mirrors mobile StreamChatDiagnostics timing).
  const callStart = Date.now();
  let tokenCount = 0;
  let firstTokenMs: number | null = null;
  let firstSentenceMs: number | null = null;

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err: unknown) {
      // A mid-stream connection drop rejects reader.read() with a raw browser
      // error that bypasses safeAuthFetch (which only wraps the initial
      // fetch). Normalize it here too, preserving any tokens already shown so
      // the caller keeps the partial reply instead of discarding it.
      if (isNetworkFetchError(err)) {
        throw Object.assign(new Error(NETWORK_ERROR_MESSAGE), {
          network: true,
          ...(firstTokenReceived ? { partialContent: accumulated } : {}),
        });
      }
      throw err;
    }
    const { value, done } = chunk;
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
      } else if (eventType === "status") {
        onStatus?.((parsed as { text: string }).text);
      } else if (eventType === "activity") {
        // Typed live activity trace step (tool + start/ok/fail + human line).
        // Malformed frames are dropped — activity is display-only.
        const step = parseOraActivityStep(parsed);
        if (step) onActivity?.(step);
      } else if (eventType === "token") {
        const text = (parsed as { text: string }).text;
        firstTokenReceived = true;
        tokenCount += 1;
        if (firstTokenMs === null) firstTokenMs = Date.now() - callStart;
        accumulated += text;
        if (firstSentenceMs === null && /[.!?]/.test(accumulated)) {
          firstSentenceMs = Date.now() - callStart;
        }
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
  setLastOraStreamDiagnostics(
    mapOraStreamDiagnostics({
      mode: body.mode,
      tapToFirstTokenMs: firstTokenMs,
      firstSentenceMs,
      completeMs: Date.now() - callStart,
      tokenCount,
      viaFallback: false,
      serverDiag: donePayload.serverDiag,
    }),
  );
  return donePayload;
}

export function useOraChat(): UseOraChatReturn {
  const { isLoaded, isSignedIn } = useUser();
  const [messages, setMessages] = useState<OraMessage[]>([]);
  // Latest transcript kept in a ref so getRealtimeContext() can snapshot the
  // recent history + last user utterance without being in its dependency array.
  const messagesRef = useRef<OraMessage[]>([]);
  messagesRef.current = messages;
  const [session, setSession] = useState<OraSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Live work narration from SSE `status` events (repo analysis etc.) —
  // shown in place of the generic "thinking" indicator, cleared on first token.
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  // Live activity trace for the in-flight turn (typed tool steps). A living
  // line, not a log: pushActivity folds a step into the bounded trace and
  // clearActivity empties it (first token, turn end, errors).
  const [activitySteps, setActivitySteps] = useState<OraActivityTraceStep[]>([]);
  const pushActivity = useCallback((step: OraActivityStep) => {
    setActivitySteps((prev) => reduceOraActivity(prev, step));
  }, []);
  const clearActivity = useCallback(() => {
    setActivitySteps(clearedOraActivity());
  }, []);
  // Honest failure line: if a tool step is still in progress when the turn
  // errors out, flip it to its shared "tried and failed" wording.
  const failInFlightActivity = useCallback(() => {
    setActivitySteps((prev) => {
      const current = prev[prev.length - 1];
      return current && current.phase === "start"
        ? reduceOraActivity(prev, oraActivityStep(current.tool, "fail"))
        : prev;
    });
  }, []);
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

  // Resolve the Ora project this chat surface is anchored to: the open
  // conversation's own project first, falling back to the active route
  // project. Used to file uploads and generated files under the right
  // project space in the Library. Reads refs only, so it is render-stable.
  const currentOraProjectId = useCallback((): number | null => {
    const c = convRef.current;
    const pid =
      c?.conversations.find((x) => x.id === c.currentConversationId)?.projectId ??
      c?.activeProjectId ??
      null;
    return typeof pid === "number" ? pid : null;
  }, []);

  const sessionInitRef = useRef(false);
  const transcriptRestoredRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendStartRef = useRef(false);
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
  // Their extracted text lives in the server's session-scoped store (with a
  // durable mirror for signed-in users), so we re-send the recent refs on each
  // chat turn to let Ora answer follow-ups about an earlier upload and edit the
  // ORIGINAL file in place. Reset on new/changed conversation, and mirrored to
  // sessionStorage (cache-only) so a reload doesn't break "Revise ..." turns.
  const documentRefsRef = useRef<string[]>([]);

  // The pending clarification context for THIS conversation. Set when Ora
  // replies with a clarifying question about an ambiguous uploaded-file edit;
  // the user's next message is sent WITH this context so the server merges the
  // answer into the original task and executes it. One-shot: replaced/cleared
  // by whatever the next reply returns. Mirrored to sessionStorage (cache-only,
  // skipped in temporary mode) so a reload doesn't orphan the answer.
  const pendingClarificationRef = useRef<OraPendingClarification | null>(null);

  // Rolling conversation summary for THIS conversation. As the chat grows past
  // the recent-message window, older turns are condensed into this running
  // summary (maintained server-side, returned each reply) and re-sent so long
  // conversations stay coherent. `summarizedUpToRef` tracks how many leading
  // messages have already been folded in, so each turn only ships the NEW
  // overflow (bounded cost). Reset on new/changed/cleared conversation. Kept
  // in-memory only — recomputed once after a reload from the persisted turns.
  const conversationSummaryRef = useRef<string>("");
  const summarizedUpToRef = useRef<number>(0);
  // Every explicit new-chat / conversation switch retires the async work that
  // belonged to the previous thread. Late responses then become no-ops instead
  // of repainting the new blank chat or saving into the wrong conversation.
  const conversationResetGenRef = useRef(0);

  const setMessagesForGeneration = useCallback(
    (generation: number, updater: (prev: OraMessage[]) => OraMessage[]) => {
      if (conversationResetGenRef.current !== generation) return;
      setMessages((prev) =>
        conversationResetGenRef.current === generation ? updater(prev) : prev,
      );
    },
    [],
  );

  const retireThreadWork = useCallback(() => {
    conversationResetGenRef.current += 1;
    editGenRef.current += 1;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setIsLoading(false);
    setPendingImageAnalysis(false);
    setStreamStatus(null);
    clearActivity();
  }, [clearActivity]);

  const resetVisibleThread = useCallback(
    (clearStandaloneStores: boolean) => {
      retireThreadWork();
      loadedConvRef.current = null;
      documentRefsRef.current = [];
      pendingClarificationRef.current = null;
      conversationSummaryRef.current = "";
      summarizedUpToRef.current = 0;
      for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
      objectUrlsRef.current = [];
      if (clearStandaloneStores) {
        storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);
        storePendingClarification(DOC_REFS_STANDALONE_KEY, null);
      }
      setMessages([]);
      setError(null);
      setSessionExpired(false);
      setAttachedFile(null);
      setUploadState("idle");
      setUploadError(null);
    },
    [retireThreadWork],
  );

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
  const saveToConversation = useCallback(
    async (msgs: OraMessage[], targetId: number | null, targetGeneration: number) => {
      const c = convRef.current;
      if (
        !c ||
        c.isConversationTransitioning() ||
        c.conversationTransitionGeneration !== targetGeneration
      )
        return;
      let id = targetId;
      if (id == null) {
        if (c.getCurrentConversationId() != null) return;
        const firstUser = msgs.find((m) => m.role === "user");
        id = await c.ensureConversation(firstUser?.content ?? "New chat");
        // Uploads that happened before this conversation existed were cached
        // under the "standalone" key — move them to the new conversation's key
        // so a later reload restores them for this conversation.
        if (id != null && !temporaryRef.current && documentRefsRef.current.length > 0) {
          storeDocumentRefs(docRefsKey(id), documentRefsRef.current);
          storeDocumentRefs(DOC_REFS_STANDALONE_KEY, []);
        }
        // Same move for a clarification asked before the conversation existed.
        if (id != null && !temporaryRef.current && pendingClarificationRef.current) {
          storePendingClarification(docRefsKey(id), pendingClarificationRef.current);
          storePendingClarification(DOC_REFS_STANDALONE_KEY, null);
        }
      }
      if (id == null) return;
      const latest = convRef.current;
      if (
        !latest ||
        latest.isConversationTransitioning() ||
        latest.conversationTransitionGeneration !== targetGeneration ||
        latest.getCurrentConversationId() !== id
      )
        return;
      const surfaceSaveFailure = () => {
        const current = convRef.current;
        if (
          current?.conversationTransitionGeneration === targetGeneration &&
          current.getCurrentConversationId() === id
        ) {
          setError(
            "This conversation could not be saved. Retry before leaving this chat so your messages are not lost.",
          );
        }
      };
      try {
        const res = await safeAuthFetch(`${BASE}/api/ora/conversations/${id}/messages`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: id, messages: serializeForStorage(msgs) }),
        });
        if (res.ok) {
          loadedConvRef.current = id;
          latest.notifyPersisted();
        } else {
          surfaceSaveFailure();
        }
      } catch {
        surfaceSaveFailure();
      }
    },
    [],
  );

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
        if (c.isConversationTransitioning()) return;
        // Snapshot the target conversation id NOW, before the debounce window.
        const targetId = c.getCurrentConversationId();
        const targetGeneration = c.conversationTransitionGeneration;
        saveTimerRef.current = setTimeout(() => {
          void saveToConversation(msgs, targetId, targetGeneration);
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

  useEffect(() => {
    if (!conv) return;
    return conv.registerConversationTransitionHandler((nextConversationId) => {
      resetVisibleThread(nextConversationId == null);
    });
  }, [conv, resetVisibleThread]);

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
            // Same session as before the reload — its cached upload refs are
            // still valid, so restore them alongside the transcript.
            documentRefsRef.current = getStoredDocumentRefs(DOC_REFS_STANDALONE_KEY);
            pendingClarificationRef.current =
              getStoredPendingClarification(DOC_REFS_STANDALONE_KEY);
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
      //
      // Network failures retry quietly with backoff before surfacing an error:
      // publishing restarts the server for a short window, and this first
      // session call is the request most likely to land inside it. Without the
      // retry, visitors see a scary banner even though the site recovers on
      // its own seconds later.
      const retryDelaysMs = [1500, 4000];
      for (let attempt = 0; ; attempt++) {
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
            // Restore cached upload refs with the transcript. If the session
            // rotated, signed-in users still resolve via the durable mirror
            // and any truly stale refs are skipped server-side.
            documentRefsRef.current = getStoredDocumentRefs(DOC_REFS_STANDALONE_KEY);
            pendingClarificationRef.current =
              getStoredPendingClarification(DOC_REFS_STANDALONE_KEY);
          }
          return;
        } catch (err: unknown) {
          const isNetwork = (err as { network?: boolean }).network === true;
          if (isNetwork && attempt < retryDelaysMs.length) {
            await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
            continue;
          }
          const msg = (err as Error).message ?? "Could not start Ora session.";
          setError(msg);
          return;
        }
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
    const conversationContext = convRef.current;
    if (!conversationContext) return;
    // Temporary ("incognito") mode never reads persisted conversation history —
    // even if the user selects a prior conversation, we keep a blank slate so
    // long-term content can't leak into an incognito turn (it would otherwise be
    // re-sent as `body.messages`).
    if (temporaryRef.current) {
      resetVisibleThread(false);
      conversationContext.completeConversationTransition(
        conversationContext.conversationTransitionGeneration,
      );
      return;
    }
    const id = conversationContext.currentConversationId;
    const transitionGeneration = conversationContext.conversationTransitionGeneration;
    if (id == null) {
      resetVisibleThread(true);
      conversationContext.completeConversationTransition(transitionGeneration);
      return;
    }
    if (id === loadedConvRef.current && !conversationContext.isConversationTransitioning()) return;
    retireThreadWork();
    // Switching conversations: the prior conversation's upload refs and rolling
    // summary no longer apply (they belong to a different transcript). Restore
    // THIS conversation's cached upload refs so follow-up "Revise ..." turns
    // still target the original uploaded file after a reload or switch-back.
    documentRefsRef.current = getStoredDocumentRefs(docRefsKey(id));
    pendingClarificationRef.current = getStoredPendingClarification(docRefsKey(id));
    conversationSummaryRef.current = "";
    summarizedUpToRef.current = 0;
    setMessages([]);
    // Snapshot the edit generation before fetching. If the user types/sends a
    // message while this GET is in flight, editGenRef advances and we discard the
    // (now stale) server payload rather than overwriting the unsaved local edit.
    const genAtStart = editGenRef.current;

    let cancelled = false;
    void (async () => {
      try {
        const res = await safeAuthFetch(`${BASE}/api/ora/conversations/${id}`);
        if (!res.ok) return;
        const data = (await res.json()) as { conversation: { messages: OraMessage[] } };
        const latest = convRef.current;
        if (
          !cancelled &&
          latest?.currentConversationId === id &&
          latest.conversationTransitionGeneration === transitionGeneration &&
          editGenRef.current === genAtStart
        ) {
          loadedConvRef.current = id;
          setMessages(data.conversation.messages ?? []);
        }
      } catch {
        /* best-effort */
      } finally {
        if (!cancelled) {
          convRef.current?.completeConversationTransition(transitionGeneration);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    conv?.currentConversationId,
    conv?.newConversationTick,
    conv?.conversationTransitionGeneration,
    resetVisibleThread,
    retireThreadWork,
  ]);

  const uploadFile = useCallback(
    async (file: File) => {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setUploadState("error");
        setUploadError(
          `Unsupported file type "${ext}". Please upload a PDF, DOCX, PPTX, TXT, CSV, XLSX, ZIP, PNG, JPG, or WEBP file.`,
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
        // Anonymous uploads retain the bounded legacy-session envelope. Signed-in
        // users are admitted only by their account's remaining aggregate storage.
        if (!isSignedIn && file.size > MAX_FILE_SIZE) {
          setUploadState("error");
          setUploadError(
            `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 100 MB.`,
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
        // The shared account-asset uploader performs signed-in image downscaling.
        // Keep this compatibility compressor only for the anonymous multipart path.
        const uploadBlob = isImg && !isSignedIn ? await compressImageForUpload(file) : file;

        // The legacy anonymous path keeps its memory-safety envelope. Signed-in
        // images use the streamed account-asset path and its aggregate allowance.
        if (!isSignedIn && isImg && uploadBlob.size > MAX_IMAGE_SIZE) {
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

        const uploadProjectId = currentOraProjectId();
        let data: {
          fileRef?: string;
          imageRef?: string;
          assetId?: number;
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
          analysisStatus?: "ready" | "unavailable";
          analysisMessage?: string;
        };
        if (isSignedIn) {
          // Account assets use the governed two-stage stream: reserve the exact
          // aggregate bytes, PUT the Blob directly to private R2, then attach
          // only its asset id to Ora. No multipart body enters Node memory.
          const streamedFile = new File([uploadBlob], uploadName, {
            type: uploadBlob.type || file.type,
          });
          const uploaded = await uploadAccountAsset({
            file: streamedFile,
            source: "picker",
          });
          const attach = await safeAuthFetch(`${BASE}/api/public-ai/upload/attach`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assetId: uploaded.assetId,
              ...(uploadProjectId == null ? {} : { oraProjectId: uploadProjectId }),
            }),
          });
          data = (await attach.json().catch(() => ({}))) as typeof data;
          if (!attach.ok) {
            throw new Error(
              (data as { error?: string }).error ?? `Upload attach failed (HTTP ${attach.status})`,
            );
          }
          if (data.analysisStatus === "unavailable") {
            setUploadState("error");
            setUploadError(
              data.analysisMessage ??
                "Your file is saved, but it could not be prepared for chat analysis right now.",
            );
            return;
          }
          if (data.fileType === "image" ? !data.imageRef : !data.fileRef) {
            throw new Error("Your file is saved, but it could not be attached to chat right now.");
          }
        } else {
          const formData = new FormData();
          formData.append("file", uploadBlob, uploadName);
          const response = await safeAuthFetch(`${BASE}/api/public-ai/upload`, {
            method: "POST",
            body: formData,
          });
          if (!response.ok) {
            const failure = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(failure.error ?? `Upload failed (HTTP ${response.status})`);
          }
          data = (await response.json()) as typeof data;
        }

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
          // only the most recent few (server caps re-hydration at 5). Mirrored
          // to sessionStorage (skipped in temporary mode) so a reload doesn't
          // lose the refs and turn an in-place "Revise" into a regeneration.
          if (data.fileRef) {
            const next = [...documentRefsRef.current, data.fileRef].slice(-5);
            documentRefsRef.current = next;
            if (!temporaryRef.current) {
              storeDocumentRefs(docRefsKey(convRef.current?.currentConversationId ?? null), next);
            }
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
    [session, isSignedIn, currentOraProjectId],
  );

  const clearAttachment = useCallback(() => {
    setAttachedFile(null);
    setUploadState("idle");
    setUploadError(null);
  }, []);

  const sendMessage = useCallback(
    async (
      content: string,
      opts?: { truncateTo?: number; editedFrom?: boolean; forceSearch?: boolean },
    ) => {
      if (!content.trim() || isLoading || sendStartRef.current) return;
      if (isSignedIn) markOraActive();

      const conversationContext = convRef.current;
      if (conversationContext?.isConversationTransitioning()) {
        setError("Please wait for the new chat to finish opening, then send again.");
        return;
      }

      const turnGeneration = conversationResetGenRef.current;
      const isTurnCurrent = () => conversationResetGenRef.current === turnGeneration;
      sendStartRef.current = true;
      setIsLoading(true);
      setError(null);

      let conversationBootstrapFailed = false;
      try {
        if (
          isSignedIn &&
          conversationContext &&
          !temporaryRef.current &&
          conversationContext.getCurrentConversationId() == null
        ) {
          const transitionGeneration = conversationContext.conversationTransitionGeneration;
          const createdId = await conversationContext.ensureConversation(content);
          const latest = convRef.current;
          if (
            createdId == null ||
            !latest ||
            !isTurnCurrent() ||
            latest.isConversationTransitioning() ||
            latest.conversationTransitionGeneration !== transitionGeneration ||
            latest.getCurrentConversationId() !== createdId
          ) {
            conversationBootstrapFailed = true;
            if (isTurnCurrent()) {
              setError("Ora could not create a saved conversation. Your message was not sent.");
            }
            return;
          }
          loadedConvRef.current = createdId;
        }
      } catch {
        conversationBootstrapFailed = true;
        if (isTurnCurrent()) {
          setError("Ora could not create a saved conversation. Your message was not sent.");
        }
        return;
      } finally {
        sendStartRef.current = false;
        if (conversationBootstrapFailed && isTurnCurrent()) {
          setIsLoading(false);
        }
      }

      const currentAttachment = attachedFile;
      const baseMessages =
        opts?.truncateTo !== undefined ? messages.slice(0, opts.truncateTo) : messages;
      const setTurnMessages = (updater: (prev: OraMessage[]) => OraMessage[]) =>
        setMessagesForGeneration(turnGeneration, updater);

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
      setTurnMessages(() => {
        const next = [...baseMessages, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setStreamStatus("Rendering the edited image...");
      // Fresh turn — drop any stale activity trace from the previous send.
      clearActivity();

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
            timeZone: clientTimeZone(),
          };
          if (language && language !== "auto") {
            body.language = language;
          } else {
            body.languageHint = navigator.language;
          }

          if (currentAttachment.isImage) {
            const isImageEdit = isOraUploadedImageEditRequest(content);
            setPendingImageAnalysis(!isImageEdit);
            body.imageRef = currentAttachment.fileRef;

            pushActivity(
              isImageEdit
                ? oraActivityStep("image-generation", "start")
                : oraActivityStep("file-reading", "start", ORA_ANALYZING_IMAGE_TEXT),
            );
            const data = await apiPost<{
              reply: string;
              imageUrl?: string;
              editInstruction?: string;
              imageAnalysisCount?: number;
              imageAnalysisLimit?: number;
              msgCount?: number;
              msgLimit?: number;
              imageCount?: number;
              imageLimit?: number;
            }>(isImageEdit ? "/api/public-ai/image-edit" : "/api/public-ai/image-analysis", body);
            if (!isTurnCurrent()) return;
            if (isImageEdit && !data.imageUrl) {
              throw new Error("The image edit failed and no edited image was created.");
            }
            pushActivity(oraActivityStep(isImageEdit ? "image-generation" : "file-reading", "ok"));

            setTurnMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.reply,
                  ...(!isImageEdit ? { messageKind: "image-analysis" as const } : {}),
                  ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
                  ...(data.editInstruction ? { editInstruction: data.editInstruction } : {}),
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
                    ...(data.imageAnalysisCount != null
                      ? { imageAnalysisCount: data.imageAnalysisCount }
                      : {}),
                    ...(data.imageAnalysisLimit != null
                      ? { imageAnalysisLimit: data.imageAnalysisLimit }
                      : {}),
                    ...(data.msgCount != null ? { msgCount: data.msgCount } : {}),
                    ...(data.msgLimit != null ? { msgLimit: data.msgLimit } : {}),
                    ...(data.imageCount != null ? { imageCount: data.imageCount } : {}),
                    ...(data.imageLimit != null ? { imageLimit: data.imageLimit } : {}),
                  }
                : null,
            );
          } else if (currentAttachment.isDataset) {
            body.fileRef = currentAttachment.fileRef;
            pushActivity(
              oraActivityStep(
                "dataset-analysis",
                "start",
                oraAnalyzingDatasetText(currentAttachment.filename),
              ),
            );
            const data = await apiPost<{
              result: DatasetAnalysisResult;
              msgCount: number;
              msgLimit: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/dataset-analysis", body);
            if (!isTurnCurrent()) return;
            pushActivity(oraActivityStep("dataset-analysis", "ok"));

            setTurnMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.result.summary,
                  datasetResult: data.result,
                  ...(data.result.fileAgentPreview
                    ? { fileAgentPreview: data.result.fileAgentPreview }
                    : {}),
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) => mergeUsage(prev, data));
          } else {
            body.fileRef = currentAttachment.fileRef;
            pushActivity(
              oraActivityStep(
                "file-reading",
                "start",
                oraReadingFileText(currentAttachment.filename),
              ),
            );
            const data = await apiPost<{
              reply: string;
              msgCount: number;
              msgLimit: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/file-analysis", body);
            if (!isTurnCurrent()) return;
            pushActivity(oraActivityStep("file-reading", "ok"));

            setTurnMessages((prev) => {
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
            timeZone: clientTimeZone(),
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
          // A clarifying question is outstanding — send its round-tripped task
          // context so the server merges this answer with the original ask.
          if (pendingClarificationRef.current) {
            body.pendingClarification = pendingClarificationRef.current;
          }
          if (language && language !== "auto") {
            body.language = language;
          } else {
            body.languageHint = navigator.language;
          }
          // "Retry live search" forces the backend to re-run the live web-search
          // tool this turn instead of re-classifying the message.
          if (opts?.forceSearch) {
            body.forceSearch = true;
          }
          type ChatResponseData = {
            reply: string;
            suggestions?: string[];
            fileName?: string;
            fileData?: string;
            mimeType?: string;
            assetId?: number;
            editQuality?: OraFileEditQuality;
            imageUrl?: string;
            imageId?: number;
            imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };
            memorySaveCandidate?: string;
            memorySaveCandidateConfidence?: "high" | "low";
            memorySaveCandidateSensitive?: boolean;
            sources?: OraSource[];
            images?: OraImage[];
            videos?: OraVideo[];
            conversationSummary?: string;
            memoriesUsed?: OraMemoryUsed[];
            usedFiles?: OraUsedFile[];
            fileCitations?: OraFileCitation[];
            fileAgentPreview?: OraFileAgentPreview;
            msgCount: number;
            msgLimit: number;
            imageCount?: number;
            imageLimit?: number;
            resetsAt?: string | null;
            windowHours?: number;
            searchFallback?: boolean;
            searchRetryable?: boolean;
            needsClarification?: boolean;
            clarificationKind?: OraClarificationKind;
            pendingTaskContext?: OraPendingClarification;
            activity?: OraActivityStep[];
          };

          // Server-reported terminal activity steps (the non-streaming tool
          // paths report ok/fail with the response since they have no SSE).
          const applyServerActivity = (d: ChatResponseData): void => {
            for (const raw of d.activity ?? []) {
              const step = parseOraActivityStep(raw);
              if (step) pushActivity(step);
            }
          };

          const buildAssistantMsg = (d: ChatResponseData): OraMessage => ({
            role: "assistant",
            content: d.reply,
            suggestions: d.suggestions ?? [],
            ...(d.imageUrl ? { imageUrl: d.imageUrl } : {}),
            ...(d.imageId != null ? { imageId: d.imageId } : {}),
            ...(d.imageMeta ? { imageMeta: d.imageMeta } : {}),
            ...(d.sources && d.sources.length > 0 ? { sources: d.sources } : {}),
            ...(d.images && d.images.length > 0 ? { images: d.images } : {}),
            ...(d.videos && d.videos.length > 0 ? { videos: d.videos } : {}),
            ...(d.searchFallback ? { searchFallback: true } : {}),
            ...(d.searchRetryable ? { searchRetryable: true } : {}),
            ...(d.needsClarification ? { needsClarification: true } : {}),
            ...(d.clarificationKind ? { clarificationKind: d.clarificationKind } : {}),
            ...(d.memoriesUsed && d.memoriesUsed.length > 0
              ? { memoriesUsed: d.memoriesUsed }
              : {}),
            ...(d.usedFiles && d.usedFiles.length > 0 ? { usedFiles: d.usedFiles } : {}),
            ...(d.fileCitations && d.fileCitations.length > 0
              ? { fileCitations: d.fileCitations }
              : {}),
            ...(d.fileAgentPreview ? { fileAgentPreview: d.fileAgentPreview } : {}),
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
                    ...(d.assetId != null ? { assetId: d.assetId } : {}),
                    ...(d.editQuality ? { editQuality: d.editQuality } : {}),
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

          if (opts?.forceSearch) {
            // A "Retry live search" must deterministically re-run the LIVE
            // web-search tool. Search is a non-streaming specialist branch, so
            // the stream route would only bounce it back with a streamingFallback
            // signal — skip that round-trip and POST straight to /chat with
            // forceSearch:true.
            pushActivity(oraActivityStep("web-search", "start"));
            data = await apiPost<ChatResponseData>("/api/public-ai/chat", body);
            if (!isTurnCurrent()) return;
            applyServerActivity(data);
            setLastOraStreamDiagnostics(
              mapOraStreamDiagnostics({
                mode: body.mode,
                tapToFirstTokenMs: null,
                firstSentenceMs: null,
                completeMs: null,
                tokenCount: 0,
                viaFallback: true,
              }),
            );
          } else {
            try {
              // Optimistically add a streaming placeholder that updates in real time.
              setTurnMessages((prev) => [
                ...prev,
                { role: "assistant" as const, content: "", isStreaming: true },
              ]);

              // The activity trace is cleared on the FIRST real answer token
              // and stays cleared — late activity frames (e.g. the post-stream
              // false-delivery rescue) must not resurrect the trace row.
              let sawFirstToken = false;
              const donePayload = await consumeOraStream(
                BASE,
                body,
                (delta) => {
                  if (!isTurnCurrent()) return;
                  if (!sawFirstToken) {
                    sawFirstToken = true;
                    clearActivity();
                  }
                  setStreamStatus(null);
                  // flushSync forces React to commit this update synchronously,
                  // bypassing automatic batching. Without it, when the Replit dev
                  // proxy delivers all SSE frames in one TCP chunk, every onToken
                  // call lands in the same event-loop turn and React 18 batches
                  // them all into a single render — the entire response appears at
                  // once instead of word-by-word.
                  flushSync(() => {
                    setTurnMessages((prev) => {
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
                (statusText) => {
                  if (isTurnCurrent()) setStreamStatus(statusText);
                },
                (step) => {
                  if (isTurnCurrent() && !sawFirstToken) pushActivity(step);
                },
              );

              if (!isTurnCurrent()) return;
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
                setTurnMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant" && last.isStreaming && !last.content)
                    return prev.slice(0, -1);
                  return prev;
                });
                if (isTurnCurrent()) streamAbortRef.current = null;
                return;
              }

              if (se.partialContent !== undefined) {
                // SSE `error` event received after one or more tokens were already
                // emitted. Preserve the partial reply (mark it done) rather than
                // silently discarding it. Do NOT re-throw — the outer catch would
                // remove the user message too, leaving the thread with no trace.
                setTurnMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant" && last.isStreaming) {
                    return [...prev.slice(0, -1), { ...last, isStreaming: false }];
                  }
                  return prev;
                });
                if (isTurnCurrent()) {
                  setError(
                    "Ora's response was cut off. The partial reply above may be incomplete.",
                  );
                  streamAbortRef.current = null;
                }
                return; // Do not fall through to the outer catch
              }

              // Remove the empty streaming placeholder before any fallback/rethrow.
              setTurnMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && last.isStreaming) return prev.slice(0, -1);
                return prev;
              });

              if (!se.streamingFallback) {
                // Real error (429, 401, network, etc.) — rethrow for the outer
                // catch block to surface the right message.
                if (isTurnCurrent()) streamAbortRef.current = null;
                throw streamErr;
              }

              // Streaming unavailable (503, specialist-tool signal, or error
              // before first token) — silently fall back to /chat.
              // streamFallbackToken (when present) proves to /chat that the
              // streaming route already pre-incremented the session counter so
              // it should not double-charge the anonymous-session slot.
              if (isTurnCurrent()) setStreamStatus("Finishing the answer...");
              data = await apiPost<ChatResponseData>("/api/public-ai/chat", {
                ...body,
                ...(se.streamFallbackToken ? { streamFallbackToken: se.streamFallbackToken } : {}),
              });
              if (!isTurnCurrent()) return;
              applyServerActivity(data);
              setLastOraStreamDiagnostics(
                mapOraStreamDiagnostics({
                  mode: body.mode,
                  tapToFirstTokenMs: null,
                  firstSentenceMs: null,
                  completeMs: null,
                  tokenCount: 0,
                  viaFallback: true,
                }),
              );
            }
          }

          if (isTurnCurrent()) streamAbortRef.current = null;
          if (!isTurnCurrent()) return;

          // One-shot pending-clarification bookkeeping: a clarifying reply arms
          // the NEXT turn with its round-tripped task context; any other reply
          // clears whatever was pending (answered, superseded, or stale).
          const nextPending =
            data.needsClarification && data.pendingTaskContext ? data.pendingTaskContext : null;
          pendingClarificationRef.current = nextPending;
          if (!temporaryRef.current) {
            storePendingClarification(
              docRefsKey(convRef.current?.currentConversationId ?? null),
              nextPending,
            );
          }

          // True when this reply bypassed real provider-level token streaming.
          // Covers both the /chat fallback path and SSE providers that wrap a
          // single non-streaming completion into the SSE envelope.
          const viaFallback = !usedStreaming || !isRealStreamingPayload;

          // Reflect the resolved fallback status on the last-turn diagnostics
          // (consumeOraStream cannot know isRealStreaming until the done event).
          const lastDiag = getLastOraStreamDiagnostics();
          if (lastDiag) setLastOraStreamDiagnostics({ ...lastDiag, viaFallback });

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
            setTurnMessages((prev) => {
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
            setTurnMessages((prev) => {
              const next = [
                ...prev,
                { ...buildAssistantMsg(data), ...(viaFallback ? { viaFallback: true } : {}) },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
          }
          if (isTurnCurrent()) setSession((prev) => mergeUsage(prev, data));
        }
      };

      try {
        await executeApiCall();
      } catch (err: unknown) {
        if (!isTurnCurrent()) return;
        // Whatever tool was mid-flight gets its honest "tried and failed" line
        // (invisible once the error banner replaces the loading row, but keeps
        // the trace state truthful for diagnostics and retries).
        failInFlightActivity();
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
            if (!isTurnCurrent()) return;
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
        } else if (status === 503 && (err as { searchRetryable?: boolean }).searchRetryable) {
          // Live search must either return verified, cited results or fail
          // visibly. Keep the user's turn in the thread and append an inline
          // assistant error bubble so Retry live search can replay the same ask.
          const retryableMessage =
            msg ??
            "I couldn't reach verified live web results just now. Please try again in a moment - your message is still here.";
          setError(null);
          setTurnMessages((prev) => {
            const trimmed =
              prev.at(-1)?.role === "assistant" && prev.at(-1)?.isStreaming
                ? prev.slice(0, -1)
                : prev;
            const next: OraMessage[] = [
              ...trimmed,
              {
                role: "assistant",
                content: retryableMessage,
                error: true,
                searchRetryable: true,
              },
            ];
            storeTranscript(next);
            return next;
          });
          return;
        } else {
          setError(msg ?? "Something went wrong. Please try again.");
          // For transient image-analysis failures (502, network, etc.) restore the chip
          // so the visitor can retry without re-uploading.
          if (currentAttachment?.isImage) {
            setAttachedFile(currentAttachment);
            setUploadState("attached");
          }
        }
        setTurnMessages((prev) => {
          const next = prev.slice(0, -1);
          storeTranscript(next);
          return next;
        });
      } finally {
        if (isTurnCurrent()) {
          setPendingImageAnalysis(false);
          setIsLoading(false);
          setStreamStatus(null);
        }
      }
    },
    [
      isLoading,
      messages,
      language,
      attachedFile,
      isSignedIn,
      saveToServer,
      mode,
      pushActivity,
      clearActivity,
      failInFlightActivity,
      setMessagesForGeneration,
    ],
  );

  const generateFile = useCallback(
    async (content: string, format: string, activeAssetId?: number | null) => {
      if (!content.trim() || isLoading) return;

      const formatLabel = format.toUpperCase();
      const isRevision = activeAssetId != null;
      const userMsg: OraMessage = {
        role: "user",
        content: isRevision ? content : `Create a ${formatLabel} file: ${content}`,
      };
      const turnGeneration = conversationResetGenRef.current;
      const isTurnCurrent = () => conversationResetGenRef.current === turnGeneration;
      const setToolMessages = (updater: (prev: OraMessage[]) => OraMessage[]) =>
        setMessagesForGeneration(turnGeneration, updater);
      setToolMessages((prev) => {
        const next = [...prev, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setIsLoading(true);
      setError(null);
      // Live activity trace: explicit file generation runs on a non-streaming
      // route, so synthesize the shared "Generating your file…" start step here
      // and let the response's terminal step (or the catch) close it.
      clearActivity();
      pushActivity(oraActivityStep("file-generation", "start"));

      try {
        const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
        const body: Record<string, unknown> = {
          message: content,
          messages: history,
          format,
          timeZone: clientTimeZone(),
        };
        if (language && language !== "auto") {
          body.language = language;
        } else {
          body.languageHint = navigator.language;
        }
        // Carry any earlier-uploaded files so the file is built from real data.
        if (documentRefsRef.current.length > 0) {
          body.documentRefs = documentRefsRef.current;
        }
        // File the generated document under the current project space.
        const genProjectId = currentOraProjectId();
        if (genProjectId != null) {
          body.oraProjectId = genProjectId;
        }
        // Phase 10: revision engine — pass the active working artifact id so
        // the backend can fetch its bytes and apply the edit in-place rather
        // than regenerating from scratch.
        if (activeAssetId != null) {
          body.activeAssetId = activeAssetId;
        }

        const data = await apiPost<{
          reply: string;
          fileName: string;
          fileData: string;
          mimeType: string;
          assetId?: number;
          editQuality?: OraFileEditQuality;
          fileAgentPreview?: OraFileAgentPreview;
          msgCount: number;
          msgLimit: number;
          imageCount?: number;
          imageLimit?: number;
          resetsAt?: string | null;
          windowHours?: number;
          activity?: OraActivityStep[];
        }>("/api/public-ai/generate-file", body);
        if (!isTurnCurrent()) return;
        const fileRequest = resolveOraFileFormatRequest(content, format);
        if (
          !fileRequest.ok ||
          !isSuccessfulOraGeneratedFilePayload(data, {
            format: fileRequest.format,
            requestedFileName: fileRequest.requestedFileName,
          })
        ) {
          throw new Error(
            "I couldn't create that file because the returned filename or file type did not match your request. No download card was shown.",
          );
        }

        for (const raw of data.activity ?? []) {
          const step = parseOraActivityStep(raw);
          if (step) pushActivity(step);
        }
        setToolMessages((prev) => {
          const next = [
            ...prev,
            {
              role: "assistant" as const,
              content: data.reply,
              generatedFile: {
                fileName: data.fileName,
                fileData: data.fileData,
                mimeType: data.mimeType,
                format: fileRequest.format,
                ...(data.assetId != null ? { assetId: data.assetId } : {}),
                ...(data.editQuality ? { editQuality: data.editQuality } : {}),
              } satisfies GeneratedFile,
              ...(data.fileAgentPreview ? { fileAgentPreview: data.fileAgentPreview } : {}),
            },
          ];
          storeTranscript(next);
          if (isSignedIn) saveToServer(next);
          return next;
        });
        if (isTurnCurrent()) setSession((prev) => mergeUsage(prev, data));
      } catch (err: unknown) {
        if (!isTurnCurrent()) return;
        // Honest terminal step for the in-flight "Generating your file…" line.
        failInFlightActivity();
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
            if (!isTurnCurrent()) return;
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
              timeZone: clientTimeZone(),
              // Preserve the active-asset revision target across the retry.
              ...(activeAssetId != null ? { activeAssetId } : {}),
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
            // File the generated document under the current project space.
            const retryProjectId = currentOraProjectId();
            if (retryProjectId != null) {
              retryBody.oraProjectId = retryProjectId;
            }
            const retryData = await apiPost<{
              reply: string;
              fileName: string;
              fileData: string;
              mimeType: string;
              editQuality?: OraFileEditQuality;
              fileAgentPreview?: OraFileAgentPreview;
              msgCount: number;
              msgLimit: number;
              imageCount?: number;
              imageLimit?: number;
              resetsAt?: string | null;
              windowHours?: number;
            }>("/api/public-ai/generate-file", retryBody);
            if (!isTurnCurrent()) return;
            const retryFileRequest = resolveOraFileFormatRequest(content, format);
            if (
              !retryFileRequest.ok ||
              !isSuccessfulOraGeneratedFilePayload(retryData, {
                format: retryFileRequest.format,
                requestedFileName: retryFileRequest.requestedFileName,
              })
            ) {
              throw new Error(
                "I couldn't create that file because the returned filename or file type did not match your request. No download card was shown.",
                { cause: err },
              );
            }
            setToolMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: retryData.reply,
                  generatedFile: {
                    fileName: retryData.fileName,
                    fileData: retryData.fileData,
                    mimeType: retryData.mimeType,
                    format: retryFileRequest.format,
                    ...(retryData.editQuality ? { editQuality: retryData.editQuality } : {}),
                  } satisfies GeneratedFile,
                  ...(retryData.fileAgentPreview
                    ? { fileAgentPreview: retryData.fileAgentPreview }
                    : {}),
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            if (isTurnCurrent()) {
              setSession((prev) => mergeUsage(prev, retryData));
              setIsLoading(false);
              setStreamStatus(null);
            }
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
        setToolMessages((prev) => {
          const next = [
            ...prev,
            {
              role: "assistant" as const,
              content: `I couldn't generate the requested file. ${msg ?? "Please try again."}`,
            },
          ];
          storeTranscript(next);
          if (isSignedIn) saveToServer(next);
          return next;
        });
      } finally {
        if (isTurnCurrent()) {
          setIsLoading(false);
          setStreamStatus(null);
        }
      }
    },
    [
      isLoading,
      messages,
      language,
      isSignedIn,
      saveToServer,
      currentOraProjectId,
      pushActivity,
      clearActivity,
      failInFlightActivity,
      setMessagesForGeneration,
    ],
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

      const sourceImageMeta = messagesRef.current.find(
        (m) => m.imageId === sourceImageId,
      )?.imageMeta;
      const userMsg: OraMessage = { role: "user", content: `Edit image: ${trimmed}` };
      const turnGeneration = conversationResetGenRef.current;
      const isTurnCurrent = () => conversationResetGenRef.current === turnGeneration;
      const setEditMessages = (updater: (prev: OraMessage[]) => OraMessage[]) =>
        setMessagesForGeneration(turnGeneration, updater);
      setEditMessages((prev) => {
        const next = [...prev, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setIsLoading(true);
      setError(null);

      try {
        // File the edited image under the current project space (server
        // validates ownership and degrades to Personal when absent).
        const editProjectId = currentOraProjectId();
        const enqueueRes = await safeAuthFetch(`${BASE}/api/images/${sourceImageId}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: trimmed,
            quality: "standard",
            origin: "ora",
            ...(editProjectId != null ? { oraProjectId: editProjectId } : {}),
          }),
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
        if (!isTurnCurrent()) return;

        // Poll the in-process job until it completes (~90s ceiling).
        let fileUrl: string | null = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (!isTurnCurrent()) return;
          const statusRes = await safeAuthFetch(`${BASE}/api/images/status/${jobId}`);
          if (!isTurnCurrent()) return;
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
        setStreamStatus("Loading the edited image...");
        const imgRes = await safeAuthFetch(`${BASE}/api/images/${newImageId}/file`);
        if (!isTurnCurrent()) return;
        if (!imgRes.ok) throw new Error("Could not load the edited image.");
        const blob = await imgRes.blob();
        if (!isTurnCurrent()) return;
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
        if (!isTurnCurrent()) return;

        setEditMessages((prev) => {
          const next = [
            ...prev,
            {
              role: "assistant" as const,
              content: "Here's the edited image. Tap Edit to refine it further.",
              imageUrl: displayUrl,
              imageId: newImageId,
              editInstruction: trimmed,
              ...(sourceImageMeta ? { imageMeta: sourceImageMeta } : {}),
            } satisfies OraMessage,
          ];
          storeTranscript(next);
          if (isSignedIn) saveToServer(next);
          return next;
        });
      } catch (err: unknown) {
        if (!isTurnCurrent()) return;
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
        setEditMessages((prev) => {
          const next = prev.slice(0, -1);
          storeTranscript(next);
          return next;
        });
      } finally {
        if (isTurnCurrent()) {
          setIsLoading(false);
          setStreamStatus(null);
        }
      }
    },
    [isLoading, isSignedIn, saveToServer, currentOraProjectId, setMessagesForGeneration],
  );

  const clearConversation = useCallback(async () => {
    // Conversation mode: starting a new chat just resets to a blank conversation
    // (current id → null). The prior conversation stays in the sidebar; nothing
    // is deleted server-side and the rate-limit session is preserved.
    if (convRef.current) {
      resetVisibleThread(true);
      convRef.current.newConversation();
      return;
    }

    clearStoredTranscript();
    clearStoredSessionId();
    clearAllStoredDocumentRefs();
    resetVisibleThread(false);
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
  }, [isSignedIn, resetVisibleThread]);

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
  const setTemporary = useCallback(
    (value: boolean) => {
      setTemporaryState(value);
      temporaryRef.current = value;
      resetVisibleThread(false);
      if (convRef.current) {
        convRef.current.newConversation();
      }
    },
    [resetVisibleThread],
  );

  const retryLastMessage = useCallback(async () => {
    if (isLoading) return;
    const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
    if (lastUserIdx === -1) return;
    const lastUserMsg = messages[lastUserIdx];
    if (!lastUserMsg?.content.trim()) return;
    // When the previous search result/error is retryable, re-run a LIVE search
    // instead of re-routing the message (which could land on a plain
    // conversational answer). Force the search tool so "Retry live search"
    // always means exactly that.
    //
    // Two shapes qualify: (a) the trailing assistant message carries the
    // retryable search flag; (b) older retryable failures preserved the user's
    // turn as the trailing message.
    const lastMsg = messages[messages.length - 1];
    const forceSearch =
      (lastMsg?.role === "assistant" &&
        (lastMsg.searchRetryable === true || lastMsg.searchFallback === true)) ||
      lastMsg?.role === "user";
    setError(null);
    await sendMessage(lastUserMsg.content, { truncateTo: lastUserIdx, forceSearch });
  }, [messages, isLoading, sendMessage]);

  // Append a finalized realtime-voice turn into the transcript without a server
  // chat round-trip. The realtime model has already produced the reply locally,
  // so this only mirrors the spoken turn into the existing history using the
  // same race-safe persistence path as sendMessage (sessionStorage +
  // debounced conversation save). It never calls /chat, never mergeUsage (the
  // mint spend cap already metered the session), and never touches isLoading.
  const appendVoiceMessage = useCallback(
    (role: "user" | "assistant", content: string) => {
      const text = content.trim();
      if (!text) return;
      setMessages((prev) => {
        const next: OraMessage[] = [...prev, { role, content: text }];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
    },
    [isSignedIn, saveToServer],
  );

  const appendVoiceToolResult = useCallback(
    (result: OraRealtimeToolWrittenResult) => {
      const content = result.content.trim();
      if (!content && !result.generatedFile && !result.imageUrl) return;
      setMessages((prev) => {
        const next: OraMessage[] = [
          ...prev,
          {
            role: "assistant",
            content: content || "Ora finished the requested tool.",
            ...(result.sources ? { sources: result.sources } : {}),
            ...(result.usedFiles ? { usedFiles: result.usedFiles } : {}),
            ...(result.generatedFile ? { generatedFile: result.generatedFile } : {}),
            ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
            ...(result.imageId ? { imageId: result.imageId } : {}),
            ...(result.imageMeta ? { imageMeta: result.imageMeta } : {}),
          },
        ];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
    },
    [isSignedIn, saveToServer],
  );

  // Snapshot the live chat context for a realtime "Talk to Ora" session. This
  // mirrors how the `/chat` request body is assembled (see sendMessage) so the
  // realtime mint endpoint receives the exact same temporary/memory/project/
  // conversation/language signals — keeping all Ora rules in one place.
  const getRealtimeContext = useCallback((): OraRealtimeContext => {
    const activeConv = convRef.current;
    const oraProjectId =
      activeConv?.conversations.find((c) => c.id === activeConv.currentConversationId)?.projectId ??
      activeConv?.activeProjectId ??
      null;
    const currentConvId = activeConv?.currentConversationId;
    const ctx: OraRealtimeContext = {
      temporary: temporaryRef.current,
      referenceSavedMemories: getReferenceSavedMemories(),
      oraProjectId: typeof oraProjectId === "number" ? oraProjectId : null,
      conversationId: typeof currentConvId === "number" ? currentConvId : null,
      timeZone: clientTimeZone(),
      documentRefs: documentRefsRef.current.slice(-5),
    };
    if (language && language !== "auto") {
      ctx.language = language;
    } else {
      ctx.languageHint = navigator.language;
    }
    // Carry the recent text conversation into the spoken session so Ora keeps the
    // same context the user already sees. History is seeded client-side as
    // lower-authority realtime conversation items (never system instructions);
    // only the last user utterance is forwarded to the mint as a saved-memory
    // ranking hint (message).
    const recent = messagesRef.current
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0)
      .slice(-12)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    if (recent.length > 0) {
      ctx.history = recent;
      const lastUser = [...recent].reverse().find((m) => m.role === "user");
      if (lastUser) ctx.message = lastUser.content;
    }
    return ctx;
  }, [language]);

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
    streamStatus,
    activitySteps,
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
    appendVoiceMessage,
    appendVoiceToolResult,
    getRealtimeContext,
  };
}
