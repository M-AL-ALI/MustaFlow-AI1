import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  databaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  projects: [{ id: 7 }, { id: 12 }],
  workerReady: vi.fn(() => true),
  preflight: vi.fn(),
  accept: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(async () => mocks.projects) })),
        })),
      })),
    },
  };
});
vi.mock("./durable-queue", () => ({
  QUEUE_PROJECT_RETIREMENT: "mustaflow.project-retirement",
  isDurableWorkerReady: mocks.workerReady,
}));
vi.mock("./project-retirement", () => ({
  preflightProjectRetirement: mocks.preflight,
  acceptProjectRetirement: mocks.accept,
  enqueueProjectRetirementOperation: mocks.enqueue,
}));

import {
  AccountErasureProjectRetirementError,
  acceptOwnedProjectsForAccountErasure,
} from "./account-erasure-project-retirement";

describe("account erasure project convergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects = [{ id: 7 }, { id: 12 }];
    mocks.workerReady.mockReturnValue(true);
    mocks.preflight.mockResolvedValue({ projectId: 7, state: "allowed" });
    mocks.accept
      .mockResolvedValueOnce({ operationId: "op-7", projectId: 7, state: "accepted" })
      .mockResolvedValueOnce({ operationId: "op-12", projectId: 12, state: "completed" });
    mocks.enqueue.mockResolvedValue({ state: "already_scheduled" });
  });

  it("refuses before any project mutation when the retirement worker is unavailable", async () => {
    mocks.workerReady.mockReturnValue(false);

    await expect(
      acceptOwnedProjectsForAccountErasure({ userId: "owner", requestedBy: "owner" }),
    ).rejects.toEqual(
      new AccountErasureProjectRetirementError("account_erasure_retirement_worker_unavailable"),
    );
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("preflights every active or legacy project before accepting any", async () => {
    mocks.preflight
      .mockResolvedValueOnce({ projectId: 7, state: "allowed" })
      .mockResolvedValueOnce({
        projectId: 12,
        state: "refused",
        code: "project_retirement_reconciliation_required",
      });

    await expect(
      acceptOwnedProjectsForAccountErasure({ userId: "owner", requestedBy: "owner" }),
    ).rejects.toMatchObject({ code: "project_retirement_reconciliation_required" });
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("accepts and durably schedules every project with legacy adoption enabled", async () => {
    await expect(
      acceptOwnedProjectsForAccountErasure({ userId: "owner", requestedBy: "owner" }),
    ).resolves.toEqual({ projectIds: [7, 12], operationIds: ["op-7", "op-12"] });

    expect(mocks.accept).toHaveBeenNthCalledWith(1, {
      projectId: 7,
      requestedBy: "owner",
      ownerId: "owner",
      allowLegacyDeleted: true,
    });
    expect(mocks.accept).toHaveBeenNthCalledWith(2, {
      projectId: 12,
      requestedBy: "owner",
      ownerId: "owner",
      allowLegacyDeleted: true,
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it("fails safely when a committed retirement receipt cannot be scheduled", async () => {
    mocks.enqueue.mockResolvedValueOnce({ state: "unavailable" });

    await expect(
      acceptOwnedProjectsForAccountErasure({ userId: "owner", requestedBy: "owner" }),
    ).rejects.toMatchObject({ code: "account_erasure_project_retirement_schedule_unavailable" });
  });
});
