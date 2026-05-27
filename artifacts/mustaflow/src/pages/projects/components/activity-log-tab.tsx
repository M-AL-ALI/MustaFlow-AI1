import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  Zap,
  Globe,
  MessageSquare,
  FilePen,
  Users,
  Copy,
  Download,
  Link2,
  GitBranch,
  Bookmark,
  Server,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Trash2,
  Mail,
  GitFork,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ActivityEntry {
  id: number;
  actorName: string | null;
  eventType: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const EVENT_ICONS: Record<string, { icon: React.ElementType; color: string }> = {
  build: { icon: Zap, color: "text-violet-400" },
  build_failed: { icon: AlertTriangle, color: "text-red-400" },
  publish: { icon: Globe, color: "text-emerald-400" },
  unpublish: { icon: Globe, color: "text-muted-foreground" },
  comment: { icon: MessageSquare, color: "text-blue-400" },
  file_edit: { icon: FilePen, color: "text-yellow-400" },
  member_join: { icon: Users, color: "text-emerald-400" },
  member_leave: { icon: Users, color: "text-muted-foreground" },
  rollback: { icon: GitBranch, color: "text-orange-400" },
  duplicate: { icon: Copy, color: "text-blue-400" },
  cloned_from: { icon: GitFork, color: "text-blue-400" },
  delete: { icon: Trash2, color: "text-red-400" },
  invite: { icon: Mail, color: "text-emerald-400" },
  export: { icon: Download, color: "text-muted-foreground" },
  share_link_created: { icon: Link2, color: "text-blue-400" },
  share_link_revoked: { icon: Link2, color: "text-muted-foreground" },
  domain_connected: { icon: Server, color: "text-emerald-400" },
  version_pinned: { icon: Bookmark, color: "text-amber-400" },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface ActivityLogTabProps {
  projectId: number;
}

export function ActivityLogTab({ projectId }: ActivityLogTabProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        filter === "all"
          ? `/api/projects/${projectId}/activity-log?limit=100`
          : `/api/projects/${projectId}/activity-log?limit=100&eventType=${filter}`;
      const r = await fetch(url);
      if (r.ok) setEntries((await r.json()) as ActivityEntry[]);
    } finally {
      setLoading(false);
    }
  }, [projectId, filter]);

  useEffect(() => {
    void fetchActivity();
  }, [fetchActivity]);

  const EVENT_FILTERS = [
    { label: "All", value: "all" },
    { label: "Builds", value: "build" },
    { label: "Publishes", value: "publish" },
    { label: "Comments", value: "comment" },
    { label: "Rollbacks", value: "rollback" },
    { label: "Duplicates", value: "duplicate" },
    { label: "Cloned from", value: "cloned_from" },
    { label: "Deletes", value: "delete" },
    { label: "Invites", value: "invite" },
    { label: "File edits", value: "file_edit" },
    { label: "Members", value: "member_join" },
  ];

  // Group entries by date
  const grouped: { date: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const date = new Date(entry.createdAt).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const last = grouped[grouped.length - 1];
    if (last?.date === date) {
      last.entries.push(entry);
    } else {
      grouped.push({ date, entries: [entry] });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2 flex-wrap">
        {EVENT_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7"
          onClick={() => void fetchActivity()}
          disabled={loading}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Activity list */}
      <div className="flex-1 overflow-y-auto">
        {loading && entries.length === 0 && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-2 px-6">
            <Activity className="h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">No activity yet</p>
            <p className="text-xs text-muted-foreground">
              Activity is logged when you build, publish, comment, and more.
            </p>
          </div>
        )}

        {grouped.map((group) => (
          <div key={group.date}>
            <div className="sticky top-0 bg-background/80 backdrop-blur-sm px-4 py-2 border-b border-border/50">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.date}
              </p>
            </div>
            <div className="divide-y divide-border/50">
              {group.entries.map((entry) => {
                const meta = EVENT_ICONS[entry.eventType] ?? {
                  icon: Activity,
                  color: "text-muted-foreground",
                };
                const Icon = meta.icon;
                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-card border border-border",
                        meta.color,
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{entry.summary}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {entry.actorName && (
                          <span className="text-[11px] text-muted-foreground">
                            by {entry.actorName}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {timeAgo(entry.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
