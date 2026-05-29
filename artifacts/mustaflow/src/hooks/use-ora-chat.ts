import { useState, useEffect, useCallback, useRef } from "react";
import { useUser } from "@clerk/react";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";

export interface OraMessage {
  role: "user" | "assistant";
  content: string;
  handoffCta?: boolean;
  datasetResult?: DatasetAnalysisResult;
  suggestions?: string[];
}

export interface OraSession {
  sessionId: string;
  msgCount: number;
  msgLimit: number;
  fileCount: number;
  fileLimit: number;
}

export type UploadState = "idle" | "uploading" | "attached" | "error";

export type OraStatus = "idle" | "thinking" | "replying" | "uploading" | "reading" | "analyzing";

export interface AttachedFile {
  fileRef: string;
  filename: string;
  fileType: string;
  charCount: number;
  isDataset: boolean;
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
  sendMessage: (content: string) => Promise<void>;
  clearError: () => void;
  uploadFile: (file: File) => Promise<void>;
  clearAttachment: () => void;
  attachedFile: AttachedFile | null;
  uploadState: UploadState;
  uploadError: string | null;
  clearUploadError: () => void;
  oraStatus: OraStatus;
  clearConversation: () => Promise<void>;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "ora_session_id";
const TRANSCRIPT_STORAGE_KEY = "ora_transcript";

const FILE_LIMIT = 3;
const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".csv", ".xlsx"];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is OraMessage =>
        typeof m === "object" &&
        m !== null &&
        ((m as OraMessage).role === "user" || (m as OraMessage).role === "assistant") &&
        typeof (m as OraMessage).content === "string",
    );
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
  messages: OraMessage[],
): OraStatus {
  if (uploadState === "uploading") return "uploading";
  if (isLoading) {
    if (attachedFile) {
      if (isDatasetFileType(attachedFile.fileType, attachedFile.filename)) return "analyzing";
      return "reading";
    }
    const hasAssistantReply = messages.some((m) => m.role === "assistant");
    return hasAssistantReply ? "replying" : "thinking";
  }
  return "idle";
}

function serializeForStorage(
  messages: OraMessage[],
): Array<{ role: string; content: string; handoffCta?: boolean }> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.handoffCta !== undefined ? { handoffCta: m.handoffCta } : {}),
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

  // Tracks whether the initial Ora session setup has run (runs once on mount)
  const sessionInitRef = useRef(false);
  // Tracks whether we've already restored the server transcript for this mount
  const transcriptRestoredRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setLanguage = useCallback((lang: string) => {
    setLanguageState(lang);
    try {
      sessionStorage.setItem("ora_language", lang);
    } catch {
      /* ignore */
    }
  }, []);

  const saveToServer = useCallback((msgs: OraMessage[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      apiPost("/api/ora/transcript", { messages: serializeForStorage(msgs) }).catch(() => {
        /* best-effort; silent on failure */
      });
    }, 800);
  }, []);

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
          }>("/api/public-ai/session");
          setSession({
            sessionId: data.sessionId,
            msgCount: data.msgCount,
            msgLimit: data.msgLimit,
            fileCount: data.fileCount ?? 0,
            fileLimit: data.fileLimit ?? FILE_LIMIT,
          });
          // Load sessionStorage transcript as a baseline; Phase 2 may overwrite with server data
          const stored = getStoredTranscript();
          if (stored.length > 0) {
            setMessages(stored);
          }
          return;
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          if (status === 401) {
            clearStoredSessionId();
            clearStoredTranscript();
          }
        }
      }

      // No valid session — create one
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
      } catch (err: unknown) {
        const msg = (err as Error).message ?? "Could not start Ora session.";
        setError(msg);
      }
    };

    void init();
  }, []);

  // Phase 2: Server transcript restore — runs once Clerk confirms the user is signed in
  useEffect(() => {
    if (!isLoaded || !isSignedIn || transcriptRestoredRef.current) return;
    transcriptRestoredRef.current = true;

    const restoreTranscript = async () => {
      try {
        const data = await apiGet<{ messages: OraMessage[] }>("/api/ora/transcript");
        if (data.messages.length > 0) {
          setMessages(data.messages);
          storeTranscript(data.messages);
        }
      } catch {
        // Best-effort — sessionStorage messages (set in Phase 1) remain as fallback
      }
    };

    void restoreTranscript();
  }, [isLoaded, isSignedIn]);

  const uploadFile = useCallback(
    async (file: File) => {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setUploadState("error");
        setUploadError(
          `Unsupported file type "${ext}". Please upload a PDF, DOCX, TXT, CSV, or XLSX file.`,
        );
        return;
      }

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

      setUploadState("uploading");
      setUploadError(null);

      try {
        const formData = new FormData();
        formData.append("file", file);

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
          fileRef: string;
          filename: string;
          fileType: string;
          charCount: number;
          rowCount?: number;
          colCount?: number;
          truncated?: boolean;
          sanitizedCells?: number;
          hiddenSheetsSkipped?: number;
          fileCount: number;
          fileLimit: number;
        };

        const isDataset = data.fileType === "csv" || data.fileType === "xlsx";
        setAttachedFile({
          fileRef: data.fileRef,
          filename: data.filename,
          fileType: data.fileType,
          charCount: data.charCount,
          isDataset,
          rowCount: data.rowCount,
          colCount: data.colCount,
          truncated: data.truncated,
          sanitizedCells: data.sanitizedCells,
          hiddenSheetsSkipped: data.hiddenSheetsSkipped,
        });
        setUploadState("attached");
        setSession((prev) =>
          prev ? { ...prev, fileCount: data.fileCount, fileLimit: data.fileLimit } : null,
        );
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
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      const userMsg: OraMessage = { role: "user", content };
      setMessages((prev) => {
        const next = [...prev, userMsg];
        storeTranscript(next);
        if (isSignedIn) saveToServer(next);
        return next;
      });
      setIsLoading(true);
      setError(null);

      const currentAttachment = attachedFile;

      try {
        const history = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));

        if (currentAttachment) {
          setAttachedFile(null);
          setUploadState("idle");

          const body: Record<string, unknown> = {
            fileRef: currentAttachment.fileRef,
            message: content,
            messages: history,
          };
          if (language && language !== "auto") {
            body.language = language;
          }

          if (currentAttachment.isDataset) {
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
            const data = await apiPost<{
              reply: string;
              handoffCta: boolean;
              msgCount: number;
              msgLimit: number;
            }>("/api/public-ai/file-analysis", body);

            setMessages((prev) => {
              const next = [
                ...prev,
                { role: "assistant" as const, content: data.reply, handoffCta: data.handoffCta },
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
          }
          const data = await apiPost<{
            reply: string;
            handoffCta: boolean;
            suggestions?: string[];
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
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message;
        if (status === 429) {
          setError(msg ?? "You have reached the message limit for this session.");
        } else if (status === 401) {
          clearStoredSessionId();
          clearStoredTranscript();
          setError(
            "Your session has expired. Please refresh the page to start a new conversation.",
          );
        } else if (status === 404 && currentAttachment) {
          setError("The attached file has expired. Please upload it again.");
        } else {
          setError(msg ?? "Something went wrong. Please try again.");
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
    [isLoading, messages, language, attachedFile, isSignedIn, saveToServer],
  );

  const clearConversation = useCallback(async () => {
    // Cancel any pending debounced save so it cannot repopulate server state after clear
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    clearStoredTranscript();
    clearStoredSessionId();
    setMessages([]);
    setError(null);
    if (isSignedIn) {
      try {
        await apiDelete("/api/ora/transcript");
      } catch {
        /* best-effort */
      }
    }
    // Reset the transcript-restored flag so a new sign-in cycle can restore again
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

  const oraStatus = deriveOraStatus(isLoading, uploadState, attachedFile, messages);

  return {
    messages,
    session,
    isLoading,
    error,
    atLimit,
    language,
    setLanguage,
    sendMessage,
    clearError: () => setError(null),
    uploadFile,
    clearAttachment,
    attachedFile,
    uploadState,
    uploadError,
    clearUploadError: () => setUploadError(null),
    oraStatus,
    clearConversation,
  };
}
