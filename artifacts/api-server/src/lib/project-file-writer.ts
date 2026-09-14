import type { Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentTasksTable,
  projectArtifactsTable,
  projectFilesTable,
  projectsTable,
  projectVersionsTable,
  type FileSnapshotEntry,
} from "@workspace/db";
import type { BuilderFile } from "./builder";
import { selectPrimaryArtifactFiles } from "./primary-artifact-files";
import {
  describeCommittedFileChanges,
  type EffectiveFileChange,
} from "./committed-build-file-report";
import { FailedDraftRecoveryError, failedDraftFingerprint } from "./zero-sealed-failed-draft";
import { resolveArtifactId } from "./artifacts";
import { PROJECT_LIFECYCLE_LOCK_NAMESPACE } from "./project-retirement-contract";
import {
  transactionHoldsProjectLifecycleLock,
  withResponseProjectLifecycleTransaction,
} from "./project-lifecycle";
import { reconcileProjectFileAssetUsage } from "./project-file-asset-usage";

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

export class ProjectFileWriteError extends Error {
  readonly code = "project_file_write_failed";

  constructor(options?: ErrorOptions) {
    super(
      "Your project changes could not be saved. Nothing was changed; please try again.",
      options,
    );
    this.name = "ProjectFileWriteError";
  }
}

export class ProjectInactiveWriteError extends Error {
  readonly code = "project_inactive";

  constructor() {
    super("This project is in Trash and cannot be changed.");
    this.name = "ProjectInactiveWriteError";
  }
}

export type ProjectFileWriteScope =
  | { kind: "artifact"; artifactId?: number | null }
  | { kind: "project" };

export interface ProjectFileMutation {
  /** Internal foreground request only; expired responses must reacquire the lock. */
  lifecycleResponse?: Response;
  projectId: number;
  files: BuilderFile[];
  replaceAll: boolean;
  scope: ProjectFileWriteScope;
  removedPaths?: string[];
  /** Opt-in evidence of the effective artifact view, captured under the write lock. */
  captureEffectiveFileChanges?: boolean;
  /** Compare-and-write fence for sealed drafts, checked under the lifecycle lock. */
  expectedBase?: { fingerprint: string; taskId: number; ownerUserId: string };
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
  effectiveFileChanges?: EffectiveFileChange[];
}

/**
 * Replace or patch one explicitly requested mutable file scope in a bounded transaction.
 * A failed delete, insert, or timeout leaves the previously committed rows unchanged.
 */
export function writeProjectFilesAtomically(
  input: ProjectFileMutation & { captureEffectiveFileChanges: true },
): Promise<ProjectFileWriteReceipt & { effectiveFileChanges: EffectiveFileChange[] }>;
export function writeProjectFilesAtomically(
  input: ProjectFileMutation,
): Promise<ProjectFileWriteReceipt>;
export async function writeProjectFilesAtomically(
  input: ProjectFileMutation,
): Promise<ProjectFileWriteReceipt> {
  let resolvedScope: { kind: "artifact"; artifactId: number } | { kind: "project" };
  try {
    resolvedScope = await (async (): Promise<
      { kind: "artifact"; artifactId: number } | { kind: "project" }
    > => {
      if (input.scope.kind === "project") return { kind: "project" };

      const artifactId = await resolveArtifactId(input.projectId, input.scope.artifactId ?? null);
      if (artifactId === null) {
        throw new ProjectFileArtifactScopeError();
      }
      return { kind: "artifact", artifactId };
    })();
  } catch (error) {
    if (error instanceof ProjectFileArtifactScopeError) throw error;
    throw new ProjectFileWriteError({ cause: error });
  }

  if (input.captureEffectiveFileChanges && resolvedScope.kind !== "artifact") {
    throw new ProjectFileArtifactScopeError();
  }

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

  let authoritativeVersion: { id: number; filesSnapshot: FileSnapshotEntry[] } | null;
  let effectiveFileChanges: EffectiveFileChange[] | undefined;
  try {
    const lifecycleResponse =
      input.lifecycleResponse &&
      !input.lifecycleResponse.destroyed &&
      !input.lifecycleResponse.writableEnded
        ? input.lifecycleResponse
        : undefined;
    authoritativeVersion = await withResponseProjectLifecycleTransaction(
      lifecycleResponse,
      input.projectId,
      async (tx) => {
        await tx.execute(
          sql`select set_config('lock_timeout', ${`${PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS}ms`}, true)`,
        );
        await tx.execute(
          sql`select set_config('statement_timeout', ${`${PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS}ms`}, true)`,
        );
        // Reuse only a private, authenticated witness for this exact transaction.
        // A queued job has no response and must acquire its own lifecycle lock.
        if (!transactionHoldsProjectLifecycleLock(tx, input.projectId)) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${input.projectId})`,
          );
        }
        const [activeProject] = await tx
          .select({ id: projectsTable.id, ownerId: projectsTable.ownerId })
          .from(projectsTable)
          .where(and(eq(projectsTable.id, input.projectId), isNull(projectsTable.deletedAt)))
          .limit(1);
        if (!activeProject) throw new ProjectInactiveWriteError();

        if (input.expectedBase) {
          const guard = input.expectedBase;
          if (resolvedScope.kind !== "artifact" || activeProject.ownerId !== guard.ownerUserId)
            throw new FailedDraftRecoveryError();
          const [task] = await tx
            .select({ status: agentTasksTable.status })
            .from(agentTasksTable)
            .where(
              and(
                eq(agentTasksTable.id, guard.taskId),
                eq(agentTasksTable.projectId, input.projectId),
              ),
            )
            .limit(1)
            .for("update");
          if (!task || task.status !== "building")
            throw new FailedDraftRecoveryError(
              "This run stopped before its files could be saved. Nothing was changed.",
            );
          const [primary] = await tx
            .select({ id: projectArtifactsTable.id })
            .from(projectArtifactsTable)
            .where(
              and(
                eq(projectArtifactsTable.projectId, input.projectId),
                eq(projectArtifactsTable.isPrimary, true),
                isNull(projectArtifactsTable.deletedAt),
              ),
            )
            .limit(1);
          if (primary?.id !== resolvedScope.artifactId) throw new FailedDraftRecoveryError();
          const rows = await tx
            .select({
              projectId: projectFilesTable.projectId,
              artifactId: projectFilesTable.artifactId,
              path: projectFilesTable.path,
              content: projectFilesTable.content,
              mimeType: projectFilesTable.mimeType,
            })
            .from(projectFilesTable)
            .where(eq(projectFilesTable.projectId, input.projectId));
          if (
            failedDraftFingerprint(
              selectPrimaryArtifactFiles(rows, input.projectId, resolvedScope.artifactId),
            ) !== guard.fingerprint
          ) {
            throw new FailedDraftRecoveryError(
              "The project changed while this build was running. Your newer files were kept; nothing was overwritten.",
            );
          }
        }

        const readEffectiveFiles = async () => {
          const rows = await tx
            .select({
              projectId: projectFilesTable.projectId,
              artifactId: projectFilesTable.artifactId,
              path: projectFilesTable.path,
              content: projectFilesTable.content,
              mimeType: projectFilesTable.mimeType,
            })
            .from(projectFilesTable)
            .where(eq(projectFilesTable.projectId, input.projectId));
          return selectPrimaryArtifactFiles(
            rows,
            input.projectId,
            resolvedScope.kind === "artifact" ? resolvedScope.artifactId : null,
          );
        };
        const effectiveBefore = input.captureEffectiveFileChanges
          ? await readEffectiveFiles()
          : null;

        const reconciliationPaths = new Set(affectedPaths);
        if (input.replaceAll) {
          const priorFiles = await tx
            .select({ path: projectFilesTable.path })
            .from(projectFilesTable)
            .where(fileScope);
          for (const file of priorFiles) reconciliationPaths.add(file.path);
        }

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

        const nextContentByPath = new Map(input.files.map((file) => [file.path, file.content]));
        for (const filePath of reconciliationPaths) {
          await reconcileProjectFileAssetUsage(tx, {
            projectId: input.projectId,
            artifactId: resolvedScope.kind === "artifact" ? resolvedScope.artifactId : null,
            filePath,
            nextContent: nextContentByPath.get(filePath) ?? null,
          });
        }

        if (effectiveBefore !== null) {
          effectiveFileChanges = describeCommittedFileChanges(
            effectiveBefore,
            await readEffectiveFiles(),
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
      },
    );
  } catch (error) {
    if (error instanceof ProjectInactiveWriteError) throw error;
    if (error instanceof FailedDraftRecoveryError) throw error;
    if (error instanceof ProjectFileVersionHandoffError) throw error;
    throw new ProjectFileWriteError({ cause: error });
  }

  return {
    authoritativeVersion,
    ...(effectiveFileChanges === undefined ? {} : { effectiveFileChanges }),
  };
}
