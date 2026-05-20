import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  RotateCcw,
  ChevronDown,
  ChevronRight,
  FileCode2,
  GitCommit,
  Diff,
  X,
  Loader2,
  FileMinus,
  FilePlus,
} from "lucide-react";
import {
  useGetVersion,
  getGetVersionQueryKey,
  getListVersionsQueryKey,
  getListProjectFilesQueryKey,
  useRollbackVersion,
} from "@workspace/api-client-react";
import type { ProjectVersion, ProjectFileSummary } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type FileSnapshotEntry = { path: string; content: string; mimeType: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(date).toLocaleDateString();
}

type TriggerKind = "build" | "refine" | "rollback" | "publish" | "manual";

function detectTrigger(label: string): TriggerKind {
  const lower = label.toLowerCase();
  if (lower.includes("rollback") || lower.includes("restore")) return "rollback";
  if (lower.includes("publish")) return "publish";
  if (lower.includes("refine") || lower.includes("change") || lower.includes("update"))
    return "refine";
  if (lower.includes("build") || lower.includes("initial") || lower.includes("generat"))
    return "build";
  return "manual";
}

const triggerConfig: Record<TriggerKind, { label: string; className: string }> = {
  build: { label: "Build", className: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  refine: { label: "Refine", className: "bg-violet-500/15 text-violet-400 border-violet-500/30" },
  rollback: {
    label: "Rollback",
    className: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  },
  publish: { label: "Publish", className: "bg-green-500/15 text-green-400 border-green-500/30" },
  manual: { label: "Manual", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

type DiffLine =
  | { kind: "same"; text: string; lineA: number; lineB: number }
  | { kind: "add"; text: string; lineB: number }
  | { kind: "remove"; text: string; lineA: number };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let lineA = 1;
  let lineB = 1;

  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ kind: "same", text: oldLines[i]!, lineA, lineB });
      i++;
      j++;
      lineA++;
      lineB++;
    } else if (j < n && (i >= m || (dp[i]![j + 1] ?? 0) >= (dp[i + 1]![j] ?? 0))) {
      result.push({ kind: "add", text: newLines[j]!, lineB });
      j++;
      lineB++;
    } else {
      result.push({ kind: "remove", text: oldLines[i]!, lineA });
      i++;
      lineA++;
    }
  }
  return result;
}

const DIFF_LINE_LIMIT = 2000;

function FileDiffViewer({
  path,
  snapshotContent,
  currentContent,
  onClose,
}: {
  path: string;
  snapshotContent: string;
  currentContent: string;
  onClose: () => void;
}) {
  const snapshotLines = snapshotContent === "" ? 0 : snapshotContent.split("\n").length;
  const currentLines = currentContent === "" ? 0 : currentContent.split("\n").length;
  const tooLarge = snapshotLines + currentLines > DIFF_LINE_LIMIT;

  const diff = tooLarge ? [] : computeDiff(snapshotContent, currentContent);
  const addCount = diff.filter((l) => l.kind === "add").length;
  const removeCount = diff.filter((l) => l.kind === "remove").length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0d1117]">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 bg-card shrink-0">
        <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-mono text-sm text-foreground truncate flex-1">{path}</span>
        <span className="text-xs text-green-400 shrink-0">+{addCount}</span>
        <span className="text-xs text-red-400 shrink-0 mr-2">-{removeCount}</span>
        <span className="text-[10px] text-muted-foreground shrink-0 border border-border rounded px-1.5 py-0.5">
          snapshot → current
        </span>
        <button
          onClick={onClose}
          className="ml-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close diff"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto font-mono text-xs">
        {tooLarge ? (
          <div className="p-8 text-center text-muted-foreground">
            <div className="text-sm font-medium mb-2">File too large to diff in browser</div>
            <div className="text-xs">
              This file has {snapshotLines.toLocaleString()} + {currentLines.toLocaleString()}{" "}
              lines. Download or export the project to compare large files externally.
            </div>
          </div>
        ) : addCount === 0 && removeCount === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            No differences — file is identical to the current version.
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {diff.map((line, idx) => {
                const lineNumA =
                  line.kind === "same" ? line.lineA : line.kind === "remove" ? line.lineA : null;
                const lineNumB =
                  line.kind === "same" ? line.lineB : line.kind === "add" ? line.lineB : null;
                const rowClass =
                  line.kind === "add"
                    ? "bg-green-950/50"
                    : line.kind === "remove"
                      ? "bg-red-950/50"
                      : "";
                const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
                const textClass =
                  line.kind === "add"
                    ? "text-green-300"
                    : line.kind === "remove"
                      ? "text-red-300"
                      : "text-[#d4d4d4]";

                return (
                  <tr key={idx} className={rowClass}>
                    <td className="select-none w-10 px-2 py-0 text-right text-zinc-600 border-r border-zinc-800">
                      {lineNumA ?? ""}
                    </td>
                    <td className="select-none w-10 px-2 py-0 text-right text-zinc-600 border-r border-zinc-800">
                      {lineNumB ?? ""}
                    </td>
                    <td className="select-none w-5 px-1 py-0 text-zinc-500 border-r border-zinc-800">
                      {prefix}
                    </td>
                    <td className={`py-0 px-3 whitespace-pre ${textClass}`}>{line.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type DiffRequest = { path: string; snapshotContent: string; currentContent: string };

function SnapshotFileBrowser({
  projectId,
  versionId,
  currentFiles,
  onDiff,
}: {
  projectId: number;
  versionId: number;
  currentFiles: ProjectFileSummary[];
  onDiff: (req: DiffRequest) => void;
}) {
  const { data, isLoading } = useGetVersion(projectId, versionId, {
    query: { queryKey: getGetVersionQueryKey(projectId, versionId) },
  });

  const [comparingPath, setComparingPath] = useState<string | null>(null);

  const handleCompare = useCallback(
    async (snapshotFile: FileSnapshotEntry) => {
      const currentFile = currentFiles.find((f) => f.path === snapshotFile.path);

      if (!currentFile) {
        onDiff({
          path: snapshotFile.path,
          snapshotContent: snapshotFile.content,
          currentContent: "",
        });
        return;
      }

      setComparingPath(snapshotFile.path);
      try {
        const res = await fetch(`/api/projects/${projectId}/files/${currentFile.id}`);
        if (res.ok) {
          const fetched = (await res.json()) as { content: string };
          onDiff({
            path: snapshotFile.path,
            snapshotContent: snapshotFile.content,
            currentContent: fetched.content,
          });
        }
      } finally {
        setComparingPath(null);
      }
    },
    [currentFiles, projectId, onDiff],
  );

  if (isLoading) {
    return (
      <div className="mt-3 space-y-1.5 pl-4 pr-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  const files: FileSnapshotEntry[] = data?.filesSnapshot ?? [];

  if (files.length === 0) {
    return (
      <div className="mt-3 pl-4 text-xs text-muted-foreground">No files in this snapshot.</div>
    );
  }

  const currentByPath = new Map(currentFiles.map((f) => [f.path, f]));

  return (
    <div className="mt-2 space-y-0.5 pl-4 pr-3">
      <div className="text-[10px] text-muted-foreground pb-1 font-medium uppercase tracking-wide">
        {files.length} file{files.length !== 1 ? "s" : ""} in snapshot
      </div>
      {files.map((f) => {
        const sizeBytes = new TextEncoder().encode(f.content).length;
        const existsInCurrent = currentByPath.has(f.path);
        const isComparing = comparingPath === f.path;

        return (
          <div
            key={f.path}
            className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 group"
          >
            <FileCode2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs text-foreground truncate flex-1 min-w-0">
              {f.path}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {formatBytes(sizeBytes)}
            </span>
            {!existsInCurrent && (
              <span className="text-[10px] text-orange-400 shrink-0">new in restore</span>
            )}
            <button
              onClick={() => void handleCompare(f)}
              disabled={isComparing}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary shrink-0 disabled:opacity-50 transition-colors"
              title={
                existsInCurrent ? "Compare with current version" : "View file (not in current)"
              }
            >
              {isComparing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Diff className="h-3 w-3" />
              )}
              {existsInCurrent ? "Compare" : "View"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function RollbackFileList({
  projectId,
  versionId,
  currentFiles,
}: {
  projectId: number;
  versionId: number;
  currentFiles: ProjectFileSummary[];
}) {
  const { data, isLoading } = useGetVersion(projectId, versionId, {
    query: { queryKey: getGetVersionQueryKey(projectId, versionId) },
  });

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  const snapshotFiles: FileSnapshotEntry[] = data?.filesSnapshot ?? [];
  const currentByPath = new Map(currentFiles.map((f) => [f.path, f]));
  const snapshotPathSet = new Set(snapshotFiles.map((f) => f.path));

  const overwritten = snapshotFiles.filter((f) => currentByPath.has(f.path));
  const restored = snapshotFiles.filter((f) => !currentByPath.has(f.path));
  const deleted = currentFiles.filter((f) => !snapshotPathSet.has(f.path));

  return (
    <div className="space-y-3 mt-3">
      {overwritten.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1">
            Overwritten ({overwritten.length})
          </div>
          <div className="max-h-28 overflow-y-auto space-y-0.5">
            {overwritten.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-1.5 text-xs text-foreground font-mono truncate"
              >
                <FileCode2 className="h-3 w-3 text-muted-foreground shrink-0" />
                {f.path}
              </div>
            ))}
          </div>
        </div>
      )}
      {restored.length > 0 && (
        <div>
          <div className="text-[10px] text-green-400 font-medium uppercase tracking-wide mb-1">
            Re-added ({restored.length})
          </div>
          <div className="max-h-28 overflow-y-auto space-y-0.5">
            {restored.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-1.5 text-xs text-green-300 font-mono truncate"
              >
                <FilePlus className="h-3 w-3 shrink-0" />
                {f.path}
              </div>
            ))}
          </div>
        </div>
      )}
      {deleted.length > 0 && (
        <div>
          <div className="text-[10px] text-red-400 font-medium uppercase tracking-wide mb-1">
            Removed from current ({deleted.length})
          </div>
          <div className="max-h-28 overflow-y-auto space-y-0.5">
            {deleted.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-1.5 text-xs text-red-300 font-mono truncate"
              >
                <FileMinus className="h-3 w-3 shrink-0" />
                {f.path}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RollbackDrawer({
  open,
  version,
  projectId,
  currentFiles,
  onClose,
  onSuccess,
}: {
  open: boolean;
  version: ProjectVersion | null;
  projectId: number;
  currentFiles: ProjectFileSummary[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const rollback = useRollbackVersion();

  const handleConfirm = useCallback(() => {
    if (!version) return;
    rollback.mutate(
      { id: projectId, versionId: version.id },
      {
        onSuccess: () => {
          onClose();
          onSuccess();
        },
      },
    );
  }, [version, projectId, rollback, onClose, onSuccess]);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            Restore version
          </SheetTitle>
          <SheetDescription>
            Restoring <strong className="text-foreground">{version?.label}</strong> will replace
            your current project files with this snapshot.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 rounded-md border border-border bg-muted/30 p-4">
          <div className="text-sm font-medium text-foreground mb-1">Files that will be changed</div>
          {version && (
            <RollbackFileList
              projectId={projectId}
              versionId={version.id}
              currentFiles={currentFiles}
            />
          )}
          {version && (
            <div className="pt-3 mt-3 text-xs text-muted-foreground border-t border-border">
              Snapshot was created{" "}
              <strong className="text-foreground">{relativeTime(version.createdAt)}</strong>{" "}
              &middot; {new Date(version.createdAt).toLocaleString()}
            </div>
          )}
        </div>

        <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
          <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
            <li>Secrets and integrations are not affected</li>
            <li>A rollback entry will appear in the build history</li>
            <li>A new snapshot will be saved after the restore completes</li>
          </ul>
        </div>

        <SheetFooter className="mt-6 gap-2 flex-row justify-end">
          <Button variant="outline" onClick={onClose} disabled={rollback.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={rollback.isPending}>
            {rollback.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Restoring…
              </>
            ) : (
              <>
                <RotateCcw className="h-4 w-4 mr-2" />
                Restore this version
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function VersionTimeline({
  projectId,
  versions,
  isLoading,
  currentFiles,
}: {
  projectId: number;
  versions: ProjectVersion[] | undefined;
  isLoading: boolean;
  currentFiles: ProjectFileSummary[];
}) {
  const queryClient = useQueryClient();

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ProjectVersion | null>(null);
  const [diffState, setDiffState] = useState<DiffRequest | null>(null);

  const handleRollbackSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
    queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
  }, [queryClient, projectId]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!versions || versions.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground border border-border rounded-lg bg-card mx-4">
        <GitCommit className="h-8 w-8 mx-auto mb-3 opacity-30" />
        <div className="text-sm font-medium mb-1">No saved versions yet</div>
        <div className="text-xs">
          The AI Builder automatically snapshots a version after each successful build or change.
        </div>
      </div>
    );
  }

  const latestId = versions[0]?.id;

  return (
    <>
      {diffState && (
        <FileDiffViewer
          path={diffState.path}
          snapshotContent={diffState.snapshotContent}
          currentContent={diffState.currentContent}
          onClose={() => setDiffState(null)}
        />
      )}

      <RollbackDrawer
        open={!!rollbackTarget}
        version={rollbackTarget}
        projectId={projectId}
        currentFiles={currentFiles}
        onClose={() => setRollbackTarget(null)}
        onSuccess={handleRollbackSuccess}
      />

      <div className="relative px-4 space-y-0">
        <div className="absolute left-[28px] top-0 bottom-0 w-px bg-border pointer-events-none" />

        {versions.map((v) => {
          const isCurrent = v.id === latestId;
          const isExpanded = expandedId === v.id;
          const trigger = detectTrigger(v.label);
          const cfg = triggerConfig[trigger];

          return (
            <div key={v.id} className="relative pl-10 pb-4">
              <div
                className={`absolute left-[20px] top-4 h-3.5 w-3.5 rounded-full border-2 z-10 ${
                  isCurrent
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/40 bg-background"
                }`}
              />

              <div
                className={`border rounded-lg bg-card transition-colors ${
                  isCurrent ? "border-primary/40" : "border-border"
                }`}
              >
                <button
                  className="w-full text-left p-3 flex items-start gap-3"
                  onClick={() => setExpandedId(isExpanded ? null : v.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold">{v.label}</span>
                      {isCurrent && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-4 border-primary/40 text-primary shrink-0"
                        >
                          Current
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 h-4 shrink-0 ${cfg.className}`}
                      >
                        {cfg.label}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 h-4 shrink-0 text-muted-foreground border-border"
                      >
                        {v.filesCount} file{v.filesCount !== 1 ? "s" : ""}
                      </Badge>
                    </div>
                    {v.note && (
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {v.note}
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {relativeTime(v.createdAt)} &middot; {new Date(v.createdAt).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 mt-0.5">
                    {!isCurrent && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRollbackTarget(v);
                        }}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        Restore
                      </Button>
                    )}
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border pb-3">
                    <SnapshotFileBrowser
                      projectId={projectId}
                      versionId={v.id}
                      currentFiles={currentFiles}
                      onDiff={setDiffState}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
