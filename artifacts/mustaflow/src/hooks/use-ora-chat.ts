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
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_STORAGE_KEY = "ora_session_id";

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
          const data = await apiGet<OraSession>("/api/public-ai/session");
          setSession(data);
          return;
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          if (status === 401) {
            clearStoredSessionId();
          }
        }
      }
      try {
        const data = await apiPost<OraSession>("/api/public-ai/session", {});
        storeSessionId(data.sessionId);
        setSession(data);
      } catch (err: unknown) {
        const msg = (err as Error).message ?? "Could not start Ora session.";
        setError(msg);
      }
    };

    void init();
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return;

      const userMsg: OraMessage = { role: "user", content };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setError(null);

      try {
        // Keep at most the last 20 messages so the backend's array limit is never exceeded
        const history = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
        const body: Record<string, unknown> = { message: content, messages: history };
        if (language && language !== "auto") {
          body.language = language;
        }

        const data = await apiPost<{
          reply: string;
          handoffCta: boolean;
          msgCount: number;
          msgLimit: number;
        }>("/api/public-ai/chat", body);

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.reply, handoffCta: data.handoffCta },
        ]);
        setSession((prev) =>
          prev
            ? { ...prev, msgCount: data.msgCount, msgLimit: data.msgLimit }
            : { sessionId: "", msgCount: data.msgCount, msgLimit: data.msgLimit },
        );
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        const msg = (err as Error).message;
        if (status === 429) {
          setError(msg ?? "You have reached the message limit for this session.");
        } else if (status === 401) {
          clearStoredSessionId();
          setError(
            "Your session has expired. Please refresh the page to start a new conversation.",
          );
        } else {
          setError(msg ?? "Something went wrong. Please try again.");
        }
        setMessages((prev) => prev.slice(0, -1));
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, messages, language],
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
  };
}
