/**
 * Orax Desktop — Phase 3B/3C Git workflow helper.
 *
 * Prepares a branch, commits approved patch files, pushes to the remote,
 * and optionally creates a real GitHub pull request via the GitHub REST API.
 * All git operations use spawn() with a fixed argument array — no shell
 * execution, no eval, no wildcards, no hard-resets, no working-tree wipes,
 * no force-push.
 *
 * Token handling: tokens are always run through redactToken() before
 * appearing in any warning, error, or log output. Tokens are never
 * included in the return value of prepareProjectPr().
 */

import path from "node:path";
import https from "node:https";
import { spawn } from "node:child_process";

// ── Token redaction ───────────────────────────────────────────────────────────

export function redactToken(msg: string, token: string): string {
  if (!token || token.length < 8) return msg;
  return msg.split(token).join("[REDACTED]");
}

// ── Spawn helper ──────────────────────────────────────────────────────────────

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, shell: false, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => resolve({ stdout, stderr: err.message, code: 1 }));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

// ── Branch name builder ───────────────────────────────────────────────────────

/**
 * Returns a branch name safe for git: orax/<shortThreadId8>/<slug>
 * Only alphanumeric, hyphen, and underscore characters are kept in slug.
 */
export function buildBranchName(shortThreadId: string, slug: string): string {
  const safeId = shortThreadId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "");
  const safeSlug = slug
    .slice(0, 32)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `orax/${safeId}/${safeSlug || "patch"}`;
}

// ── Repo validation ───────────────────────────────────────────────────────────

export interface GitRepoInfo {
  isRepo: boolean;
  currentBranch: string | null;
  hasRemote: boolean;
  remoteUrl: string | null;
  warnings: string[];
}

export async function validateGitRepo(dir: string): Promise<GitRepoInfo> {
  const warnings: string[] = [];

  const revParse = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (revParse.code !== 0) {
    return {
      isRepo: false,
      currentBranch: null,
      hasRemote: false,
      remoteUrl: null,
      warnings: ["Not a git repository"],
    };
  }

  const branchRes = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
  if (currentBranch === "HEAD") warnings.push("Repository is in detached HEAD state");

  const remoteUrl = await getGitRemoteUrl(dir);
  const hasRemote = remoteUrl !== null;
  if (!hasRemote) warnings.push("No remote named 'origin' configured");

  return { isRepo: true, currentBranch, hasRemote, remoteUrl, warnings };
}

// ── Remote URL ────────────────────────────────────────────────────────────────

export async function getGitRemoteUrl(dir: string): Promise<string | null> {
  const res = await runGit(dir, ["remote", "get-url", "origin"]);
  if (res.code !== 0) return null;
  return res.stdout.trim() || null;
}

// ── GitHub remote parsing ─────────────────────────────────────────────────────

export interface GitHubRemote {
  owner: string;
  repo: string;
}

/**
 * Parses a git remote URL and returns the GitHub owner and repo name.
 * Supports HTTPS and SSH remote formats. Returns null if not a GitHub remote.
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  const httpsMatch = remoteUrl.match(
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return null;
}

// ── GitHub browser PR URL (fallback when API is unavailable) ──────────────────

function derivePrBrowserUrl(owner: string, repo: string, branchName: string): string {
  return `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(branchName)}?expand=1`;
}

// ── GitHub API PR creation ────────────────────────────────────────────────────

interface GhPrCreated {
  url: string;
  number: number;
}

/**
 * Creates a GitHub pull request via the REST API.
 * The token is never logged — callers must pass a redacted copy for errors.
 */
function createGitHubPr(opts: {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  token: string;
}): Promise<GhPrCreated> {
  return new Promise((resolve, reject) => {
    const { owner, repo, base, head, title, body, token } = opts;
    const reqBody = JSON.stringify({ title, body, head, base });
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${owner}/${repo}/pulls`,
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(reqBody),
          "User-Agent": "Orax-Desktop/1.0",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status === 201) {
            try {
              const parsed = JSON.parse(data) as { html_url: string; number: number };
              resolve({ url: parsed.html_url, number: parsed.number });
            } catch {
              reject(new Error("GitHub API returned invalid JSON for the created PR"));
            }
          } else if (status === 422) {
            try {
              const parsed = JSON.parse(data) as {
                errors?: Array<{ message?: string }>;
                message?: string;
              };
              const alreadyExists = parsed.errors?.some((e) =>
                /already exists/i.test(e.message ?? ""),
              );
              if (alreadyExists) {
                reject(new Error("A pull request already exists for this branch"));
              } else {
                reject(
                  new Error(`GitHub validation error: ${parsed.message ?? data.slice(0, 120)}`),
                );
              }
            } catch {
              reject(new Error("GitHub API 422 validation error"));
            }
          } else {
            reject(new Error(`GitHub API error (status ${status})`));
          }
        });
      },
    );
    req.on("error", (err: Error) => {
      reject(new Error(`GitHub API request failed: ${err.message}`));
    });
    req.write(reqBody);
    req.end();
  });
}

// ── Blocker types ─────────────────────────────────────────────────────────────

export type PrBlockerType =
  | "no_git_repo"
  | "no_github_remote"
  | "push_failed"
  | "api_create_failed";

// ── Main prepare function ─────────────────────────────────────────────────────

export interface PrepareProjectPrOptions {
  /** Absolute path to the local project directory. */
  projectDir: string;
  /** Thread ID — first 8 chars used in branch name. */
  threadId: string;
  /** Short URL-safe slug derived from the project name. */
  projectSlug: string;
  /** Relative file paths changed by the approved patch. */
  changedFiles: string[];
  /** Commit message body. */
  commitMessage: string;
  /** Optional PR title (defaults to first line of commitMessage). */
  prTitle?: string;
  /** Optional PR body (defaults to commitMessage). */
  prBody?: string;
  /** Override for the base branch (defaults to current branch before switching). */
  baseBranch?: string;
  /** Optional GitHub personal access token — if omitted, reads from env. */
  githubToken?: string;
}

export interface PrepareProjectPrResult {
  branchName: string;
  baseBranch: string | null;
  commitSha: string;
  changedFiles: string[];
  repoOwner: string | null;
  repoName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  blockerType: PrBlockerType | null;
  blockerReason: string | null;
  warnings: string[];
  durationMs: number;
}

export async function prepareProjectPr(
  opts: PrepareProjectPrOptions,
): Promise<PrepareProjectPrResult> {
  const startMs = Date.now();
  const warnings: string[] = [];
  const {
    projectDir,
    threadId,
    projectSlug,
    changedFiles,
    commitMessage,
    prTitle,
    prBody,
    githubToken,
  } = opts;

  // Resolve token from arg or environment — never log it
  const token: string | null =
    githubToken ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? null;

  // ── Validate repo ──────────────────────────────────────────────────────────
  const repoInfo = await validateGitRepo(projectDir);
  if (!repoInfo.isRepo) {
    return {
      branchName: buildBranchName(threadId, projectSlug),
      baseBranch: null,
      commitSha: "",
      changedFiles: [],
      repoOwner: null,
      repoName: null,
      prUrl: null,
      prNumber: null,
      blockerType: "no_git_repo",
      blockerReason: "Project directory is not a git repository.",
      warnings: ["Not a git repository"],
      durationMs: Date.now() - startMs,
    };
  }
  if (repoInfo.warnings.length > 0) warnings.push(...repoInfo.warnings);

  // ── Detect GitHub remote ───────────────────────────────────────────────────
  const remoteUrl = repoInfo.remoteUrl;
  const ghRemote = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  if (!ghRemote) {
    return {
      branchName: buildBranchName(threadId, projectSlug),
      baseBranch: repoInfo.currentBranch,
      commitSha: "",
      changedFiles: [],
      repoOwner: null,
      repoName: null,
      prUrl: null,
      prNumber: null,
      blockerType: "no_github_remote",
      blockerReason: remoteUrl
        ? "The origin remote is not a GitHub repository. Only GitHub remotes are supported for pull requests."
        : "No git remote configured. Add a GitHub remote to use pull requests.",
      warnings,
      durationMs: Date.now() - startMs,
    };
  }

  const { owner, repo } = ghRemote;
  const baseBranch = opts.baseBranch ?? repoInfo.currentBranch ?? "main";

  // ── Build branch name ──────────────────────────────────────────────────────
  const branchName = buildBranchName(threadId, projectSlug);

  // ── Create or switch to orax branch (no hard-resets, no working-tree wipes) ─
  const checkBranch = await runGit(projectDir, ["rev-parse", "--verify", branchName]);
  if (checkBranch.code === 0) {
    const switchRes = await runGit(projectDir, ["switch", branchName]);
    if (switchRes.code !== 0) {
      throw new Error(
        `Could not switch to branch ${branchName}: ${switchRes.stderr.slice(0, 200)}`,
      );
    }
  } else {
    const createRes = await runGit(projectDir, ["switch", "-c", branchName]);
    if (createRes.code !== 0) {
      throw new Error(`Could not create branch ${branchName}: ${createRes.stderr.slice(0, 200)}`);
    }
  }

  // ── Stage only the specifically changed files — no wildcards ───────────────
  const stagedFiles: string[] = [];
  for (const relPath of changedFiles) {
    const abs = path.resolve(projectDir, relPath);
    if (!abs.startsWith(projectDir + path.sep) && abs !== projectDir) {
      warnings.push(`Skipped out-of-tree path: ${relPath}`);
      continue;
    }
    const addRes = await runGit(projectDir, ["add", "--", relPath]);
    if (addRes.code !== 0) {
      warnings.push(`Could not stage ${relPath}: ${addRes.stderr.trim().slice(0, 120)}`);
    } else {
      stagedFiles.push(relPath);
    }
  }

  if (stagedFiles.length === 0) {
    throw new Error("No changed files could be staged for commit");
  }

  // ── Commit ─────────────────────────────────────────────────────────────────
  const safeMessage = commitMessage.slice(0, 4000);
  const commitRes = await runGit(projectDir, ["commit", "-m", safeMessage]);
  if (commitRes.code !== 0) {
    const combined = commitRes.stdout + commitRes.stderr;
    if (/nothing to commit|nothing added/.test(combined)) {
      warnings.push("No new changes to commit — working tree already clean after staging");
    } else {
      throw new Error(`Commit failed: ${commitRes.stderr.slice(0, 300)}`);
    }
  }

  // ── Resolve commit SHA ─────────────────────────────────────────────────────
  const shaRes = await runGit(projectDir, ["rev-parse", "HEAD"]);
  const commitSha = shaRes.stdout.trim();

  // ── Push without force ─────────────────────────────────────────────────────
  let pushSucceeded = false;
  let blockerType: PrBlockerType | null = null;
  let blockerReason: string | null = null;

  if (token) {
    // Inject token via credential URL — no shell evaluation required
    // remoteUrl is non-null here: ghRemote being non-null proves the ternary took the truthy branch
    const credUrl = (remoteUrl as string).replace(
      /^https:\/\//,
      `https://x-access-token:${token}@`,
    );
    const pushRes = await runGit(projectDir, ["push", credUrl, `${branchName}:${branchName}`]);
    if (pushRes.code !== 0) {
      const redacted = redactToken(pushRes.stderr.slice(0, 200), token);
      warnings.push(`Push with token failed: ${redacted}`);
      blockerType = "push_failed";
      blockerReason = `Could not push to GitHub. Check that your token has write access to ${owner}/${repo}.`;
    } else {
      pushSucceeded = true;
    }
  } else {
    const pushRes = await runGit(projectDir, ["push", "origin", branchName]);
    if (pushRes.code !== 0) {
      const safeErr = pushRes.stderr.slice(0, 200);
      warnings.push(`Push failed (may need authentication): ${safeErr}`);
      blockerType = "push_failed";
      blockerReason = `Could not push to GitHub. Set GITHUB_TOKEN on your desktop machine to authenticate, or configure git credentials for ${owner}/${repo}.`;
    } else {
      pushSucceeded = true;
    }
  }

  if (!pushSucceeded) {
    return {
      branchName,
      baseBranch,
      commitSha,
      changedFiles: stagedFiles,
      repoOwner: owner,
      repoName: repo,
      prUrl: null,
      prNumber: null,
      blockerType,
      blockerReason,
      warnings,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Attempt GitHub API PR creation ─────────────────────────────────────────
  let prUrl: string | null = derivePrBrowserUrl(owner, repo, branchName);
  let prNumber: number | null = null;

  if (token) {
    const title = (prTitle ?? commitMessage.split("\n")[0] ?? "Orax patch").slice(0, 256);
    const body = prBody ?? commitMessage;
    try {
      const created = await createGitHubPr({
        owner,
        repo,
        base: baseBranch,
        head: branchName,
        title,
        body,
        token,
      });
      prUrl = created.url;
      prNumber = created.number;
    } catch (apiErr) {
      const errMsg = apiErr instanceof Error ? apiErr.message : "Unknown error";
      const safeMsg = token ? redactToken(errMsg, token) : errMsg;
      warnings.push(`GitHub API PR creation failed: ${safeMsg}`);
      blockerType = "api_create_failed";
      blockerReason = `Branch was pushed but PR creation failed: ${safeMsg}. Use the link below to open a PR manually.`;
      // prUrl stays as the derived browser URL fallback
    }
  } else {
    warnings.push("No GITHUB_TOKEN found — branch pushed, PR link is a browser URL only.");
  }

  return {
    branchName,
    baseBranch,
    commitSha,
    changedFiles: stagedFiles,
    repoOwner: owner,
    repoName: repo,
    prUrl,
    prNumber,
    blockerType,
    blockerReason,
    warnings,
    durationMs: Date.now() - startMs,
  };
}
