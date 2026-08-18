import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

const harness = vi.hoisted(() => {
  const queryResults: Array<Array<{ id: number }>> = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = queryResults.shift() ?? [];
          return {
            limit: vi.fn(async () => rows),
            orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
          };
        }),
      })),
    })),
  }));
  return { queryResults, select };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { ...original.db, select: harness.select } };
});

import { ProjectWorkspaceUnavailableError, resolveProjectWorkspaceId } from "../workspace-tenancy";

describe("project workspace selection", () => {
  beforeEach(() => {
    harness.queryResults.length = 0;
    harness.select.mockClear();
  });

  it("honors a requested workspace after live membership is proven", async () => {
    harness.queryResults.push([{ id: 41 }]);

    await expect(
      resolveProjectWorkspaceId({ userId: "collaborator", requestedWorkspaceId: 41 }),
    ).resolves.toBe(41);
    expect(harness.select).toHaveBeenCalledTimes(1);
  });

  it("falls back to the caller's deterministic default for an unauthorized hostile id", async () => {
    harness.queryResults.push([], [{ id: 7 }]);

    await expect(
      resolveProjectWorkspaceId({ userId: "caller", requestedWorkspaceId: 999_999 }),
    ).resolves.toBe(7);
    expect(harness.select).toHaveBeenCalledTimes(2);
  });

  it("uses the default directly when no hint is supplied", async () => {
    harness.queryResults.push([{ id: 7 }]);

    await expect(resolveProjectWorkspaceId({ userId: "owner" })).resolves.toBe(7);
    expect(harness.select).toHaveBeenCalledTimes(1);
  });

  it("fails closed when no active owner workspace exists", async () => {
    harness.queryResults.push([]);

    await expect(resolveProjectWorkspaceId({ userId: "ownerless" })).rejects.toBeInstanceOf(
      ProjectWorkspaceUnavailableError,
    );
  });
});
