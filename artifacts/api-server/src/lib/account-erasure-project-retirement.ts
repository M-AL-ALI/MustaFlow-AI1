import { db, projectsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { isDurableWorkerReady, QUEUE_PROJECT_RETIREMENT } from "./durable-queue";
import {
  acceptProjectRetirement,
  enqueueProjectRetirementOperation,
  preflightProjectRetirement,
} from "./project-retirement";

export class AccountErasureProjectRetirementError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccountErasureProjectRetirementError";
  }
}

/**
 * Move every project still owned by an account through the same durable
 * retirement coordinator used by the project Trash surface. The read-only
 * pass happens before the first acceptance so a known refusal never leaves a
 * partially retired account. Each acceptance repeats the decision under the
 * project lifecycle lock, and every receipt must be durably scheduled before
 * account credentials or personal data may be minimized.
 */
export async function acceptOwnedProjectsForAccountErasure(input: {
  userId: string;
  requestedBy: string;
}): Promise<{ projectIds: number[]; operationIds: string[] }> {
  if (!isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)) {
    throw new AccountErasureProjectRetirementError("account_erasure_retirement_worker_unavailable");
  }

  const projects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.ownerId, input.userId))
    .orderBy(asc(projectsTable.id));

  for (const project of projects) {
    const preflight = await preflightProjectRetirement({
      projectId: project.id,
      ownerId: input.userId,
      allowLegacyDeleted: true,
    });
    if (!preflight || preflight.state !== "allowed") {
      throw new AccountErasureProjectRetirementError(
        preflight?.state === "refused"
          ? preflight.code
          : "account_erasure_project_retirement_unavailable",
      );
    }
  }

  const operationIds: string[] = [];
  for (const project of projects) {
    const accepted = await acceptProjectRetirement({
      projectId: project.id,
      requestedBy: input.requestedBy,
      ownerId: input.userId,
      allowLegacyDeleted: true,
    });
    if (!accepted || accepted.state === "refused") {
      throw new AccountErasureProjectRetirementError(
        accepted?.state === "refused"
          ? accepted.code
          : "account_erasure_project_retirement_unavailable",
      );
    }
    const scheduling = await enqueueProjectRetirementOperation(accepted.operationId);
    if (scheduling.state === "unavailable") {
      throw new AccountErasureProjectRetirementError(
        "account_erasure_project_retirement_schedule_unavailable",
      );
    }
    operationIds.push(accepted.operationId);
  }

  return { projectIds: projects.map((project) => project.id), operationIds };
}
