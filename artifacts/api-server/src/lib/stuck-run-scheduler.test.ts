import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateResults, insertedEvents, drainNextProjectTask, inArray } = vi.hoisted(() => ({
  updateResults: [] as Array<Array<{ id: number; projectId: number }>>,
  insertedEvents: [] as Array<Record<string, unknown>>,
  drainNextProjectTask: vi.fn().mockResolvedValue(undefined),
  inArray: vi.fn(() => ({})),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  inArray,
  sql: vi.fn(() => ({})),
}));

vi.mock("@workspace/db", () => {
  const agentTasksTable = {
    id: "id",
    projectId: "projectId",
    status: "status",
    startedAt: "startedAt",
    createdAt: "createdAt",
    lastHeartbeatAt: "lastHeartbeatAt",
  };
  return {
    agentTasksTable,
    taskEventsTable: {},
    db: {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateResults.shift() ?? []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Record<string, unknown> | Array<Record<string, unknown>>) => {
          if (Array.isArray(value)) insertedEvents.push(...value);
          else insertedEvents.push(value);
          return [];
        }),
      })),
    },
  };
});

vi.mock("./jobs", () => ({ drainNextProjectTask }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sweepStuckRuns } from "./stuck-run-scheduler";

describe("stuck-run scheduler planning adoption", () => {
  beforeEach(() => {
    updateResults.length = 0;
    insertedEvents.length = 0;
    drainNextProjectTask.mockClear();
    inArray.mockClear();
  });

  it("sweeps both mutation and answer tasks without treating answering as a build lock", async () => {
    updateResults.push([], []);

    await sweepStuckRuns();

    expect(inArray).toHaveBeenCalledWith("status", ["building", "answering"]);
  });

  it("atomically adopts a stale never-started planning task and nudges it once", async () => {
    updateResults.push([{ id: 22, projectId: 12 }], []);

    await sweepStuckRuns();
    await Promise.resolve();

    expect(insertedEvents).toContainEqual(
      expect.objectContaining({ taskId: 22, eventType: "dispatch_recovered" }),
    );
    expect(drainNextProjectTask).toHaveBeenCalledTimes(1);
    expect(drainNextProjectTask).toHaveBeenCalledWith(12, 22);
  });

  it("does not nudge when another replica already adopted the row", async () => {
    updateResults.push([], []);

    await sweepStuckRuns();
    await Promise.resolve();

    expect(drainNextProjectTask).not.toHaveBeenCalled();
    expect(insertedEvents).toEqual([]);
  });
});
