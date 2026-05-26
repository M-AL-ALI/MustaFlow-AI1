import { useState, useCallback } from "react";
import {
  GitBranch,
  GitCommit,
  Upload,
  Download,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Github,
  ChevronDown,
  Clock,
  Sparkles,
  Link2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useGetGithubStatus,
  getGetGithubStatusQueryKey,
  usePushToGithub,
  useListGithubBranches,
  useListGithubCommits,
  getListGithubBranchesQueryKey,
  getListGithubCommitsQueryKey,
} from "@workspace/api-client-react";
import type { GithubConnection } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface GitPanelProps {
  projectId: number;
}

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ConnectedView({
  projectId,
  connection,
}: {
  projectId: number;
  connection: GithubConnection;
}) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [pushResult, setPushResult] = useState<{ repoUrl: string; filesCount: number } | null>(
    null,
  );
  const [pushError, setPushError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<string | null>(null);
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const push = usePushToGithub();

  const { data: branchesData } = useListGithubBranches(projectId, {
    query: {
      queryKey: getListGithubBranchesQueryKey(projectId),
      enabled: !!connection.repositoryName,
    },
  });

  const {
    data: commitsData,
    isLoading: commitsLoading,
    refetch: refetchCommits,
  } = useListGithubCommits(
    projectId,
    {},
    {
      query: {
        queryKey: getListGithubCommitsQueryKey(projectId, {}),
        enabled: !!connection.repositoryName && showHistory,
      },
    },
  );

  const handlePush = useCallback(async () => {
    setPushError(null);
    setPushResult(null);
    try {
      const result = await push.mutateAsync({
        id: projectId,
        data: commitMessage.trim() ? { commitMessage: commitMessage.trim() } : {},
      });
      setPushResult({ repoUrl: result.repoUrl, filesCount: result.filesCount });
      setCommitMessage("");
      await queryClient.invalidateQueries({ queryKey: getGetGithubStatusQueryKey(projectId) });
    } catch (err) {
      setPushError(err instanceof Error ? err.message : "Push failed.");
    }
  }, [push, projectId, commitMessage, queryClient]);

  const handlePull = useCallback(async () => {
    setPulling(true);
    setPullMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/pull`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { message?: string };
        setPullMsg(data.message ?? "Pulled latest changes.");
        void refetchCommits();
      } else {
        const err = (await res.json()) as { error?: string };
        setPullMsg(`Pull failed: ${err.error ?? "unknown error"}`);
      }
    } catch {
      setPullMsg("Network error during pull.");
    } finally {
      setPulling(false);
    }
  }, [projectId, refetchCommits]);

  const handleGenerateMessage = useCallback(async () => {
    setGeneratingMsg(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/git/generate-message`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { message?: string };
        if (data.message) setCommitMessage(data.message);
      }
    } catch {
      // fall back to a default
      setCommitMessage("Update project files");
    } finally {
      setGeneratingMsg(false);
    }
  }, [projectId]);

  const repoUrl =
    connection.repositoryOwner && connection.repositoryName
      ? `https://github.com/${connection.repositoryOwner}/${connection.repositoryName}`
      : null;

  const branches = branchesData?.branches ?? [];
  const commits = commitsData?.commits ?? [];

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-3">
      {/* Repo info */}
      <div className="border border-border rounded-md bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <Github className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-foreground truncate">
              {connection.repositoryOwner}/{connection.repositoryName ?? "—"}
            </div>
            <div className="text-[10px] text-muted-foreground">{connection.githubAccountName}</div>
          </div>
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        {branches.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-border/50">
            <GitBranch className="h-3 w-3 text-muted-foreground" />
            <select
              className="flex-1 bg-transparent text-[11px] text-muted-foreground outline-none"
              defaultValue={connection.defaultBranch ?? "main"}
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Commit & Push */}
      <div className="border border-border rounded-md bg-card overflow-hidden">
        <div className="px-3 py-2 border-b border-border">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Commit & Push
          </div>
        </div>
        <div className="p-2 space-y-2">
          <div className="relative">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message…"
              rows={3}
              className="w-full bg-muted/30 border border-border rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-primary/50 resize-none"
            />
            <button
              onClick={() => void handleGenerateMessage()}
              disabled={generatingMsg}
              className="absolute bottom-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-muted-foreground hover:text-primary bg-muted border border-border transition-colors"
              title="Generate commit message with AI"
            >
              {generatingMsg ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Sparkles className="h-2.5 w-2.5" />
              )}
              AI
            </button>
          </div>

          <div className="flex gap-1.5">
            <button
              onClick={() => void handlePush()}
              disabled={push.isPending || pulling}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {push.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              {push.isPending ? "Pushing…" : "Push"}
            </button>
            <button
              onClick={() => void handlePull()}
              disabled={pulling || push.isPending}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border border-border text-muted-foreground rounded disabled:opacity-40 hover:bg-muted hover:text-foreground transition-colors"
              title="Pull latest changes from remote"
            >
              {pulling ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              Pull
            </button>
          </div>

          {pushResult && (
            <div className="flex items-start gap-1.5 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-2 py-1.5">
              <CheckCircle2 className="h-3 w-3 shrink-0 mt-0.5" />
              <span>
                Pushed {pushResult.filesCount} file{pushResult.filesCount !== 1 ? "s" : ""} to{" "}
                <a
                  href={pushResult.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  GitHub
                </a>
              </span>
            </div>
          )}

          {pullMsg && (
            <div
              className={cn(
                "flex items-start gap-1.5 text-[10px] rounded px-2 py-1.5",
                pullMsg.startsWith("Pull failed") || pullMsg.startsWith("Network")
                  ? "text-red-400 bg-red-500/10 border border-red-500/20"
                  : "text-green-400 bg-green-500/10 border border-green-500/20",
              )}
            >
              {pullMsg.startsWith("Pull failed") || pullMsg.startsWith("Network") ? (
                <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="h-3 w-3 shrink-0 mt-0.5" />
              )}
              {pullMsg}
            </div>
          )}

          {pushError && (
            <div className="flex items-start gap-1.5 text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
              <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
              {pushError}
            </div>
          )}
        </div>
      </div>

      {/* Commit history */}
      <div className="border border-border rounded-md bg-card overflow-hidden">
        <button
          onClick={() => {
            setShowHistory((v) => !v);
            if (!showHistory) void refetchCommits();
          }}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors"
        >
          <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex-1 text-left">
            Commit History
          </span>
          <ChevronDown
            className={cn(
              "h-3 w-3 text-muted-foreground transition-transform",
              showHistory && "rotate-180",
            )}
          />
        </button>
        {showHistory && (
          <div className="border-t border-border">
            {commitsLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              </div>
            ) : commits.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
                No commits yet.
              </div>
            ) : (
              commits.slice(0, 20).map((commit) => (
                <div
                  key={commit.sha}
                  className="flex items-start gap-2.5 px-3 py-2 border-b border-border/50 last:border-0"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0 mt-1.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-foreground leading-snug line-clamp-2">
                      {commit.message}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-muted-foreground">
                      <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                      <span>·</span>
                      <Clock className="h-2.5 w-2.5" />
                      {timeAgo(commit.date)}
                    </div>
                  </div>
                  {commit.htmlUrl && (
                    <a
                      href={commit.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground/40 hover:text-primary transition-colors shrink-0"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DisconnectedView({ projectId }: { projectId: number }) {
  const oauthHref = `/api/projects/${projectId}/github/oauth/start`;

  return (
    <div className="flex-1 overflow-y-auto min-h-0 p-3">
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <Github className="h-4 w-4 text-foreground" />
          </div>
          <div>
            <div className="text-xs font-semibold">Connect GitHub</div>
            <div className="text-[10px] text-muted-foreground">
              Push project files to a repository
            </div>
          </div>
        </div>
        <div className="px-4 py-4 space-y-3">
          <a
            href={oauthHref}
            className="w-full inline-flex items-center justify-center gap-2 h-8 rounded-md bg-foreground text-background text-xs font-medium hover:bg-foreground/90 transition-colors"
          >
            <Github className="h-3.5 w-3.5" />
            Connect with GitHub
          </a>
          <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
            <Link2 className="h-3 w-3 shrink-0 mt-0.5 text-green-400" />
            Once connected, push any version of your project as a Git commit.
          </div>
        </div>
      </div>
    </div>
  );
}

export function GitPanel({ projectId }: GitPanelProps) {
  const {
    data: status,
    isLoading,
    refetch,
  } = useGetGithubStatus(projectId, {
    query: { queryKey: getGetGithubStatusQueryKey(projectId) },
  });

  const isConnected = status?.connected === true;
  const connection = status?.connection as GithubConnection | undefined;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Version Control
        </span>
        <button
          onClick={() => void refetch()}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : isConnected && connection ? (
        <ConnectedView projectId={projectId} connection={connection} />
      ) : (
        <DisconnectedView projectId={projectId} />
      )}
    </div>
  );
}
