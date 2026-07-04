/**
 * Phase 2N — Safe local project fix drafter.
 *
 * Takes failed verification check results and file context from the previously
 * patched files to produce a targeted fix patch proposal.
 * No files are written. No shell commands. No exec/spawn/shell execution.
 * All paths validated under the project root before inclusion.
 * Same safety rules and blocked-file constants as project-patch-drafter.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileReadEntry } from "./project-file-reader";
import type {
  DraftFilePatch,
  DraftProjectPatch,
  FilePatchPreview,
} from "./project-patch-drafter";

// ── Public types ─────────────────────────────────────────────────────────────

export type { DraftFilePatch, DraftProjectPatch, FilePatchPreview };

export interface FailedCheck {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface ProjectFixDraftResult {
  draftPatch: DraftProjectPatch;
  filePreviews: FilePatchPreview[];
  warnings: string[];
}

// ── Safety constants (mirror project-patch-drafter) ───────────────────────────

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

function sha256OfContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Error output parser ────────────────────────────────────────────────────────

/**
 * Extract file paths mentioned in check stderr/stdout output.
 * Looks for common patterns: "src/foo.ts:10:5 error" or "in src/foo.ts".
 */
function extractMentionedFiles(checks: FailedCheck[]): string[] {
  const mentioned = new Set<string>();
  const fileRef =
    /(?:^|[\s"'`(])([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs|json|yaml|yml|css|scss|html|vue|svelte))[:\s"'`)/]/gm;

  for (const check of checks) {
    if (check.status !== "failed") continue;
    const output = check.stderr + "\n" + check.stdout;
    for (const m of output.matchAll(fileRef)) {
      const relPath = (m[1] ?? "").replace(/^[.]+\//, "").replace(/^\/+/, "");
      if (relPath.length > 0 && !relPath.startsWith("node_modules")) {
        mentioned.add(relPath);
      }
    }
  }
  return [...mentioned].slice(0, 8);
}

// ── Hunk builder ──────────────────────────────────────────────────────────────

function buildFixHunkPreview(
  relPath: string,
  failReason: string,
  contentPreview: string | null,
): string[] {
  const header = `--- a/${relPath}`;
  const targetHeader = `+++ b/${relPath}`;

  if (!contentPreview) {
    return [
      header,
      targetHeader,
      "@@ -0,0 +1 @@ [fix draft]",
      `+ // Fix: ${failReason}`,
      "+ // (exact fix pending AI review)",
    ];
  }

  const contentLines = contentPreview
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 4);
  const lineNo = Math.max(1, contentPreview.split("\n").indexOf(contentLines[0] ?? "") + 1);

  return [
    header,
    targetHeader,
    `@@ -${lineNo},4 +${lineNo},5 @@ [fix draft]`,
    ...contentLines.map((cl) => ` ${cl.slice(0, 100)}`),
    `+ // Fix: ${failReason.slice(0, 80)}`,
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function draftProjectFix(params: {
  localPath: string;
  failedChecks: FailedCheck[];
  changedFiles: Array<{ relativePath: string; operation: string }>;
  fileReadEntries: FileReadEntry[];
  previousPatchSummary: string;
  originalUserMessage: string;
}): Promise<ProjectFixDraftResult> {
  const {
    localPath,
    failedChecks,
    changedFiles,
    fileReadEntries,
    previousPatchSummary,
    originalUserMessage,
  } = params;

  const warnings: string[] = [];

  const failedOnly = failedChecks.filter((c) => c.status === "failed");

  // Build content-preview map from file read entries
  const previewByPath = new Map<string, string>();
  for (const entry of fileReadEntries) {
    previewByPath.set(entry.relativePath, entry.contentPreview);
  }

  // Determine target files: previously changed files prioritized by error mentions
  const mentionedInErrors = extractMentionedFiles(failedOnly);
  const prevChangedPaths = changedFiles.map((f) => f.relativePath);

  // Priority: prev-changed that appear in errors → other error-mentioned → prev-changed only
  const orderedCandidates = [
    ...prevChangedPaths.filter((p) => mentionedInErrors.includes(p)),
    ...mentionedInErrors.filter((p) => !prevChangedPaths.includes(p)),
    ...prevChangedPaths.filter((p) => !mentionedInErrors.includes(p)),
  ];

  // Also include files from fileReadEntries not yet covered
  for (const entry of fileReadEntries) {
    if (!orderedCandidates.includes(entry.relativePath)) {
      orderedCandidates.push(entry.relativePath);
    }
  }

  // Validate and collect safe target files
  const safeCandidates: Array<{ relativePath: string; contentPreview: string | null }> = [];

  for (const relPath of orderedCandidates) {
    const check = validatePatchPath(localPath, relPath);
    if (!check.ok) {
      warnings.push(`Skipping ${relPath}: ${check.reason}`);
      continue;
    }
    safeCandidates.push({
      relativePath: relPath,
      contentPreview: previewByPath.get(relPath) ?? null,
    });
    if (safeCandidates.length >= MAX_CHANGED_FILES) break;
  }

  if (safeCandidates.length === 0) {
    warnings.push("No safe target files identified from failed checks.");
    const failSummary =
      failedOnly.length > 0
        ? `${failedOnly[0]!.name}: ${(failedOnly[0]!.stderr || failedOnly[0]!.stdout).slice(0, 200)}`
        : "No failed check output available.";
    return {
      draftPatch: {
        summary: "Could not identify target files from the verification failure.",
        changedFiles: [],
        risks: [`Verification failure: ${failSummary}`],
        verificationPlan: ["Re-run verification after applying any manual fixes."],
        draftGeneratedAt: new Date().toISOString(),
      },
      filePreviews: [],
      warnings,
    };
  }

  // Build short fail-reason label for hunk previews
  const failReasonShort =
    failedOnly.length > 0
      ? `${failedOnly[0]!.name}: ${(failedOnly[0]!.stderr || failedOnly[0]!.stdout).slice(0, 120)}`
      : "verification failed";

  // Build changed-file fix proposals
  const patchChangedFiles: DraftFilePatch[] = [];
  for (const { relativePath, contentPreview } of safeCandidates) {
    const hunkPreview = buildFixHunkPreview(relativePath, failReasonShort, contentPreview);
    let originalHash: string | undefined;
    let oldContentPreview: string | undefined;
    if (contentPreview) {
      originalHash = sha256OfContent(contentPreview);
      oldContentPreview = contentPreview.slice(0, 2_000);
    }
    patchChangedFiles.push({
      relativePath,
      operation: "update",
      intentDescription: `Fix verification failure: ${failReasonShort.slice(0, 80)}`,
      hunkPreview,
      originalHash,
      oldContentPreview,
    });
  }

  // Summary
  const failedCheckNames = failedOnly.map((c) => c.name).join(", ") || "check";
  const fileNames = patchChangedFiles.map((f) => f.relativePath).join(", ");
  const summary =
    patchChangedFiles.length === 1
      ? `Fix for ${failedCheckNames} failure in ${fileNames}.`
      : `Fix for ${failedCheckNames} failure — ${patchChangedFiles.length} files: ${fileNames}.`;

  // Risks
  const risks: string[] = [
    `Addresses failed check${failedOnly.length === 1 ? "" : "s"}: ${failedCheckNames}.`,
    "Review the proposed changes carefully — automated fix may not fully resolve all failures.",
  ];
  if (
    patchChangedFiles.some(
      (f) =>
        f.relativePath.toLowerCase().includes("auth") ||
        f.relativePath.toLowerCase().includes("route"),
    )
  ) {
    risks.push("Auth or routing changes detected — test affected flows after applying.");
  }

  // Verification plan
  const verificationPlan = [
    `Re-run the failed check${failedOnly.length === 1 ? "" : "s"}: ${failedCheckNames}.`,
    "Run the full project typecheck to confirm no new errors are introduced.",
    "Test the affected feature manually to verify the fix resolves the issue.",
  ];

  void previousPatchSummary;
  void originalUserMessage;

  // Build filePreviews for backend AI enrichment
  let totalBytes = 0;
  const filePreviews: FilePatchPreview[] = [];
  for (const entry of fileReadEntries) {
    if (totalBytes >= MAX_TOTAL_PREVIEW_BYTES) break;
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
      changedFiles: patchChangedFiles,
      risks,
      verificationPlan,
      draftGeneratedAt: new Date().toISOString(),
    },
    filePreviews,
    warnings,
  };
}
