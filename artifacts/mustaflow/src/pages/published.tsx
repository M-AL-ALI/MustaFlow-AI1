import { useEffect, useState } from "react";
import { Globe, Copy, Check, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface Project {
  id: number;
  name: string;
  description: string | null;
  status: string;
  publicSlug: string | null;
  updatedAt: string;
  kind: string;
}

function PublicUrl({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/api/p/${slug}/`;

  function copy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <code className="text-xs text-muted-foreground truncate max-w-[240px]">/api/p/{slug}/</code>
      <button
        onClick={copy}
        title="Copy public URL"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open public URL"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

export default function PublishedPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to load projects");
      const data = (await res.json()) as Project[];
      setProjects(data.filter((p) => p.status === "published" && p.publicSlug));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Published Apps</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All publicly accessible versions of your projects.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Globe className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-foreground mb-1">No published apps yet</h3>
          <p className="text-sm text-muted-foreground">
            Open a project, build your app, then publish it from the Publishing tab.
          </p>
        </div>
      )}

      {projects.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <div className="grid grid-cols-[1fr_260px_100px_80px] gap-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              <span>Project</span>
              <span>Public URL</span>
              <span>Last updated</span>
              <span>Status</span>
            </div>
          </div>
          <div className="divide-y divide-border">
            {projects.map((project) => (
              <div
                key={project.id}
                className="grid grid-cols-[1fr_260px_100px_80px] gap-4 items-center px-4 py-3 hover:bg-muted/20 transition-colors"
              >
                <div className="min-w-0">
                  <a
                    href={`/projects/${project.id}`}
                    className="text-sm font-medium text-foreground hover:text-primary transition-colors truncate block"
                  >
                    {project.name}
                  </a>
                  {project.description && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {project.description}
                    </p>
                  )}
                </div>
                <div className="min-w-0">
                  {project.publicSlug && <PublicUrl slug={project.publicSlug} />}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(project.updatedAt).toLocaleDateString()}
                </div>
                <div>
                  <Badge
                    variant="outline"
                    className="text-xs bg-green-500/10 text-green-500 border-green-500/30"
                  >
                    Live
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">How publishing works</h2>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Publishing freezes the current version of your app into a snapshot. Draft changes you
            make after publishing are invisible to the public until you publish again.
          </p>
          <p>
            Each project gets a permanent public slug (e.g.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">my-app-abc123</code>) that
            persists across re-publishes. You can also add a custom domain in the Publishing tab.
          </p>
        </div>
      </div>
    </div>
  );
}
