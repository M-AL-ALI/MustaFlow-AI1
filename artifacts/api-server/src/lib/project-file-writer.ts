import { and, eq, inArray, sql } from "drizzle-orm";
import { db, projectFilesTable } from "@workspace/db";
import type { BuilderFile } from "./builder";
import { resolveArtifactId } from "./artifacts";

export const PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS = 2_000;
export const PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS = 10_000;

export class ProjectFileArtifactScopeError extends Error {
  readonly code = "project_file_artifact_scope_unavailable";

  constructor() {
    super("Project files could not be saved because their artifact scope is unavailable.");
    this.name = "ProjectFileArtifactScopeError";
  }
}

export interface ProjectFileMutation {
  projectId: number;
  files: BuilderFile[];
  replaceAll: boolean;
  artifactId?: number | null;
  removedPaths?: string[];
}

/**
 * Replace or patch one artifact's mutable file set in a single bounded transaction.
 * A failed delete, insert, or timeout leaves the previously committed rows unchanged.
 */
export async function writeProjectFilesAtomically(input: ProjectFileMutation): Promise<void> {
  const resolvedArtifactId = await resolveArtifactId(input.projectId, input.artifactId ?? null);
  if (resolvedArtifactId === null) {
    throw new ProjectFileArtifactScopeError();
  }

  const affectedPaths = [
    ...new Set([...input.files.map((file) => file.path), ...(input.removedPaths ?? [])]),
  ];

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS}ms`}, true)`,
    );
    await tx.execute(
      sql`select set_config('statement_timeout', ${`${PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS}ms`}, true)`,
    );

    if (input.replaceAll) {
      await tx
        .delete(projectFilesTable)
        .where(
          and(
            eq(projectFilesTable.projectId, input.projectId),
            eq(projectFilesTable.artifactId, resolvedArtifactId),
          ),
        );
    } else if (affectedPaths.length > 0) {
      await tx
        .delete(projectFilesTable)
        .where(
          and(
            eq(projectFilesTable.projectId, input.projectId),
            eq(projectFilesTable.artifactId, resolvedArtifactId),
            inArray(projectFilesTable.path, affectedPaths),
          ),
        );
    }

    if (input.files.length > 0) {
      await tx.insert(projectFilesTable).values(
        input.files.map((file) => ({
          projectId: input.projectId,
          artifactId: resolvedArtifactId,
          path: file.path,
          content: file.content,
          mimeType: file.mimeType,
        })),
      );
    }
  });
}
