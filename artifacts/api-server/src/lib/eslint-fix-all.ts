import { and, asc, eq } from "drizzle-orm";
import { db, projectFilesTable } from "@workspace/db";
import { runEslintFix } from "./checks/eslint-runner";
import { reconcileProjectFileAssetUsage } from "./project-file-asset-usage";

export type EslintFixAllPerFileResult = {
  fileId: number;
  path: string;
  supported: boolean;
  changed: boolean;
  fixedCount: number;
  remainingCount: number;
  errorCount: number;
  before?: string;
  after?: string;
};

export type EslintFixAllResult = {
  filesScanned: number;
  filesFixed: number;
  fixedCount: number;
  remainingCount: number;
  results: EslintFixAllPerFileResult[];
  preFixFiles: Array<{ path: string; content: string; mimeType: string }>;
};

export type ApplyProjectEslintFixesOptions = {
  /** When true, do not persist updates — return the proposed changes only. */
  dryRun?: boolean;
  /** When set, only apply fixes to these file IDs (others are still scanned/reported). */
  fileIds?: Set<number> | null;
};

/**
 * Scan every lintable file in the project, apply ESLint auto-fixes, and write
 * the updated content back to project_files (unless `dryRun` is set). Returns
 * per-file results plus the pre-fix file set so callers can snapshot it for
 * rollback if desired.
 *
 * Shared by the on-demand `POST /api/projects/:id/eslint-fix-all` route and
 * the post-build auto-fix hook in the build pipeline.
 */
export async function applyProjectEslintFixes(
  projectId: number,
  options: ApplyProjectEslintFixesOptions = {},
): Promise<EslintFixAllResult> {
  const dryRun = options.dryRun === true;
  const fileIds = options.fileIds ?? null;

  const rows = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId))
    .orderBy(asc(projectFilesTable.path));

  const results: EslintFixAllPerFileResult[] = [];
  const updates: Array<{ id: number; artifactId: number | null; path: string; output: string }> =
    [];

  for (const row of rows) {
    const before = runEslintFix({ path: row.path, content: row.content, ruleIds: [] });
    if (!before.supported) {
      continue;
    }

    const beforeIssues = runEslintFix({
      path: row.path,
      content: row.content,
      ruleIds: ["__mustaflow_noop__"],
    });
    const totalBefore = beforeIssues.remaining.length;

    const after = before;
    const fixedCount = Math.max(0, totalBefore - after.remaining.length);
    const errorCount = after.remaining.filter((r) => r.severity === "error").length;

    const entry: EslintFixAllPerFileResult = {
      fileId: row.id,
      path: row.path,
      supported: true,
      changed: after.changed,
      fixedCount,
      remainingCount: after.remaining.length,
      errorCount,
    };
    if (dryRun && after.changed) {
      entry.before = row.content;
      entry.after = after.output;
    }
    results.push(entry);

    if (after.changed && (fileIds === null || fileIds.has(row.id))) {
      updates.push({
        id: row.id,
        artifactId: row.artifactId,
        path: row.path,
        output: after.output,
      });
    }
  }

  if (!dryRun && updates.length > 0) {
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(projectFilesTable)
          .set({ content: u.output, updatedAt: now })
          .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, u.id)));
        await reconcileProjectFileAssetUsage(tx, {
          projectId,
          artifactId: u.artifactId,
          filePath: u.path,
          nextContent: u.output,
        });
      }
    });
  }

  // Totals reflect the subset that was actually written (or would be written, on dry-run
  // with no subset filter). filesScanned still tracks every lintable file we considered.
  const appliedIds = new Set(updates.map((u) => u.id));
  const consideredAsApplied = !dryRun && fileIds !== null;
  const totals = results.reduce(
    (acc, r) => {
      acc.filesScanned += 1;
      const isApplied = consideredAsApplied ? appliedIds.has(r.fileId) : r.changed;
      if (isApplied) {
        acc.filesFixed += 1;
        acc.fixedCount += r.fixedCount;
      }
      if (!isApplied && r.changed) {
        // Selected-out files still have their remaining (un-applied) issues.
        acc.remainingCount += r.remainingCount + r.fixedCount;
      } else {
        acc.remainingCount += r.remainingCount;
      }
      return acc;
    },
    { filesScanned: 0, filesFixed: 0, fixedCount: 0, remainingCount: 0 },
  );

  return {
    ...totals,
    results,
    preFixFiles: rows.map((r) => ({
      path: r.path,
      content: r.content,
      mimeType: r.mimeType,
    })),
  };
}
