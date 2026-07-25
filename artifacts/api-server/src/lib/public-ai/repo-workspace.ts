/**
 * Ora repo workspace — sandboxed, read-only, ephemeral.
 *
 * The default engine indexes repository paths through GitHub's read-only tree
 * API, then fetches individual blobs only when a read tool needs them. A
 * filtered streaming tarball extractor remains as a small-repo fallback.
 * Neither path uses `git clone`, creates a .git directory, or exposes a
 * write/push channel. Session caches are bounded and swept by TTL.
 *
 * HARD BOUNDARY: this module only downloads and reads. No function here
 * mutates a repository or talks to GitHub with anything but GET.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger";
import {
  fetchRepoBlob,
  fetchRepoTree,
  OraGithubApiError,
  searchRepoCodePaths,
  tarballUrl,
  type OraRepoTreeEntry,
} from "./repo-github-auth";

export const REPO_WORKSPACE_LIMITS = {
  /** Hard cap on total source bytes retained from the fallback archive. */
  maxExtractedBytes: 120 * 1024 * 1024,
  /** Hard cap on indexed source files; extra files are dropped from the index. */
  maxFiles: 8000,
  /** Individual files larger than this are excluded before download/retention. */
  maxFileBytes: 1_500_000,
  /** Bounded lazy blob cache per repository session. */
  maxBlobCacheBytes: 12 * 1024 * 1024,
  maxBlobCacheEntries: 80,
  /** Bounded targeted scan when GitHub code search cannot answer. */
  maxFallbackSearchFiles: 80,
  maxFallbackSearchBytes: 8 * 1024 * 1024,
  /** Download + extract wall-clock timeout. */
  materializeTimeoutMs: 90_000,
  /** Workspace TTL — swept after this long without use. */
  ttlMs: 45 * 60 * 1000,
} as const;

/** Directories never worth analyzing; pruned from the index and disk. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "attached_assets",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".avif",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wav",
  ".ogg",
  ".flac",
  ".webm",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".class",
  ".jar",
  ".sqlite",
  ".db",
  ".lockb",
  ".node",
  ".pyc",
]);

export interface RepoWorkspaceFile {
  path: string;
  bytes: number;
  sha?: string;
}

export interface RepoWorkspaceSearchPlan {
  primaryPaths: string[];
  fallbackPaths: string[];
  note?: string;
}

export interface RepoWorkspace {
  root: string;
  files: RepoWorkspaceFile[];
  totalBytes: number;
  truncated: boolean;
  lastUsedAt: number;
  source?: "github_api" | "tarball";
  readTextFile?: (file: RepoWorkspaceFile) => Promise<string>;
  planSearch?: (query: string) => Promise<RepoWorkspaceSearchPlan>;
  skipped?: RepoSkippedEntry[];
}

const workspaces = new Map<string, RepoWorkspace>();
// Serialize concurrent materializations of the same session.
const inflight = new Map<string, Promise<RepoWorkspace>>();

function workspaceRootDir(): string {
  return path.join(os.tmpdir(), "ora-repo-workspaces");
}

export function workspaceKey(sessionId: number): string {
  return createHash("sha256").update(`ora-repo-session:${sessionId}`).digest("hex").slice(0, 24);
}

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isSkippedPath(relPath: string): boolean {
  return relPath.split("/").some((seg) => SKIP_DIRS.has(seg));
}

export type RepoSkipReason =
  | "skipped_directory"
  | "binary"
  | "oversized_file"
  | "retained_byte_limit"
  | "file_count_limit"
  | "unsafe_path";

export interface RepoSkippedEntry {
  path: string;
  bytes: number;
  reason: RepoSkipReason;
}

export interface FilteredRepoTree {
  files: RepoWorkspaceFile[];
  totalBytes: number;
  truncated: boolean;
  skipped: RepoSkippedEntry[];
}

function normalizedRepoPath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".."
  ) {
    return null;
  }
  return normalized;
}

function retainLargestSkips(skipped: RepoSkippedEntry[], entry: RepoSkippedEntry): void {
  skipped.push(entry);
  skipped.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  if (skipped.length > 12) skipped.length = 12;
}

/** Filters tree metadata before any blob body is downloaded. */
export function filterRepoTreeEntries(
  entries: OraRepoTreeEntry[],
  treeWasTruncated = false,
): FilteredRepoTree {
  const files: RepoWorkspaceFile[] = [];
  const skipped: RepoSkippedEntry[] = [];
  let totalBytes = 0;
  let truncated = treeWasTruncated;

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const relPath = normalizedRepoPath(entry.path);
    const bytes = Math.max(0, entry.size ?? 0);
    if (!relPath) {
      retainLargestSkips(skipped, { path: entry.path, bytes, reason: "unsafe_path" });
      continue;
    }
    if (isSkippedPath(relPath)) {
      retainLargestSkips(skipped, { path: relPath, bytes, reason: "skipped_directory" });
      continue;
    }
    if (isBinaryPath(relPath)) {
      retainLargestSkips(skipped, { path: relPath, bytes, reason: "binary" });
      continue;
    }
    if (bytes > REPO_WORKSPACE_LIMITS.maxFileBytes) {
      retainLargestSkips(skipped, { path: relPath, bytes, reason: "oversized_file" });
      continue;
    }
    if (files.length >= REPO_WORKSPACE_LIMITS.maxFiles) {
      truncated = true;
      retainLargestSkips(skipped, { path: relPath, bytes, reason: "file_count_limit" });
      continue;
    }
    files.push({ path: relPath, bytes, sha: entry.sha });
    totalBytes += bytes;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes, truncated, skipped };
}

/**
 * Resolve a user/model-supplied repo-relative path inside the workspace root,
 * rejecting absolute paths and any `..` traversal out of the sandbox.
 */
export function resolveWorkspacePath(root: string, relPath: string): string | null {
  const cleaned = relPath.replace(/^\/+/, "");
  const resolved = path.resolve(root, cleaned);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// ── Pure-JS tar.gz extraction ────────────────────────────────────────────────
// Deliberately no system `tar` / no child process: deployment containers may
// not ship the binary, and a failed spawn's stdin emits an unhandled `error`
// event that can crash the whole server mid-request. Built-in zlib + a
// minimal ustar/pax parser has no environment dependency at all.

function cstr(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString("utf8");
}

const PAX_COLLECT_CAP = 64 * 1024;

export interface RepoExtractionSummary {
  retainedBytes: number;
  retainedFiles: number;
  skipped: RepoSkippedEntry[];
}

/**
 * Streaming ustar/pax extractor for GitHub tarballs. Strips the leading
 * `owner-repo-sha/` root directory, writes ONLY regular files that pass the
 * sandbox guards (path safety, skip-dirs, binary/size caps), and ignores
 * symlinks, hardlinks, and devices entirely — they are never created on disk.
 * Exported for tests (fixtures are real `tar czf` output).
 */
export class TarGzEntryExtractor {
  private buf: Buffer = Buffer.alloc(0);
  private pending:
    | { kind: "file"; fh: fs.FileHandle; remaining: number; padding: number }
    | { kind: "collect"; chunks: Buffer[]; type: string; remaining: number; padding: number }
    | { kind: "skip"; remaining: number; padding: number }
    | null = null;
  private paxPath: string | null = null;
  private extractedBytes = 0;
  private extractedFiles = 0;
  private readonly skipped: RepoSkippedEntry[] = [];

  constructor(private readonly dest: string) {}

  async push(chunk: Buffer): Promise<void> {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    await this.drain();
  }

  async finish(): Promise<void> {
    await this.drain();
    if (this.pending) {
      if (this.pending.kind === "file") await this.pending.fh.close().catch(() => {});
      throw new Error("truncated tarball: archive ended mid-entry");
    }
  }

  getSummary(): RepoExtractionSummary {
    return {
      retainedBytes: this.extractedBytes,
      retainedFiles: this.extractedFiles,
      skipped: [...this.skipped],
    };
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.pending) {
        const take = Math.min(this.pending.remaining, this.buf.length);
        if (take > 0) {
          const data = this.buf.subarray(0, take);
          if (this.pending.kind === "file") await this.pending.fh.write(data);
          else if (this.pending.kind === "collect") this.pending.chunks.push(Buffer.from(data));
          this.pending.remaining -= take;
          this.buf = this.buf.subarray(take);
        }
        if (this.pending.remaining > 0) return;
        if (this.buf.length < this.pending.padding) return;
        this.buf = this.buf.subarray(this.pending.padding);
        if (this.pending.kind === "file") await this.pending.fh.close();
        else if (this.pending.kind === "collect") this.onMetadata(this.pending);
        this.pending = null;
        continue;
      }

      if (this.buf.length < 512) return;
      const header = this.buf.subarray(0, 512);
      this.buf = this.buf.subarray(512);
      if (header.every((b) => b === 0)) continue; // end-of-archive blocks

      const size = parseInt(cstr(header, 124, 12).trim() || "0", 8) || 0;
      const typeflag = String.fromCharCode(header[156] ?? 0);
      const padding = (512 - (size % 512)) % 512;
      const prefix = cstr(header, 345, 155);
      const rawName = cstr(header, 0, 100);
      const name = this.paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
      this.paxPath = null;

      // pax extended header ('x') / GNU longname ('L') carry the NEXT entry's
      // real path; global pax ('g') is skipped like everything non-file.
      if (typeflag === "x" || typeflag === "L") {
        this.pending =
          size <= PAX_COLLECT_CAP
            ? { kind: "collect", chunks: [], type: typeflag, remaining: size, padding }
            : { kind: "skip", remaining: size, padding };
        continue;
      }
      if (typeflag !== "0" && typeflag !== "\0") {
        // dirs, symlinks, hardlinks, devices, global pax — never materialized.
        this.pending = { kind: "skip", remaining: size, padding };
        continue;
      }

      // Strip the tarball's single root directory (owner-repo-sha/).
      const slash = name.indexOf("/");
      const rawRelPath = slash === -1 ? "" : name.slice(slash + 1);
      const relPath = normalizedRepoPath(rawRelPath);
      const abs = relPath ? resolveWorkspacePath(this.dest, relPath) : null;
      let skipReason: RepoSkipReason | null = null;
      if (!abs || !relPath) skipReason = "unsafe_path";
      else if (isSkippedPath(relPath)) skipReason = "skipped_directory";
      else if (isBinaryPath(relPath)) skipReason = "binary";
      else if (size > REPO_WORKSPACE_LIMITS.maxFileBytes) skipReason = "oversized_file";
      else if (this.extractedFiles >= REPO_WORKSPACE_LIMITS.maxFiles)
        skipReason = "file_count_limit";
      else if (this.extractedBytes + size > REPO_WORKSPACE_LIMITS.maxExtractedBytes)
        skipReason = "retained_byte_limit";

      if (skipReason) {
        if (rawRelPath) {
          retainLargestSkips(this.skipped, {
            path: rawRelPath,
            bytes: size,
            reason: skipReason,
          });
        }
        this.pending = { kind: "skip", remaining: size, padding };
        continue;
      }

      if (!abs || !relPath) {
        this.pending = { kind: "skip", remaining: size, padding };
        continue;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fs.open(abs, "w");
      this.extractedBytes += size;
      this.extractedFiles++;
      this.pending = { kind: "file", fh, remaining: size, padding };
    }
  }

  private onMetadata(entry: { chunks: Buffer[]; type: string }): void {
    const data = Buffer.concat(entry.chunks).toString("utf8");
    if (entry.type === "L") {
      this.paxPath = data.replace(/\0+$/, "");
      return;
    }
    // pax records: "<len> key=value\n"
    const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(data);
    if (m?.[1]) this.paxPath = m[1];
  }
}

/**
 * Gunzip + extract a tarball from any byte source into `dest`.
 * Exported for tests; `downloadAndExtract` feeds it the HTTP body.
 */
export async function extractTarGz(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  dest: string,
): Promise<RepoExtractionSummary> {
  await fs.mkdir(dest, { recursive: true });
  const gunzip = createGunzip();
  const extractor = new TarGzEntryExtractor(dest);

  let feedError: unknown = null;
  const feed = (async () => {
    try {
      for await (const value of source) {
        if (!gunzip.write(Buffer.from(value))) await once(gunzip, "drain");
      }
      gunzip.end();
    } catch (err) {
      feedError = err;
      gunzip.destroy(err as Error);
    }
  })();

  for await (const chunk of gunzip) {
    await extractor.push(chunk as Buffer);
  }
  await feed;
  if (feedError) throw feedError;
  await extractor.finish();
  return extractor.getSummary();
}

async function downloadAndExtract(
  url: string,
  token: string,
  dest: string,
): Promise<RepoExtractionSummary> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPO_WORKSPACE_LIMITS.materializeTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ora-repo-analyst",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`tarball download failed: HTTP ${res.status}`);
    }
    return await extractTarGz(res.body as unknown as AsyncIterable<Uint8Array>, dest);
  } finally {
    clearTimeout(timer);
  }
}

async function indexAndPrune(root: string): Promise<{
  files: RepoWorkspaceFile[];
  totalBytes: number;
  truncated: boolean;
}> {
  const files: RepoWorkspaceFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Symlinks can point outside the sandbox — remove unconditionally.
        await fs.rm(absPath, { force: true });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          await fs.rm(absPath, { recursive: true, force: true });
          continue;
        }
        await walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBinaryPath(relPath) || isSkippedPath(relPath)) {
        await fs.rm(absPath, { force: true });
        continue;
      }
      const stat = await fs.stat(absPath);
      if (stat.size > REPO_WORKSPACE_LIMITS.maxFileBytes) {
        await fs.rm(absPath, { force: true });
        continue;
      }
      if (
        files.length >= REPO_WORKSPACE_LIMITS.maxFiles ||
        totalBytes + stat.size > REPO_WORKSPACE_LIMITS.maxExtractedBytes
      ) {
        truncated = true;
        await fs.rm(absPath, { force: true });
        continue;
      }
      files.push({ path: relPath, bytes: stat.size });
      totalBytes += stat.size;
    }
  }

  await walk(root, "");
  return { files, totalBytes, truncated };
}

export class RepoWorkspaceReadError extends Error {
  constructor(readonly safeReason: string) {
    super(safeReason);
    this.name = "RepoWorkspaceReadError";
  }
}

export function safeRepoWorkspaceFailure(error: unknown): string {
  if (error instanceof RepoWorkspaceReadError) return error.safeReason;
  if (error instanceof OraGithubApiError && error.rateLimited) {
    return "The GitHub API rate limit was reached. No repository code was analyzed; retry shortly.";
  }
  return "The repository could not be read right now. No repository code was analyzed.";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function describeNoReadableFiles(skipped: RepoSkippedEntry[]): string {
  const largest = skipped[0];
  if (!largest) {
    return "No readable source files were found. No repository code was analyzed.";
  }
  const kind =
    largest.reason === "binary"
      ? "binary file"
      : largest.reason === "skipped_directory"
        ? "excluded directory entry"
        : largest.reason === "oversized_file"
          ? "oversized file"
          : "filtered entry";
  return (
    `No readable source files were retained. The largest skipped item was ` +
    `${largest.path} (${formatBytes(largest.bytes)}, ${kind}). ` +
    "No repository code was analyzed."
  );
}

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".prisma",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

function fallbackSearchPaths(
  files: RepoWorkspaceFile[],
  query: string,
  excluded: Set<string>,
): string[] {
  const baseTokens = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
  const stemVariants: Record<string, string[]> = {
    analyze: ["analysis", "analyst"],
    build: ["builder"],
    classify: ["classification", "classifier"],
    generate: ["generation", "generator"],
    resolve: ["resolution", "resolver"],
    route: ["router", "routing"],
    search: ["searcher"],
  };
  const tokens = Array.from(
    new Set(baseTokens.flatMap((token) => [token, ...(stemVariants[token] ?? [])])),
  );
  return files
    .filter(
      (file) =>
        !excluded.has(file.path) &&
        file.bytes <= REPO_WORKSPACE_LIMITS.maxFileBytes &&
        SOURCE_EXTENSIONS.has(path.extname(file.path).toLowerCase()),
    )
    .map((file) => {
      const lower = file.path.toLowerCase();
      const tokenHits = tokens.reduce((sum, token) => sum + Number(lower.includes(token)), 0);
      const rootDepth = file.path.split("/").length;
      const nonSourcePenalty = /(^|\/)(\.agents|docs?|__tests__)(\/|$)|\.test\.[^.]+$/i.test(
        file.path,
      )
        ? 1
        : 0;
      return { file, hasTokenHit: Number(tokenHits > 0), tokenHits, nonSourcePenalty, rootDepth };
    })
    .sort(
      (a, b) =>
        b.hasTokenHit - a.hasTokenHit ||
        a.nonSourcePenalty - b.nonSourcePenalty ||
        b.tokenHits - a.tokenHits ||
        a.rootDepth - b.rootDepth ||
        a.file.bytes - b.file.bytes ||
        a.file.path.localeCompare(b.file.path),
    )
    .slice(0, REPO_WORKSPACE_LIMITS.maxFallbackSearchFiles)
    .map(({ file }) => file.path);
}

function createApiWorkspace(
  args: MaterializeArgs,
  key: string,
  tree: Awaited<ReturnType<typeof fetchRepoTree>>,
): RepoWorkspace {
  const filtered = filterRepoTreeEntries(tree.entries, tree.truncated);
  if (filtered.files.length === 0) {
    throw new RepoWorkspaceReadError(describeNoReadableFiles(filtered.skipped));
  }

  const filesByPath = new Map(filtered.files.map((file) => [file.path, file]));
  const blobCache = new Map<string, { text: string; bytes: number; lastUsedAt: number }>();
  let blobCacheBytes = 0;
  const ws: RepoWorkspace = {
    root: path.join(workspaceRootDir(), key),
    files: filtered.files,
    totalBytes: filtered.totalBytes,
    truncated: filtered.truncated,
    lastUsedAt: Date.now(),
    source: "github_api",
    skipped: filtered.skipped,
  };

  const cacheBlob = (sha: string, text: string, bytes: number) => {
    const existing = blobCache.get(sha);
    if (existing) blobCacheBytes -= existing.bytes;
    blobCache.delete(sha);
    blobCache.set(sha, { text, bytes, lastUsedAt: Date.now() });
    blobCacheBytes += bytes;
    while (
      blobCache.size > REPO_WORKSPACE_LIMITS.maxBlobCacheEntries ||
      blobCacheBytes > REPO_WORKSPACE_LIMITS.maxBlobCacheBytes
    ) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of blobCache) {
        if (candidate.lastUsedAt < oldestAt) {
          oldestAt = candidate.lastUsedAt;
          oldestKey = candidateKey;
        }
      }
      if (!oldestKey) break;
      const removed = blobCache.get(oldestKey);
      blobCache.delete(oldestKey);
      blobCacheBytes -= removed?.bytes ?? 0;
    }
  };

  const readTextFile = async (file: RepoWorkspaceFile): Promise<string> => {
    if (!file.sha) throw new RepoWorkspaceReadError(`Could not resolve "${file.path}".`);
    const cached = blobCache.get(file.sha);
    if (cached) {
      cached.lastUsedAt = Date.now();
      blobCache.delete(file.sha);
      blobCache.set(file.sha, cached);
      ws.lastUsedAt = Date.now();
      return cached.text;
    }
    let body: Buffer;
    try {
      body = await fetchRepoBlob(args.token, args.owner, args.repo, file.sha);
    } catch (error) {
      if (error instanceof OraGithubApiError && error.rateLimited) {
        throw new RepoWorkspaceReadError(
          `The GitHub API rate limit was reached, so "${file.path}" was not read. Retry shortly.`,
        );
      }
      throw new RepoWorkspaceReadError(
        `"${file.path}" could not be read from the connected repository.`,
      );
    }
    if (body.byteLength > REPO_WORKSPACE_LIMITS.maxFileBytes) {
      throw new RepoWorkspaceReadError(
        `"${file.path}" is ${formatBytes(body.byteLength)}, above the safe per-file read limit.`,
      );
    }
    if (body.includes(0)) {
      throw new RepoWorkspaceReadError(`"${file.path}" is binary and was not analyzed.`);
    }
    file.bytes = body.byteLength;
    const text = body.toString("utf8");
    cacheBlob(file.sha, text, body.byteLength);
    ws.lastUsedAt = Date.now();
    return text;
  };

  const planSearch = async (query: string): Promise<RepoWorkspaceSearchPlan> => {
    let primaryPaths: string[] = [];
    let note: string | undefined;
    try {
      primaryPaths = (
        await searchRepoCodePaths(
          args.token,
          args.owner,
          args.repo,
          query,
          REPO_WORKSPACE_LIMITS.maxFallbackSearchFiles,
        )
      ).filter((candidate) => filesByPath.has(candidate));
      if (primaryPaths.length === 0) {
        note =
          "GitHub code search returned no readable candidates; a targeted source scan was used.";
      }
    } catch (error) {
      note =
        error instanceof OraGithubApiError && error.rateLimited
          ? "GitHub code search hit its rate limit; a targeted source scan was used."
          : "GitHub code search was unavailable; a targeted source scan was used.";
    }
    const primarySet = new Set(primaryPaths);
    return {
      primaryPaths,
      fallbackPaths: fallbackSearchPaths(filtered.files, query, primarySet),
      note,
    };
  };

  ws.readTextFile = readTextFile;
  ws.planSearch = planSearch;
  return ws;
}

export interface MaterializeArgs {
  sessionId: number;
  owner: string;
  repo: string;
  ref: string;
  defaultBranch?: string;
  token: string;
}

/**
 * Get (or lazily build) the read-only workspace for a repo session.
 * Reuses an existing workspace when present and fresh.
 */
export async function materializeRepoWorkspace(args: MaterializeArgs): Promise<RepoWorkspace> {
  const key = workspaceKey(args.sessionId);
  const existing = workspaces.get(key);
  if (existing) {
    if (existing.source === "github_api") {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    try {
      await fs.access(existing.root);
      existing.lastUsedAt = Date.now();
      return existing;
    } catch {
      workspaces.delete(key);
    }
  }
  const running = inflight.get(key);
  if (running) return running;

  const build = (async () => {
    const root = path.join(workspaceRootDir(), key);
    logger.info(
      { owner: args.owner, repo: args.repo, sessionId: args.sessionId },
      "ora-repo: loading lazy repository index",
    );
    let apiFailure: unknown;
    try {
      const tree = await fetchRepoTree(
        args.token,
        args.owner,
        args.repo,
        args.ref || args.defaultBranch || "HEAD",
      );
      const apiWorkspace = createApiWorkspace(args, key, tree);
      workspaces.set(key, apiWorkspace);
      return apiWorkspace;
    } catch (error) {
      if (error instanceof RepoWorkspaceReadError) throw error;
      apiFailure = error;
      logger.warn(
        {
          owner: args.owner,
          repo: args.repo,
          status: error instanceof OraGithubApiError ? error.status : undefined,
        },
        "ora-repo: lazy API index unavailable; trying filtered archive fallback",
      );
    }

    await fs.rm(root, { recursive: true, force: true });
    const url = tarballUrl(args.owner, args.repo, args.ref);
    try {
      const extraction = await downloadAndExtract(url, args.token, root);
      const { files, totalBytes, truncated } = await indexAndPrune(root);
      if (files.length === 0) {
        throw new RepoWorkspaceReadError(describeNoReadableFiles(extraction.skipped));
      }
      const ws: RepoWorkspace = {
        root,
        files,
        totalBytes,
        truncated,
        lastUsedAt: Date.now(),
        source: "tarball",
        skipped: extraction.skipped,
      };
      workspaces.set(key, ws);
      return ws;
    } catch (fallbackError) {
      await fs.rm(root, { recursive: true, force: true });
      if (fallbackError instanceof RepoWorkspaceReadError) throw fallbackError;
      const apiReason =
        apiFailure instanceof OraGithubApiError && apiFailure.rateLimited
          ? "The GitHub API rate limit was reached, and the filtered fallback snapshot also failed."
          : "The repository index and filtered fallback snapshot both failed.";
      throw new RepoWorkspaceReadError(
        `${apiReason} No repository code was analyzed; retry shortly.`,
      );
    }
  })();
  inflight.set(key, build);
  try {
    return await build;
  } finally {
    inflight.delete(key);
  }
}

export function getCachedWorkspace(sessionId: number): RepoWorkspace | null {
  return workspaces.get(workspaceKey(sessionId)) ?? null;
}

export async function destroyRepoWorkspace(sessionId: number): Promise<void> {
  const key = workspaceKey(sessionId);
  const ws = workspaces.get(key);
  workspaces.delete(key);
  const root = ws?.root ?? path.join(workspaceRootDir(), key);
  await fs.rm(root, { recursive: true, force: true });
}

/** TTL sweep — called from a timer at startup and safe to call ad hoc. */
export async function sweepExpiredWorkspaces(now = Date.now()): Promise<number> {
  let swept = 0;
  for (const [key, ws] of workspaces) {
    if (now - ws.lastUsedAt > REPO_WORKSPACE_LIMITS.ttlMs) {
      workspaces.delete(key);
      await fs.rm(ws.root, { recursive: true, force: true });
      swept++;
    }
  }
  return swept;
}

let sweeper: NodeJS.Timeout | null = null;

export function startWorkspaceSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(
    () => {
      void sweepExpiredWorkspaces().catch((err) =>
        logger.warn({ err }, "ora-repo: workspace sweep failed"),
      );
    },
    5 * 60 * 1000,
  );
  sweeper.unref();
}
