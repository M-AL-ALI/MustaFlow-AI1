import { and, eq, inArray, sql } from "drizzle-orm";
import { db, projectFilesTable, projectVersionsTable, type FileSnapshotEntry } from "@workspace/db";
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

export class ProjectFileVersionHandoffError extends Error {
  readonly code = "project_file_version_handoff_failed";

  constructor(options?: ErrorOptions) {
    super(
      "Your files and version could not be saved together. Nothing was changed; please try again.",
      options,
    );
    this.name = "ProjectFileVersionHandoffError";
  }
}

export type ProjectFileWriteScope =
  | { kind: "artifact"; artifactId?: number | null }
  | { kind: "project" };

export interface ProjectFileMutation {
  projectId: number;
  files: BuilderFile[];
  replaceAll: boolean;
  scope: ProjectFileWriteScope;
  removedPaths?: string[];
  authoritativeVersion?: {
    label: string;
    note: string;
    changelogEntry: string;
    planSnapshot?: Record<string, unknown>;
    planSourceMessageId?: number;
  };
}

export interface ProjectFileWriteReceipt {
  authoritativeVersion: { id: number; filesSnapshot: FileSnapshotEntry[] } | null;
}

/**
 * Replace or patch one explicitly requested mutable file scope in a bounded transaction.
 * A failed delete, insert, or timeout leaves the previously committed rows unchanged.
 */
export async function writeProjectFilesAtomically(
  input: ProjectFileMutation,
): Promise<ProjectFileWriteReceipt> {
  const resolvedScope: { kind: "artifact"; artifactId: number } | { kind: "project" } =
    await (async () => {
      if (input.scope.kind === "project") return { kind: "project" };

      const artifactId = await resolveArtifactId(input.projectId, input.scope.artifactId ?? null);
      if (artifactId === null) {
        throw new ProjectFileArtifactScopeError();
      }
      return { kind: "artifact", artifactId };
    })();

  const affectedPaths = [
    ...new Set([...input.files.map((file) => file.path), ...(input.removedPaths ?? [])]),
  ];
  const fileScope =
    resolvedScope.kind === "project"
      ? eq(projectFilesTable.projectId, input.projectId)
      : and(
          eq(projectFilesTable.projectId, input.projectId),
          eq(projectFilesTable.artifactId, resolvedScope.artifactId),
        );

  const authoritativeVersion = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS}ms`}, true)`,
    );
    await tx.execute(
      sql`select set_config('statement_timeout', ${`${PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS}ms`}, true)`,
    );

    if (input.replaceAll) {
      await tx.delete(projectFilesTable).where(fileScope);
    } else if (affectedPaths.length > 0) {
      await tx
        .delete(projectFilesTable)
        .where(and(fileScope, inArray(projectFilesTable.path, affectedPaths)));
    }

    if (input.files.length > 0) {
      await tx.insert(projectFilesTable).values(
        input.files.map((file) => ({
          projectId: input.projectId,
          artifactId: resolvedScope.kind === "artifact" ? resolvedScope.artifactId : null,
          path: file.path,
          content: file.content,
          mimeType: file.mimeType,
        })),
      );
    }

    if (!input.authoritativeVersion) return null;

    try {
      const snapshot = await tx
        .select({
          path: projectFilesTable.path,
          content: projectFilesTable.content,
          mimeType: projectFilesTable.mimeType,
        })
        .from(projectFilesTable)
        .where(eq(projectFilesTable.projectId, input.projectId));
      const [version] = await tx
        .insert(projectVersionsTable)
        .values({
          projectId: input.projectId,
          label: input.authoritativeVersion.label,
          note: input.authoritativeVersion.note,
          changelogEntry: input.authoritativeVersion.changelogEntry,
          filesSnapshot: snapshot,
          planSnapshot: input.authoritativeVersion.planSnapshot,
          planSourceMessageId: input.authoritativeVersion.planSourceMessageId,
        })
        .returning({ id: projectVersionsTable.id });
      if (!version) throw new ProjectFileVersionHandoffError();
      return { id: version.id, filesSnapshot: snapshot };
    } catch (error) {
      if (error instanceof ProjectFileVersionHandoffError) throw error;
      throw new ProjectFileVersionHandoffError({ cause: error });
    }
  });

  return { authoritativeVersion };
}
