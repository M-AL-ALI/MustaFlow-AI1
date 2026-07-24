/**
 * Ora repo read tools — the ONLY operations Ora can perform on a repo.
 *
 * list_files / read_file / search_repo / read_commits / diff. All disk
 * access goes through the sandboxed workspace with path-traversal guards;
 * history and diffs use read-only GitHub REST GETs. There is deliberately
 * no write / commit / push / mutate tool in this module or anywhere else
 * in Ora's namespace — read-only is enforced by construction.
 */
import { promises as fs } from "node:fs";
import { fetchCommitDiff, fetchRepoCommits, type OraRepoCommit } from "./repo-github-auth";
import { resolveWorkspacePath, type RepoWorkspace } from "./repo-workspace";

export const REPO_TOOL_LIMITS = {
  maxListEntries: 400,
  maxReadLines: 400,
  maxReadChars: 30_000,
  maxSearchResults: 60,
  maxSearchFileBytes: 400_000,
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
  const abs = resolveWorkspacePath(ws.root, rel);
  if (!abs) return { ok: false, content: "Invalid path." };
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return { ok: false, content: `Could not read "${rel}".` };
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
  for (const f of ws.files) {
    if (f.bytes > REPO_TOOL_LIMITS.maxSearchFileBytes) continue;
    const abs = resolveWorkspacePath(ws.root, f.path);
    if (!abs) continue;
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (!raw.toLowerCase().includes(needle)) continue;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.toLowerCase().includes(needle)) {
        results.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (results.length >= REPO_TOOL_LIMITS.maxSearchResults) break;
      }
    }
    if (results.length >= REPO_TOOL_LIMITS.maxSearchResults) break;
  }
  if (results.length === 0) return { ok: true, content: `No matches for "${q}".` };
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
    return { ok: false, content: `Could not fetch commits: ${(err as Error).message}` };
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
    return { ok: false, content: `Could not fetch diff: ${(err as Error).message}` };
  }
}
