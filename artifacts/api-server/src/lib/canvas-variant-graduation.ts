import { eq, sql } from "drizzle-orm";
import { db, projectFilesTable, projectVersionsTable, type FileSnapshotEntry } from "@workspace/db";
import { guessMime, type BuilderFile } from "./builder";
import {
  PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS,
  PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS,
} from "./project-file-writer";
import { reconcileProjectFileAssetUsage } from "./project-file-asset-usage";

export class CanvasVariantGraduationError extends Error {
  readonly code = "canvas_variant_graduation_failed";

  constructor(options?: ErrorOptions) {
    super(
      "The canvas variant could not be applied. Nothing was changed; please try again.",
      options,
    );
    this.name = "CanvasVariantGraduationError";
  }
}

export interface CanvasVariantGraduationInput {
  projectId: number;
  variantId: number;
  variantLabel: string;
  files: BuilderFile[];
}

export interface CanvasVariantGraduationReceipt {
  inserted: number;
  updated: number;
}

/** Preserve row identity while snapshotting and graduating every requested file atomically. */
export async function graduateCanvasVariantAtomically(
  input: CanvasVariantGraduationInput,
): Promise<CanvasVariantGraduationReceipt> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('lock_timeout', ${`${PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS}ms`}, true)`,
      );
      await tx.execute(
        sql`select set_config('statement_timeout', ${`${PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS}ms`}, true)`,
      );

      const currentRows = await tx
        .select()
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, input.projectId));
      const preSnapshot: FileSnapshotEntry[] = currentRows.map((row) => ({
        path: row.path,
        content: row.content,
        mimeType: row.mimeType || guessMime(row.path),
      }));
      await tx.insert(projectVersionsTable).values({
        projectId: input.projectId,
        label: `Pre-graduation: ${input.variantLabel}`,
        note: `Snapshot taken before graduating canvas variant #${input.variantId}.`,
        filesSnapshot: preSnapshot,
      });

      const existingByPath = new Map(currentRows.map((row) => [row.path, row]));
      let inserted = 0;
      let updated = 0;
      for (const file of input.files) {
        const mimeType = file.mimeType || guessMime(file.path);
        const existing = existingByPath.get(file.path);
        if (existing) {
          await tx
            .update(projectFilesTable)
            .set({ content: file.content, mimeType, updatedAt: new Date() })
            .where(eq(projectFilesTable.id, existing.id));
          updated += 1;
        } else {
          await tx.insert(projectFilesTable).values({
            projectId: input.projectId,
            path: file.path,
            content: file.content,
            mimeType,
          });
          inserted += 1;
        }
        await reconcileProjectFileAssetUsage(tx, {
          projectId: input.projectId,
          artifactId: existing?.artifactId ?? null,
          filePath: file.path,
          nextContent: file.content,
        });
      }

      return { inserted, updated };
    });
  } catch (error) {
    if (error instanceof CanvasVariantGraduationError) throw error;
    throw new CanvasVariantGraduationError({ cause: error });
  }
}
