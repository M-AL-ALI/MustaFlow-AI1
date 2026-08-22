import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  Bell,
  X,
  Check,
  CheckCheck,
  MessageSquare,
  Users,
  Rocket,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { terminalPresentationFor } from "@/lib/zero-terminal";

interface Notification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  actorName: string | null;
  projectId: number | null;
  metadata: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
  nextCursor: number | null;
}

function typeIcon(type: string) {
  if (type.startsWith("comment") || type === "mention") return MessageSquare;
  if (type.startsWith("org") || type.startsWith("member")) return Users;
  if (type === "build_complete" || type === "build_failed") return Zap;
  return Rocket;
}

function getNotificationHref(n: Notification): string | null {
  const meta = n.metadata ?? {};
  switch (n.type) {
    case "build_complete":
    case "build_failed":
      if (n.projectId) return `/projects/${n.projectId}?tab=activity`;
      return null;
    case "org_invite": {
      const token = meta.token as string | undefined;
      if (token) return `/orgs/invites/${token}`;
      return "/orgs";
    }
    case "project_published":
      if (n.projectId) return `/projects/${n.projectId}?tab=publishing`;
      return null;
    case "mention": {
      const commentId = meta.commentId as number | undefined;
      if (n.projectId && commentId)
        return `/projects/${n.projectId}?tab=comments&comment=${commentId}`;
      if (n.projectId) return `/projects/${n.projectId}?tab=comments`;
      return null;
    }
    case "comment_reply":
      if (n.projectId) return `/projects/${n.projectId}?tab=comments`;
      return null;
    default:
      if (n.projectId) return `/projects/${n.projectId}`;
      return null;
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await authFetch("/api/notifications?limit=20");
      if (resp.ok) setData((await resp.json()) as NotificationsResponse);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchNotifications();
    const id = setInterval(() => void fetchNotifications(), 30000);
    return () => clearInterval(id);
  }, [fetchNotifications]);

  const markRead = async (id: number) => {
    await authFetch(`/api/notifications/${id}/read`, { method: "POST" });
    setData((prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
            unreadCount: Math.max(0, prev.unreadCount - 1),
          }
        : prev,
    );
  };

  const markAllRead = async () => {
    await authFetch("/api/notifications/read-all", { method: "POST" });
    setData((prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.map((n) => ({ ...n, read: true })),
            unreadCount: 0,
          }
        : prev,
    );
  };

  const dismiss = async (id: number) => {
    await authFetch(`/api/notifications/${id}`, { method: "DELETE" });
    setData((prev) =>
      prev
        ? {
            ...prev,
            notifications: prev.notifications.filter((n) => n.id !== id),
            unreadCount: prev.notifications.find((n) => n.id === id && !n.read)
              ? Math.max(0, prev.unreadCount - 1)
              : prev.unreadCount,
          }
        : prev,
    );
  };

  const handleNotificationClick = (n: Notification) => {
    const href = getNotificationHref(n);
    if (!n.read) void markRead(n.id);
    if (href) {
      setOpen(false);
      window.location.href = href;
    }
  };

  const unread = data?.unreadCount ?? 0;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative h-8 w-8"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void fetchNotifications();
        }}
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-50 w-96 rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Notifications</h3>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => void markAllRead()}
                  >
                    <CheckCheck className="h-3 w-3" />
                    Mark all read
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setOpen(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto divide-y divide-border">
              {loading && !data && (
                <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
              )}
              {data?.notifications.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No notifications yet
                </div>
              )}
              {data?.notifications.map((n) => {
                const terminal = terminalPresentationFor({
                  terminal: n.metadata?.terminal,
                  status:
                    n.type === "build_complete"
                      ? "completed"
                      : n.type === "build_failed"
                        ? "failed"
                        : undefined,
                });
                const effectiveType = terminal
                  ? terminal.taskStatus === "failed"
                    ? "build_failed"
                    : "build_complete"
                  : n.type;
                const Icon = terminal
                  ? terminal.tone === "success"
                    ? Check
                    : terminal.tone === "failure"
                      ? X
                      : AlertTriangle
                  : typeIcon(effectiveType);
                const href = getNotificationHref(n);
                return (
                  <div
                    key={n.id}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50",
                      !n.read && "bg-accent/20",
                      href && "cursor-pointer",
                    )}
                    onClick={() => handleNotificationClick(n)}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full",
                        !n.read ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm", !n.read && "font-medium")}>
                        {terminal?.title ?? n.title}
                      </p>
                      {(terminal?.message ?? n.body) && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                          {terminal?.message ?? n.body}
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {timeAgo(n.createdAt)}
                      </p>
                    </div>
                    <div
                      className="flex flex-shrink-0 items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!n.read && (
                        <button
                          onClick={() => void markRead(n.id)}
                          className="rounded p-1 hover:bg-muted"
                          title="Mark as read"
                        >
                          <Check className="h-3 w-3 text-muted-foreground" />
                        </button>
                      )}
                      <button
                        onClick={() => void dismiss(n.id)}
                        className="rounded p-1 hover:bg-muted"
                        title="Dismiss"
                      >
                        <X className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
