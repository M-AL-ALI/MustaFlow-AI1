import {
  agentTasksTable,
  checkRunsTable,
  db,
  projectsTable,
  projectVersionsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import type { WorkspaceReadiness, WorkspaceReadinessContext } from "@workspace/ora-contracts";
import {
  readWorkspaceReadiness,
  type VersionBoundPublishReadinessInput,
  type WorkspaceReadinessSource,
} from "./workspace-readiness";

export const databaseWorkspaceReadinessSource: WorkspaceReadinessSource = {
  async loadTask(context) {
    const [task] = await db
      .select({
        id: agentTasksTable.id,
        projectId: agentTasksTable.projectId,
        status: agentTasksTable.status,
        terminal: agentTasksTable.terminal,
        report: agentTasksTable.report,
        stagingSnapshot: agentTasksTable.stagingSnapshot,
        appliedAt: agentTasksTable.appliedAt,
        discardedAt: agentTasksTable.discardedAt,
      })
      .from(agentTasksTable)
      .where(
        and(
          eq(agentTasksTable.id, context.subject.taskId),
          eq(agentTasksTable.projectId, context.projectId),
        ),
      );
    return task
      ? {
          id: task.id,
          projectId: task.projectId,
          status: task.status,
          terminal: task.terminal,
          report: task.report ?? null,
          stagedChangesPending:
            task.stagingSnapshot !== null && task.appliedAt === null && task.discardedAt === null,
        }
      : null;
  },
  async loadVersion(context) {
    const [version] = await db
      .select({
        id: projectVersionsTable.id,
        projectId: projectVersionsTable.projectId,
        validationStatus: projectVersionsTable.validationStatus,
      })
      .from(projectVersionsTable)
      .where(
        and(
          eq(projectVersionsTable.id, context.subject.versionId),
          eq(projectVersionsTable.projectId, context.projectId),
        ),
      );
    return version ?? null;
  },
  async loadCheckRuns(context) {
    return db
      .select({
        id: checkRunsTable.id,
        checkName: checkRunsTable.checkName,
        status: checkRunsTable.status,
      })
      .from(checkRunsTable)
      .where(
        and(
          eq(checkRunsTable.projectId, context.projectId),
          eq(checkRunsTable.taskId, context.subject.taskId),
        ),
      )
      .orderBy(asc(checkRunsTable.id));
  },
  async loadTesting(context) {
    const [project] = await db
      .select({
        status: projectsTable.testingStatus,
        testedSnapshotId: projectsTable.testedSnapshotId,
        candidateSnapshotId: projectsTable.testingCandidateSnapshotId,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, context.projectId));
    return project ?? null;
  },
};

export function readDatabaseWorkspaceReadiness(
  context: WorkspaceReadinessContext,
  publish: VersionBoundPublishReadinessInput | null,
): Promise<WorkspaceReadiness> {
  return readWorkspaceReadiness(context, publish, databaseWorkspaceReadinessSource);
}
