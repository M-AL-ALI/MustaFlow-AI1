import { describe, expect, it } from "vitest";
import { selectLingeringCompletedTask } from "./builder-task-queue";

describe("Builder task queue completed-task linger", () => {
  const older = {
    id: 101,
    title: "Older build",
    status: "completed",
    completionKind: "finalized",
    createdAt: "2026-07-27T17:50:00.000Z",
    completedAt: "2026-07-27T18:00:00.000Z",
  };
  const latest = {
    id: 102,
    title: "Latest build",
    status: "completed",
    completionKind: "step_cap",
    createdAt: "2026-07-27T18:50:00.000Z",
    completedAt: "2026-07-27T19:00:00.000Z",
  };

  it("keeps the most recently completed task visible while the queue is idle", () => {
    expect(selectLingeringCompletedTask([older, latest], false)).toBe(latest);
  });

  it("removes the lingering task as soon as the next task starts", () => {
    expect(selectLingeringCompletedTask([older, latest], true)).toBeUndefined();
  });

  it("replaces the prior lingered task when a newer task completes", () => {
    const newest = {
      ...latest,
      id: 103,
      title: "Newest build",
      createdAt: "2026-07-27T19:50:00.000Z",
      completedAt: "2026-07-27T20:00:00.000Z",
    };
    expect(selectLingeringCompletedTask([older, latest, newest], false)).toBe(newest);
  });

  it("uses completion time when builds finish out of creation order", () => {
    const createdLaterButFinishedEarlier = {
      ...latest,
      id: 103,
      createdAt: "2026-07-27T19:10:00.000Z",
      completedAt: "2026-07-27T19:20:00.000Z",
    };
    const createdEarlierButFinishedLast = {
      ...older,
      id: 104,
      createdAt: "2026-07-27T19:00:00.000Z",
      completedAt: "2026-07-27T19:30:00.000Z",
    };

    expect(
      selectLingeringCompletedTask(
        [createdLaterButFinishedEarlier, createdEarlierButFinishedLast],
        false,
      ),
    ).toBe(createdEarlierButFinishedLast);
  });

  it("does not resurrect an older completed chip after a newer started task fails", () => {
    const failed = {
      id: 103,
      title: "Failed follow-up",
      status: "failed",
      createdAt: "2026-07-27T19:50:00.000Z",
      completedAt: "2026-07-27T20:00:00.000Z",
    };
    expect(selectLingeringCompletedTask([older, latest, failed], false)).toBeUndefined();
  });
});
