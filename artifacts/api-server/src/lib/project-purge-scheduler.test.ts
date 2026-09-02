import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_PURGE_SCHEDULER_BATCH_LIMIT,
  dispatchDueProjectPurges,
  dispatchProjectPurgeMilestones,
  runProjectPurgeScheduler,
  scheduleLegacyProjectPurges,
  type LegacyPurgeCandidate,
  type ProjectPurgeSchedulerStore,
} from "./project-purge-scheduler";

function candidate(projectId: number): LegacyPurgeCandidate {
  return {
    projectId,
    ownerId: `user_${projectId}`,
    projectName: `Project ${projectId}`,
    deletedAt: "2024-01-01T00:00:00.000Z",
    retirementOperationId: null,
  };
}

function store(overrides: Partial<ProjectPurgeSchedulerStore> = {}): ProjectPurgeSchedulerStore {
  return {
    listLegacyCandidates: vi.fn(async () => []),
    scheduleLegacyCandidate: vi.fn(async () => null),
    listDueScheduled: vi.fn(async () => []),
    transitionDueToAccepted: vi.fn(async () => false),
    listDueNotificationMilestones: vi.fn(async () => []),
    ...overrides,
  };
}

describe("project purge scheduler", () => {
  it("caps every scheduler read at fifty", async () => {
    const listLegacyCandidates = vi.fn(async () => []);
    const subject = store({ listLegacyCandidates });

    await scheduleLegacyProjectPurges(subject, 999);

    expect(listLegacyCandidates).toHaveBeenCalledWith(PROJECT_PURGE_SCHEDULER_BATCH_LIMIT);
  });

  it("refuses non-positive and fractional batch sizes", async () => {
    const subject = store();
    await expect(scheduleLegacyProjectPurges(subject, 0)).rejects.toThrow(
      "project_purge_scheduler_limit_invalid",
    );
    await expect(scheduleLegacyProjectPurges(subject, 1.5)).rejects.toThrow(
      "project_purge_scheduler_limit_invalid",
    );
  });

  it("schedules every legacy tombstone through the database-clock store", async () => {
    const scheduleLegacyCandidate = vi.fn(async (item: LegacyPurgeCandidate) => ({
      operationId: `purge_${item.projectId}`,
      projectId: item.projectId,
    }));
    const subject = store({
      listLegacyCandidates: vi.fn(async () => [candidate(1), candidate(2)]),
      scheduleLegacyCandidate,
    });

    const result = await scheduleLegacyProjectPurges(subject);

    expect(result).toEqual({ inspected: 2, scheduled: ["purge_1", "purge_2"] });
    expect(scheduleLegacyCandidate).toHaveBeenNthCalledWith(1, candidate(1));
    expect(scheduleLegacyCandidate).toHaveBeenNthCalledWith(2, candidate(2));
  });

  it("rejects a store that violates the bounded-read contract", async () => {
    const subject = store({
      listLegacyCandidates: vi.fn(async () =>
        Array.from({ length: 3 }, (_, index) => candidate(index + 1)),
      ),
    });
    await expect(scheduleLegacyProjectPurges(subject, 2)).rejects.toThrow(
      "project_purge_scheduler_store_unbounded",
    );
  });

  it("enqueues only operations whose due transition wins", async () => {
    const enqueue = vi.fn(async () => undefined);
    const subject = store({
      listDueScheduled: vi.fn(async () => [
        { operationId: "purge_a", projectId: 1 },
        { operationId: "purge_b", projectId: 2 },
      ]),
      transitionDueToAccepted: vi.fn(async (id) => id === "purge_a"),
    });

    const result = await dispatchDueProjectPurges({ store: subject, enqueue });

    expect(result).toEqual({ inspected: 2, enqueued: ["purge_a"], failures: [] });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith("purge_a");
  });

  it("defers an ineligible due tombstone so a bounded page cannot starve later purges", () => {
    const source = readFileSync(new URL("./project-purge-scheduler.ts", import.meta.url), "utf8");
    const ineligible = source.slice(
      source.indexOf("!owner ||"),
      source.indexOf("const transitioned = await tx"),
    );

    expect(ineligible).toContain("nextAttemptAt: sql`now() + interval '1 day'`");
    expect(ineligible).toContain('eq(projectPurgeOperationsTable.state, "scheduled")');
  });

  it("receipts enqueue failures without claiming deletion failed or succeeded", async () => {
    const onEnqueueFailure = vi.fn(async () => undefined);
    const subject = store({
      listDueScheduled: vi.fn(async () => [{ operationId: "purge_a", projectId: 1 }]),
      transitionDueToAccepted: vi.fn(async () => true),
    });
    const failure = new Error("queue unavailable");

    const result = await dispatchDueProjectPurges({
      store: subject,
      enqueue: vi.fn(async () => {
        throw failure;
      }),
      onEnqueueFailure,
    });

    expect(result).toEqual({ inspected: 1, enqueued: [], failures: ["purge_a"] });
    expect(onEnqueueFailure).toHaveBeenCalledWith("purge_a", failure);
  });

  it("delivers milestones independently and continues after one delivery fails", async () => {
    const trash = {
      operationId: "purge_a",
      recipientUserId: "user_a",
      milestone: "trash" as const,
      projectId: 1,
      projectName: "A",
      dueAt: "2026-10-01T00:00:00Z",
    };
    const warning = { ...trash, operationId: "purge_b", milestone: "seven_day" as const };
    const subject = store({ listDueNotificationMilestones: vi.fn(async () => [trash, warning]) });
    const onNotificationFailure = vi.fn(async () => undefined);

    const result = await dispatchProjectPurgeMilestones({
      store: subject,
      deliverMilestone: vi.fn(async (input) => {
        if (input.operationId === "purge_a") throw new Error("email row unavailable");
      }),
      onNotificationFailure,
    });

    expect(result.delivered).toEqual([{ operationId: "purge_b", milestone: "seven_day" }]);
    expect(result.failures).toEqual([{ operationId: "purge_a", milestone: "trash" }]);
    expect(onNotificationFailure).toHaveBeenCalledOnce();
  });

  it("runs backfill, queue dispatch, and milestone delivery in one bounded pass", async () => {
    const subject = store({
      listLegacyCandidates: vi.fn(async () => [candidate(1)]),
      scheduleLegacyCandidate: vi.fn(async () => ({ operationId: "legacy", projectId: 1 })),
      listDueScheduled: vi.fn(async () => [{ operationId: "due", projectId: 2 }]),
      transitionDueToAccepted: vi.fn(async () => true),
      listDueNotificationMilestones: vi.fn(async () => [
        {
          operationId: "legacy",
          recipientUserId: "user_1",
          milestone: "trash" as const,
          projectId: 1,
          projectName: "Project 1",
          dueAt: "2026-10-01T00:00:00Z",
        },
      ]),
    });

    const result = await runProjectPurgeScheduler({
      store: subject,
      enqueue: vi.fn(async () => undefined),
      deliverMilestone: vi.fn(async () => undefined),
    });

    expect(result.legacyScheduled).toEqual(["legacy"]);
    expect(result.acceptedAndEnqueued).toEqual(["due"]);
    expect(result.notificationsDelivered).toEqual([{ operationId: "legacy", milestone: "trash" }]);
  });
});
