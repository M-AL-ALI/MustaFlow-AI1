import { useListProjects } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ExternalLink, Clock, CheckCircle2, XCircle, Loader2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DevSidebar } from "@/components/dev-sidebar";

function DeploymentTypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    static: "Static",
    autoscale: "Autoscale",
    reserved_vm: "Reserved VM",
  };
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border text-muted-foreground bg-muted">
      {labels[type] ?? type}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "published") return <CheckCircle2 className="h-4 w-4 text-green-400" />;
  if (status === "building") return <Loader2 className="h-4 w-4 text-yellow-400 animate-spin" />;
  return <XCircle className="h-4 w-4 text-muted-foreground/50" />;
}

export default function DevDeploymentsPage() {
  const { data: projects, isLoading } = useListProjects({ mode: "developer" });

  const deployed = projects?.filter((p) => p.status === "published" || p.prodContainerId) ?? [];
  const all = projects ?? [];

  return (
    <div className="h-screen bg-background text-foreground flex w-full overflow-hidden">
      <DevSidebar />

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-10">
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight mb-1">Deployments</h1>
            <p className="text-sm text-muted-foreground">
              All deployed Developer Mode projects and their live status.
            </p>
          </div>

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
              {/* Header */}
              <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 items-center px-4 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide border-b border-border mb-1">
                <span className="w-5" />
                <span>Project</span>
                <span>Type</span>
                <span>Updated</span>
                <span>Manage</span>
              </div>

              {all.map((project) => {
                const isLive = project.status === "published";
                const slug = project.publicSlug;
                const liveUrl = slug ? `https://mustaflow.app/p/${slug}` : null;

                return (
                  <div
                    key={project.id}
                    className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 items-center px-4 py-3 rounded-xl border border-border bg-card hover:border-border/80 transition-colors"
                  >
                    <StatusIcon status={project.status} />

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
                          <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                        </a>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {isLive
                            ? "Live"
                            : project.status === "building"
                              ? "Building…"
                              : "Not deployed"}
                        </p>
                      )}
                    </div>

                    <DeploymentTypeBadge type="static" />

                    <div className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                      <Clock className="h-3 w-3" />
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </div>

                    <Link href={`/dev/workspace/${project.id}`}>
                      <Button variant="outline" size="sm" className="text-xs h-7 shrink-0">
                        Manage
                      </Button>
                    </Link>
                  </div>
                );
              })}
            </div>
          )}

          {deployed.length > 0 && (
            <p className="text-xs text-muted-foreground text-center mt-8">
              {deployed.length} of {all.length} project{all.length !== 1 ? "s" : ""} deployed
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
