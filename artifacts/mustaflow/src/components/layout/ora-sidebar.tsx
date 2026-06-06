import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import logoUrl from "/logo.png";
import {
  MessageCirclePlus,
  BookOpen,
  Brain,
  Settings,
  LogOut,
  ChevronDown,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  FolderInput,
  Image as ImageIcon,
  HelpCircle,
  Bug,
  LifeBuoy,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerkUser, useClerkActions } from "@/lib/clerk-safe";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  useOraConversations,
  type OraConversationSummary,
  type OraProjectSummary,
} from "@/hooks/ora-conversations-context";

// Ora is a standalone assistant — it must NOT link into the AI Builder's
// /integrations page. Only Ora-scoped destinations belong here.
export const NAV_ITEMS = [
  { name: "Memory", href: "/ora/memory", icon: Brain },
  { name: "Library", href: "/ora/library", icon: BookOpen },
  { name: "Help Center", href: "/help", icon: HelpCircle },
  { name: "Report Issue", href: "/help?mode=report", icon: Bug },
  { name: "My Support Tickets", href: "/support/tickets", icon: LifeBuoy },
  { name: "Settings", href: "/ora/settings", icon: Settings },
];

interface OraWindowUsage {
  messageCount: number;
  messageLimit: number;
  imageCount: number;
  imageLimit: number;
  resetsAt: string | null;
  windowHours?: number;
}

/**
 * Format the time remaining until `resetsAt` as a compact countdown, e.g.
 * "4h 32m" or "12m". Returns null when there is no active window (resetsAt is
 * null — the full allowance is available and the timer hasn't started yet).
 */
function formatCountdown(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  const ms = target - now;
  if (ms <= 0) return null;
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Ora is metered by per-user ROLLING-WINDOW message/image quotas per tier — NOT
// the AI Builder credit wallet. Messages and images share ONE window timer that
// refills together. This widget reads /api/public-ai/usage and must never call
// /api/credits or link to Builder billing.
function OraUsageWidget() {
  const { isSignedIn } = useClerkUser();
  const [usage, setUsage] = useState<OraWindowUsage | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fetchUsage = useCallback(async () => {
    try {
      const res = await authFetch("/api/public-ai/usage");
      if (res.ok) {
        const data = (await res.json()) as OraWindowUsage;
        setUsage(data);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    void fetchUsage();
    const id = setInterval(() => void fetchUsage(), 60_000);
    const onFocus = () => void fetchUsage();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [isSignedIn, fetchUsage]);

  // Tick the countdown every second so the reset time stays live.
  useEffect(() => {
    if (!usage?.resetsAt) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [usage?.resetsAt]);

  if (!isSignedIn || !usage) return null;

  const msgRemaining = Math.max(0, usage.messageLimit - usage.messageCount);
  const imgRemaining = Math.max(0, usage.imageLimit - usage.imageCount);
  const msgLow = msgRemaining <= Math.max(1, Math.ceil(usage.messageLimit * 0.1));
  const countdown = formatCountdown(usage.resetsAt, now);

  return (
    <div className="px-3 py-2">
      <div
        className={cn(
          "rounded-lg px-3 py-2.5 text-xs border",
          msgLow
            ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-600"
            : "bg-muted/50 border-border text-muted-foreground",
        )}
      >
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-foreground">{msgRemaining}</span>
            <span className="ml-1">of {usage.messageLimit} messages left</span>
          </div>
        </div>
        {usage.imageLimit > 0 && (
          <div className="flex items-center gap-2 mt-1.5">
            <ImageIcon className="h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-foreground">{imgRemaining}</span>
              <span className="ml-1">of {usage.imageLimit} images left</span>
            </div>
          </div>
        )}
        {countdown ? (
          <div className="flex items-center gap-2 mt-1.5">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="ml-0">Resets in {countdown}</span>
            </div>
          </div>
        ) : (
          <p className="text-[10px] leading-tight mt-1.5 font-normal">Full allowance available</p>
        )}
      </div>
    </div>
  );
}

function OraUserSection() {
  const { user, isLoaded } = useClerkUser();
  const { signOut } = useClerkActions();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!isLoaded || !user) return null;

  const displayName = user.fullName ?? user.emailAddresses[0]?.emailAddress ?? "User";
  const email = user.emailAddresses[0]?.emailAddress ?? "";
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="relative px-3 py-3 border-t border-border">
      <button
        onClick={() => setMenuOpen((o) => !o)}
        className="w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors"
      >
        {user.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={displayName}
            className="h-7 w-7 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-7 w-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold shrink-0">
            {initials}
          </div>
        )}
        <div className="flex-1 text-left min-w-0">
          <div className="text-xs font-semibold text-foreground truncate">{displayName}</div>
          {email && <div className="text-[10px] text-muted-foreground truncate">{email}</div>}
        </div>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform",
            menuOpen && "rotate-180",
          )}
        />
      </button>

      {menuOpen && (
        <div className="mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
          <Link
            href="/ora/settings"
            onClick={() => setMenuOpen(false)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors no-underline"
          >
            <Settings className="h-3.5 w-3.5" />
            Ora settings
          </Link>
          <button
            onClick={() => {
              setMenuOpen(false);
              void signOut({ redirectUrl: "/" });
            }}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** A single conversation row with inline rename + delete + move. */
function ConversationRow({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
  projects,
  onMove,
}: {
  conversation: OraConversationSummary;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** All of the user's projects, for the "Move to project" menu. */
  projects: OraProjectSummary[];
  /** Move this conversation to a project (or null for standalone). */
  onMove: (projectId: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title ?? "");
  const label = conversation.title?.trim() || "New chat";

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== conversation.title) onRename(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(conversation.title ?? "");
            }
          }}
          className="flex-1 min-w-0 rounded bg-background border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={commit}
          aria-label="Save name"
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setDraft(conversation.title ?? "");
          }}
          aria-label="Cancel rename"
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center rounded-md transition-colors",
        active ? "bg-primary/10" : "hover:bg-muted",
      )}
    >
      <button
        onClick={onSelect}
        className={cn(
          "flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors",
          active ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <MessageSquare className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity pr-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Move conversation"
              className="p-1 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
              <FolderInput className="h-3.5 w-3.5" />
              Move to
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {conversation.projectId != null ? (
              <DropdownMenuItem onSelect={() => onMove(null)} className="text-xs">
                <MessageSquare className="mr-2 h-3.5 w-3.5" />
                Recent (no project)
              </DropdownMenuItem>
            ) : null}
            {projects
              .filter((p) => p.id !== conversation.projectId)
              .map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => onMove(p.id)} className="text-xs">
                  <Folder className="mr-2 h-3.5 w-3.5" />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
            {projects.filter((p) => p.id !== conversation.projectId).length === 0 &&
            conversation.projectId == null ? (
              <DropdownMenuItem disabled className="text-xs">
                No projects yet
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          onClick={() => {
            setDraft(conversation.title ?? "");
            setEditing(true);
          }}
          aria-label="Rename conversation"
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={onDelete}
          aria-label="Delete conversation"
          className="p-1 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/** Projects with their nested conversations, plus create/rename/delete. */
function ProjectsSection({ close }: { close: () => void }) {
  const {
    projects,
    conversations,
    currentConversationId,
    activeProjectId,
    selectConversation,
    newConversation,
    moveConversation,
    renameConversation,
    deleteConversation,
    renameProject,
    deleteProject,
  } = useOraConversations();
  const [, setLocation] = useLocation();

  const [expanded, setExpanded] = useState<Set<number>>(() =>
    activeProjectId == null ? new Set() : new Set([activeProjectId]),
  );
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  // Always keep the active project expanded so its conversations are visible.
  useEffect(() => {
    if (activeProjectId == null) return;
    setExpanded((prev) => {
      if (prev.has(activeProjectId)) return prev;
      const next = new Set(prev);
      next.add(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </p>
        <button
          onClick={() => {
            setLocation("/ora/projects/new");
            close();
          }}
          aria-label="New project"
          className="p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-0.5">
        {projects.map((p) => {
          const isOpen = expanded.has(p.id);
          const projectConvs = conversations.filter((c) => c.projectId === p.id);
          return (
            <div key={p.id}>
              {editingProjectId === p.id ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const name = editName.trim();
                        if (name && name !== p.name) void renameProject(p.id, name);
                        setEditingProjectId(null);
                      }
                      if (e.key === "Escape") setEditingProjectId(null);
                    }}
                    className="flex-1 min-w-0 rounded bg-background border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={() => {
                      const name = editName.trim();
                      if (name && name !== p.name) void renameProject(p.id, name);
                      setEditingProjectId(null);
                    }}
                    aria-label="Save project name"
                    className="p-1 text-muted-foreground hover:text-foreground"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div
                  className={cn(
                    "group flex items-center rounded-md transition-colors",
                    p.id === activeProjectId ? "bg-primary/10" : "hover:bg-muted",
                  )}
                >
                  {/* Chevron toggles expand/collapse without entering. */}
                  <button
                    onClick={() => toggle(p.id)}
                    aria-label={isOpen ? "Collapse project" : "Expand project"}
                    className="pl-2 py-1.5 text-muted-foreground hover:text-foreground"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                  {/* The rest of the row enters the project (navigates). */}
                  <button
                    onClick={() => {
                      setLocation(`/ora/projects/${p.id}`);
                      close();
                    }}
                    title={p.description ?? undefined}
                    className={cn(
                      "flex-1 min-w-0 flex items-center gap-1.5 pl-1 pr-2 py-1.5 text-left text-xs font-medium",
                      p.id === activeProjectId ? "text-primary" : "text-foreground",
                    )}
                  >
                    {p.id === activeProjectId ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex flex-col">
                      <span className="truncate">{p.name}</span>
                      {p.description ? (
                        <span className="truncate text-[10px] font-normal text-muted-foreground">
                          {p.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity pr-1">
                    <button
                      onClick={() => {
                        setLocation(`/ora/projects/${p.id}`);
                        newConversation(p.id);
                        close();
                      }}
                      aria-label="New chat in project"
                      className="p-1 text-muted-foreground hover:text-foreground"
                    >
                      <MessageCirclePlus className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => {
                        setEditName(p.name);
                        setEditingProjectId(p.id);
                      }}
                      aria-label="Rename project"
                      className="p-1 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete this project? Conversations inside this project will be moved to Recent and will not be deleted.",
                          )
                        )
                          void deleteProject(p.id);
                      }}
                      aria-label="Delete project"
                      className="p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}

              {isOpen && (
                <div className="ml-3 border-l border-border pl-2 space-y-0.5 py-0.5">
                  {projectConvs.length === 0 ? (
                    <p className="px-2 py-1 text-[10px] text-muted-foreground">No conversations</p>
                  ) : (
                    projectConvs.map((c) => (
                      <ConversationRow
                        key={c.id}
                        conversation={c}
                        active={c.id === currentConversationId}
                        projects={projects}
                        onMove={(projectId) => void moveConversation(c.id, projectId)}
                        onSelect={() => {
                          selectConversation(c.id);
                          close();
                        }}
                        onRename={(title) => void renameConversation(c.id, title)}
                        onDelete={() => {
                          if (window.confirm("Delete this conversation?"))
                            void deleteConversation(c.id);
                        }}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Recent conversations dropdown — surfaces standalone chats (those not filed
 * under a project) ordered by most-recent activity. Without this, conversations
 * created from the "New conversation" button (projectId === null) had no home in
 * the sidebar and appeared to "disappear" from history.
 */
function RecentConversationsSection({ close }: { close: () => void }) {
  const {
    projects,
    conversations,
    currentConversationId,
    selectConversation,
    newConversation,
    moveConversation,
    renameConversation,
    deleteConversation,
  } = useOraConversations();
  const [, setLocation] = useLocation();

  const [open, setOpen] = useState(true);

  // Backend already returns conversations ordered by lastMessageAt desc.
  // Standalone chats (no project) live here; project chats live under Projects.
  const recent = conversations.filter((c) => c.projectId == null);

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent conversations
          </span>
        </button>
        {/* Distinct, explicit standalone new-chat action — always creates a
            conversation with projectId === null, regardless of active project. */}
        <button
          onClick={() => {
            setLocation("/ora");
            newConversation(null);
            close();
          }}
          aria-label="New standalone chat"
          className="p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="space-y-0.5">
          {recent.length === 0 ? (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">No recent conversations</p>
          ) : (
            recent.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === currentConversationId}
                projects={projects}
                onMove={(projectId) => void moveConversation(c.id, projectId)}
                onSelect={() => {
                  selectConversation(c.id);
                  close();
                }}
                onRename={(title) => void renameConversation(c.id, title)}
                onDelete={() => {
                  if (window.confirm("Delete this conversation?")) void deleteConversation(c.id);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface OraSidebarProps {
  /** Clears the current conversation to start a fresh one. */
  onNewConversation: () => void;
}

/**
 * Slide-out navigation for the standalone Ora assistant.
 * Toggled by the fixed logo button in the top-left corner.
 */
export function OraSidebar({ onNewConversation }: OraSidebarProps) {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, close]);

  return (
    <>
      {/* Fixed logo button — visible only while the drawer is closed. */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open Ora menu"
          className="fixed top-3 left-3 z-50 h-9 w-9 rounded-xl bg-sidebar border border-border shadow-md flex items-center justify-center hover:bg-muted transition-colors"
        >
          <img src={logoUrl} alt="Ora" className="h-6 w-auto object-contain" />
        </button>
      )}

      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40" onClick={close} aria-hidden="true" />
      )}

      {/* Drawer */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-72 bg-sidebar border-r border-border flex flex-col overflow-y-auto transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header — logo + wordmark */}
        <div className="px-4 py-5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-2 shadow">
              <img src={logoUrl} alt="Ora" className="h-8 w-auto object-contain" />
            </div>
            <span className="text-base font-bold text-foreground">Ora</span>
          </div>
        </div>

        {/* New conversation */}
        <div className="px-3 pb-3 shrink-0">
          <button
            onClick={() => {
              onNewConversation();
              close();
            }}
            className="w-full flex items-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors px-3 py-2 text-sm font-medium"
          >
            <MessageCirclePlus className="h-4 w-4 shrink-0" />
            New conversation
          </button>
        </div>

        <hr className="border-border mx-3" />

        {/* Conversations + projects history */}
        <div className="flex-1 overflow-y-auto py-2">
          <RecentConversationsSection close={close} />

          <hr className="border-border mx-3 my-2" />

          <ProjectsSection close={close} />

          <hr className="border-border mx-3 my-2" />

          {/* Nav items */}
          <div className="px-3 py-2 space-y-1">
            {NAV_ITEMS.map(({ name, href, icon: Icon }) => {
              const isActive =
                location === href || (href !== "/" && location.startsWith(href + "/"));
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={close}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer no-underline",
                    isActive
                      ? "border-l-2 border-primary bg-primary/5 text-primary pl-[10px]"
                      : "border-l-2 border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {name}
                </Link>
              );
            })}
          </div>
        </div>

        <hr className="border-border mx-3" />

        {/* Bottom: Ora daily usage + user */}
        <OraUsageWidget />
        <OraUserSection />
      </div>
    </>
  );
}
