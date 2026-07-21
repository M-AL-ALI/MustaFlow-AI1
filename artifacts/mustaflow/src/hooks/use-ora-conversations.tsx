import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { authFetch } from "@/lib/api-fetch";
import { useClerkUser } from "@/lib/clerk-safe";
import { useToast } from "@/hooks/use-toast";
import {
  resolveScopeProjectId,
  shouldDeselectMovedConversation,
  isActiveProjectValid,
} from "@/lib/ora-project-scope";
import {
  OraConversationsContext,
  type OraConversationSummary,
  type OraProjectSummary,
  type OraConversationsContextValue,
} from "@/hooks/ora-conversations-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CURRENT_ID_KEY = "ora_current_conversation_id";
// Set by the dedicated "New project" page so the first chat opened after
// creating a project is scoped to that project (not saved as standalone).
const PENDING_PROJECT_KEY = "ora_pending_project_id";

function storeCurrentId(id: number | null): void {
  try {
    if (id == null) sessionStorage.removeItem(CURRENT_ID_KEY);
    else sessionStorage.setItem(CURRENT_ID_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/** Stash a project id so the next Ora session opens a fresh chat under it. */
export function setPendingOraProjectId(id: number): void {
  try {
    sessionStorage.setItem(PENDING_PROJECT_KEY, String(id));
  } catch {
    /* ignore */
  }
}

/** Read (without clearing) the pending project id, if any. */
function getStoredPendingProjectId(): number | null {
  try {
    const raw = sessionStorage.getItem(PENDING_PROJECT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
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

export function OraConversationsProvider({
  children,
  activeProjectId = null,
}: {
  children: React.ReactNode;
  /**
   * The project the user is inside, derived from the `/ora/projects/:projectId`
   * route. This is the single source of truth for the active project and
   * survives reloads because it comes from the URL, not local/session state.
   */
  activeProjectId?: number | null;
}) {
  const { isSignedIn } = useClerkUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(() =>
    getStoredPendingProjectId() != null ? null : getStoredCurrentId(),
  );
  const [loading, setLoading] = useState(true);

  const currentIdRef = useRef<number | null>(currentConversationId);
  currentIdRef.current = currentConversationId;
  // Scope override for the NEXT new conversation:
  //   undefined → defer to the active project (route)
  //   null      → explicit standalone chat
  //   number    → that specific project
  const pendingProjectIdRef = useRef<number | null | undefined>(undefined);
  const activeProjectIdRef = useRef<number | null>(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const creatingPromiseRef = useRef<Promise<number | null> | null>(null);
  // Track whether we've synced last-active from server settings on mount.
  const lastActiveSyncedRef = useRef(false);

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
        const data = (await convRes.json()) as {
          conversations: OraConversationSummary[];
          hasMore?: boolean;
        };
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

  // After the first load, sync the last-active conversation from server settings
  // so the user picks up where they left off (e.g. different browser/device).
  useEffect(() => {
    if (loading) return;
    if (!isSignedIn) return;
    if (lastActiveSyncedRef.current) return;
    lastActiveSyncedRef.current = true;
    // Only apply if there's no locally-stored id already.
    if (currentIdRef.current != null) return;
    void (async () => {
      try {
        const res = await authFetch(`${BASE}/api/ora/settings`);
        if (!res.ok) return;
        const data = (await res.json()) as { settings?: { lastConversationId?: number | null } };
        const lastId = data.settings?.lastConversationId ?? null;
        if (lastId == null) return;
        if (currentIdRef.current != null) return; // user already selected something
        // Confirm the id still exists in the loaded list.
        setConversations((prev) => {
          if (prev.some((c) => c.id === lastId)) {
            setCurrentConversationId(lastId);
            storeCurrentId(lastId);
          }
          return prev;
        });
      } catch {
        /* best-effort */
      }
    })();
  }, [loading, isSignedIn]);

  // When arriving from the dedicated "New project" page, open a fresh chat
  // scoped to that project so the first message is saved under it (not as a
  // standalone conversation). Consume the stashed id once on mount.
  const pendingConsumedRef = useRef(false);
  useEffect(() => {
    if (pendingConsumedRef.current) return;
    pendingConsumedRef.current = true;
    const pid = getStoredPendingProjectId();
    if (pid != null) {
      pendingProjectIdRef.current = pid;
      setCurrentConversationId(null);
      storeCurrentId(null);
      try {
        sessionStorage.removeItem(PENDING_PROJECT_KEY);
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Route guard: if the active project (from the URL) is invalid or points at an
  // archived/deleted project, redirect to /ora and surface a clear message. We
  // must NOT silently fall through to standalone Ora and save chats as
  // standalone. Wait until the project list has loaded before judging validity.
  useEffect(() => {
    if (loading) return;
    if (activeProjectId == null) return;
    if (!isActiveProjectValid(activeProjectId, projects)) {
      toast({ title: "That project no longer exists" });
      setLocation("/ora");
    }
  }, [loading, activeProjectId, projects, toast, setLocation]);

  // Entering/leaving a project (route change) resets to a blank chat unless the
  // currently-open conversation already belongs to the new active project — so
  // the main view shows that project's home, never a chat from another project.
  // Initialised to the mount value so a hard reload on /ora/projects/:id keeps
  // any stored conversation selection rather than blanking it.
  const prevActiveProjectRef = useRef<number | null>(activeProjectId);
  useEffect(() => {
    if (prevActiveProjectRef.current === activeProjectId) return;
    prevActiveProjectRef.current = activeProjectId;
    const current = conversations.find((c) => c.id === currentIdRef.current);
    const currentProjectId = current?.projectId ?? null;
    if (currentProjectId !== activeProjectId) {
      pendingProjectIdRef.current = undefined;
      setCurrentConversationId(null);
      storeCurrentId(null);
    }
  }, [activeProjectId, conversations]);

  const selectConversation = useCallback(
    (id: number | null) => {
      // Selecting an existing conversation clears any pending new-chat scope.
      pendingProjectIdRef.current = undefined;
      setCurrentConversationId(id);
      storeCurrentId(id);
      // Fire-and-forget: sync the last-active id to server settings.
      if (id != null && isSignedIn) {
        void authFetch(`${BASE}/api/ora/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastConversationId: id }),
        }).catch(() => {
          /* best-effort */
        });
      }
    },
    [isSignedIn],
  );

  const newConversation = useCallback((projectId?: number | null) => {
    // `projectId` may be a number (scope to it), null (explicit standalone) or
    // undefined (defer to the active project route). Preserve the distinction —
    // do NOT coalesce undefined→null, or a project-scoped "New conversation"
    // would silently fall back to standalone.
    pendingProjectIdRef.current = projectId;
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
              // Route is the source of truth: when no explicit override was set,
              // a first message persists under the active project (if any).
              projectId: resolveScopeProjectId(
                pendingProjectIdRef.current,
                activeProjectIdRef.current,
              ),
            }),
          });
          if (!res.ok) return null;
          const data = (await res.json()) as { conversation: OraConversationSummary };
          const id = data.conversation.id;
          currentIdRef.current = id;
          pendingProjectIdRef.current = undefined;
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
          body: JSON.stringify({ title: title.trim().slice(0, 120) || null, titleSource: "user" }),
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

  const restoreConversation = useCallback(
    async (id: number) => {
      try {
        await authFetch(`${BASE}/api/ora/conversations/${id}/restore`, { method: "PATCH" });
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const permanentDeleteConversation = useCallback(
    async (id: number) => {
      try {
        await authFetch(`${BASE}/api/ora/conversations/${id}?permanent=true`, { method: "DELETE" });
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

  const pinConversation = useCallback(
    async (id: number, pinned: boolean) => {
      try {
        await authFetch(`${BASE}/api/ora/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned }),
        });
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
        // If the open conversation just left the active project, deselect it so
        // the UI never shows a chat inside the wrong project.
        if (
          shouldDeselectMovedConversation(
            id,
            currentIdRef.current,
            projectId,
            activeProjectIdRef.current,
          )
        ) {
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

  const restoreProject = useCallback(
    async (id: number) => {
      try {
        await authFetch(`${BASE}/api/ora/projects/${id}/restore`, { method: "POST" });
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const activeProject = useMemo(
    () =>
      activeProjectId == null ? null : (projects.find((p) => p.id === activeProjectId) ?? null),
    [activeProjectId, projects],
  );

  const value: OraConversationsContextValue = {
    projects,
    conversations,
    currentConversationId,
    activeProjectId,
    activeProject,
    loading,
    refresh,
    selectConversation,
    newConversation,
    ensureConversation,
    notifyPersisted,
    renameConversation,
    deleteConversation,
    restoreConversation,
    permanentDeleteConversation,
    pinConversation,
    moveConversation,
    createProject,
    renameProject,
    deleteProject,
    restoreProject,
  };

  return (
    <OraConversationsContext.Provider value={value}>{children}</OraConversationsContext.Provider>
  );
}
