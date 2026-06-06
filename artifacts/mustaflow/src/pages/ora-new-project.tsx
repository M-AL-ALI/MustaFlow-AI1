import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, FolderPlus, Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { authFetch } from "@/lib/api-fetch";
import { setPendingOraProjectId } from "@/hooks/use-ora-conversations";
import { useToast } from "@/hooks/use-toast";
import type { OraProjectSummary } from "@/hooks/ora-conversations-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Dedicated Ora "New project" page.
 *
 * Replaces the old inline name box in the Ora sidebar. Lets the user name a
 * project and optionally describe what it's about before it's created, then
 * returns to the Ora home where the new project appears in the sidebar.
 */
export default function OraNewProjectPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !submitting;

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await authFetch(`${BASE}/api/ora/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName.slice(0, 80),
          description: description.trim().slice(0, 500) || undefined,
        }),
      });
      if (!res.ok) {
        toast({
          title: "Could not create project",
          description: "Please try again in a moment.",
          variant: "destructive",
        });
        return;
      }
      const data = (await res.json()) as { project: OraProjectSummary };
      // The project route is the source of truth for the active project. Keep
      // the sessionStorage handoff as a non-authoritative fallback so first-
      // message scoping still succeeds even if the route param is slow to apply.
      setPendingOraProjectId(data.project.id);
      setLocation(`/ora/projects/${data.project.id}`);
    } catch {
      toast({
        title: "Could not create project",
        description: "Please check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <button
          onClick={() => setLocation("/ora")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Ora
        </button>
        <ThemeToggle />
      </header>

      <main className="flex-1 flex justify-center px-4 py-10">
        <div className="w-full max-w-lg">
          <div className="flex items-center gap-3 mb-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FolderPlus className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-semibold text-foreground">New project</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-8">
            Group related conversations together. Give your project a name and, optionally, a short
            description of what it's about.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
            className="space-y-6"
          >
            <div className="space-y-2">
              <label
                htmlFor="ora-project-name"
                className="block text-sm font-medium text-foreground"
              >
                Project name
              </label>
              <input
                id="ora-project-name"
                autoFocus
                value={name}
                maxLength={80}
                placeholder="e.g. Marketing plan"
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md bg-background border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="ora-project-description"
                className="block text-sm font-medium text-foreground"
              >
                Description <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <textarea
                id="ora-project-description"
                value={description}
                maxLength={500}
                rows={4}
                placeholder="What is this project about?"
                onChange={(e) => setDescription(e.target.value)}
                className="w-full resize-none rounded-md bg-background border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="text-xs text-muted-foreground text-right">{description.length}/500</p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setLocation("/ora")}
                className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  "Create project"
                )}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
