import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  selectResults: [] as unknown[][],
  select: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => {
    const rows = mocks.selectResults.shift() ?? [];
    const query = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(async () => rows),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    return query;
  });
  return { ...original, db: { ...original.db, select: mocks.select } };
});

describe("authorization lockdown: canonical project access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
  });

  it("grants the active project owner", async () => {
    mocks.selectResults = [[{ ownerId: "owner", organizationId: null }]];
    const { checkProjectAccess } = await import("../auth");

    await expect(checkProjectAccess("owner", 1401, "admin")).resolves.toBe("granted");
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it("grants a live organization collaborator whose role meets the minimum", async () => {
    mocks.selectResults = [[{ ownerId: "owner", organizationId: 81 }], [{ role: "admin" }]];
    const { checkProjectAccess } = await import("../auth");

    await expect(checkProjectAccess("collaborator", 1402, "member")).resolves.toBe("granted");
  });

  it("denies when no live organization membership survives the active-org join", async () => {
    mocks.selectResults = [[{ ownerId: "owner", organizationId: 82 }], []];
    const { checkProjectAccess } = await import("../auth");

    await expect(checkProjectAccess("former-collaborator", 1403)).resolves.toBe("denied");
  });

  it("denies a live collaborator below the route's required role", async () => {
    mocks.selectResults = [[{ ownerId: "owner", organizationId: 83 }], [{ role: "viewer" }]];
    const { checkProjectAccess } = await import("../auth");

    await expect(checkProjectAccess("viewer", 1404, "member")).resolves.toBe("denied");
  });

  it("lists owned and live-organization projects returned by the central scope query", async () => {
    mocks.selectResults = [[{ organizationId: 84, role: "viewer" }], [{ id: 1405 }, { id: 1406 }]];
    const { listAccessibleProjectIds } = await import("../auth");

    await expect(listAccessibleProjectIds("collaborator", "viewer")).resolves.toEqual([1405, 1406]);
  });

  it("gives an unauthorized caller the same project response for existing and missing ids", async () => {
    const { requireProjectOwnership } = await import("../auth");

    const invoke = async (rows: unknown[]) => {
      mocks.selectResults = [rows];
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const next = vi.fn();
      const req = {
        userId: "requester",
        params: { id: "1407" },
      } as unknown as Request;
      const selectCallsBefore = mocks.select.mock.calls.length;

      await requireProjectOwnership(
        req,
        { status } as unknown as Response,
        next as unknown as NextFunction,
      );

      return {
        status: status.mock.calls,
        body: json.mock.calls,
        nextCalls: next.mock.calls.length,
        selectCalls: mocks.select.mock.calls.length - selectCallsBefore,
      };
    };

    const existingOtherOwner = await invoke([{ ownerId: "different-owner" }]);
    const nonexistent = await invoke([]);

    expect(existingOtherOwner).toEqual(nonexistent);
    expect(existingOtherOwner).toEqual({
      status: [[404]],
      body: [[{ error: "Project not found" }]],
      nextCalls: 0,
      selectCalls: 1,
    });
  });

  it("keeps owner access on the same single-query path", async () => {
    mocks.selectResults = [[{ ownerId: "owner" }]];
    const { requireProjectOwnership } = await import("../auth");
    const status = vi.fn();
    const next = vi.fn();

    await requireProjectOwnership(
      { userId: "owner", params: { id: "1408" } } as unknown as Request,
      { status } as unknown as Response,
      next as unknown as NextFunction,
    );

    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
