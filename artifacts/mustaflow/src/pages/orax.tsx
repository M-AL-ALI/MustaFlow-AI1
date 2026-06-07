import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  Code2,
  FileSearch,
  FileText,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { authFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";

type OraxRepository = {
  id: number;
  provider: string;
  owner: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
  connectionStatus: string;
  githubAccountName?: string | null;
  tokenScopes?: string | null;
  connectedAt?: string | null;
  lastScanAt?: string | null;
  scanStatus?: string;
  updatedAt: string;
};

type OraxScanSummary = {
  repo?: {
    fullName?: string;
    htmlUrl?: string;
    defaultBranch?: string;
    private?: boolean;
    language?: string | null;
  };
  branch?: string;
  commitSha?: string;
  fileCount?: number;
  directoryCount?: number;
  totalBytes?: number;
  languages?: Record<string, number>;
  topLevelEntries?: Array<{ path: string; type: string }>;
  sampleFiles?: string[];
  truncated?: boolean;
};

type OraxScan = {
  id: number;
  repositoryId: number;
  status: string;
  branch: string;
  commitSha?: string | null;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  summary: OraxScanSummary;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

type OraxTask = {
  id: number;
  repositoryId: number;
  kind: string;
  status: string;
  title: string;
  prompt: string;
  plan: {
    mode?: string;
    objective?: string;
    steps?: string[];
    guardrails?: string[];
    unavailableUntilApproved?: string[];
  };
  result?: { message?: string };
  createdAt: string;
};

type OraxApproval = {
  id: number;
  repositoryId: number;
  taskId: number;
  action: string;
  status: string;
  request: {
    paths?: string[];
    branch?: string;
    reason?: string | null;
  };
  result?: {
    branch?: string;
    totalBytes?: number;
    files?: Array<{ path: string; sha: string; size: number; truncated: boolean }>;
    skipped?: Array<{ path: string; reason: string }>;
  };
  riskSummary?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  completedAt?: string | null;
};

type OraxReadResult = {
  branch: string;
  files: Array<{
    path: string;
    sha: string;
    size: number;
    content: string;
    truncated: boolean;
  }>;
  skipped: Array<{ path: string; reason: string }>;
};

type OraxCapabilities = {
  available: string[];
  lockedUntilApprovalLayer: string[];
};

const TASK_KINDS = [
  { value: "analyze", label: "Analyze" },
  { value: "plan", label: "Plan" },
  { value: "review", label: "Review" },
  { value: "fix", label: "Fix" },
] as const;

export default function OraxPage() {
  const [repositories, setRepositories] = useState<OraxRepository[]>([]);
  const [tasks, setTasks] = useState<OraxTask[]>([]);
  const [approvals, setApprovals] = useState<OraxApproval[]>([]);
  const [capabilities, setCapabilities] = useState<OraxCapabilities | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [githubToken, setGithubToken] = useState("");
  const [scans, setScans] = useState<OraxScan[]>([]);
  const [taskKind, setTaskKind] = useState<(typeof TASK_KINDS)[number]["value"]>("analyze");
  const [prompt, setPrompt] = useState("");
  const [approvalPaths, setApprovalPaths] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [readResult, setReadResult] = useState<OraxReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [scanningRepository, setScanningRepository] = useState(false);
  const [loadingScans, setLoadingScans] = useState(false);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [requestingApproval, setRequestingApproval] = useState(false);
  const [decidingApprovalId, setDecidingApprovalId] = useState<number | null>(null);
  const [readingApprovalId, setReadingApprovalId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRepository = useMemo(
    () => repositories.find((repo) => repo.id === selectedRepoId) ?? repositories[0] ?? null,
    [repositories, selectedRepoId],
  );
  const latestScan = scans[0] ?? null;
  const latestScanLanguages = Object.entries(latestScan?.summary?.languages ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [tasks, selectedTaskId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [capRes, repoRes, taskRes] = await Promise.all([
        authFetch("/api/orax/capabilities"),
        authFetch("/api/orax/repositories"),
        authFetch("/api/orax/tasks"),
      ]);
      if (!capRes.ok || !repoRes.ok || !taskRes.ok) {
        throw new Error("Could not load ORAX workspace");
      }
      const capData = (await capRes.json()) as OraxCapabilities;
      const repoData = (await repoRes.json()) as { repositories: OraxRepository[] };
      const taskData = (await taskRes.json()) as { tasks: OraxTask[] };
      setCapabilities(capData);
      setRepositories(repoData.repositories);
      setTasks(taskData.tasks);
      setSelectedRepoId((current) => current ?? repoData.repositories[0]?.id ?? null);
      setSelectedTaskId((current) => current ?? taskData.tasks[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load ORAX");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadScans = useCallback(async (repositoryId: number) => {
    setLoadingScans(true);
    try {
      const res = await authFetch(`/api/orax/repositories/${repositoryId}/scans`);
      if (!res.ok) {
        throw new Error("Could not load repository scans");
      }
      const body = (await res.json()) as { scans: OraxScan[] };
      setScans(body.scans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load repository scans");
      setScans([]);
    } finally {
      setLoadingScans(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedRepository) {
      setScans([]);
      return;
    }
    void loadScans(selectedRepository.id);
  }, [loadScans, selectedRepository]);

  const loadApprovals = useCallback(async (taskId: number) => {
    setLoadingApprovals(true);
    try {
      const res = await authFetch(`/api/orax/tasks/${taskId}/approvals`);
      if (!res.ok) {
        throw new Error("Could not load approvals");
      }
      const body = (await res.json()) as { approvals: OraxApproval[] };
      setApprovals(body.approvals);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load approvals");
      setApprovals([]);
    } finally {
      setLoadingApprovals(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedTask) {
      setApprovals([]);
      setReadResult(null);
      return;
    }
    setReadResult(null);
    void loadApprovals(selectedTask.id);
  }, [loadApprovals, selectedTask]);

  async function addRepository() {
    if (!repositoryUrl.trim() || submittingRepo) return;
    setSubmittingRepo(true);
    setError(null);
    try {
      const res = await authFetch("/api/orax/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl, defaultBranch }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save repository");
      }
      const body = (await res.json()) as { repository: OraxRepository };
      setRepositories((prev) => [body.repository, ...prev]);
      setSelectedRepoId(body.repository.id);
      setRepositoryUrl("");
      setDefaultBranch("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function connectGithub() {
    if (!selectedRepository || !githubToken.trim() || connectingGithub) return;
    setConnectingGithub(true);
    setError(null);
    try {
      const res = await authFetch(
        `/api/orax/repositories/${selectedRepository.id}/github/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: githubToken }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not connect GitHub repository");
      }
      const body = (await res.json()) as { repository: OraxRepository };
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === body.repository.id ? body.repository : repo)),
      );
      setGithubToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect GitHub repository");
    } finally {
      setConnectingGithub(false);
    }
  }

  async function scanRepository() {
    if (!selectedRepository || scanningRepository) return;
    setScanningRepository(true);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/repositories/${selectedRepository.id}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: selectedRepository.defaultBranch }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not scan repository");
      }
      const body = (await res.json()) as { repository: OraxRepository; scan: OraxScan };
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === body.repository.id ? body.repository : repo)),
      );
      setScans((prev) => [body.scan, ...prev.filter((scan) => scan.id !== body.scan.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not scan repository");
      if (selectedRepository) {
        void loadScans(selectedRepository.id);
      }
    } finally {
      setScanningRepository(false);
    }
  }

  async function createTask() {
    if (!selectedRepository || !prompt.trim() || submittingTask) return;
    setSubmittingTask(true);
    setError(null);
    try {
      const res = await authFetch("/api/orax/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryId: selectedRepository.id,
          kind: taskKind,
          prompt,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not create ORAX task");
      }
      const body = (await res.json()) as { task: OraxTask };
      setTasks((prev) => [body.task, ...prev]);
      setSelectedTaskId(body.task.id);
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create ORAX task");
    } finally {
      setSubmittingTask(false);
    }
  }

  async function requestFileReadApproval() {
    if (!selectedTask || requestingApproval) return;
    const paths = approvalPaths
      .split(/[\n,]/)
      .map((path) => path.trim())
      .filter(Boolean);
    if (!paths.length) {
      setError("Add at least one repository-relative file path");
      return;
    }
    setRequestingApproval(true);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${selectedTask.id}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "read_files",
          paths,
          reason: approvalReason,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not request approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) => [body.approval, ...prev]);
      setApprovalPaths("");
      setApprovalReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request approval");
    } finally {
      setRequestingApproval(false);
    }
  }

  async function decideApproval(approvalId: number, decision: "approved" | "denied") {
    if (decidingApprovalId) return;
    setDecidingApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not update approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update approval");
    } finally {
      setDecidingApprovalId(null);
    }
  }

  async function readApprovedFiles(approvalId: number) {
    if (readingApprovalId) return;
    setReadingApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}/read-files`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not read approved files");
      }
      const body = (await res.json()) as OraxReadResult & { approval: OraxApproval };
      setReadResult({ branch: body.branch, files: body.files, skipped: body.skipped });
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read approved files");
    } finally {
      setReadingApprovalId(null);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/mode-select"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Back to mode select"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Code2 className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold">ORAX</h1>
              <p className="text-xs text-muted-foreground">Coding agent foundation</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Repositories</h2>
            </div>
            <div className="mt-4 space-y-2">
              <input
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                placeholder="main"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => void addRepository()}
                disabled={submittingRepo || !repositoryUrl.trim()}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submittingRepo ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitBranch className="h-4 w-4" />
                )}
                Add repository
              </button>
            </div>

            <div className="mt-4 space-y-2">
              {repositories.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                  Add a repository URL to create the first ORAX workspace target.
                </p>
              ) : (
                repositories.map((repo) => (
                  <button
                    key={repo.id}
                    onClick={() => setSelectedRepoId(repo.id)}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      selectedRepository?.id === repo.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <div className="font-medium">
                      {repo.owner}/{repo.name}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {repo.provider} - {repo.defaultBranch} - {repo.connectionStatus}
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Read-only GitHub access</h2>
            </div>
            {selectedRepository ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {selectedRepository.githubAccountName ? (
                    <>
                      Connected as{" "}
                      <span className="font-medium text-foreground">
                        {selectedRepository.githubAccountName}
                      </span>
                      {selectedRepository.tokenScopes ? (
                        <span> with scopes: {selectedRepository.tokenScopes}</span>
                      ) : null}
                    </>
                  ) : (
                    "Public repositories can scan without a token. Private repositories need a read-only GitHub token."
                  )}
                </div>
                <input
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder="GitHub token for read-only access"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={() => void connectGithub()}
                  disabled={connectingGithub || !githubToken.trim()}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {connectingGithub ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  Connect read-only token
                </button>
                <button
                  onClick={() => void scanRepository()}
                  disabled={scanningRepository}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {scanningRepository ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Scan repository
                </button>
                <div className="text-xs text-muted-foreground">
                  Last scan:{" "}
                  {selectedRepository.lastScanAt
                    ? new Date(selectedRepository.lastScanAt).toLocaleString()
                    : "Not scanned yet"}
                  {selectedRepository.scanStatus ? ` - ${selectedRepository.scanStatus}` : null}
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                Add a repository before connecting GitHub access.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Current capabilities</h2>
            </div>
            <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
              {(capabilities?.available ?? []).map((item) => (
                <li key={item} className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 rounded-md border border-yellow-500/20 bg-yellow-500/10 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-yellow-700 dark:text-yellow-400">
                <LockKeyhole className="h-3.5 w-3.5" />
                Locked until approval layer
              </div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {(capabilities?.lockedUntilApprovalLayer ?? []).map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
          </section>
        </aside>

        <section className="space-y-4">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <FileSearch className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Repository scan</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Read-only repository metadata and file-tree summary. Source editing and terminal
                  execution remain locked.
                </p>
              </div>
              {loadingScans ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            {latestScan ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Status" value={latestScan.status} />
                  <Metric label="Branch" value={latestScan.branch} />
                  <Metric
                    label="Commit"
                    value={latestScan.commitSha ? latestScan.commitSha.slice(0, 10) : "Unknown"}
                  />
                  <Metric label="Size" value={formatBytes(latestScan.totalBytes)} />
                  <Metric label="Files" value={String(latestScan.fileCount)} />
                  <Metric label="Folders" value={String(latestScan.directoryCount)} />
                  <Metric
                    label="Scanned"
                    value={new Date(latestScan.createdAt).toLocaleString()}
                    wide
                  />
                </div>

                {latestScan.error ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {latestScan.error}
                  </div>
                ) : null}

                {latestScanLanguages.length ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                      Languages
                    </h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {latestScanLanguages.map(([language, count]) => (
                        <span
                          key={language}
                          className="rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                        >
                          {language}: {count}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {latestScan.summary?.sampleFiles?.length ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                      Sample files
                    </h3>
                    <div className="mt-2 grid gap-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                      {latestScan.summary.sampleFiles.slice(0, 20).map((file) => (
                        <div key={file} className="truncate">
                          {file}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                No scans yet. Add a GitHub repository, then run a read-only scan.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Create ORAX task</h2>
                </div>
                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                  Phase 1 creates a safe coding-agent plan. Code edits, terminal execution, PRs, and
                  pushes stay locked.
                </p>
              </div>
              <div className="flex rounded-md border border-border p-1">
                {TASK_KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    onClick={() => setTaskKind(kind.value)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium",
                      taskKind === kind.value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask ORAX to inspect, plan, review, or prepare a fix for this repository..."
              className="mt-4 min-h-32 w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Target:{" "}
                {selectedRepository ? (
                  <span className="font-medium text-foreground">
                    {selectedRepository.owner}/{selectedRepository.name}
                  </span>
                ) : (
                  "Add a repository first"
                )}
              </p>
              <button
                onClick={() => void createTask()}
                disabled={!selectedRepository || !prompt.trim() || submittingTask}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submittingTask ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Create safe plan
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Approval-gated file read</h2>
                </div>
                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                  ORAX can read selected source files only after approval. It still cannot edit,
                  execute terminal commands, push branches, open PRs, or deploy.
                </p>
              </div>
              {loadingApprovals ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            {selectedTask ? (
              <div className="mt-4 space-y-4">
                <select
                  value={selectedTask.id}
                  onChange={(event) => setSelectedTaskId(Number(event.target.value))}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      #{task.id} - {task.title}
                    </option>
                  ))}
                </select>

                <textarea
                  value={approvalPaths}
                  onChange={(event) => setApprovalPaths(event.target.value)}
                  placeholder="src/main.ts&#10;package.json&#10;README.md"
                  className="min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  value={approvalReason}
                  onChange={(event) => setApprovalReason(event.target.value)}
                  placeholder="Reason for reading these files"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={() => void requestFileReadApproval()}
                  disabled={requestingApproval || !approvalPaths.trim()}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {requestingApproval ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  Request approval
                </button>

                <div className="space-y-2">
                  {approvals.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No approval requests for this task yet.
                    </p>
                  ) : (
                    approvals.map((approval) => (
                      <article
                        key={approval.id}
                        className="rounded-md border border-border bg-muted/20 px-3 py-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">
                              {approval.action} - {approval.status}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {(approval.request.paths ?? []).join(", ")}
                            </div>
                            {approval.riskSummary ? (
                              <div className="mt-2 text-xs text-muted-foreground">
                                {approval.riskSummary}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {approval.status === "pending" ? (
                              <>
                                <button
                                  onClick={() => void decideApproval(approval.id, "approved")}
                                  disabled={decidingApprovalId === approval.id}
                                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                  Approve
                                </button>
                                <button
                                  onClick={() => void decideApproval(approval.id, "denied")}
                                  disabled={decidingApprovalId === approval.id}
                                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  <X className="h-3.5 w-3.5" />
                                  Deny
                                </button>
                              </>
                            ) : null}
                            {approval.status === "approved" ? (
                              <button
                                onClick={() => void readApprovedFiles(approval.id)}
                                disabled={readingApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60"
                              >
                                {readingApprovalId === approval.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <FileSearch className="h-3.5 w-3.5" />
                                )}
                                Read files
                              </button>
                            ) : null}
                          </div>
                        </div>
                        {approval.result?.files?.length ? (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Read {approval.result.files.length} file(s),{" "}
                            {formatBytes(approval.result.totalBytes ?? 0)}
                          </div>
                        ) : null}
                      </article>
                    ))
                  )}
                </div>

                {readResult ? (
                  <div className="rounded-md border border-border bg-muted/20 p-3">
                    <div className="text-sm font-semibold">
                      Approved file read result - {readResult.branch}
                    </div>
                    {readResult.skipped.length ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Skipped:{" "}
                        {readResult.skipped
                          .map((item) => `${item.path} (${item.reason})`)
                          .join(", ")}
                      </div>
                    ) : null}
                    <div className="mt-3 space-y-3">
                      {readResult.files.map((file) => (
                        <div key={file.path} className="rounded-md border border-border bg-card">
                          <div className="border-b border-border px-3 py-2 text-xs font-medium">
                            {file.path} - {formatBytes(file.size)}
                          </div>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs text-muted-foreground">
                            {file.content}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                Create an ORAX task before requesting file-read approval.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Task history</h2>
              </div>
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>
            <div className="divide-y divide-border">
              {tasks.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground">
                  No ORAX tasks yet. Create a safe plan to start the coding-agent history.
                </p>
              ) : (
                tasks.map((task) => (
                  <article key={task.id} className="px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                          <h3 className="text-sm font-semibold">{task.title}</h3>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {task.kind} - {task.status} - {new Date(task.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                        read-only foundation
                      </span>
                    </div>
                    {task.result?.message ? (
                      <p className="mt-3 text-sm text-muted-foreground">{task.result.message}</p>
                    ) : null}
                    {task.plan?.steps?.length ? (
                      <ol className="mt-3 space-y-1 text-sm text-foreground">
                        {task.plan.steps.map((step, index) => (
                          <li key={`${task.id}-${step}`} className="flex gap-2">
                            <span className="text-xs text-muted-foreground">{index + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-muted/30 px-3 py-2",
        wide ? "sm:col-span-2" : "",
      )}
    >
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
