/**
 * Phase 2L — Safe local project patch applier.
 *
 * Writes approved patch files to disk after creating a checkpoint backup.
 * No shell commands. No exec/spawn. No working-directory assumptions.
 * All paths are validated under the project root before any write.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ApplyFilePatch {
  relativePath: string;
  operation: "update" | "create";
  newContent: string;
  originalHash?: string; // SHA-256 of original content — verified before update
}

export interface ApplyProjectPatchParams {
  localPath: string;
  threadId: string;
  patches: ApplyFilePatch[];
}

export interface ApplyProjectPatchResult {
  changedFiles: Array<{
    relativePath: string;
    operation: "update" | "create";
    checkpointBackupPath: string | null;
  }>;
  checkpointPath: string;
  warnings: string[];
  durationMs: number;
}

// ── Safety constants (mirror project-file-reader) ─────────────────────────────

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

// ── Path validation ───────────────────────────────────────────────────────────

function validateApplyPath(rootPath: string, relPath: string): { ok: boolean; reason?: string } {
  if (path.isAbsolute(relPath)) {
    return { ok: false, reason: "absolute path rejected" };
  }
  if (relPath.includes("..")) {
    return { ok: false, reason: "path traversal rejected" };
  }

  const resolved = path.resolve(rootPath, relPath);
  if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) {
    return { ok: false, reason: "path escapes project root" };
  }

  const parts = relPath.replace(/\\/g, "/").split("/");
  const filename = parts[parts.length - 1] ?? "";

  if (BLOCKED_FILE_PATTERNS.some((p) => p.test(filename))) {
    return { ok: false, reason: "blocked secret file" };
  }
  for (const part of parts.slice(0, -1)) {
    if (BLOCKED_DIRS.has(part)) {
      return { ok: false, reason: `blocked directory: ${part}` };
    }
  }

  // Symlink check for existing files only
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(rootPath + path.sep) && real !== rootPath) {
      return { ok: false, reason: "symlink escapes project root" };
    }
  } catch {
    // File may not exist yet (create operation) — that is fine
  }

  return { ok: true };
}

// ── Hash helper ───────────────────────────────────────────────────────────────

export function sha256FileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sha256FileAtPath(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf8");
  return sha256FileContent(content);
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function createCheckpoint(
  rootPath: string,
  threadId: string,
  patches: ApplyFilePatch[],
): { checkpointPath: string; warnings: string[] } {
  const warnings: string[] = [];
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeThread = threadId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const checkpointPath = path.join(rootPath, ".orax", "checkpoints", safeThread, ts);

  fs.mkdirSync(checkpointPath, { recursive: true });

  // Back up original files that will be updated
  for (const patch of patches) {
    if (patch.operation !== "update") continue;
    const absPath = path.resolve(rootPath, patch.relativePath);
    if (!fs.existsSync(absPath)) continue;

    const destDir = path.join(checkpointPath, path.dirname(patch.relativePath));
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(checkpointPath, patch.relativePath);
    try {
      fs.copyFileSync(absPath, destFile);
    } catch (e) {
      warnings.push(
        `Checkpoint backup failed for ${patch.relativePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Write metadata — no secrets or blocked files included
  const meta = {
    projectRoot: "[redacted]",
    threadId,
    changedFiles: patches.map((p) => ({
      relativePath: p.relativePath,
      operation: p.operation,
    })),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(checkpointPath, "metadata.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );

  return { checkpointPath, warnings };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function applyProjectPatch(
  params: ApplyProjectPatchParams,
): Promise<ApplyProjectPatchResult> {
  const { localPath, threadId, patches } = params;
  const startedAt = Date.now();
  const warnings: string[] = [];

  if (!fs.existsSync(localPath)) {
    throw new Error("apply_project_patch: project root does not exist");
  }

  // ── Phase 1: validate ALL patches before touching the filesystem ────────────
  const validPatches: ApplyFilePatch[] = [];
  for (const patch of patches) {
    const check = validateApplyPath(localPath, patch.relativePath);
    if (!check.ok) {
      warnings.push(`Skipping ${patch.relativePath}: ${check.reason}`);
      continue;
    }

    // For updates, verify originalHash if provided (drift guard)
    if (patch.operation === "update" && patch.originalHash) {
      const absPath = path.resolve(localPath, patch.relativePath);
      if (fs.existsSync(absPath)) {
        const currentHash = sha256FileAtPath(absPath);
        if (currentHash !== patch.originalHash) {
          warnings.push(
            `${patch.relativePath}: file changed since patch was drafted — skipping to avoid conflicts.`,
          );
          continue;
        }
      }
    }

    validPatches.push(patch);
  }

  if (validPatches.length === 0) {
    throw new Error("No valid patches to apply after path validation and drift check.");
  }

  // ── Phase 2: create checkpoint backup BEFORE writing anything ──────────────
  const { checkpointPath, warnings: cpWarnings } = createCheckpoint(
    localPath,
    threadId,
    validPatches,
  );
  for (const w of cpWarnings) warnings.push(w);

  // ── Phase 3: write files ───────────────────────────────────────────────────
  const changedFiles: ApplyProjectPatchResult["changedFiles"] = [];

  for (const patch of validPatches) {
    const absPath = path.resolve(localPath, patch.relativePath);
    const dir = path.dirname(absPath);
    const backupPath =
      patch.operation === "update" ? path.join(checkpointPath, patch.relativePath) : null;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, patch.newContent, "utf8");
      changedFiles.push({
        relativePath: patch.relativePath,
        operation: patch.operation,
        checkpointBackupPath: backupPath,
      });
    } catch (e) {
      warnings.push(
        `Failed to write ${patch.relativePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    changedFiles,
    checkpointPath,
    warnings,
    durationMs: Date.now() - startedAt,
  };
}
