/**
 * Preview Sync Pipeline — canonical payload helpers.
 *
 * Single source of truth for building `project_files_changed` payloads and
 * publishing them to the project-level preview event bus channel so that every
 * open browser tab receives real-time FS updates regardless of whether the AI
 * Builder panel is open.
 *
 * Rules enforced here:
 *  - Only safe text files are included in the files map (no .env, no secrets,
 *    no binary-looking content, no files > 512 KB).
 *  - `requiresInstall` is set when package.json or package-lock.json changed.
 *  - `requiresRestart` is set when vite/webpack/tsconfig/runtime config changed.
 *  - Binary files and huge files appear in `changedPaths` only (no content).
 *  - Removed paths are listed in `removedPaths`.
 */

import { publishPreviewEvent } from "./event-bus";

// ── Constants ─────────────────────────────────────────────────────────────────

const PACKAGE_FILES = new Set(["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

const RESTART_PATTERNS = [
  /^vite\.config\.[jt]s$/,
  /^webpack\.config\.[jt]s$/,
  /^tsconfig.*\.json$/,
  /^\.env(\.[^/]+)?$/,
  /^next\.config\.[jt]s$/,
  /^svelte\.config\.[jt]s$/,
  /^nuxt\.config\.[jt]s$/,
  /^remix\.config\.[jt]s$/,
  /^astro\.config\.[jt]s$/,
  /^babel\.config\.[jt]s$/,
  /^rollup\.config\.[jt]s$/,
  /^metro\.config\.[jt]s$/,
  /^app\.json$/,
];

const SECRET_FILENAME_PATTERNS = [
  /^\.env(\.[^/]+)?$/,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /\.p12$/i,
  /\.pfx$/i,
];

/** Max file size we'll include content for (512 KB). */
const MAX_CONTENT_BYTES = 512 * 1024;

/** Heuristic binary check: if any of the first 512 bytes is a null byte, treat as binary. */
function looksLikeBinary(content: string): boolean {
  const check = content.slice(0, 512);
  return check.includes("\0");
}

function isSecretFilename(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(base));
}

function isSafeTextFile(path: string, content: string): boolean {
  if (isSecretFilename(path)) return false;
  if (content.length > MAX_CONTENT_BYTES) return false;
  if (looksLikeBinary(content)) return false;
  return true;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProjectFilesOperationType =
  | "build"
  | "refine"
  | "apply"
  | "rollback"
  | "visual-edit"
  | "manual-save"
  | "qa-auto-fix"
  | "delete-reinsert";

export interface ProjectFilesChangedPayload {
  projectId: number;
  operationType: ProjectFilesOperationType;
  /** Paths of all files that were written/updated (including those excluded from `files`). */
  changedPaths: string[];
  /** Paths of files that were deleted. */
  removedPaths: string[];
  /** Content of safe text files keyed by path. Binary/huge/secret files are excluded. */
  files: Record<string, string>;
  /** True when package.json or lockfile changed — frontend should run npm install. */
  requiresInstall: boolean;
  /** True when a config that requires a dev-server restart changed. */
  requiresRestart: boolean;
  /** ISO timestamp of when this event was generated. */
  generatedAt: string;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build the canonical `project_files_changed` payload.
 *
 * @param projectId    - Project ID.
 * @param files        - All files that were written (path + content).
 * @param removedPaths - Paths that were deleted.
 * @param operationType - What triggered this update.
 */
export function buildProjectFilesChangedPayload(
  projectId: number,
  files: Array<{ path: string; content: string }>,
  removedPaths: string[],
  operationType: ProjectFilesOperationType,
): ProjectFilesChangedPayload {
  const changedPaths = files.map((f) => f.path);

  const safeFiles: Record<string, string> = {};
  let requiresInstall = false;
  let requiresRestart = false;

  for (const { path, content } of files) {
    const basename = path.split("/").pop() ?? path;

    if (PACKAGE_FILES.has(basename)) {
      requiresInstall = true;
    }

    if (RESTART_PATTERNS.some((re) => re.test(basename))) {
      requiresRestart = true;
    }

    if (isSafeTextFile(path, content)) {
      safeFiles[path] = content;
    }
  }

  return {
    projectId,
    operationType,
    changedPaths,
    removedPaths,
    files: safeFiles,
    requiresInstall,
    requiresRestart,
    generatedAt: new Date().toISOString(),
  };
}

// ── Publisher ─────────────────────────────────────────────────────────────────

/**
 * Build the payload and publish it to the project-level preview event bus.
 * Returns the payload so callers can also attach it to a task event's `data`.
 */
export function publishProjectFilesChanged(
  projectId: number,
  files: Array<{ path: string; content: string }>,
  removedPaths: string[],
  operationType: ProjectFilesOperationType,
): ProjectFilesChangedPayload {
  const payload = buildProjectFilesChangedPayload(projectId, files, removedPaths, operationType);

  publishPreviewEvent({
    projectId,
    eventType: "project_files_changed",
    data: payload as unknown as Record<string, unknown>,
    createdAt: payload.generatedAt,
  });

  return payload;
}

/**
 * Emit a `preview_ready` event on the project preview channel.
 * Called after agentic container sync confirms HTTP 200 on /healthz.
 */
export function publishPreviewReady(projectId: number): void {
  publishPreviewEvent({
    projectId,
    eventType: "preview_ready",
    createdAt: new Date().toISOString(),
  });
}

/**
 * Emit a `preview_sync_failed` event on the project preview channel.
 * Called when agentic container sync or healthz poll fails.
 */
export function publishPreviewSyncFailed(projectId: number, reason: string): void {
  publishPreviewEvent({
    projectId,
    eventType: "preview_sync_failed",
    data: { reason },
    createdAt: new Date().toISOString(),
  });
}
