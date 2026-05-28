import { useState, useEffect, useCallback, useRef } from "react";

export interface OraMessage {
  role: "user" | "assistant";
  content: string;
  handoffCta?: boolean;
}

export interface OraSession {
  sessionId: string;
  msgCount: number;
  msgLimit: number;
  fileCount: number;
  fileLimit: number;
}

export type UploadState = "idle" | "uploading" | "attached" | "error";

export interface AttachedFile {
  fileRef: string;
  filename: string;
  fileType: string;
  charCount: number;
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
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "ora_session_id";
const TRANSCRIPT_STORAGE_KEY = "ora_transcript";

const FILE_LIMIT = 3;
const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt"];
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

export function useOraChat(): UseOraChatReturn {
  const [messages, setMessages] = useState<OraMessage[]>([]);
  const [session, setSession] = useState<OraSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguageState] = useState<string>(getStoredLanguage);
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const initRef = useRef(false);

  const setLanguage = useCallback((lang: string) => {
    setLanguageState(lang);
    try {
      sessionStorage.setItem("ora_language", lang);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

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

  const uploadFile = useCallback(
    async (file: File) => {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setUploadState("error");
        setUploadError(`Unsupported file type "${ext}". Please upload a PDF, DOCX, or TXT file.`);
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
          fileCount: number;
          fileLimit: number;
        };

        setAttachedFile({
          fileRef: data.fileRef,
          filename: data.filename,
          fileType: data.fileType,
          charCount: data.charCount,
        });
        setUploadState("attached");
        setSession((prev) =>
          prev
            ? { ...prev, fileCount: data.fileCount, fileLimit: data.fileLimit }
            : null,
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
        return next;
      });
      setIsLoading(true);
      setError(null);

      const currentAttachment = attachedFile;

      try {
        const history = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));

        let data: { reply: string; handoffCta: boolean; msgCount: number; msgLimit: number };

        if (currentAttachment) {
          const body: Record<string, unknown> = {
            fileRef: currentAttachment.fileRef,
            message: content,
            messages: history,
          };
          if (language && language !== "auto") {
            body.language = language;
          }
          data = await apiPost<typeof data>("/api/public-ai/file-analysis", body);
          setAttachedFile(null);
          setUploadState("idle");
        } else {
          const body: Record<string, unknown> = { message: content, messages: history };
          if (language && language !== "auto") {
            body.language = language;
          }
          data = await apiPost<typeof data>("/api/public-ai/chat", body);
        }

        setMessages((prev) => {
          const next = [
            ...prev,
            { role: "assistant" as const, content: data.reply, handoffCta: data.handoffCta },
          ];
          storeTranscript(next);
          return next;
        });
        setSession((prev) =>
          prev
            ? { ...prev, msgCount: data.msgCount, msgLimit: data.msgLimit }
            : { sessionId: "", msgCount: data.msgCount, msgLimit: data.msgLimit, fileCount: 0, fileLimit: FILE_LIMIT },
        );
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
    [isLoading, messages, language, attachedFile],
  );

  const atLimit = (session?.msgCount ?? 0) >= (session?.msgLimit ?? 20);

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
  };
}
