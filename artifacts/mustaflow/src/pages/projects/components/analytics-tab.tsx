import { useEffect, useState } from "react";
import { BarChart3, Globe, Calendar, RefreshCw } from "lucide-react";
import type { Project } from "@workspace/api-client-react";

type Deployment = {
  id: number;
  env: string;
  status: string;
  publicUrl: string | null;
  filesCount: number | null;
  createdAt: string;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AnalyticsTab({ project }: { project: Project }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublished = project.status === "published";

  async function load() {
    if (!isPublished) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/deployments`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { deployments: Deployment[] };
      setDeployments(data.deployments);
    } catch {
      setError("Could not load deployment data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, isPublished]);

  if (!isPublished) {
    return (
      <div className="p-6 h-full overflow-y-auto flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm">
          <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/30" />
          <div>
            <p className="text-sm font-medium text-foreground">No analytics yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Publish your app to start tracking deployment activity. Analytics data updates after each publish.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const publishCount = deployments.filter((d) => d.status === "passed").length;
  const lastPublish = deployments.find((d) => d.status === "passed");

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold mb-1">Analytics</h2>
            <p className="text-sm text-muted-foreground">
              Deployment activity for this project.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-muted-foreground">
              <Globe className="h-4 w-4" />
              <span className="text-xs font-medium">Total Publishes</span>
            </div>
            <div className="text-2xl font-bold">{publishCount}</div>
            <div className="text-[11px] text-muted-foreground/60 mt-1">
              Times app was published
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2 text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span className="text-xs font-medium">Last Published</span>
            </div>
            <div className="text-sm font-semibold">
              {lastPublish ? formatDate(lastPublish.createdAt) : "—"}
            </div>
            <div className="text-[11px] text-muted-foreground/60 mt-1">
              Most recent publish event
            </div>
          </div>
        </div>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center justify-between">
            <span className="text-xs font-semibold">Deployment History</span>
            <span className="text-xs text-muted-foreground">{deployments.length} events</span>
          </div>
          {loading && deployments.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground animate-pulse">
              Loading…
            </div>
          ) : deployments.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No deployment events yet.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {deployments.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center gap-3">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                      d.status === "passed"
                        ? "bg-green-500/10 text-green-400"
                        : d.status === "unpublished"
                          ? "bg-muted text-muted-foreground"
                          : "bg-blue-500/10 text-blue-400"
                    }`}
                  >
                    {d.status}
                  </span>
                  <span className="text-xs text-muted-foreground capitalize shrink-0">{d.env}</span>
                  {d.publicUrl && (
                    <a
                      href={d.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-mono text-primary/80 hover:text-primary truncate"
                    >
                      {d.publicUrl}
                    </a>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground/60 whitespace-nowrap shrink-0">
                    {formatDate(d.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground/50 text-center">
          Analytics data updates after each publish. Traffic metrics (page views, visitors) require an external analytics integration.
        </p>
      </div>
    </div>
  );
}
