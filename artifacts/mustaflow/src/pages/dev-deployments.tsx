import { useState, useCallback } from "react";
import { useListProjects } from "@workspace/api-client-react";
import { Link } from "wouter";
import {
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Server,
  Zap,
  Globe,
  Timer,
  RefreshCw,
  Square,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SlideOutNav } from "@/components/layout/slide-out-nav";
import { cn } from "@/lib/utils";

type DeploymentType = "static" | "autoscale" | "reserved_vm" | "scheduled";

const TYPE_META: Record<DeploymentType, { label: string; icon: React.ElementType; color: string }> =
  {
    static: { label: "Static", icon: Globe, color: "text-blue-400" },
    autoscale: { label: "Autoscale", icon: Zap, color: "text-yellow-400" },
    reserved_vm: { label: "Reserved VM", icon: Server, color: "text-purple-400" },
    scheduled: { label: "Scheduled", icon: Timer, color: "text-orange-400" },
  };

function DeploymentTypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type as DeploymentType] ?? {
    label: type,
    icon: Server,
    color: "text-muted-foreground",
  };
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border bg-muted",
        meta.color,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "published")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-400 bg-green-400/10 border border-green-400/20 px-1.5 py-0.5 rounded">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Live
      </span>
    );
  if (status === "building")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-yellow-400 bg-yellow-400/10 border border-yellow-400/20 px-1.5 py-0.5 rounded">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Building
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-400 bg-red-400/10 border border-red-400/20 px-1.5 py-0.5 rounded">
        <XCircle className="h-2.5 w-2.5" />
        Failed
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
      <Square className="h-2.5 w-2.5" />
      Stopped
    </span>
  );
}

export default function DevDeploymentsPage() {
  const { data: projects, isLoading, refetch } = useListProjects({ mode: "developer" });
  const [redeploying, setRedeploying] = useState<number | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);

  // All developer-mode projects returned by the API (mode=developer filter applied at API level).
  // Unpublished projects land in "testing" status; they appear as Stopped.
  const all = projects ?? [];
  const live = all.filter((p) => p.status === "published");
  const building = all.filter((p) => p.status === "building");
  const stopped = all.filter((p) => p.status !== "published" && p.status !== "building");

  const handleRedeploy = useCallback(
    async (projectId: number) => {
      setRedeploying(projectId);
      try {
        await fetch(`/api/projects/${projectId}/deploy`, { method: "POST" });
        void refetch();
      } catch {
        /* ignore */
      } finally {
        setRedeploying(null);
      }
    },
    [refetch],
  );

  const handleStop = useCallback(
    async (projectId: number) => {
      setStopping(projectId);
      try {
        await fetch(`/api/projects/${projectId}/unpublish`, { method: "POST" });
        void refetch();
      } catch {
        /* ignore */
      } finally {
        setStopping(null);
      }
    },
    [refetch],
  );

  return (
    <div className="h-screen bg-background text-foreground w-full overflow-hidden">
      <SlideOutNav />

      <main className="h-full w-full overflow-y-auto pl-14 pt-3">
        <div className="max-w-5xl mx-auto px-8 py-10">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight mb-1">Deployments</h1>
            <p className="text-sm text-muted-foreground">
              All deployed Developer Mode projects and their live status.
            </p>
          </div>

          {/* Status summary */}
          {!isLoading && all.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mb-8">
              {[
                {
                  label: "Live",
                  count: live.length,
                  icon: CheckCircle2,
                  color: "text-green-400",
                  bg: "bg-green-400/5 border-green-400/20",
                },
                {
                  label: "Building",
                  count: building.length,
                  icon: Loader2,
                  color: "text-yellow-400",
                  bg: "bg-yellow-400/5 border-yellow-400/20",
                },
                {
                  label: "Stopped",
                  count: stopped.length,
                  icon: Square,
                  color: "text-muted-foreground",
                  bg: "bg-muted/30 border-border",
                },
              ].map(({ label, count, icon: Icon, color, bg }) => (
                <div
                  key={label}
                  className={cn("flex items-center gap-3 rounded-xl border px-4 py-3", bg)}
                >
                  <Icon
                    className={cn(
                      "h-5 w-5 shrink-0",
                      color,
                      label === "Building" && "animate-spin",
                    )}
                  />
                  <div>
                    <div className={cn("text-xl font-bold tabular-nums", color)}>{count}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 rounded-xl border border-border bg-muted/20 animate-pulse"
                />
              ))}
            </div>
          ) : all.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/30 px-8 py-16 text-center max-w-md mx-auto">
              <Server className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-foreground mb-1">No projects yet</h3>
              <p className="text-xs text-muted-foreground mb-5">
                Create a Developer Mode project first, then deploy it from the workspace.
              </p>
              <Link href="/dev">
                <Button size="sm" className="gap-2">
                  Go to home
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Table header */}
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide border-b border-border mb-1">
                <span className="w-5" />
                <span>Project</span>
                <span>Type</span>
                <span>Status</span>
                <span>Updated</span>
                <span>Actions</span>
              </div>

              {all.map((project) => {
                const isLive = project.status === "published";
                const slug = project.publicSlug;
                const liveUrl = slug ? `https://${slug}.mustaflow.app/` : null;
                const isRedeploying = redeploying === project.id;
                const isStopping = stopping === project.id;

                return (
                  <div
                    key={project.id}
                    className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-3 rounded-xl border border-border bg-card hover:border-border/80 transition-colors"
                  >
                    {/* Dot indicator */}
                    <div
                      className={cn(
                        "h-2 w-2 rounded-full",
                        isLive
                          ? "bg-green-400"
                          : project.status === "building"
                            ? "bg-yellow-400 animate-pulse"
                            : "bg-muted-foreground/30",
                      )}
                    />

                    {/* Project name + URL */}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{project.name}</p>
                      {liveUrl && isLive ? (
                        <a
                          href={liveUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-1 truncate mt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {liveUrl}
                          <ArrowUpRight className="h-2.5 w-2.5 shrink-0" />
                        </a>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {project.status === "building" ? "Building…" : "Not deployed"}
                        </p>
                      )}
                    </div>

                    {/* Type badge */}
                    <DeploymentTypeBadge
                      type={(project as { deploymentType?: string }).deploymentType ?? "static"}
                    />

                    {/* Status badge */}
                    <StatusBadge status={project.status} />

                    {/* Timestamp */}
                    <div className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                      <Clock className="h-3 w-3" />
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {liveUrl && isLive && (
                        <a href={liveUrl} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="sm" className="text-xs h-7 gap-1 px-2">
                            <ExternalLink className="h-3 w-3" />
                            Visit
                          </Button>
                        </a>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 gap-1 px-2"
                        disabled={isRedeploying}
                        onClick={() => void handleRedeploy(project.id)}
                      >
                        {isRedeploying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Redeploy
                      </Button>
                      {isLive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 gap-1 px-2 text-muted-foreground hover:text-destructive"
                          disabled={isStopping}
                          onClick={() => void handleStop(project.id)}
                        >
                          {isStopping ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Square className="h-3 w-3" />
                          )}
                          Stop
                        </Button>
                      )}
                      <Link href={`/dev/workspace/${project.id}`}>
                        <Button variant="outline" size="sm" className="text-xs h-7 shrink-0">
                          Manage
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {all.length > 0 && (
            <p className="text-xs text-muted-foreground text-center mt-8">
              {live.length} of {all.length} project{all.length !== 1 ? "s" : ""} live
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
