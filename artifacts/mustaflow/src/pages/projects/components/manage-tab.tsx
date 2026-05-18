import { useState } from "react";
import { Trash2, Download, Copy, AlertTriangle, CheckCircle2, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export function ManageTab({ projectId }: { projectId: number }) {
  const [, setLocation] = useLocation();
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicateSuccess, setDuplicateSuccess] = useState<{ id: number; name: string } | null>(null);

  const exportUrl = `/api/projects/${projectId}/export`;

  async function handleDuplicate() {
    setDuplicating(true);
    setDuplicateError(null);
    setDuplicateSuccess(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { id: number; name: string; filesCount: number };
      setDuplicateSuccess({ id: data.id, name: data.name });
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : "Duplicate failed");
    } finally {
      setDuplicating(false);
    }
  }

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-bold mb-1">Manage Project</h2>
          <p className="text-sm text-muted-foreground">Project settings, exports, and danger zone.</p>
        </div>

        {/* Export */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold">Export Files</h3>
          <p className="text-xs text-muted-foreground">
            Download all generated files as a zip archive. Includes a README, folder structure, and a
            <code className="mx-1 px-1 bg-muted rounded text-[11px]">.env.example</code>
            listing required environment variable names — secret values are never included.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl} download>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export Files
              </a>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href={exportUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Preview
              </a>
            </Button>
          </div>
        </div>

        {/* Duplicate */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold">Duplicate Project</h3>
          <p className="text-xs text-muted-foreground">
            Create an independent copy with all files. Secrets are not copied for security — add them
            separately in the Tools tab of the new project.
          </p>

          {duplicateSuccess ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-green-500">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Duplicated as <strong>{duplicateSuccess.name}</strong>
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => setLocation(`/projects/${duplicateSuccess.id}`)}
                >
                  Open Duplicate
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDuplicateSuccess(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {duplicateError && (
                <p className="text-xs text-destructive">{duplicateError}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDuplicate}
                disabled={duplicating}
              >
                {duplicating ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {duplicating ? "Duplicating…" : "Duplicate Project"}
              </Button>
            </div>
          )}
        </div>

        {/* Danger zone */}
        <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Danger Zone</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Deleting a project is permanent and cannot be undone. All files, versions, tasks, and
            secrets will be removed.
          </p>
          <Button variant="destructive" size="sm" disabled>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete Project
          </Button>
        </div>
      </div>
    </div>
  );
}
