/**
 * Orax Desktop — Phase 3B Git workflow helper.
 *
 * Prepares a branch and commit from approved patch files on the local
 * desktop machine and pushes it to the remote.  All git operations use
 * spawn() with a fixed argument array — no shell execution, no eval,
 * no wildcards, no hard-resets, no working-tree wipes, no force-push.
 *
 * The caller (relay-client.ts) must ensure the patch has already been
 * applied (apply_project_patch) and verified (verify_project_patch)
 * before invoking prepareProjectPr().
 */

import path from "node:path";
import { spawn } from "node:child_process";

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

  if (currentBranch === "HEAD") {
    warnings.push("Repository is in detached HEAD state");
  }

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

// ── GitHub PR URL derivation ──────────────────────────────────────────────────

function deriveGitHubPrUrl(remoteUrl: string, branchName: string): string | null {
  let repo: string | null = null;

  const httpsMatch = remoteUrl.match(
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) repo = httpsMatch[1];

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!repo && sshMatch) repo = sshMatch[1];

  if (!repo) return null;
  return `https://github.com/${repo}/compare/${encodeURIComponent(branchName)}?expand=1`;
}

// ── Main prepare function ─────────────────────────────────────────────────────

export interface PrepareProjectPrOptions {
  /** Absolute path to the local project directory. */
  projectDir: string;
  /** Thread ID — first 8 chars used in branch name. */
  threadId: string;
  /** Short URL-safe slug derived from the project name. */
  projectSlug: string;
  /** Relative file paths that were changed by the approved patch. */
  changedFiles: string[];
  /** Commit message body. */
  commitMessage: string;
  /** Optional GitHub personal access token for authenticated push. */
  githubToken?: string;
}

export interface PrepareProjectPrResult {
  branchName: string;
  commitSha: string;
  changedFiles: string[];
  prUrl: string | null;
  warnings: string[];
  durationMs: number;
}

export async function prepareProjectPr(
  opts: PrepareProjectPrOptions,
): Promise<PrepareProjectPrResult> {
  const startMs = Date.now();
  const warnings: string[] = [];
  const { projectDir, threadId, projectSlug, changedFiles, commitMessage, githubToken } = opts;

  // Validate repo — exits early if not a git repository
  const repoInfo = await validateGitRepo(projectDir);
  if (!repoInfo.isRepo) {
    throw new Error("Project directory is not a git repository");
  }
  if (repoInfo.warnings.length > 0) warnings.push(...repoInfo.warnings);

  // Build branch name
  const branchName = buildBranchName(threadId, projectSlug);

  // Create or switch to the orax branch from current HEAD (no force, no hard reset)
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
      throw new Error(
        `Could not create branch ${branchName}: ${createRes.stderr.slice(0, 200)}`,
      );
    }
  }

  // Stage only the specifically changed files — no wildcards, no git add .
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

  // Commit with a safe message (no shell interpolation)
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

  // Resolve commit SHA
  const shaRes = await runGit(projectDir, ["rev-parse", "HEAD"]);
  const commitSha = shaRes.stdout.trim();

  // Push without force
  let prUrl: string | null = null;
  const remoteUrl = repoInfo.remoteUrl;

  if (remoteUrl) {
    let pushSucceeded = false;

    if (githubToken) {
      // Inject token via credential URL — no shell evaluation required
      const credUrl = remoteUrl.replace(/^https:\/\//, `https://x-access-token:${githubToken}@`);
      const pushRes = await runGit(projectDir, ["push", credUrl, `${branchName}:${branchName}`]);
      if (pushRes.code !== 0) {
        warnings.push(`Push with token failed: ${pushRes.stderr.slice(0, 200)}`);
      } else {
        pushSucceeded = true;
      }
    } else {
      const pushRes = await runGit(projectDir, ["push", "origin", branchName]);
      if (pushRes.code !== 0) {
        warnings.push(
          `Push failed (may need authentication): ${pushRes.stderr.slice(0, 200)}`,
        );
      } else {
        pushSucceeded = true;
      }
    }

    if (pushSucceeded) {
      prUrl = deriveGitHubPrUrl(remoteUrl, branchName);
    }
  } else {
    warnings.push("No remote configured — branch committed locally only");
  }

  return {
    branchName,
    commitSha,
    changedFiles: stagedFiles,
    prUrl,
    warnings,
    durationMs: Date.now() - startMs,
  };
}
