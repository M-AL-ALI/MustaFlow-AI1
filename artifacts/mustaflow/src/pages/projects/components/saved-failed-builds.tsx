import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";

export interface SavedFailedBuildTask {
  id: number;
  projectId?: number;
  prompt?: string | null;
  report?: unknown;
  status?: string;
  stagingSnapshot?: unknown;
  appliedAt?: string | null;
  discardedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
}

interface SavedFailedBuildsProps {
  projectId: number;
  tasks: readonly SavedFailedBuildTask[];
  loading?: boolean;
  error?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onReview?: (request: string, taskId: number) => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function savedBuildRequest(task: SavedFailedBuildTask): string | null {
  for (const value of [task.prompt, record(task.report)?.userRequest]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function retainedFileCount(task: SavedFailedBuildTask): number {
  const files = task.stagingSnapshot;
  if (!Array.isArray(files) || files.length === 0) return 0;
  return files.every((file) => {
    const value = record(file);
    return (
      typeof value?.path === "string" && value.path.trim() && typeof value.content === "string"
    );
  })
    ? files.length
    : 0;
}

function timestamp(task: SavedFailedBuildTask): number {
  const value = Date.parse(task.completedAt ?? task.createdAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

export function SavedFailedBuilds({
  projectId,
  tasks,
  loading = false,
  error = false,
  refreshing = false,
  onRefresh,
  onReview,
}: SavedFailedBuildsProps) {
  const headingId = useId();
  const [visibleCount, setVisibleCount] = useState(5);
  useEffect(() => setVisibleCount(5), [projectId]);

  const projectTasks = tasks.filter(
    (task) => task.projectId === projectId && Number.isSafeInteger(task.id) && task.id > 0,
  );
  const usedSources = new Set(
    projectTasks.flatMap((task) => {
      const sourceId = record(record(task.report)?.retrySource)?.taskId;
      return typeof sourceId === "number" && Number.isSafeInteger(sourceId) && sourceId > 0
        ? [sourceId]
        : [];
    }),
  );
  const saved = projectTasks
    .filter(
      (task) =>
        task.status === "failed" &&
        retainedFileCount(task) > 0 &&
        (task.appliedAt === null || task.appliedAt === undefined) &&
        (task.discardedAt === null || task.discardedAt === undefined) &&
        !usedSources.has(task.id),
    )
    .sort((a, b) => timestamp(b) - timestamp(a) || b.id - a.id);

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-card p-3 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Saved failed builds
        </h3>
        {onRefresh && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || refreshing}
            onClick={onRefresh}
            aria-label="Refresh saved builds"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Review a saved draft before sending it for repair. Nothing is applied or published here.
        Availability is checked when you send.
      </p>
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading saved builds...
        </p>
      ) : error ? (
        <p role="alert" className="text-xs">
          Saved builds could not be refreshed. Refresh before choosing a draft.
        </p>
      ) : saved.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No unused failed drafts in the loaded build history.
        </p>
      ) : (
        <ul className="space-y-2">
          {saved.slice(0, visibleCount).map((task) => {
            const request = savedBuildRequest(task);
            const stateKnown = task.appliedAt === null && task.discardedAt === null;
            const date = timestamp(task);
            const count = retainedFileCount(task);
            return (
              <li
                key={task.id}
                className="rounded-md border border-border/70 p-3 space-y-2 min-w-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-1 text-xs">
                  <span className="font-medium">Build #{task.id}</span>
                  <span className="text-muted-foreground">
                    {count} saved {count === 1 ? "file" : "files"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {date ? new Date(date).toLocaleString() : "Date unavailable"}
                </p>
                <p className="text-xs">
                  {stateKnown
                    ? "Saved draft, not applied."
                    : "Draft state unavailable. Refresh before retrying."}
                </p>
                {request ? (
                  <details>
                    <summary className="cursor-pointer text-xs rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Full request for build #{task.id}
                    </summary>
                    <p
                      dir="auto"
                      className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs text-muted-foreground"
                    >
                      {request}
                    </p>
                  </details>
                ) : (
                  <p className="text-xs">
                    Full request unavailable. Refresh saved builds before retrying.
                  </p>
                )}
                {onReview && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="max-w-full whitespace-normal h-auto min-h-9 py-2"
                    aria-label={`Review build #${task.id} in composer`}
                    disabled={!stateKnown || !request || refreshing}
                    onClick={() => {
                      if (stateKnown && request) onReview(request, task.id);
                    }}
                  >
                    Review in composer
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!loading && !error && saved.length > visibleCount && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setVisibleCount((count) => count + 5)}
        >
          Show older saved builds
        </Button>
      )}
    </section>
  );
}
