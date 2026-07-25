/**
 * Ora repo read tools — the ONLY operations Ora can perform on a repo.
 *
 * list_files / read_file / search_repo / read_commits / diff. Source reads
 * use lazy read-only GitHub blobs by default and a sandboxed disk fallback;
 * history and diffs use read-only GitHub REST GETs. There is deliberately
 * no write / commit / push / mutate tool in this module or anywhere else
 * in Ora's namespace — read-only is enforced by construction.
 */
import { promises as fs } from "node:fs";
import {
  fetchCommitDiff,
  fetchRepoCommits,
  OraGithubApiError,
  type OraRepoCommit,
} from "./repo-github-auth";
import {
  REPO_WORKSPACE_LIMITS,
  RepoWorkspaceReadError,
  resolveWorkspacePath,
  type RepoWorkspace,
  type RepoWorkspaceFile,
} from "./repo-workspace";

export const REPO_TOOL_LIMITS = {
  maxListEntries: 400,
  maxReadLines: 400,
  maxReadChars: 30_000,
  maxSearchResults: 60,
  maxSearchFileBytes: 400_000,
  searchFetchConcurrency: 6,
  maxQueryLength: 200,
} as const;

/** The full tool surface. Read-only by construction — nothing else exists. */
export const REPO_READ_TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_repo",
  "read_commits",
  "diff",
] as const;
export type RepoReadToolName = (typeof REPO_READ_TOOL_NAMES)[number];

export interface RepoToolResult {
  ok: boolean;
  content: string;
}

async function readWorkspaceText(ws: RepoWorkspace, filePath: string): Promise<string> {
  const known = ws.files.find((file) => file.path === filePath);
  if (!known) throw new Error("file is not present in the readable repository index");
  if (ws.readTextFile) return ws.readTextFile(known);
  const abs = resolveWorkspacePath(ws.root, filePath);
  if (!abs) throw new Error("invalid repository path");
  return fs.readFile(abs, "utf8");
}

// ── list_files ───────────────────────────────────────────────────────────────

export function listFiles(ws: RepoWorkspace, dirPath: string): RepoToolResult {
  const prefix = dirPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (prefix.includes("..")) return { ok: false, content: "Invalid path." };
  const matches = ws.files.filter(
    (f) => prefix === "" || f.path === prefix || f.path.startsWith(prefix + "/"),
  );
  if (matches.length === 0) {
    return { ok: false, content: `No files under "${prefix || "/"}".` };
  }
  // Collapse to direct children of the prefix: files stay files, deeper
  // paths collapse to their first-level directory.
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const f of matches) {
    const rest = prefix === "" ? f.path : f.path.slice(prefix.length + 1);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(`${rest} (${f.bytes} B)`);
    else dirs.add(rest.slice(0, slash) + "/");
  }
  const lines = [...Array.from(dirs).sort(), ...files.sort()];
  const truncated = lines.length > REPO_TOOL_LIMITS.maxListEntries;
  const shown = lines.slice(0, REPO_TOOL_LIMITS.maxListEntries);
  return {
    ok: true,
    content:
      `${prefix || "."} — ${dirs.size} dirs, ${files.length} files` +
      (ws.truncated ? " (repo index truncated by size caps)" : "") +
      `\n${shown.join("\n")}` +
      (truncated ? `\n… [list truncated at ${REPO_TOOL_LIMITS.maxListEntries} entries]` : ""),
  };
}

// ── read_file ────────────────────────────────────────────────────────────────

export async function readFile(
  ws: RepoWorkspace,
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<RepoToolResult> {
  const rel = filePath.replace(/^\/+/, "");
  const known = ws.files.find((f) => f.path === rel);
  if (!known) return { ok: false, content: `File not found in repo index: "${rel}".` };
  let raw: string;
  try {
    raw = await readWorkspaceText(ws, rel);
  } catch (error) {
    return {
      ok: false,
      content:
        error instanceof RepoWorkspaceReadError
          ? error.safeReason
          : `Could not read "${rel}". No code from that file was analyzed.`,
    };
  }
  const allLines = raw.split("\n");
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(
    allLines.length,
    endLine ?? from + REPO_TOOL_LIMITS.maxReadLines - 1,
    from + REPO_TOOL_LIMITS.maxReadLines - 1,
  );
  const numbered = allLines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}\t${line}`)
    .join("\n");
  const clipped =
    numbered.length > REPO_TOOL_LIMITS.maxReadChars
      ? `${numbered.slice(0, REPO_TOOL_LIMITS.maxReadChars)}\n… [truncated]`
      : numbered;
  const suffix = to < allLines.length ? `\n… [file continues to line ${allLines.length}]` : "";
  return {
    ok: true,
    content: `${rel} (lines ${from}-${to} of ${allLines.length}):\n${clipped}${suffix}`,
  };
}

// ── search_repo ──────────────────────────────────────────────────────────────

export async function searchRepo(ws: RepoWorkspace, query: string): Promise<RepoToolResult> {
  const q = query.trim().slice(0, REPO_TOOL_LIMITS.maxQueryLength);
  if (q.length < 2) return { ok: false, content: "Search query too short." };
  const needle = q.toLowerCase();
  const results: string[] = [];
  const plan = ws.planSearch
    ? await ws.planSearch(q)
    : { primaryPaths: ws.files.map((file) => file.path), fallbackPaths: [] };
  const filesByPath = new Map(ws.files.map((file) => [file.path, file]));
  let successfullyRead = 0;
  let fetchedBytes = 0;

  const scan = async (paths: string[], stopAfterMatchingBatch: boolean): Promise<void> => {
    for (let offset = 0; offset < paths.length; ) {
      const batch: RepoWorkspaceFile[] = [];
      while (offset < paths.length && batch.length < REPO_TOOL_LIMITS.searchFetchConcurrency) {
        const file = filesByPath.get(paths[offset++]!);
        if (!file || file.bytes > REPO_TOOL_LIMITS.maxSearchFileBytes) continue;
        const queuedBytes = batch.reduce((sum, candidate) => sum + candidate.bytes, 0);
        if (
          ws.source === "github_api" &&
          fetchedBytes + queuedBytes + file.bytes > REPO_WORKSPACE_LIMITS.maxFallbackSearchBytes
        ) {
          continue;
        }
        batch.push(file);
      }
      if (batch.length === 0) continue;

      const beforeBatch = results.length;
      const reads = await Promise.all(
        batch.map(async (file) => {
          try {
            return { file, raw: await readWorkspaceText(ws, file.path) };
          } catch {
            return { file, raw: null };
          }
        }),
      );
      for (const { file, raw } of reads) {
        if (raw === null) continue;
        successfullyRead++;
        fetchedBytes += file.bytes;
        if (!raw.toLowerCase().includes(needle)) continue;
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.toLowerCase().includes(needle)) {
            results.push(`${file.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (results.length >= REPO_TOOL_LIMITS.maxSearchResults) break;
          }
        }
        if (results.length >= REPO_TOOL_LIMITS.maxSearchResults) break;
      }
      if (results.length >= REPO_TOOL_LIMITS.maxSearchResults) break;
      if (stopAfterMatchingBatch && results.length > beforeBatch) break;
    }
  };

  await scan(plan.primaryPaths, false);
  if (results.length === 0 && plan.fallbackPaths.length > 0) {
    await scan(plan.fallbackPaths, true);
  }

  if (results.length === 0 && successfullyRead === 0) {
    return {
      ok: false,
      content:
        `${plan.note ? `${plan.note} ` : ""}` +
        "No candidate source file could be read, so no repository code was analyzed.",
    };
  }
  if (results.length === 0) {
    return {
      ok: true,
      content: `${plan.note ? `${plan.note} ` : ""}No matches for "${q}".`,
    };
  }
  const capped = results.length >= REPO_TOOL_LIMITS.maxSearchResults;
  return {
    ok: true,
    content:
      `${results.length} match(es) for "${q}":\n${results.join("\n")}` +
      (capped ? `\n… [results capped at ${REPO_TOOL_LIMITS.maxSearchResults}]` : ""),
  };
}

// ── read_commits / diff (read-only GitHub REST) ──────────────────────────────

export async function readCommits(
  token: string,
  owner: string,
  repo: string,
  limit: number,
): Promise<RepoToolResult> {
  let commits: OraRepoCommit[];
  try {
    commits = await fetchRepoCommits(token, owner, repo, limit);
  } catch (err) {
    return {
      ok: false,
      content:
        err instanceof OraGithubApiError && err.rateLimited
          ? "The GitHub API rate limit was reached, so recent commits were not read. Retry shortly."
          : "Recent commits could not be read from the connected repository.",
    };
  }
  if (commits.length === 0) return { ok: true, content: "No commits found." };
  return {
    ok: true,
    content: commits.map((c) => `${c.sha} ${c.date} ${c.author}: ${c.message}`).join("\n"),
  };
}

export async function diffCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<RepoToolResult> {
  try {
    const diff = await fetchCommitDiff(token, owner, repo, sha);
    return { ok: true, content: diff || "(empty diff)" };
  } catch (err) {
    return {
      ok: false,
      content:
        err instanceof OraGithubApiError && err.rateLimited
          ? "The GitHub API rate limit was reached, so the diff was not read. Retry shortly."
          : "The requested diff could not be read from the connected repository.",
    };
  }
}
