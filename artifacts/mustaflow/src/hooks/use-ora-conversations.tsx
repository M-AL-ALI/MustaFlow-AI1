import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/api-fetch";
import { useClerkUser } from "@/lib/clerk-safe";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CURRENT_ID_KEY = "ora_current_conversation_id";

export interface OraConversationSummary {
  id: number;
  title: string | null;
  projectId: number | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface OraProjectSummary {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface OraConversationsContextValue {
  projects: OraProjectSummary[];
  conversations: OraConversationSummary[];
  currentConversationId: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
  selectConversation: (id: number | null) => void;
  /** Reset to a blank chat. Optionally target a project for the next message. */
  newConversation: (projectId?: number | null) => void;
  /** Create the current conversation if one doesn't exist yet (first message). */
  ensureConversation: (title: string) => Promise<number | null>;
  /** Called by the chat hook after messages persist, to re-sort the list. */
  notifyPersisted: () => void;
  renameConversation: (id: number, title: string) => Promise<void>;
  deleteConversation: (id: number) => Promise<void>;
  moveConversation: (id: number, projectId: number | null) => Promise<void>;
  createProject: (name: string) => Promise<OraProjectSummary | null>;
  renameProject: (id: number, name: string) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
}

const OraConversationsContext = createContext<OraConversationsContextValue | null>(null);

function storeCurrentId(id: number | null): void {
  try {
    if (id == null) sessionStorage.removeItem(CURRENT_ID_KEY);
    else sessionStorage.setItem(CURRENT_ID_KEY, String(id));
  } catch {
    /* ignore */
  }
}

function getStoredCurrentId(): number | null {
  try {
    const raw = sessionStorage.getItem(CURRENT_ID_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function OraConversationsProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useClerkUser();
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(
    getStoredCurrentId,
  );
  const [loading, setLoading] = useState(true);

  const currentIdRef = useRef<number | null>(currentConversationId);
  currentIdRef.current = currentConversationId;
  const pendingProjectIdRef = useRef<number | null>(null);
  const creatingPromiseRef = useRef<Promise<number | null> | null>(null);

  const refresh = useCallback(async () => {
    if (!isSignedIn) {
      setProjects([]);
      setConversations([]);
      setLoading(false);
      return;
    }
    try {
      const [convRes, projRes] = await Promise.all([
        authFetch(`${BASE}/api/ora/conversations`),
        authFetch(`${BASE}/api/ora/projects`),
      ]);
      if (convRes.ok) {
        const data = (await convRes.json()) as { conversations: OraConversationSummary[] };
        setConversations(data.conversations);
        // If the stored current id no longer exists, drop it.
        if (
          currentIdRef.current != null &&
          !data.conversations.some((c) => c.id === currentIdRef.current)
        ) {
          setCurrentConversationId(null);
          storeCurrentId(null);
        }
      }
      if (projRes.ok) {
        const data = (await projRes.json()) as { projects: OraProjectSummary[] };
        setProjects(data.projects);
      }
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectConversation = useCallback((id: number | null) => {
    pendingProjectIdRef.current = null;
    setCurrentConversationId(id);
    storeCurrentId(id);
  }, []);

  const newConversation = useCallback((projectId?: number | null) => {
    pendingProjectIdRef.current = projectId ?? null;
    setCurrentConversationId(null);
    storeCurrentId(null);
  }, []);

  const ensureConversation = useCallback(
    async (title: string): Promise<number | null> => {
      if (currentIdRef.current != null) return currentIdRef.current;
      if (creatingPromiseRef.current) return creatingPromiseRef.current;

      const promise = (async (): Promise<number | null> => {
        try {
          const res = await authFetch(`${BASE}/api/ora/conversations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim().slice(0, 120) || null,
              projectId: pendingProjectIdRef.current ?? null,
            }),
          });
          if (!res.ok) return null;
          const data = (await res.json()) as { conversation: OraConversationSummary };
          const id = data.conversation.id;
          currentIdRef.current = id;
          pendingProjectIdRef.current = null;
          setCurrentConversationId(id);
          storeCurrentId(id);
          void refresh();
          return id;
        } catch {
          return null;
        }
      })();

      creatingPromiseRef.current = promise;
      const id = await promise;
      creatingPromiseRef.current = null;
      return id;
    },
    [refresh],
  );

  const notifyPersisted = useCallback(() => {
    void refresh();
  }, [refresh]);

  const renameConversation = useCallback(
    async (id: number, title: string) => {
      try {
        await authFetch(`${BASE}/api/ora/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim().slice(0, 120) || null }),
        });
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const deleteConversation = useCallback(
    async (id: number) => {
      try {
        await authFetch(`${BASE}/api/ora/conversations/${id}`, { method: "DELETE" });
        if (currentIdRef.current === id) {
          setCurrentConversationId(null);
          storeCurrentId(null);
        }
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const moveConversation = useCallback(
    async (id: number, projectId: number | null) => {
      try {
        await authFetch(`${BASE}/api/ora/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const createProject = useCallback(
    async (name: string): Promise<OraProjectSummary | null> => {
      try {
        const res = await authFetch(`${BASE}/api/ora/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim().slice(0, 80) }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { project: OraProjectSummary };
        await refresh();
        return data.project;
      } catch {
        return null;
      }
    },
    [refresh],
  );

  const renameProject = useCallback(
    async (id: number, name: string) => {
      try {
        await authFetch(`${BASE}/api/ora/projects/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim().slice(0, 80) }),
        });
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const deleteProject = useCallback(
    async (id: number) => {
      try {
        await authFetch(`${BASE}/api/ora/projects/${id}`, { method: "DELETE" });
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const value: OraConversationsContextValue = {
    projects,
    conversations,
    currentConversationId,
    loading,
    refresh,
    selectConversation,
    newConversation,
    ensureConversation,
    notifyPersisted,
    renameConversation,
    deleteConversation,
    moveConversation,
    createProject,
    renameProject,
    deleteProject,
  };

  return (
    <OraConversationsContext.Provider value={value}>{children}</OraConversationsContext.Provider>
  );
}

/** Returns the conversations context, or null when used outside the provider. */
export function useOraConversationsOptional(): OraConversationsContextValue | null {
  return useContext(OraConversationsContext);
}

/** Returns the conversations context; throws when used outside the provider. */
export function useOraConversations(): OraConversationsContextValue {
  const ctx = useContext(OraConversationsContext);
  if (!ctx) {
    throw new Error("useOraConversations must be used within an OraConversationsProvider");
  }
  return ctx;
}
