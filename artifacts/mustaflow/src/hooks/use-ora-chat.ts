import { useState, useEffect, useCallback, useRef } from "react";
import { useUser } from "@clerk/react";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";
import { authFetch } from "@/lib/api-fetch";
import { useOraConversationsOptional } from "@/hooks/use-ora-conversations";

export type FileFormat = "csv" | "xlsx" | "docx" | "pdf" | "pptx";

export interface GeneratedFile {
  fileName: string;
  fileData: string;
  mimeType: string;
  format: FileFormat;
}

export interface OraMessage {
  role: "user" | "assistant";
  content: string;
  handoffCta?: boolean;
  datasetResult?: DatasetAnalysisResult;
  suggestions?: string[];
  messageKind?: "image-analysis" | "document-analysis";
  hadAttachment?: boolean;
  editedFrom?: boolean;
  generatedFile?: GeneratedFile;
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

export interface UseOraChatReturn {
  messages: OraMessage[];
  session: OraSession | null;
  isLoading: boolean;
  error: string | null;
  atLimit: boolean;
  language: string;
  setLanguage: (lang: string) => void;
  sendMessage: (
    content: string,
    opts?: { truncateTo?: number; editedFrom?: boolean },
  ) => Promise<void>;
  generateFile: (content: string, format: FileFormat) => Promise<void>;
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
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "ora_session_id";
const TRANSCRIPT_STORAGE_KEY = "ora_transcript";

const FILE_LIMIT = 3;
const IMAGE_LIMIT = 2;

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
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
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
    const hasAssistantReply = messages.some((m) => m.role === "assistant");
    return hasAssistantReply ? "replying" : "thinking";
  }
  return "idle";
}

function serializeForStorage(messages: OraMessage[]): Array<{
  role: string;
  content: string;
  handoffCta?: boolean;
  messageKind?: string;
  suggestions?: string[];
  hadAttachment?: boolean;
  editedFrom?: boolean;
  generatedFile?: GeneratedFile;
  datasetResult?: DatasetAnalysisResult;
}> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.handoffCta !== undefined ? { handoffCta: m.handoffCta } : {}),
    ...(m.messageKind !== undefined ? { messageKind: m.messageKind } : {}),
    ...(m.suggestions && m.suggestions.length > 0 ? { suggestions: m.suggestions } : {}),
    ...(m.hadAttachment ? { hadAttachment: true } : {}),
    ...(m.editedFrom ? { editedFrom: true } : {}),
    // Include generatedFile so the download card persists across re-renders
    ...(m.generatedFile ? { generatedFile: m.generatedFile } : {}),
    ...(m.datasetResult !== undefined ? { datasetResult: m.datasetResult } : {}),
  }));
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
  // Tracks the conversation id whose messages are currently loaded, so the load
  // effect can skip re-fetching a conversation we just created locally.
  const loadedConvRef = useRef<number | null>(null);
  // Bumped on every local edit (each saveToServer call). An in-flight load
  // captures this value and discards its server result if a local edit happened
  // while the fetch was outstanding — prevents a stale GET clobbering new input.
  const editGenRef = useRef(0);

  const setLanguage = useCallback((lang: string) => {
    setLanguageState(lang);
    try {
      sessionStorage.setItem("ora_language", lang);
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
        }>("/api/public-ai/session", {});
        storeSessionId(data.sessionId);
        setSession({
          sessionId: data.sessionId,
          msgCount: data.msgCount,
          msgLimit: data.msgLimit,
          fileCount: data.fileCount ?? 0,
          fileLimit: data.fileLimit ?? FILE_LIMIT,
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
    const id = conv.currentConversationId;
    if (id == null) {
      loadedConvRef.current = null;
      setMessages([]);
      return;
    }
    if (id === loadedConvRef.current) return;
    loadedConvRef.current = id;
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
        if (session && (session.imageCount ?? 0) >= (session.imageLimit ?? IMAGE_LIMIT)) {
          setUploadState("error");
          setUploadError(
            `Image limit reached (${session.imageLimit ?? IMAGE_LIMIT}/${session.imageLimit ?? IMAGE_LIMIT}). Start a new session to upload more images.`,
          );
          return;
        }
      } else {
        if (file.size > MAX_FILE_SIZE) {
          setUploadState("error");
          setUploadError(
            `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 10 MB.`,
          );
          return;
        }
        if (session && session.fileCount >= session.fileLimit) {
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

        const res = await fetch(`${BASE}/api/public-ai/upload`, {
          method: "POST",
          credentials: "include",
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
    [session],
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
        ...(currentAttachment ? { hadAttachment: true } : {}),
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

      const history = baseMessages.slice(-20).map((m) => ({ role: m.role, content: m.content }));

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
              handoffCta: boolean;
              imageAnalysisCount: number;
              imageAnalysisLimit: number;
            }>("/api/public-ai/image-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.reply,
                  handoffCta: data.handoffCta,
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
            }>("/api/public-ai/dataset-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.result.summary,
                  handoffCta: true,
                  datasetResult: data.result,
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) =>
              prev
                ? { ...prev, msgCount: data.msgCount, msgLimit: data.msgLimit }
                : {
                    sessionId: "",
                    msgCount: data.msgCount,
                    msgLimit: data.msgLimit,
                    fileCount: 0,
                    fileLimit: FILE_LIMIT,
                  },
            );
          } else {
            body.fileRef = currentAttachment.fileRef;
            const data = await apiPost<{
              reply: string;
              handoffCta: boolean;
              msgCount: number;
              msgLimit: number;
            }>("/api/public-ai/file-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                {
                  role: "assistant" as const,
                  content: data.reply,
                  handoffCta: data.handoffCta,
                  messageKind: "document-analysis" as const,
                },
              ];
              storeTranscript(next);
              if (isSignedIn) saveToServer(next);
              return next;
            });
            setSession((prev) =>
              prev
                ? { ...prev, msgCount: data.msgCount, msgLimit: data.msgLimit }
                : {
                    sessionId: "",
                    msgCount: data.msgCount,
                    msgLimit: data.msgLimit,
                    fileCount: 0,
                    fileLimit: FILE_LIMIT,
                  },
            );
          }
        } else {
          const body: Record<string, unknown> = { message: content, messages: history };
          if (language && language !== "auto") {
            body.language = language;
          } else {
            body.languageHint = navigator.language;
          }
          const data = await apiPost<{
            reply: string;
            handoffCta?: boolean;
            suggestions?: string[];
            // Present when the chat route auto-detected a file generation request
            fileName?: string;
            fileData?: string;
            mimeType?: string;
            msgCount: number;
            msgLimit: number;
          }>("/api/public-ai/chat", body);

          setMessages((prev) => {
            const next = [
              ...prev,
              {
                role: "assistant" as const,
                content: data.reply,
                handoffCta: data.handoffCta,
                suggestions: data.suggestions ?? [],
                ...(data.fileName && data.fileData && data.mimeType
                  ? {
                      generatedFile: {
                        fileName: data.fileName,
                        fileData: data.fileData,
                        mimeType: data.mimeType,
                        // Infer format from file extension
                        format: data.fileName.split(".").pop() as GeneratedFile["format"],
                      } satisfies GeneratedFile,
                    }
                  : {}),
              },
            ];
            storeTranscript(next);
            if (isSignedIn) saveToServer(next);
            return next;
          });
          setSession((prev) =>
            prev
              ? { ...prev, msgCount: data.msgCount, msgLimit: data.msgLimit }
              : {
                  sessionId: "",
                  msgCount: data.msgCount,
                  msgLimit: data.msgLimit,
                  fileCount: 0,
                  fileLimit: FILE_LIMIT,
                },
          );
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
            }>("/api/public-ai/session", {});
            storeSessionId(data.sessionId);
            setSession({
              sessionId: data.sessionId,
              msgCount: data.msgCount,
              msgLimit: data.msgLimit,
              fileCount: data.fileCount ?? 0,
              fileLimit: data.fileLimit ?? FILE_LIMIT,
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
    [isLoading, messages, language, attachedFile, isSignedIn, saveToServer],
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

        const data = await apiPost<{
          reply: string;
          fileName: string;
          fileData: string;
          mimeType: string;
          msgCount: number;
          msgLimit: number;
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
        setSession((prev) =>
          prev
            ? { ...prev, msgCount: data.msgCount, msgLimit: data.msgLimit }
            : {
                sessionId: "",
                msgCount: data.msgCount,
                msgLimit: data.msgLimit,
                fileCount: 0,
                fileLimit: FILE_LIMIT,
              },
        );
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
            const retryData = await apiPost<{
              reply: string;
              fileName: string;
              fileData: string;
              mimeType: string;
              msgCount: number;
              msgLimit: number;
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
            setSession((prev) =>
              prev
                ? { ...prev, msgCount: retryData.msgCount, msgLimit: retryData.msgLimit }
                : {
                    sessionId: refreshed.sessionId,
                    msgCount: retryData.msgCount,
                    msgLimit: retryData.msgLimit,
                    fileCount: 0,
                    fileLimit: FILE_LIMIT,
                  },
            );
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

  const clearConversation = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    // Conversation mode: starting a new chat just resets to a blank conversation
    // (current id → null). The prior conversation stays in the sidebar; nothing
    // is deleted server-side and the rate-limit session is preserved.
    if (convRef.current) {
      loadedConvRef.current = null;
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
      }>("/api/public-ai/session", {});
      storeSessionId(data.sessionId);
      setSession({
        sessionId: data.sessionId,
        msgCount: data.msgCount,
        msgLimit: data.msgLimit,
        fileCount: data.fileCount ?? 0,
        fileLimit: data.fileLimit ?? FILE_LIMIT,
      });
    } catch {
      /* best-effort */
    }
  }, [isSignedIn]);

  const atLimit = (session?.msgCount ?? 0) >= (session?.msgLimit ?? 20);

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
    sendMessage,
    generateFile,
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
  };
}
