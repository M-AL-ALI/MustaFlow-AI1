/**
 * Ora repo workspace — sandboxed, read-only, ephemeral.
 *
 * Materializes a GitHub repo snapshot for analysis by downloading the
 * REST tarball (never `git clone`): the extracted tree has no .git
 * directory, no remote, and no credentials on disk, so a write/push
 * channel does not exist even in principle. Workspaces live under the OS
 * tmpdir, are capped in size and file count, and are swept by TTL.
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
import { tarballUrl } from "./repo-github-auth";

export const REPO_WORKSPACE_LIMITS = {
  /** Abort the tarball download past this many compressed bytes. */
  maxTarballBytes: 60 * 1024 * 1024,
  /** Hard cap on total extracted bytes kept on disk. */
  maxExtractedBytes: 120 * 1024 * 1024,
  /** Hard cap on indexed files; extra files are dropped from the index. */
  maxFiles: 8000,
  /** Files larger than this are dropped from the workspace after extract. */
  maxFileBytes: 1_500_000,
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
}

export interface RepoWorkspace {
  root: string;
  files: RepoWorkspaceFile[];
  totalBytes: number;
  truncated: boolean;
  lastUsedAt: number;
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
      const relPath = slash === -1 ? "" : name.slice(slash + 1);
      const abs = relPath ? resolveWorkspacePath(this.dest, relPath) : null;
      const withinBudget =
        size <= REPO_WORKSPACE_LIMITS.maxFileBytes &&
        this.extractedBytes + size <= REPO_WORKSPACE_LIMITS.maxExtractedBytes;
      if (!abs || !relPath || isSkippedPath(relPath) || isBinaryPath(relPath) || !withinBudget) {
        this.pending = { kind: "skip", remaining: size, padding };
        continue;
      }

      await fs.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fs.open(abs, "w");
      this.extractedBytes += size;
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
): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const gunzip = createGunzip();
  const extractor = new TarGzEntryExtractor(dest);

  let feedError: unknown = null;
  const feed = (async () => {
    try {
      let received = 0;
      for await (const value of source) {
        received += value.byteLength;
        if (received > REPO_WORKSPACE_LIMITS.maxTarballBytes) {
          throw new Error(
            `repository tarball exceeds the ${Math.round(REPO_WORKSPACE_LIMITS.maxTarballBytes / 1024 / 1024)} MB limit`,
          );
        }
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
}

async function downloadAndExtract(url: string, token: string, dest: string): Promise<void> {
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
    await extractTarGz(res.body as unknown as AsyncIterable<Uint8Array>, dest);
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

export interface MaterializeArgs {
  sessionId: number;
  owner: string;
  repo: string;
  ref: string;
  token: string;
}

/**
 * Get (or lazily build) the extracted workspace for a repo session.
 * Reuses an existing workspace when present and fresh.
 */
export async function materializeRepoWorkspace(args: MaterializeArgs): Promise<RepoWorkspace> {
  const key = workspaceKey(args.sessionId);
  const existing = workspaces.get(key);
  if (existing) {
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
    await fs.rm(root, { recursive: true, force: true });
    const url = tarballUrl(args.owner, args.repo, args.ref);
    logger.info(
      { owner: args.owner, repo: args.repo, sessionId: args.sessionId },
      "ora-repo: materializing workspace",
    );
    await downloadAndExtract(url, args.token, root);
    const { files, totalBytes, truncated } = await indexAndPrune(root);
    const ws: RepoWorkspace = { root, files, totalBytes, truncated, lastUsedAt: Date.now() };
    workspaces.set(key, ws);
    return ws;
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
