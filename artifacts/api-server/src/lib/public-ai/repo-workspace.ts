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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

    await fs.mkdir(dest, { recursive: true });
    const tar = spawn("tar", ["-xz", "--strip-components=1", "-C", dest], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    tar.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const tarDone = new Promise<void>((resolve, reject) => {
      tar.on("error", reject);
      tar.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 400)}`));
      });
    });

    const reader = res.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > REPO_WORKSPACE_LIMITS.maxTarballBytes) {
          tar.stdin.destroy();
          throw new Error(
            `repository tarball exceeds the ${Math.round(REPO_WORKSPACE_LIMITS.maxTarballBytes / 1024 / 1024)} MB limit`,
          );
        }
        const ok = tar.stdin.write(Buffer.from(value));
        if (!ok) await new Promise<void>((r) => tar.stdin.once("drain", () => r()));
      }
      tar.stdin.end();
    } catch (err) {
      tar.kill("SIGKILL");
      throw err;
    }
    await tarDone;
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
