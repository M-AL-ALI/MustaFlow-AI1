/**
 * Ora GitHub repo analysis UI — connect-aware repo picker + active-repo chip.
 *
 * Read-only: selecting a repo creates a server-side analysis session; Ora
 * can then read/search the repo and narrate its work in chat. Nothing here
 * (or anywhere in Ora) can write to GitHub.
 */
import { useCallback, useEffect, useState } from "react";
import { Github, Loader2, Lock, X } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";

export interface OraRepoSession {
  id: number;
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  branchSha: string | null;
}

export interface OraGithubStatus {
  available: boolean;
  connected: boolean;
  healthy: boolean;
  login: string | null;
  tokenHealth: string;
  detail: string | null;
  retryable: boolean;
  reconnectRequired: boolean;
  checkedAt?: string;
}

export interface OraGithubRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
}

interface OraGithubErrorPayload {
  error?: string;
  detail?: string;
}

async function githubErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as OraGithubErrorPayload;
    return data.detail || data.error || fallback;
  } catch {
    return fallback;
  }
}

function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 10) : null;
}

export function useOraRepoSession(isSignedIn: boolean) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [githubStatus, setGithubStatus] = useState<OraGithubStatus | null>(null);
  const [repoSession, setRepoSession] = useState<OraRepoSession | null>(null);

  const refresh = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const [statusRes, sessionRes] = await Promise.all([
        authFetch("/api/ora/github/status"),
        authFetch("/api/ora/github/repo-session"),
      ]);
      if (statusRes.ok) {
        const status = (await statusRes.json()) as OraGithubStatus;
        setGithubStatus(status);
        setConnected(status.available && status.connected && status.healthy);
      }
      if (sessionRes.ok) {
        const data = (await sessionRes.json()) as { session: OraRepoSession | null };
        setRepoSession(data.session);
      }
    } catch {
      // Non-fatal — the picker simply behaves as not-connected.
    }
  }, [isSignedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectRepo = useCallback(
    async (owner: string, repo: string, conversationId?: string | null) => {
      const res = await authFetch("/api/ora/github/repo-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, conversationId: conversationId ?? null }),
      });
      if (!res.ok) throw new Error(await githubErrorMessage(res, "Could not select repository"));
      const data = (await res.json()) as { session: OraRepoSession };
      setRepoSession(data.session);
      return data.session;
    },
    [],
  );

  const detachRepo = useCallback(async () => {
    const current = repoSession;
    setRepoSession(null);
    if (current) {
      await authFetch(`/api/ora/github/repo-session/${current.id}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
  }, [repoSession]);

  return { connected, githubStatus, repoSession, refresh, selectRepo, detachRepo };
}

export function OraRepoChip({
  session,
  onDetach,
}: {
  session: OraRepoSession;
  onDetach: () => void;
}) {
  return (
    <div
      data-testid="ora-repo-chip"
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs"
    >
      <Github className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ora-accent-hsl))]" />
      <span className="font-medium">Analyzing: {session.fullName}</span>
      <span className="text-muted-foreground/60">read-only</span>
      {shortSha(session.branchSha) && (
        <span className="text-muted-foreground/60">
          {session.defaultBranch} @ {shortSha(session.branchSha)}
        </span>
      )}
      <button
        type="button"
        aria-label="Stop analyzing this repository"
        onClick={onDetach}
        className="ml-0.5 rounded-full p-0.5 hover:bg-muted transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function OraRepoPickerDialog({
  open,
  onClose,
  onSelect,
  connected,
  githubStatus,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (owner: string, repo: string) => Promise<void>;
  connected: boolean | null;
  githubStatus?: OraGithubStatus | null;
}) {
  const [repos, setRepos] = useState<OraGithubRepo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRepos = useCallback(() => {
    if (!open || connected !== true) return;
    setLoading(true);
    setError(null);
    authFetch("/api/ora/github/repos")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            await githubErrorMessage(res, "Could not load your repositories from GitHub."),
          );
        }
        const data = (await res.json()) as { repos: OraGithubRepo[] };
        setRepos(data.repos);
      })
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Could not load your repositories from GitHub.",
        ),
      )
      .finally(() => setLoading(false));
  }, [open, connected]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  if (!open) return null;

  const filtered = (repos ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-label="Choose a repository to analyze"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Github className="h-4 w-4" /> Analyze a GitHub repository
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          {connected === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking GitHub connection...
            </div>
          ) : connected === false ? (
            <div className="space-y-3 text-sm">
              {githubStatus?.connected && githubStatus.healthy === false && (
                <div className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <p className="font-medium text-red-300">GitHub needs to be reconnected.</p>
                  <p className="text-muted-foreground">
                    {githubStatus.detail ?? "Ora could not verify the saved GitHub authorization."}
                  </p>
                </div>
              )}
              <p>Connect your GitHub account first — it takes two clicks.</p>
              <a
                href="/ora/settings"
                className="inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--ora-accent-hsl))] px-3 py-2 text-xs font-semibold text-black"
              >
                <Github className="h-3.5 w-3.5" /> Connect GitHub in Settings
              </a>
              <p className="text-xs text-muted-foreground">
                Ora only reads your code. It can never commit, push, or change anything.
              </p>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter repositories…"
                className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--ora-accent-hsl))]"
              />
              {loading && (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading your repositories…
                </div>
              )}
              {error && (
                <div className="space-y-3 py-4">
                  <p className="text-sm text-red-400">{error}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={loadRepos}
                      disabled={loading}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted/60 disabled:opacity-50"
                    >
                      <Loader2 className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Retry
                    </button>
                    <a
                      href="/ora/settings"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/80"
                    >
                      <Github className="h-3.5 w-3.5" /> GitHub Settings
                    </a>
                  </div>
                </div>
              )}
              {!loading && !error && (
                <ul className="max-h-72 space-y-0.5 overflow-y-auto" data-testid="ora-repo-list">
                  {filtered.map((r) => (
                    <li key={r.fullName}>
                      <button
                        type="button"
                        disabled={selecting !== null}
                        onClick={() => {
                          setSelecting(r.fullName);
                          setError(null);
                          onSelect(r.owner, r.name)
                            .then(onClose)
                            .catch((err) =>
                              setError(
                                err instanceof Error
                                  ? err.message
                                  : "Could not open that repository.",
                              ),
                            )
                            .finally(() => setSelecting(null));
                        }}
                        className={cn(
                          "w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors",
                          selecting === r.fullName && "opacity-60",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          {selecting === r.fullName ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                          ) : (
                            <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate font-medium">{r.fullName}</span>
                          {r.private && (
                            <Lock className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                          )}
                        </span>
                        {r.description && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {r.description}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                  {filtered.length === 0 && (
                    <li className="py-4 text-center text-sm text-muted-foreground">
                      No repositories match.
                    </li>
                  )}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Read-only analysis. Ora reads and explains — it never writes to your repo.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
