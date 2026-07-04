/**
 * Phase 2J — Safe local project file reader.
 *
 * Reads file contents for the selected files with strict safety + size limits.
 * No shell commands, no secrets, no files outside sourceLocalPath.
 */
import fs from "node:fs";
import path from "node:path";
import type { SelectedProjectFile } from "./project-file-selector";

// ── Public types ─────────────────────────────────────────────────────────────

export interface FileReadEntry {
  relativePath: string;
  contentPreview: string;
  bytesRead: number;
  truncated: boolean;
  reason: string;
}

export interface ProjectFileReadResult {
  files: FileReadEntry[];
  skipped: { relativePath: string; reason: string }[];
  warnings: { message: string }[];
}

// ── Safety constants ─────────────────────────────────────────────────────────

const BLOCKED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".expo",
  ".turbo",
  ".cache",
  "__pycache__",
]);

const BLOCKED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/,
  /^secrets\./,
  /\.p8$/i,
  /\.pfx$/i,
  /\.cer$/i,
  /\.p12$/i,
  /^credentials\./,
  /^token\./,
];

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".mjs",
  ".cjs",
  ".config.ts",
  ".config.js",
  ".config.mjs",
]);

const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const MAX_CONTENT_PREVIEW = 24 * 1024; // 24 KB per file
const MAX_TOTAL_PREVIEW = 80 * 1024; // 80 KB across all files

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBlockedFilename(name: string): boolean {
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(name));
}

function isBlockedInPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  // Check each directory segment
  for (let i = 0; i < parts.length - 1; i++) {
    if (BLOCKED_DIRS.has(parts[i] ?? "")) return true;
  }
  const filename = parts[parts.length - 1] ?? "";
  return isBlockedFilename(filename);
}

function getExt(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".config.ts")) return ".config.ts";
  if (lower.endsWith(".config.js")) return ".config.js";
  if (lower.endsWith(".config.mjs")) return ".config.mjs";
  const idx = lower.lastIndexOf(".");
  return idx >= 0 ? lower.slice(idx) : "";
}

function hasAllowedExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(getExt(filename));
}

/**
 * Validate that the resolved absolute path is within the root directory.
 * Rejects:
 * - absolute relativePath arguments (starts with / or drive letter)
 * - paths containing ..
 * - symlinks that escape rootPath
 */
function validateAndResolvePath(
  rootPath: string,
  relativePath: string,
): { ok: true; absPath: string } | { ok: false; reason: string } {
  // Reject absolute paths
  if (path.isAbsolute(relativePath)) {
    return { ok: false, reason: "absolute paths are not allowed" };
  }

  // Reject any path component that is ..
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..")) {
    return { ok: false, reason: "path traversal (..) is not allowed" };
  }

  // Resolve and verify containment
  const resolved = path.resolve(rootPath, relativePath);
  const rootResolved = path.resolve(rootPath);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return { ok: false, reason: "resolved path is outside project root" };
  }

  // Verify not a symlink escaping the root
  try {
    const realResolved = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(rootResolved);
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return { ok: false, reason: "symlink escapes project root" };
    }
  } catch {
    // File may not exist yet — leave existsSync check to caller
  }

  return { ok: true, absPath: resolved };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function readSelectedProjectFiles(params: {
  localPath: string;
  files: SelectedProjectFile[];
}): Promise<ProjectFileReadResult> {
  const { localPath, files } = params;
  const results: FileReadEntry[] = [];
  const skipped: { relativePath: string; reason: string }[] = [];
  const warnings: { message: string }[] = [];

  let totalBytesRead = 0;

  for (const selected of files) {
    const { relativePath, reason } = selected;

    // Path safety checks
    const validation = validateAndResolvePath(localPath, relativePath);
    if (!validation.ok) {
      skipped.push({ relativePath, reason: validation.reason });
      continue;
    }
    const absPath = validation.absPath;

    // Blocked dir/file check (via path segments + filename patterns)
    if (isBlockedInPath(relativePath)) {
      skipped.push({ relativePath, reason: "blocked path or filename pattern" });
      continue;
    }

    // Extension check
    const filename = path.basename(relativePath);
    if (!hasAllowedExtension(filename)) {
      skipped.push({ relativePath, reason: "extension not in allowed list" });
      continue;
    }

    // Existence check
    if (!fs.existsSync(absPath)) {
      skipped.push({ relativePath, reason: "file does not exist" });
      continue;
    }

    // File size check
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      skipped.push({ relativePath, reason: "stat failed" });
      continue;
    }

    if (!stat.isFile()) {
      skipped.push({ relativePath, reason: "not a regular file" });
      continue;
    }

    if (stat.size > MAX_FILE_SIZE) {
      skipped.push({
        relativePath,
        reason: `file exceeds ${Math.round(MAX_FILE_SIZE / 1024)}KB size limit`,
      });
      continue;
    }

    // Total preview budget check
    if (totalBytesRead >= MAX_TOTAL_PREVIEW) {
      skipped.push({ relativePath, reason: "total preview budget exhausted" });
      continue;
    }

    // Read up to MAX_CONTENT_PREVIEW or remaining budget
    const bytesToRead = Math.min(
      MAX_CONTENT_PREVIEW,
      MAX_TOTAL_PREVIEW - totalBytesRead,
      stat.size,
    );

    let contentPreview = "";
    let truncated = false;
    let bytesRead = 0;

    try {
      if (bytesToRead >= stat.size) {
        // Read whole file
        contentPreview = fs.readFileSync(absPath, "utf8");
        bytesRead = stat.size;
      } else {
        // Partial read
        const buf = Buffer.alloc(bytesToRead);
        const fd = fs.openSync(absPath, "r");
        bytesRead = fs.readSync(fd, buf, 0, bytesToRead, 0);
        fs.closeSync(fd);
        contentPreview = buf.subarray(0, bytesRead).toString("utf8");
        truncated = true;
      }
    } catch {
      skipped.push({ relativePath, reason: "read failed" });
      continue;
    }

    totalBytesRead += bytesRead;

    results.push({
      relativePath,
      contentPreview,
      bytesRead,
      truncated,
      reason,
    });
  }

  if (totalBytesRead >= MAX_TOTAL_PREVIEW) {
    warnings.push({
      message: `Total file preview budget (${Math.round(MAX_TOTAL_PREVIEW / 1024)}KB) reached; some files were skipped.`,
    });
  }

  return { files: results, skipped, warnings };
}
