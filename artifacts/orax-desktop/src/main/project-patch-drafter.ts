/**
 * Phase 2K/2L — Safe local project patch drafter.
 *
 * Produces a reviewable draft patch proposal from selected/read file context.
 * No files are written. No shell commands. No working-directory assumptions.
 * All paths are validated under the project root before inclusion.
 *
 * Phase 2L additions:
 * - originalHash (SHA-256 of current file content) in each DraftFilePatch
 * - oldContentPreview passthrough for backend AI diff generation
 * - filePreviews in result (capped, for backend AI patch generation)
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SelectedProjectFile } from "./project-file-selector";
import type { FileReadEntry } from "./project-file-reader";

// ── Public types ─────────────────────────────────────────────────────────────

export interface DraftFilePatch {
  relativePath: string;
  operation: "update" | "create";
  intentDescription: string;
  hunkPreview: string[];
  /** Phase 2L: SHA-256 of the file at draft time — used to detect drift before apply */
  originalHash?: string;
  /** Phase 2L: first ~2 KB of the current file content for backend AI diffing */
  oldContentPreview?: string;
  /** Phase 2L: set by backend AI after patch generation */
  newContent?: string;
  /** Phase 2L: unified diff preview, set by backend AI */
  unifiedDiffPreview?: string;
  /** Phase 2L: reason for the change, set by backend AI */
  reason?: string;
}

export interface DraftProjectPatch {
  summary: string;
  changedFiles: DraftFilePatch[];
  risks: string[];
  verificationPlan: string[];
  draftGeneratedAt: string;
}

/** Phase 2L: capped file content preview for backend AI call */
export interface FilePatchPreview {
  relativePath: string;
  contentPreview: string;
  originalHash: string;
}

export interface ProjectPatchDraftResult {
  draftPatch: DraftProjectPatch;
  /** Phase 2L: safe capped file content for backend AI patch generation */
  filePreviews: FilePatchPreview[];
  warnings: string[];
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

const MAX_CHANGED_FILES = 5;
/** Phase 2L: max total content bytes sent to backend for AI patch generation */
const MAX_TOTAL_PREVIEW_BYTES = 50_000;

// ── Path validation ───────────────────────────────────────────────────────────

function isBlockedFile(name: string): boolean {
  return BLOCKED_FILE_PATTERNS.some((p) => p.test(name));
}

function isBlockedDir(name: string): boolean {
  return BLOCKED_DIRS.has(name);
}

function validatePatchPath(rootPath: string, relPath: string): { ok: boolean; reason?: string } {
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

  if (isBlockedFile(filename)) {
    return { ok: false, reason: "blocked secret file" };
  }
  for (const part of parts.slice(0, -1)) {
    if (isBlockedDir(part)) {
      return { ok: false, reason: `blocked directory: ${part}` };
    }
  }

  // Reject symlinks that resolve outside root
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

// ── SHA-256 hash helper (Phase 2L) ────────────────────────────────────────────

function sha256OfContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Deterministic hunk generator ──────────────────────────────────────────────

function buildHunkPreview(
  relPath: string,
  operation: "update" | "create",
  intentDescription: string,
  fileContentPreview: string | null,
): string[] {
  const header = `--- a/${relPath}`;
  const targetHeader = `+++ b/${relPath}`;
  const hunkLine = "@@ -0,0 +1 @@ [draft]";

  if (operation === "create") {
    return [
      header,
      targetHeader,
      hunkLine,
      `+ // ${intentDescription}`,
      "+ // (file will be created by Orax on approval)",
    ];
  }

  // update — show a skeleton based on file content preview
  const lines: string[] = [header, targetHeader];

  if (fileContentPreview) {
    const contentLines = fileContentPreview
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 4);
    const lineNo = Math.max(1, fileContentPreview.split("\n").indexOf(contentLines[0] ?? "") + 1);
    lines.push(`@@ -${lineNo},4 +${lineNo},5 @@ [draft]`);
    for (const cl of contentLines) {
      lines.push(` ${cl.slice(0, 100)}`);
    }
    lines.push(`+ // TODO: ${intentDescription} — (exact edit pending AI review)`);
  } else {
    lines.push(hunkLine, `+ // TODO: ${intentDescription} — (exact edit pending AI review)`);
  }

  return lines;
}

// ── Intent derivation ─────────────────────────────────────────────────────────

function deriveIntent(
  userMessage: string,
  relPath: string,
  category: string,
): { operation: "update" | "create"; intentDescription: string } {
  const msg = userMessage.toLowerCase();
  const lower = relPath.toLowerCase();

  if (/create|add new|new file|scaffold|generate/.test(msg) && !/update|fix|patch/.test(msg)) {
    const ext = lower.endsWith(".ts") || lower.endsWith(".tsx") ? "TypeScript" : "file";
    return {
      operation: "create",
      intentDescription: `Create ${ext} for: ${userMessage.slice(0, 80)}`,
    };
  }

  const categoryIntents: Record<string, string> = {
    auth: "Update authentication logic to address the reported issue",
    routing: "Update route definition or navigation guard",
    ui: "Update component rendering and state handling",
    api: "Update API handler or request validation",
    config: "Update configuration value",
    tests: "Update test assertions to cover the new behavior",
    docs: "Update documentation to reflect the change",
    package: "Update dependency or script entry",
  };

  const intent = categoryIntents[category] ?? `Update to address: ${userMessage.slice(0, 80)}`;
  return { operation: "update", intentDescription: intent };
}

// ── Risks + verification ──────────────────────────────────────────────────────

function buildRisks(userMessage: string, changedFiles: DraftFilePatch[]): string[] {
  const msg = userMessage.toLowerCase();
  const risks: string[] = [];

  if (changedFiles.some((f) => f.relativePath.toLowerCase().includes("auth"))) {
    risks.push(
      "Authentication changes may affect existing sessions — test sign-in flow after applying.",
    );
  }
  if (changedFiles.some((f) => f.relativePath.toLowerCase().includes("route"))) {
    risks.push("Route changes may break existing links or redirect logic.");
  }
  if (changedFiles.some((f) => f.operation === "create")) {
    risks.push("New files must be explicitly imported or registered to take effect.");
  }
  if (/delete|remove|drop/.test(msg)) {
    risks.push("Destructive changes — verify no other code depends on the removed code.");
  }
  if (risks.length === 0) {
    risks.push("Review the diff carefully before approving — automated patches may miss context.");
  }
  return risks;
}

function buildVerificationPlan(userMessage: string, changedFiles: DraftFilePatch[]): string[] {
  const plan: string[] = [];
  const hasConfig = changedFiles.some(
    (f) => f.relativePath.endsWith("config.ts") || f.relativePath.endsWith("config.js"),
  );

  if (hasConfig) {
    plan.push("Run the project typecheck to verify config changes compile cleanly.");
  } else {
    plan.push("Run the project typecheck (e.g. pnpm typecheck) after applying.");
  }

  plan.push("Run existing tests to confirm no regressions were introduced.");
  plan.push("Smoke-test the affected feature in the browser or with a manual request.");
  void userMessage;
  return plan;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function draftProjectPatch(params: {
  localPath: string;
  userMessage: string;
  selectedFiles: SelectedProjectFile[];
  fileReadEntries: FileReadEntry[];
  suggestedPlan: string | undefined;
}): Promise<ProjectPatchDraftResult> {
  const { localPath, userMessage, selectedFiles, fileReadEntries, suggestedPlan } = params;
  const warnings: string[] = [];

  // Build a content-preview map keyed by relativePath
  const previewByPath = new Map<string, string>();
  for (const entry of fileReadEntries) {
    previewByPath.set(entry.relativePath, entry.contentPreview);
  }

  // Validate and collect safe target files for patching
  const safeCandidates: Array<{ file: SelectedProjectFile; contentPreview: string | null }> = [];

  for (const file of selectedFiles) {
    const check = validatePatchPath(localPath, file.relativePath);
    if (!check.ok) {
      warnings.push(`Skipping ${file.relativePath}: ${check.reason}`);
      continue;
    }
    safeCandidates.push({
      file,
      contentPreview: previewByPath.get(file.relativePath) ?? null,
    });
    if (safeCandidates.length >= MAX_CHANGED_FILES) break;
  }

  if (safeCandidates.length === 0) {
    warnings.push("No safe target files found for patch proposal.");
    return {
      draftPatch: {
        summary: "Could not identify safe target files for a draft patch.",
        changedFiles: [],
        risks: ["No files to patch — inspect the project again with a more specific request."],
        verificationPlan: [],
        draftGeneratedAt: new Date().toISOString(),
      },
      filePreviews: [],
      warnings,
    };
  }

  // Build the changed-file proposals
  const changedFiles: DraftFilePatch[] = [];
  for (const { file, contentPreview } of safeCandidates) {
    const { operation, intentDescription } = deriveIntent(
      userMessage,
      file.relativePath,
      file.category,
    );
    const hunkPreview = buildHunkPreview(
      file.relativePath,
      operation,
      intentDescription,
      contentPreview,
    );

    // Phase 2L: compute originalHash for drift detection + send oldContentPreview
    let originalHash: string | undefined;
    let oldContentPreview: string | undefined;
    if (contentPreview) {
      originalHash = sha256OfContent(contentPreview);
      oldContentPreview = contentPreview.slice(0, 2_000); // first 2 KB for backend AI context
    }

    changedFiles.push({
      relativePath: file.relativePath,
      operation,
      intentDescription,
      hunkPreview,
      originalHash,
      oldContentPreview,
    });
  }

  // Build summary
  const fileNames = changedFiles.map((f) => f.relativePath).join(", ");
  const summary =
    changedFiles.length === 1
      ? `Draft patch for ${fileNames}: ${changedFiles[0]!.intentDescription}`
      : `Draft patch touching ${changedFiles.length} files (${fileNames}). Review each change before approving.`;

  const risks = buildRisks(userMessage, changedFiles);
  const verificationPlan = buildVerificationPlan(userMessage, changedFiles);

  void suggestedPlan;

  // Phase 2L: build capped filePreviews for backend AI patch generation
  let totalBytes = 0;
  const filePreviews: FilePatchPreview[] = [];
  for (const entry of fileReadEntries) {
    if (totalBytes >= MAX_TOTAL_PREVIEW_BYTES) break;
    // Validate the path again before including content
    const check = validatePatchPath(localPath, entry.relativePath);
    if (!check.ok) continue;

    const remaining = MAX_TOTAL_PREVIEW_BYTES - totalBytes;
    const preview = entry.contentPreview.slice(0, remaining);
    totalBytes += preview.length;
    filePreviews.push({
      relativePath: entry.relativePath,
      contentPreview: preview,
      originalHash: sha256OfContent(entry.contentPreview),
    });
  }

  return {
    draftPatch: {
      summary,
      changedFiles,
      risks,
      verificationPlan,
      draftGeneratedAt: new Date().toISOString(),
    },
    filePreviews,
    warnings,
  };
}
