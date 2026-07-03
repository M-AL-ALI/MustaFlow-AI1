import { useCallback, useEffect, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Code2,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderX,
  GitBranch,
  Globe,
  Loader2,
  MessageSquare,
  Monitor,
  Plus,
  RefreshCw,
  Send,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { authFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

// ── Types ──────────────────────────────────────────────────────────────────────

type OraxProject = {
  id: string;
  userId: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  status: "active" | "archived";
  defaultExecutionSourceId?: string | null;
  memory: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type OraxProjectSource = {
  id: string;
  projectId: string;
  userId: string;
  hostId?: string | null;
  type: "local_folder" | "github_repo" | "worktree" | "cloud_env" | "ssh_host";
  displayName: string;
  localPath?: string | null;
  repoUrl?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  status: "active" | "missing" | "disconnected" | "archived";
  metadata: Record<string, unknown>;
  lastSeenAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type OraxThread = {
  id: string;
  userId: string;
  projectId?: string | null;
  hostId?: string | null;
  executionSourceId?: string | null;
  title?: string | null;
  status: "idle" | "active" | "paused" | "completed" | "failed";
  mode: "local" | "worktree" | "cloud" | "ssh" | "chat_only";
  createdAt: string;
  updatedAt: string;
};

type OraxHost = {
  id: string;
  deviceName: string;
  platform: string;
  status: "online" | "offline" | "revoked";
  appVersion: string;
  lastSeenAt?: string | null;
};

// ── API helpers ────────────────────────────────────────────────────────────────

async function listProjects(): Promise<OraxProject[]> {
  const res = await authFetch("/api/orax/projects?status=active");
  if (!res.ok) throw new Error("Failed to load projects");
  const data = (await res.json()) as { projects: OraxProject[] };
  return data.projects;
}

async function createProject(name: string, description?: string): Promise<OraxProject> {
  const res = await authFetch("/api/orax/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) throw new Error("Failed to create project");
  const data = (await res.json()) as { project: OraxProject };
  return data.project;
}

async function archiveProject(projectId: string): Promise<void> {
  const res = await authFetch(`/api/orax/projects/${projectId}/archive`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to archive project");
}

async function getProject(projectId: string): Promise<OraxProject> {
  const res = await authFetch(`/api/orax/projects/${projectId}`);
  if (!res.ok) throw new Error("Failed to load project");
  const data = (await res.json()) as { project: OraxProject };
  return data.project;
}

async function listSources(projectId: string): Promise<OraxProjectSource[]> {
  const res = await authFetch(`/api/orax/projects/${projectId}/sources`);
  if (!res.ok) throw new Error("Failed to load sources");
  const data = (await res.json()) as { sources: OraxProjectSource[] };
  return data.sources;
}

async function attachGithub(
  projectId: string,
  repoUrl: string,
  displayName?: string,
  branch?: string,
): Promise<OraxProjectSource> {
  const res = await authFetch(`/api/orax/projects/${projectId}/sources/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl, displayName, branch }),
  });
  if (!res.ok) throw new Error("Failed to attach GitHub repo");
  const data = (await res.json()) as { source: OraxProjectSource };
  return data.source;
}

async function deleteSource(projectId: string, sourceId: string): Promise<void> {
  const res = await authFetch(`/api/orax/projects/${projectId}/sources/${sourceId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to remove source");
}

async function listThreads(projectId: string): Promise<OraxThread[]> {
  const res = await authFetch(`/api/orax/projects/${projectId}/threads`);
  if (!res.ok) throw new Error("Failed to load threads");
  const data = (await res.json()) as { threads: OraxThread[] };
  return data.threads;
}

async function createThread(
  projectId: string,
  opts: { title?: string; executionSourceId?: string; hostId?: string; initialMessage?: string },
): Promise<OraxThread> {
  const res = await authFetch(`/api/orax/projects/${projectId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error("Failed to create thread");
  const data = (await res.json()) as { thread: OraxThread };
  return data.thread;
}

async function listHosts(): Promise<OraxHost[]> {
  const res = await authFetch("/api/orax/hosts");
  if (!res.ok) return [];
  const data = (await res.json()) as { hosts: OraxHost[] };
  return data.hosts ?? [];
}

type ThreadMessage = { id: string; role: string; content: string; createdAt: string };
type ThreadExecCtx = {
  canExecute: boolean;
  mode: string;
  blockReason: string | null;
  host: { id: string; deviceName: string; status: string } | null;
};

async function getThreadMessages(projectId: string, threadId: string): Promise<ThreadMessage[]> {
  const res = await authFetch(
    `/api/orax/projects/${projectId}/threads/${threadId}/messages`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { messages: ThreadMessage[] };
  return data.messages ?? [];
}

async function getThreadContext(projectId: string, threadId: string): Promise<ThreadExecCtx> {
  const res = await authFetch(
    `/api/orax/projects/${projectId}/threads/${threadId}/context`,
  );
  if (!res.ok)
    return { canExecute: false, mode: "chat_only", blockReason: "Unable to load context", host: null };
  const data = (await res.json()) as { context: ThreadExecCtx };
  return data.context;
}


async function continueThread(
  projectId: string,
  threadId: string,
  opts: { userMessage?: string; executionSourceId?: string },
): Promise<{ context: ThreadExecCtx; message: ThreadMessage | null }> {
  const res = await authFetch(
    `/api/orax/projects/${projectId}/threads/${threadId}/continue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    },
  );
  if (!res.ok) throw new Error("Failed to continue thread");
  return res.json() as Promise<{ context: ThreadExecCtx; message: ThreadMessage | null }>;
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function sourceIcon(type: OraxProjectSource["type"]) {
  if (type === "local_folder" || type === "worktree") return <Folder size={13} />;
  if (type === "github_repo") return <GitBranch size={13} />;
  if (type === "cloud_env") return <Globe size={13} />;
  if (type === "ssh_host") return <Terminal size={13} />;
  return <Code2 size={13} />;
}

function sourceStatusBadge(status: OraxProjectSource["status"]) {
  if (status === "active")
    return <span className="text-xs text-green-500 font-medium">Active</span>;
  if (status === "missing")
    return <span className="text-xs text-amber-500 font-medium">Reconnect folder on desktop</span>;
  if (status === "disconnected")
    return <span className="text-xs text-muted-foreground font-medium">Disconnected</span>;
  if (status === "archived")
    return <span className="text-xs text-muted-foreground">Archived</span>;
  return null;
}

function hostOnline(host: OraxHost) {
  return host.status === "online";
}

// ── ThreadDetail view ──────────────────────────────────────────────────────────

function ThreadDetail({
  projectId,
  thread,
  onBack,
}: {
  projectId: string;
  thread: OraxThread;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [ctx, setCtx] = useState<ThreadExecCtx | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [msgs, execCtx] = await Promise.all([
        getThreadMessages(projectId, thread.id),
        getThreadContext(projectId, thread.id),
      ]);
      setMessages(msgs);
      setCtx(execCtx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load thread");
    } finally {
      setLoading(false);
    }
  }, [projectId, thread.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    setError(null);
    try {
      const result = await continueThread(projectId, thread.id, { userMessage: text });
      setCtx(result.context);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const isChatOnly = thread.mode === "chat_only" || ctx?.mode === "chat_only";
  const hostOnlineStatus =
    ctx?.host?.status === "online"
      ? "online"
      : ctx?.host
        ? "offline"
        : null;

  return (
    <div className="flex flex-col gap-4 max-w-2xl mx-auto py-6 px-4">
      {/* Back + title */}
      <div className="flex items-center gap-3">
        <button className="btn btn-ghost p-1.5" onClick={onBack}>
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold truncate">{thread.title ?? "Untitled thread"}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className={cn(
                "text-xs font-medium",
                thread.status === "active"
                  ? "text-green-500"
                  : thread.status === "failed"
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              {thread.status}
            </span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">{thread.mode}</span>
          </div>
        </div>
        <button
          className="btn btn-ghost p-1.5"
          onClick={() => void reload()}
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Execution context banner */}
      {ctx && !ctx.canExecute && ctx.blockReason && (
        <div
          className={cn(
            "flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm",
            isChatOnly
              ? "border-border bg-muted/20 text-muted-foreground"
              : "border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400",
          )}
        >
          <Monitor size={14} className="shrink-0 mt-0.5" />
          <span>{ctx.blockReason}</span>
        </div>
      )}

      {/* Host online indicator */}
      {ctx?.canExecute && hostOnlineStatus === "online" && (
        <div className="flex items-center gap-2 text-xs text-green-500">
          <Monitor size={12} />
          <span>{ctx.host?.deviceName ?? "Desktop"} online — ready to execute</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <button className="btn btn-ghost p-1" onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex flex-col gap-2.5">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <MessageSquare size={20} className="text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {isChatOnly
                ? "Start a planning conversation below."
                : "Send a message to start execution."}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex gap-2.5",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[80%] rounded-xl px-3.5 py-2 text-sm leading-relaxed",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-card text-foreground",
                )}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2 border-t pt-4">
        <textarea
          className="input flex-1 resize-none text-sm min-h-[42px] max-h-36"
          rows={2}
          placeholder={
            isChatOnly
              ? "Plan your work... (attach a source to execute code)"
              : ctx?.canExecute
                ? "Describe what you want to run..."
                : "Send a planning message..."
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={sending}
        />
        <button
          className="btn btn-primary p-2.5 shrink-0"
          onClick={() => void handleSend()}
          disabled={!draft.trim() || sending}
          title="Send"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}

// ── ProjectList page ────────────────────────────────────────────────────────────

function ProjectList({
  onSelect,
}: {
  onSelect: (p: OraxProject) => void;
}) {
  const [projects, setProjects] = useState<OraxProject[]>([]);
  const [hosts, setHosts] = useState<OraxHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projs, hs] = await Promise.all([listProjects(), listHosts()]);
      setProjects(projs);
      setHosts(hs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setBusy("create");
    try {
      const p = await createProject(newName.trim(), newDesc.trim() || undefined);
      setCreating(false);
      setNewName("");
      setNewDesc("");
      await reload();
      onSelect(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive(projectId: string) {
    setBusy(projectId);
    try {
      await archiveProject(projectId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive project");
    } finally {
      setBusy(null);
    }
  }

  const onlineHosts = hosts.filter(hostOnline);
  const anyHostOnline = onlineHosts.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Orax Projects</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cloud workspaces for your coding sessions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost p-1.5"
            onClick={() => void reload()}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="btn btn-primary flex items-center gap-1.5 text-sm"
            onClick={() => setCreating(true)}
          >
            <Plus size={14} />
            New project
          </button>
        </div>
      </div>

      {/* Desktop host status banner */}
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm",
          anyHostOnline
            ? "border-green-500/30 bg-green-500/5 text-green-600 dark:text-green-400"
            : "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
        )}
      >
        <Monitor size={14} className="shrink-0" />
        {anyHostOnline ? (
          <span>
            {onlineHosts.length === 1
              ? `${onlineHosts[0]!.deviceName} is online`
              : `${onlineHosts.length} desktop hosts online`}
          </span>
        ) : (
          <span>
            No desktop host connected.{" "}
            <Link href="/orax/devices" className="underline underline-offset-2">
              Connect Orax Desktop
            </Link>{" "}
            to execute code locally.
          </span>
        )}
      </div>

      {/* Create form */}
      {creating && (
        <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">New project</span>
            <button
              className="btn btn-ghost p-1"
              onClick={() => {
                setCreating(false);
                setNewName("");
                setNewDesc("");
              }}
            >
              <X size={14} />
            </button>
          </div>
          <input
            className="input text-sm"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
            autoFocus
          />
          <input
            className="input text-sm"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button
              className="btn btn-ghost text-sm"
              onClick={() => {
                setCreating(false);
                setNewName("");
                setNewDesc("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-sm flex items-center gap-1.5"
              onClick={() => void handleCreate()}
              disabled={!newName.trim() || busy === "create"}
            >
              {busy === "create" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Create project
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <button className="btn btn-ghost p-1" onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Project list */}
      {projects.length === 0 && !creating ? (
        <div className="flex flex-col items-center gap-3 py-14 text-center">
          <FolderOpen size={32} className="text-muted-foreground/50" />
          <div>
            <p className="text-sm font-medium">No projects yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create a project to start coding with Orax.
            </p>
          </div>
          <button
            className="btn btn-secondary text-sm flex items-center gap-1.5 mt-2"
            onClick={() => setCreating(true)}
          >
            <Plus size={13} />
            New project
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {projects.map((proj) => (
            <div
              key={proj.id}
              className="group rounded-lg border bg-card hover:border-primary/40 transition-colors cursor-pointer"
              onClick={() => onSelect(proj)}
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <FolderOpen size={16} className="text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{proj.name}</div>
                  {proj.description && (
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {proj.description}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="btn btn-ghost p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Archive project"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleArchive(proj.id);
                    }}
                    disabled={busy === proj.id}
                  >
                    {busy === proj.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                  </button>
                  <ChevronRight size={14} className="text-muted-foreground" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ProjectDetail page ─────────────────────────────────────────────────────────

function ProjectDetail({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<OraxProject | null>(null);
  const [sources, setSources] = useState<OraxProjectSource[]>([]);
  const [threads, setThreads] = useState<OraxThread[]>([]);
  const [hosts, setHosts] = useState<OraxHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Thread detail navigation
  const [selectedThread, setSelectedThread] = useState<OraxThread | null>(null);

  // New thread compose
  const [composing, setComposing] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const [threadMsg, setThreadMsg] = useState("");

  // Attach GitHub repo
  const [addingGithub, setAddingGithub] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [proj, srcs, thrs, hs] = await Promise.all([
        getProject(projectId),
        listSources(projectId),
        listThreads(projectId),
        listHosts(),
      ]);
      setProject(proj);
      setSources(srcs);
      setThreads(thrs);
      setHosts(hs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleCreateThread() {
    if (!threadTitle.trim() && !threadMsg.trim()) return;
    setBusy("thread");
    try {
      const defaultSource = sources.find((s) => s.status === "active");
      await createThread(projectId, {
        title: threadTitle.trim() || undefined,
        executionSourceId: defaultSource?.id,
        hostId: defaultSource?.hostId ?? undefined,
        initialMessage: threadMsg.trim() || undefined,
      });
      setComposing(false);
      setThreadTitle("");
      setThreadMsg("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create thread");
    } finally {
      setBusy(null);
    }
  }

  async function handleAttachGithub() {
    if (!githubUrl.trim()) return;
    setBusy("github");
    try {
      await attachGithub(projectId, githubUrl.trim(), undefined, githubBranch.trim() || "main");
      setAddingGithub(false);
      setGithubUrl("");
      setGithubBranch("main");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to attach repo");
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteSource(sourceId: string) {
    setBusy(sourceId);
    try {
      await deleteSource(projectId, sourceId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove source");
    } finally {
      setBusy(null);
    }
  }

  if (selectedThread) {
    return (
      <ThreadDetail
        projectId={projectId}
        thread={selectedThread}
        onBack={() => setSelectedThread(null)}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center gap-3 py-20">
        <p className="text-sm text-muted-foreground">Project not found.</p>
        <button className="btn btn-ghost text-sm" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }

  const activeSources = sources.filter((s) => s.status !== "archived");
  const missingLocalFolders = activeSources.filter(
    (s) => s.type === "local_folder" && s.status === "missing",
  );
  const hasActiveSource = activeSources.some((s) => s.status === "active");
  const onlineHosts = hosts.filter(hostOnline);
  const anyHostOnline = onlineHosts.length > 0;

  return (
    <div className="flex flex-col gap-5 max-w-2xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button className="btn btn-ghost p-1.5" onClick={onBack}>
          <ArrowLeft size={15} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{project.name}</h1>
          {project.description && (
            <p className="text-xs text-muted-foreground">{project.description}</p>
          )}
        </div>
        <button
          className="btn btn-ghost p-1.5"
          onClick={() => void reload()}
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive flex items-center justify-between">
          <span>{error}</span>
          <button className="btn btn-ghost p-1" onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Desktop host status */}
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm",
          anyHostOnline
            ? "border-green-500/30 bg-green-500/5"
            : "border-border bg-muted/20",
        )}
      >
        <Monitor
          size={14}
          className={cn("shrink-0", anyHostOnline ? "text-green-500" : "text-muted-foreground")}
        />
        <span className={anyHostOnline ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}>
          {anyHostOnline
            ? `${onlineHosts[0]!.deviceName} online`
            : "Desktop offline — attach a folder on your desktop to run code"}
        </span>
      </div>

      {/* Missing local folder warning */}
      {missingLocalFolders.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 flex items-start gap-2.5 text-sm">
          <FolderX size={15} className="shrink-0 text-amber-500 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-amber-600 dark:text-amber-400">
              {missingLocalFolders.length === 1
                ? "Local folder not found"
                : `${missingLocalFolders.length} local folders not found`}
            </p>
            <p className="text-muted-foreground mt-0.5">
              Reconnect folder on desktop or clone from GitHub to restore execution.
            </p>
          </div>
        </div>
      )}

      {/* No execution source — chat-only planning mode */}
      {!hasActiveSource && missingLocalFolders.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-3.5 py-3 flex items-start gap-2.5 text-sm text-muted-foreground">
          <Code2 size={15} className="shrink-0 mt-0.5" />
          <span>
            Attach a local folder or GitHub repo to execute code. You can start a chat-only planning
            thread now.
          </span>
        </div>
      )}

      {/* Execution sources */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Execution sources</h2>
          <div className="flex items-center gap-1">
            <button
              className="btn btn-ghost text-xs flex items-center gap-1 px-2 py-1"
              onClick={() => setAddingGithub(true)}
              title="Attach GitHub repo"
            >
              <GitBranch size={11} />
              GitHub
            </button>
            <span className="text-xs text-muted-foreground px-1">
              · Attach folder via Orax Desktop
            </span>
          </div>
        </div>

        {/* Add GitHub repo form */}
        {addingGithub && (
          <div className="rounded-lg border bg-card p-4 flex flex-col gap-3 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-1.5">
                <GitBranch size={13} />
                Attach GitHub repo
              </span>
              <button className="btn btn-ghost p-1" onClick={() => setAddingGithub(false)}>
                <X size={13} />
              </button>
            </div>
            <input
              className="input text-sm"
              placeholder="https://github.com/owner/repo"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              autoFocus
            />
            <input
              className="input text-sm"
              placeholder="Branch (default: main)"
              value={githubBranch}
              onChange={(e) => setGithubBranch(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                className="btn btn-ghost text-sm"
                onClick={() => setAddingGithub(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary text-sm flex items-center gap-1.5"
                onClick={() => void handleAttachGithub()}
                disabled={!githubUrl.trim() || busy === "github"}
              >
                {busy === "github" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                Attach
              </button>
            </div>
          </div>
        )}

        {activeSources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-6 flex flex-col items-center gap-2 text-center">
            <Folder size={22} className="text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              No execution sources attached. Add a GitHub repo above or attach a local folder via
              Orax Desktop.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {activeSources.map((src) => (
              <div
                key={src.id}
                className="group flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5"
              >
                <span className="text-muted-foreground shrink-0">{sourceIcon(src.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{src.displayName}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {sourceStatusBadge(src.status)}
                    {src.localPath && (
                      <span className="text-xs text-muted-foreground truncate">{src.localPath}</span>
                    )}
                    {src.repoUrl && !src.localPath && (
                      <a
                        href={src.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary flex items-center gap-0.5 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View repo
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-ghost p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  title="Remove source"
                  onClick={() => void handleDeleteSource(src.id)}
                  disabled={busy === src.id}
                >
                  {busy === src.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Threads */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Threads</h2>
          <button
            className="btn btn-ghost text-xs flex items-center gap-1 px-2 py-1"
            onClick={() => setComposing(true)}
          >
            <Plus size={11} />
            New thread
          </button>
        </div>

        {/* New thread compose */}
        {composing && (
          <div className="rounded-lg border bg-card p-4 flex flex-col gap-3 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">New thread</span>
              <button
                className="btn btn-ghost p-1"
                onClick={() => {
                  setComposing(false);
                  setThreadTitle("");
                  setThreadMsg("");
                }}
              >
                <X size={13} />
              </button>
            </div>
            <input
              className="input text-sm"
              placeholder="Thread title (optional)"
              value={threadTitle}
              onChange={(e) => setThreadTitle(e.target.value)}
              autoFocus
            />
            <textarea
              className="input text-sm resize-none"
              rows={3}
              placeholder={
                hasActiveSource
                  ? "Describe what you want to work on..."
                  : "Start with a planning message (no execution source attached yet)"
              }
              value={threadMsg}
              onChange={(e) => setThreadMsg(e.target.value)}
            />
            {!hasActiveSource && (
              <p className="text-xs text-muted-foreground">
                This thread will start in chat-only planning mode. Attach a local folder or GitHub
                repo to enable code execution.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="btn btn-ghost text-sm"
                onClick={() => {
                  setComposing(false);
                  setThreadTitle("");
                  setThreadMsg("");
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary text-sm flex items-center gap-1.5"
                onClick={() => void handleCreateThread()}
                disabled={(!threadTitle.trim() && !threadMsg.trim()) || busy === "thread"}
              >
                {busy === "thread" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                Start thread
              </button>
            </div>
          </div>
        )}

        {threads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-6 flex flex-col items-center gap-2 text-center">
            <MessageSquare size={22} className="text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">No threads yet. Start a new thread.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {threads.map((thread) => (
              <button
                key={thread.id}
                className="group w-full text-left flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5 hover:bg-muted/30 transition-colors"
                onClick={() => setSelectedThread(thread)}
              >
                <MessageSquare size={13} className="shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {thread.title ?? "Untitled thread"}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={cn(
                        "text-xs font-medium",
                        thread.status === "active"
                          ? "text-green-500"
                          : thread.status === "failed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      {thread.status}
                    </span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">{thread.mode}</span>
                  </div>
                </div>
                <ChevronRight size={13} className="shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Main OraxWorkspace page ────────────────────────────────────────────────────

export default function OraxWorkspacePage() {
  const [, params] = useRoute("/orax/workspace/:projectId");
  const [, setLocation] = useLocation();
  const [selectedProject, setSelectedProject] = useState<OraxProject | null>(null);

  // Sync URL → selected project
  const projectIdFromUrl = params?.projectId;
  useEffect(() => {
    if (!projectIdFromUrl) {
      setSelectedProject(null);
    }
  }, [projectIdFromUrl]);

  function handleSelectProject(proj: OraxProject) {
    setSelectedProject(proj);
    setLocation(`/orax/workspace/${proj.id}`);
  }

  function handleBack() {
    setSelectedProject(null);
    setLocation("/orax/workspace");
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link href="/projects" className="btn btn-ghost p-1.5">
            <ArrowLeft size={15} />
          </Link>
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Code2 size={14} className="text-primary" />
            <span>Orax</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/orax/devices" className="btn btn-ghost p-1.5" title="Devices">
            <Monitor size={14} />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      {/* Body */}
      {selectedProject ?? projectIdFromUrl ? (
        <ProjectDetail
          projectId={(selectedProject?.id ?? projectIdFromUrl)!}
          onBack={handleBack}
        />
      ) : (
        <ProjectList onSelect={handleSelectProject} />
      )}
    </div>
  );
}
