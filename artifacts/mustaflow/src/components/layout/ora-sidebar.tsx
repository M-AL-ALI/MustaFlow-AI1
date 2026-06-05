import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import logoUrl from "/logo.png";
import {
  MessageCirclePlus,
  BookOpen,
  Blocks,
  Settings,
  CreditCard,
  LogOut,
  ChevronDown,
  ChevronRight,
  Zap,
  AlertTriangle,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Folder,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useClerkUser, useClerkActions } from "@/lib/clerk-safe";
import {
  useOraConversations,
  type OraConversationSummary,
} from "@/hooks/ora-conversations-context";

const NAV_ITEMS = [
  { name: "Library", href: "/ora/library", icon: BookOpen },
  { name: "Apps", href: "/integrations", icon: Blocks },
  { name: "Settings", href: "/ora/settings", icon: Settings },
];

const LOW_CREDITS_THRESHOLD = 10;

function OraCreditsWidget() {
  const { isSignedIn } = useClerkUser();
  const [balance, setBalance] = useState<number | null>(null);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await authFetch("/api/credits");
      if (res.ok) {
        const data = (await res.json()) as { balance: number };
        setBalance(data.balance);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    void fetchBalance();
    const id = setInterval(() => void fetchBalance(), 60_000);
    const onFocus = () => void fetchBalance();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [isSignedIn, fetchBalance]);

  if (!isSignedIn || balance === null) return null;

  const isLow = balance < LOW_CREDITS_THRESHOLD;

  return (
    <div className="px-3 py-2">
      <Link href="/billing">
        <div
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs font-medium transition-colors cursor-pointer border",
            isLow
              ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-600 hover:bg-yellow-500/15"
              : "bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {isLow ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Zap className="h-3.5 w-3.5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <span className="font-semibold">{balance.toLocaleString()}</span>
            <span className="ml-1">credits</span>
            {isLow && (
              <p className="text-[10px] leading-tight mt-0.5 font-normal">Running low — buy more</p>
            )}
          </div>
          <CreditCard className="h-3 w-3 shrink-0 opacity-60" />
        </div>
      </Link>
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
            href="/billing"
            onClick={() => setMenuOpen(false)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors no-underline"
          >
            <CreditCard className="h-3.5 w-3.5" />
            Billing
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

/** A single conversation row with inline rename + delete. */
function ConversationRow({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: OraConversationSummary;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
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

/** Recent standalone (one-off) conversations — those not filed under a project. */
function RecentConversations({ close }: { close: () => void }) {
  const {
    conversations,
    currentConversationId,
    selectConversation,
    renameConversation,
    deleteConversation,
  } = useOraConversations();

  const standalone = conversations.filter((c) => c.projectId == null);
  if (standalone.length === 0) return null;

  return (
    <div className="px-3 py-2">
      <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Recent
      </p>
      <div className="space-y-0.5">
        {standalone.slice(0, 15).map((c) => (
          <ConversationRow
            key={c.id}
            conversation={c}
            active={c.id === currentConversationId}
            onSelect={() => {
              selectConversation(c.id);
              close();
            }}
            onRename={(title) => void renameConversation(c.id, title)}
            onDelete={() => {
              if (window.confirm("Delete this conversation?")) void deleteConversation(c.id);
            }}
          />
        ))}
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
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
    createProject,
    renameProject,
    deleteProject,
  } = useOraConversations();

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submitNew = async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    const project = await createProject(name);
    setNewName("");
    setCreating(false);
    if (project) setExpanded((prev) => new Set(prev).add(project.id));
  };

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </p>
        <button
          onClick={() => setCreating((c) => !c)}
          aria-label="New project"
          className="p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {creating && (
        <div className="flex items-center gap-1 px-2 pb-1">
          <input
            autoFocus
            value={newName}
            placeholder="Project name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNew();
              if (e.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            className="flex-1 min-w-0 rounded bg-background border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={() => void submitNew()}
            aria-label="Create project"
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
                <div className="group flex items-center rounded-md hover:bg-muted transition-colors">
                  <button
                    onClick={() => toggle(p.id)}
                    className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-foreground"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{p.name}</span>
                  </button>
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity pr-1">
                    <button
                      onClick={() => {
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
                            "Delete this project? Its conversations will be kept as standalone chats.",
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
      {/* Fixed logo button — always visible */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open Ora menu"
        className="fixed top-3 left-3 z-50 h-9 w-9 rounded-xl bg-sidebar border border-border shadow-md flex items-center justify-center hover:bg-muted transition-colors"
      >
        <img src={logoUrl} alt="Ora" className="h-6 w-auto object-contain" />
      </button>

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
          <RecentConversations close={close} />
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

        {/* Bottom: credits + user */}
        <OraCreditsWidget />
        <OraUserSection />
      </div>
    </>
  );
}
