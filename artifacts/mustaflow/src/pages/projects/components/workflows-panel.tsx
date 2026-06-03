/**
 * Workflows panel (Task #538) — list & run named workflows declared in
 * workflows.yaml (or stack defaults).
 */
import { authFetch } from "@/lib/api-fetch";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Play, Terminal, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";

interface WorkflowEntry {
  name: string;
  command: string;
  description?: string;
  cwd?: string;
}
interface ListResp {
  source: "yaml" | "defaults";
  workflows: WorkflowEntry[];
}
interface RunResp {
  name: string;
  ok: boolean;
  output: string;
  command: string;
}

export function WorkflowsPanel({ projectId }: { projectId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["project-workflows", projectId],
    queryFn: async (): Promise<ListResp> => {
      const r = await authFetch(`/api/projects/${projectId}/workflows`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load workflows");
      return r.json();
    },
  });

  const [running, setRunning] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RunResp | null>(null);

  async function runWorkflow(name: string) {
    setRunning(name);
    setLastResult(null);
    try {
      const r = await authFetch(
        `/api/projects/${projectId}/workflows/${encodeURIComponent(name)}/run`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const body = (await r.json()) as RunResp | { error: string };
      if (!r.ok || "error" in body) {
        toast.error("error" in body ? body.error : "Workflow run failed");
        return;
      }
      setLastResult(body);
      toast[body.ok ? "success" : "error"](
        `Workflow "${name}" ${body.ok ? "succeeded" : "exited with errors"}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Workflow run failed");
    } finally {
      setRunning(null);
    }
  }

  if (isLoading) return <div className="text-xs text-muted-foreground">Loading workflows…</div>;

  const workflows = data?.workflows ?? [];
  if (workflows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-3 border border-dashed rounded-md">
        No workflows defined. Add a <code className="px-1 bg-muted rounded">workflows.yaml</code> at
        the project root to declare runnable commands.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Terminal className="h-3 w-3" />
        Workflows
        <span className="ml-auto">
          {data?.source === "yaml" ? "from workflows.yaml" : "stack defaults"}
        </span>
      </div>
      <div className="grid gap-2">
        {workflows.map((wf) => (
          <div
            key={wf.name}
            className="flex items-center gap-3 p-2 border border-border rounded-md bg-card"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{wf.name}</div>
              <code className="text-[11px] text-muted-foreground truncate block">{wf.command}</code>
              {wf.description && (
                <div className="text-[11px] text-muted-foreground mt-0.5">{wf.description}</div>
              )}
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={running !== null}
              onClick={() => runWorkflow(wf.name)}
            >
              {running === wf.name ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5">Run</span>
            </Button>
          </div>
        ))}
      </div>
      {lastResult && (
        <div className="mt-2 border border-border rounded-md p-2 bg-black/40">
          <div className="text-[11px] text-muted-foreground mb-1">
            Last run: <span className="font-mono">{lastResult.name}</span>{" "}
            {lastResult.ok ? "✓" : "✗"}
          </div>
          <pre className="text-[11px] text-green-300 font-mono whitespace-pre-wrap max-h-64 overflow-auto">
            {lastResult.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}
