import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { authFetch } from "@/lib/api-fetch";
import { useClerkUser } from "@/lib/clerk-safe";
import { useToast } from "@/hooks/use-toast";
import { ORA_ACTIVE_HEARTBEAT_MS, shouldResumeOraConversation } from "@workspace/ora-contracts";
import {
  idleGatedOraConversationId,
  markOraActive,
  readOraLastActiveAt,
} from "@/lib/ora-idle-reset";
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
  // Decide once, before any heartbeat can update the timestamp. The saved
  // conversation id remains in sessionStorage when stale; we only decline to
  // auto-open it.
  const resumeOnMountRef = useRef(shouldResumeOraConversation(readOraLastActiveAt()));
  const [currentConversationId, setCurrentConversationId] = useState<number | null>(() =>
    getStoredPendingProjectId() != null ? null : idleGatedOraConversationId(getStoredCurrentId()),
  );
  const [newConversationTick, setNewConversationTick] = useState(0);
  const [conversationTransitionGeneration, setConversationTransitionGeneration] = useState(0);
  const [conversationTransitioning, setConversationTransitioning] = useState(false);
  const [loading, setLoading] = useState(true);

  const currentIdRef = useRef<number | null>(currentConversationId);
  currentIdRef.current = currentConversationId;
  const transitionGenerationRef = useRef(0);
  const transitionInProgressRef = useRef(false);
  const transitionHandlerRef = useRef<((nextConversationId: number | null) => void) | null>(null);

  const beginConversationTransition = useCallback((nextConversationId: number | null) => {
    const generation = transitionGenerationRef.current + 1;
    transitionGenerationRef.current = generation;
    transitionInProgressRef.current = true;
    setConversationTransitionGeneration(generation);
    setConversationTransitioning(true);
    transitionHandlerRef.current?.(nextConversationId);
    return generation;
  }, []);

  const isConversationTransitioning = useCallback(() => transitionInProgressRef.current, []);

  const completeConversationTransition = useCallback((generation: number) => {
    if (transitionGenerationRef.current !== generation) return;
    transitionInProgressRef.current = false;
    setConversationTransitioning(false);
  }, []);

  const registerConversationTransitionHandler = useCallback(
    (handler: (nextConversationId: number | null) => void) => {
      transitionHandlerRef.current = handler;
      return () => {
        if (transitionHandlerRef.current === handler) transitionHandlerRef.current = null;
      };
    },
    [],
  );
  // Scope override for the NEXT new conversation:
  //   undefined → defer to the active project (route)
  //   null      → explicit standalone chat
  //   number    → that specific project
  const pendingProjectIdRef = useRef<number | null | undefined>(undefined);
  const activeProjectIdRef = useRef<number | null>(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const creatingPromiseRef = useRef<Promise<number | null> | null>(null);
  const selectionGenRef = useRef(0);
  // Track whether we've synced last-active from server settings on mount.
  const lastActiveSyncedRef = useRef(false);
  const hiddenAtRef = useRef<number | null>(null);

  // Keep one durable "last active" clock for reloads and tab returns. The
  // initial resume decision above is already frozen before this heartbeat runs.
  useEffect(() => {
    if (!isSignedIn) return;

    const recordActive = () => markOraActive();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        const now = Date.now();
        hiddenAtRef.current = now;
        markOraActive(now);
        return;
      }

      const lastActiveAt = hiddenAtRef.current ?? readOraLastActiveAt();
      hiddenAtRef.current = null;
      if (!shouldResumeOraConversation(lastActiveAt)) {
        // Preserve sessionStorage + server lastConversationId. This changes only
        // the selected UI state and keeps project routes intact.
        currentIdRef.current = null;
        pendingProjectIdRef.current = undefined;
        setCurrentConversationId(null);
      }
      markOraActive();
    };
    const handlePageHide = () => {
      const now = Date.now();
      hiddenAtRef.current = now;
      markOraActive(now);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") recordActive();
    }, ORA_ACTIVE_HEARTBEAT_MS);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.clearInterval(heartbeat);
    };
  }, [isSignedIn]);

  const refresh = useCallback(async () => {
    if (!isSignedIn) {
      setProjects([]);
      setConversations([]);
      setLoading(false);
      return;
    }
    try {
      const [convRes, projRes] = await Promise.all([
        authFetch(`${BASE}/api/ora/conversations?limit=100`),
        authFetch(`${BASE}/api/ora/projects`),
      ]);
      if (convRes.ok) {
        const data = (await convRes.json()) as {
          conversations: OraConversationSummary[];
          hasMore?: boolean;
        };
        setConversations(data.conversations);
        const selected =
          currentIdRef.current == null
            ? null
            : data.conversations.find((conversation) => conversation.id === currentIdRef.current);
        // A hard project deep link is authoritative. Do not auto-open a stored
        // conversation from another project, and do not erase that stored id:
        // it may be resumed later from its own route.
        if (
          selected &&
          activeProjectIdRef.current != null &&
          selected.projectId !== activeProjectIdRef.current
        ) {
          currentIdRef.current = null;
          setCurrentConversationId(null);
        } else if (currentIdRef.current != null && !selected) {
          // The stored conversation no longer exists.
          currentIdRef.current = null;
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
    // A stale/missing local activity timestamp intentionally lands on home.
    // Keep the server's lastConversationId saved, but do not auto-open it.
    if (!resumeOnMountRef.current) return;
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
          const savedConversation = prev.find((conversation) => conversation.id === lastId);
          if (
            savedConversation &&
            (activeProjectIdRef.current == null ||
              savedConversation.projectId === activeProjectIdRef.current)
          ) {
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
      beginConversationTransition(null);
      selectionGenRef.current += 1;
      pendingProjectIdRef.current = undefined;
      currentIdRef.current = null;
      setCurrentConversationId(null);
      setNewConversationTick((tick) => tick + 1);
      storeCurrentId(null);
    }
  }, [activeProjectId, beginConversationTransition, conversations]);

  const selectConversation = useCallback(
    (id: number | null) => {
      markOraActive();
      beginConversationTransition(id);
      // Selecting an existing conversation clears any pending new-chat scope.
      selectionGenRef.current += 1;
      pendingProjectIdRef.current = undefined;
      currentIdRef.current = id;
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
    [beginConversationTransition, isSignedIn],
  );

  const newConversation = useCallback(
    (projectId?: number | null) => {
      markOraActive();
      beginConversationTransition(null);
      // `projectId` may be a number (scope to it), null (explicit standalone) or
      // undefined (defer to the active project route). Preserve the distinction —
      // do NOT coalesce undefined→null, or a project-scoped "New conversation"
      // would silently fall back to standalone.
      selectionGenRef.current += 1;
      pendingProjectIdRef.current = projectId;
      currentIdRef.current = null;
      setCurrentConversationId(null);
      setNewConversationTick((tick) => tick + 1);
      storeCurrentId(null);
    },
    [beginConversationTransition],
  );

  const ensureConversation = useCallback(
    async (title: string): Promise<number | null> => {
      if (currentIdRef.current != null) return currentIdRef.current;
      if (creatingPromiseRef.current) return creatingPromiseRef.current;

      const promise = (async (): Promise<number | null> => {
        const createGen = selectionGenRef.current;
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
          if (createGen !== selectionGenRef.current || currentIdRef.current != null) {
            return null;
          }
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

  const getCurrentConversationId = useCallback(() => currentIdRef.current, []);

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
    newConversationTick,
    conversationTransitionGeneration,
    conversationTransitioning,
    activeProjectId,
    activeProject,
    loading,
    refresh,
    selectConversation,
    newConversation,
    isConversationTransitioning,
    completeConversationTransition,
    registerConversationTransitionHandler,
    ensureConversation,
    getCurrentConversationId,
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
