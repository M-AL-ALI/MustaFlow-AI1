import { useState, useCallback, useEffect } from "react";
import {
  Github,
  GitBranch,
  GitPullRequest,
  GitCommit,
  Upload,
  Link2,
  Link2Off,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  Copy,
  ChevronDown,
  Lock,
  Globe,
  Clock,
  Terminal,
  Sparkles,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useGetGithubStatus,
  getGetGithubStatusQueryKey,
  useConnectGithub,
  useDisconnectGithub,
  useListGithubRepositories,
  useSelectGithubRepository,
  usePushToGithub,
  useCreateGithubBranch,
  useOpenGithubPr,
  useListGithubBranches,
  useListGithubCommits,
  getListGithubRepositoriesQueryKey,
  getListGithubBranchesQueryKey,
  getListGithubCommitsQueryKey,
} from "@workspace/api-client-react";
import type { GithubConnection, GithubRepository } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ConnectPanel({
  projectId,
  onConnected,
  oauthBanner,
}: {
  projectId: number;
  onConnected: () => void;
  oauthBanner?: { kind: "success" | "error"; message: string } | null;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showPat, setShowPat] = useState(false);
  const [oauthEnabled, setOauthEnabled] = useState<boolean | null>(null);
  const connect = useConnectGithub();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/projects/${projectId}/github/oauth/config`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j: { enabled?: boolean }) => {
        if (!cancelled) setOauthEnabled(!!j.enabled);
      })
      .catch(() => {
        if (!cancelled) setOauthEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleConnect = useCallback(async () => {
    if (!token.trim()) {
      setError("Enter a GitHub personal access token.");
      return;
    }
    setError(null);
    try {
      await connect.mutateAsync({ id: projectId, data: { token: token.trim() } });
      setToken("");
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    }
  }, [token, connect, projectId, onConnected]);

  const oauthHref = `/api/projects/${projectId}/github/oauth/start`;

  return (
    <div className="space-y-4">
      {oauthBanner && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            oauthBanner.kind === "success"
              ? "bg-green-500/10 border-green-500/20 text-green-400"
              : "bg-destructive/10 border-destructive/20 text-destructive",
          )}
        >
          {oauthBanner.kind === "success" ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          )}
          <span>{oauthBanner.message}</span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            <Github className="h-4 w-4 text-foreground" />
          </div>
          <div>
            <div className="text-sm font-semibold">Connect GitHub</div>
            <div className="text-xs text-muted-foreground">
              Push your project files to a GitHub repository
            </div>
          </div>
        </div>
        <div className="px-4 py-4 space-y-3">
          {oauthEnabled !== false && (
            <div className="space-y-2">
              <a
                href={oauthHref}
                className={cn(
                  "w-full inline-flex items-center justify-center gap-2 h-9 rounded-md bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-colors",
                  oauthEnabled === null && "opacity-60 pointer-events-none",
                )}
              >
                <Github className="h-4 w-4" />
                Connect with GitHub
              </a>
              <p className="text-[11px] text-muted-foreground text-center">
                One-click sign-in via GitHub OAuth — no token to manage.
              </p>
            </div>
          )}

          {oauthEnabled !== false && (
            <div className="flex items-center gap-2 my-1">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}

          {oauthEnabled === false ? null : (
            <button
              type="button"
              onClick={() => setShowPat((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <ChevronDown
                className={cn("h-3 w-3 transition-transform", showPat && "rotate-180")}
              />
              Use a personal access token instead
            </button>
          )}

          {(oauthEnabled === false || showPat) && (
            <>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Create a GitHub personal access token with{" "}
                <code className="bg-muted px-1 py-px rounded text-[11px]">repo</code> scope. Your
                token is encrypted and stored server-side — it is never returned to the browser.
              </p>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Personal access token
                </label>
                <Input
                  type="password"
                  placeholder="ghp_••••••••••••••••••••"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleConnect()}
                  className="h-8 text-sm font-mono"
                />
              </div>
              {error && (
                <div className="flex items-start gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  {error}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => void handleConnect()}
                  disabled={connect.isPending || !token.trim()}
                >
                  {connect.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Connecting…
                    </>
                  ) : (
                    <>
                      <Link2 className="h-3.5 w-3.5 mr-1.5" /> Connect GitHub
                    </>
                  )}
                </Button>
                <a
                  href="https://github.com/settings/tokens/new?description=MustaFlow&scopes=repo"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> Create a token
                </a>
              </div>
              <div className="flex items-start gap-2 bg-muted/40 border border-border rounded-lg p-2.5 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-400" />
                <span>
                  Your token is AES-256 encrypted before being stored. It is never logged or
                  returned to the frontend. Only your project&apos;s files are pushed — no MustaFlow
                  platform credentials are ever included.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RepoSelector({
  projectId,
  connection,
  onSelected,
}: {
  projectId: number;
  connection: GithubConnection;
  onSelected: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepository | null>(null);
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const {
    data: reposData,
    isLoading,
    refetch,
    isRefetching,
  } = useListGithubRepositories(
    projectId,
    {},
    {
      query: { queryKey: getListGithubRepositoriesQueryKey(projectId, {}), enabled: true },
    },
  );

  const selectRepo = useSelectGithubRepository();

  const filtered = (reposData?.repositories ?? []).filter(
    (r) =>
      search.trim() === "" ||
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.fullName.toLowerCase().includes(search.toLowerCase()),
  );

  const handleSelect = useCallback(async () => {
    if (!selectedRepo) {
      setError("Select a repository first.");
      return;
    }
    setError(null);
    try {
      await selectRepo.mutateAsync({
        id: projectId,
        data: {
          repositoryOwner: selectedRepo.fullName.split("/")[0],
          repositoryName: selectedRepo.name,
          defaultBranch: branch || selectedRepo.defaultBranch,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getGetGithubStatusQueryKey(projectId) });
      onSelected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select repository.");
    }
  }, [selectedRepo, branch, selectRepo, projectId, queryClient, onSelected]);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden space-y-0">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-green-500/10 flex items-center justify-center">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
          </div>
          <div>
            <div className="text-sm font-semibold">Connected as {connection.githubAccountName}</div>
            <div className="text-xs text-muted-foreground">Select a repository to link</div>
          </div>
        </div>
        <button
          onClick={() => void refetch()}
          className="text-muted-foreground hover:text-foreground transition-colors p-1"
          title="Refresh"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isRefetching && "animate-spin")} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className="relative">
          <Input
            placeholder="Search repositories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs pl-3"
          />
        </div>

        <div className="max-h-52 overflow-y-auto space-y-1 -mx-1 px-1">
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading repositories…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-4 text-xs text-muted-foreground text-center">
              No repositories found.
            </div>
          ) : (
            filtered.map((repo) => (
              <button
                key={repo.fullName}
                onClick={() => setSelectedRepo(repo)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors text-xs",
                  selectedRepo?.fullName === repo.fullName
                    ? "bg-primary/10 border border-primary/30 text-foreground"
                    : "hover:bg-muted border border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {repo.private ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="font-medium flex-1 truncate">{repo.fullName}</span>
                {repo.private && (
                  <span className="text-[10px] px-1.5 py-px rounded-full bg-muted text-muted-foreground shrink-0">
                    private
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {selectedRepo && (
          <div className="space-y-1.5 pt-1 border-t border-border">
            <label className="text-xs font-medium text-muted-foreground">Default branch</label>
            <Input
              placeholder={selectedRepo.defaultBranch}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="h-7 text-xs font-mono"
            />
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <Button
          size="sm"
          className="h-8 w-full"
          disabled={!selectedRepo || selectRepo.isPending}
          onClick={() => void handleSelect()}
        >
          {selectRepo.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Saving…
            </>
          ) : (
            <>
              <GitBranch className="h-3.5 w-3.5 mr-1.5" /> Use this repository
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function ConnectedPanel({
  projectId,
  connection,
  onDisconnect,
  onChangeRepo,
}: {
  projectId: number;
  connection: GithubConnection;
  onDisconnect: () => void;
  onChangeRepo: () => void;
}) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [pushResult, setPushResult] = useState<{
    repoUrl: string;
    commitSha: string;
    filesCount: number;
  } | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const [newBranch, setNewBranch] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchResult, setBranchResult] = useState<string | null>(null);

  const [prTitle, setPrTitle] = useState("Changes from MustaFlow AI");
  const [prHead, setPrHead] = useState("");
  const [prBody, setPrBody] = useState("Generated via MustaFlow AI builder.");
  const [prError, setPrError] = useState<string | null>(null);
  const [prResult, setPrResult] = useState<{ prUrl: string; prNumber: number } | null>(null);
  const [showPrForm, setShowPrForm] = useState(false);
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [showCodex, setShowCodex] = useState(false);

  const push = usePushToGithub();
  const createBranch = useCreateGithubBranch();
  const openPr = useOpenGithubPr();
  const disconnect = useDisconnectGithub();

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
    isRefetching: commitsRefetching,
  } = useListGithubCommits(
    projectId,
    {},
    {
      query: {
        queryKey: getListGithubCommitsQueryKey(projectId, {}),
        enabled: !!connection.repositoryName,
      },
    },
  );

  const repoUrl = `https://github.com/${connection.repositoryOwner}/${connection.repositoryName}`;

  const handlePush = useCallback(async () => {
    setPushError(null);
    setPushResult(null);
    try {
      const result = await push.mutateAsync({
        id: projectId,
        data: commitMessage.trim() ? { commitMessage: commitMessage.trim() } : {},
      });
      setPushResult(result);
      setShowCodex(true);
      await queryClient.invalidateQueries({ queryKey: getGetGithubStatusQueryKey(projectId) });
    } catch (err) {
      setPushError(err instanceof Error ? err.message : "Push failed.");
    }
  }, [push, projectId, commitMessage, queryClient]);

  const handleCreateBranch = useCallback(async () => {
    if (!newBranch.trim()) {
      setBranchError("Enter a branch name.");
      return;
    }
    setBranchError(null);
    setBranchResult(null);
    try {
      const result = await createBranch.mutateAsync({
        id: projectId,
        data: { branchName: newBranch.trim() },
      });
      setBranchResult(result.branchName);
      setNewBranch("");
      await queryClient.invalidateQueries({ queryKey: getListGithubBranchesQueryKey(projectId) });
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : "Failed to create branch.");
    }
  }, [newBranch, createBranch, projectId, queryClient]);

  const handleOpenPr = useCallback(async () => {
    if (!prHead.trim() || !prTitle.trim()) {
      setPrError("Branch and title are required.");
      return;
    }
    setPrError(null);
    setPrResult(null);
    try {
      const result = await openPr.mutateAsync({
        id: projectId,
        data: { title: prTitle, head: prHead, body: prBody },
      });
      setPrResult({ prUrl: result.prUrl, prNumber: result.prNumber });
    } catch (err) {
      setPrError(err instanceof Error ? err.message : "Failed to open pull request.");
    }
  }, [prTitle, prHead, prBody, openPr, projectId]);

  const handleDisconnect = useCallback(async () => {
    await disconnect.mutateAsync({ id: projectId });
    await queryClient.invalidateQueries({ queryKey: getGetGithubStatusQueryKey(projectId) });
    onDisconnect();
  }, [disconnect, projectId, queryClient, onDisconnect]);

  const codexPrompt = `Review this MustaFlow generated project. Check for bugs, security issues, missing tests, and improve the code without changing the product intent.`;

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-3">
      {/* Connection header */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center">
              <Github className="h-4 w-4 text-green-400" />
            </div>
            <div>
              <div className="text-sm font-semibold flex items-center gap-1.5">
                {connection.githubAccountName}
                <span className="text-[10px] font-normal bg-green-500/15 text-green-400 px-1.5 py-px rounded-full">
                  connected
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                >
                  {connection.repositoryOwner}/{connection.repositoryName}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
                <span className="text-[10px] text-muted-foreground">·</span>
                <a
                  href={`/api/projects/${projectId}/github/oauth/start?switch=1`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                  title="Re-authorize with a different GitHub account"
                >
                  Switch account
                </a>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onChangeRepo}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border hover:border-border/80"
            >
              Change repo
            </button>
            <button
              onClick={() => void handleDisconnect()}
              disabled={disconnect.isPending}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded border border-border hover:border-destructive/40 flex items-center gap-1"
            >
              {disconnect.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Link2Off className="h-3 w-3" />
              )}
              Disconnect
            </button>
          </div>
        </div>

        {/* Sync status bar */}
        <div className="px-4 py-2 border-t border-border bg-muted/20 flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            Last sync:{" "}
            <span
              className={cn(
                connection.syncStatus === "syncing"
                  ? "text-blue-400"
                  : connection.syncStatus === "error"
                    ? "text-destructive"
                    : "text-foreground",
              )}
            >
              {connection.syncStatus === "syncing"
                ? "Syncing…"
                : connection.syncStatus === "error"
                  ? "Error"
                  : timeAgo(connection.lastSyncAt)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{connection.defaultBranch}</span>
          </div>
        </div>
      </div>

      {/* Push to GitHub */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <Upload className="h-3.5 w-3.5" /> Push to GitHub
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Commit message</label>
            <Input
              placeholder="Push from MustaFlow AI"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          {pushError && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {pushError}
            </div>
          )}
          {pushResult && (
            <div className="flex items-start gap-2 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-400" />
              <div className="space-y-0.5">
                <div className="text-green-400 font-medium">
                  Pushed {pushResult.filesCount} files
                </div>
                <a
                  href={pushResult.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline flex items-center gap-0.5"
                >
                  Open repository <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
            </div>
          )}
          <Button
            size="sm"
            className="h-8 w-full"
            onClick={() => void handlePush()}
            disabled={push.isPending}
          >
            {push.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Pushing…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5 mr-1.5" /> Push to {connection.defaultBranch}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Commit history */}
      {connection.repositoryName && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <History className="h-3.5 w-3.5" /> Recent commits
            </div>
            <button
              onClick={() => void refetchCommits()}
              className="text-muted-foreground hover:text-foreground transition-colors p-1"
              title="Refresh commits"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", commitsRefetching && "animate-spin")} />
            </button>
          </div>
          <div className="divide-y divide-border">
            {commitsLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground justify-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading commits…
              </div>
            ) : !commitsData?.commits?.length ? (
              <div className="py-4 text-xs text-muted-foreground text-center">
                No commits yet — push your project to get started.
              </div>
            ) : (
              (commitsData.commits ?? []).slice(0, 20).map((commit) => (
                <a
                  key={commit.sha}
                  href={commit.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors group"
                >
                  <div className="w-5 h-5 rounded bg-muted flex items-center justify-center shrink-0 mt-0.5">
                    <GitCommit className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground truncate leading-tight group-hover:text-primary transition-colors">
                      {commit.message}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                      <code className="font-mono bg-muted px-1 rounded">{commit.shortSha}</code>
                      <span>{commit.author}</span>
                      <span>{timeAgo(commit.date)}</span>
                    </div>
                  </div>
                  <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                </a>
              ))
            )}
          </div>
        </div>
      )}

      {/* Create branch */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:bg-muted/30 transition-colors"
          onClick={() => setShowBranchForm(!showBranchForm)}
        >
          <div className="flex items-center gap-2">
            <GitBranch className="h-3.5 w-3.5" /> Create branch
          </div>
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", showBranchForm && "rotate-180")}
          />
        </button>
        {showBranchForm && (
          <div className="px-4 pb-3 space-y-3 border-t border-border pt-3">
            {(branchesData?.branches ?? []).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Existing branches</div>
                <div className="flex flex-wrap gap-1">
                  {branchesData?.branches.map((b) => (
                    <button
                      key={b.name}
                      onClick={() => setPrHead(b.name)}
                      className="text-[11px] font-mono px-1.5 py-px rounded bg-muted border border-border text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                placeholder="feature/my-branch"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleCreateBranch()}
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                size="sm"
                className="h-8 shrink-0"
                onClick={() => void handleCreateBranch()}
                disabled={createBranch.isPending || !newBranch.trim()}
              >
                {createBranch.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Create"
                )}
              </Button>
            </div>
            {branchError && (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {branchError}
              </div>
            )}
            {branchResult && (
              <div className="flex items-center gap-2 text-xs text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Branch{" "}
                <code className="font-mono bg-green-500/10 px-1 rounded">{branchResult}</code>{" "}
                created
              </div>
            )}
          </div>
        )}
      </div>

      {/* Open pull request */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:bg-muted/30 transition-colors"
          onClick={() => setShowPrForm(!showPrForm)}
        >
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-3.5 w-3.5" /> Open pull request
          </div>
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", showPrForm && "rotate-180")}
          />
        </button>
        {showPrForm && (
          <div className="px-4 pb-3 space-y-2.5 border-t border-border pt-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">PR title</label>
              <Input
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Head branch</label>
                <Input
                  placeholder="feature/my-branch"
                  value={prHead}
                  onChange={(e) => setPrHead(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Base ({connection.defaultBranch})
                </label>
                <Input
                  placeholder={connection.defaultBranch}
                  className="h-8 text-xs font-mono text-muted-foreground"
                  disabled
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Description</label>
              <textarea
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                rows={2}
                className="w-full bg-muted border border-border rounded-md px-3 py-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {prError && (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {prError}
              </div>
            )}
            {prResult && (
              <div className="flex items-center gap-2 text-xs text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <a
                  href={prResult.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline flex items-center gap-0.5"
                >
                  PR #{prResult.prNumber} opened <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
            )}
            <Button
              size="sm"
              className="h-8 w-full"
              onClick={() => void handleOpenPr()}
              disabled={openPr.isPending || !prHead.trim() || !prTitle.trim()}
            >
              {openPr.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Opening…
                </>
              ) : (
                <>
                  <GitPullRequest className="h-3.5 w-3.5 mr-1.5" /> Open pull request
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Codex panel */}
      {(showCodex || pushResult) && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <button
            className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:bg-muted/30 transition-colors"
            onClick={() => setShowCodex(!showCodex)}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-violet-400" /> Open in Codex
            </div>
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", showCodex && "rotate-180")}
            />
          </button>
          {showCodex && (
            <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                After pushing your project to GitHub, you can open the repository in Codex for
                additional coding, review, or debugging.
              </p>
              <div className="space-y-2">
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted border border-border text-xs hover:border-border/60 hover:bg-muted/80 transition-colors"
                >
                  <Github className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">Open GitHub repository</span>
                  <ExternalLink className="h-3 w-3 text-muted-foreground" />
                </a>
                <a
                  href={`https://codex.openai.com`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs hover:bg-violet-500/15 transition-colors"
                >
                  <Terminal className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                  <span className="flex-1 text-violet-300">Open Codex</span>
                  <ExternalLink className="h-3 w-3 text-violet-400/60" />
                </a>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Terminal className="h-3 w-3" /> Suggested Codex task prompt
                </div>
                <div className="relative bg-muted/60 border border-border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground leading-relaxed pr-8 font-mono">
                    {codexPrompt}
                  </p>
                  <button
                    onClick={() => handleCopy(codexPrompt)}
                    className="absolute top-2 right-2 text-muted-foreground hover:text-foreground transition-colors"
                    title="Copy prompt"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Paste this into Codex after linking your repository. Codex only has access to your
                  project repo — no MustaFlow platform credentials are shared.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GithubTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [changingRepo, setChangingRepo] = useState(false);
  const [oauthBanner, setOauthBanner] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const { data, isLoading, refetch } = useGetGithubStatus(projectId, {
    query: { queryKey: getGetGithubStatusQueryKey(projectId) },
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: getGetGithubStatusQueryKey(projectId) });
    await refetch();
  }, [queryClient, projectId, refetch]);

  // Read GitHub OAuth callback params (?github=connected|error&reason=...) and
  // turn them into a banner, then strip them from the URL so a refresh doesn't
  // re-show the message.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const github = params.get("github");
    if (!github) return;
    if (github === "connected") {
      setOauthBanner({ kind: "success", message: "GitHub connected. Select a repository below." });
      void invalidate();
    } else if (github === "error") {
      setOauthBanner({
        kind: "error",
        message: params.get("reason") ?? "GitHub OAuth failed. Please try again.",
      });
    }
    params.delete("github");
    params.delete("reason");
    params.delete("tab");
    const qs = params.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState({}, "", url);
  }, [invalidate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-xs text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading GitHub status…
      </div>
    );
  }

  const connected = data?.connected ?? false;
  const connection = data?.connection;

  if (!connected) {
    return (
      <ConnectPanel
        projectId={projectId}
        onConnected={() => void invalidate()}
        oauthBanner={oauthBanner}
      />
    );
  }

  const banner = oauthBanner && (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs mb-3",
        oauthBanner.kind === "success"
          ? "bg-green-500/10 border-green-500/20 text-green-400"
          : "bg-destructive/10 border-destructive/20 text-destructive",
      )}
    >
      {oauthBanner.kind === "success" ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      ) : (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      )}
      <span>{oauthBanner.message}</span>
    </div>
  );

  if (!connection?.repositoryName || changingRepo) {
    return (
      <>
        {banner}
        <RepoSelector
          projectId={projectId}
          connection={connection!}
          onSelected={() => {
            setChangingRepo(false);
            void invalidate();
          }}
        />
      </>
    );
  }

  return (
    <>
      {banner}
      <ConnectedPanel
        projectId={projectId}
        connection={connection}
        onDisconnect={() => void invalidate()}
        onChangeRepo={() => setChangingRepo(true)}
      />
    </>
  );
}
