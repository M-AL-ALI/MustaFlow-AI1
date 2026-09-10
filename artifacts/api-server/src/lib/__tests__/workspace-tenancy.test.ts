import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

const harness = vi.hoisted(() => {
  const queryResults: Array<Array<{ id: number }>> = [];
  const conditions: SQL[] = [];
  const joins: SQL[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn((_table, condition: SQL) => {
        joins.push(condition);
        return {
          where: vi.fn((condition: SQL) => {
            conditions.push(condition);
            const rows = queryResults.shift() ?? [];
            return {
              limit: vi.fn(async () => rows),
              orderBy: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
            };
          }),
        };
      }),
    })),
  }));
  return { queryResults, select, conditions, joins };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { ...original.db, select: harness.select } };
});

import { ProjectWorkspaceUnavailableError, resolveProjectWorkspaceId } from "../workspace-tenancy";

describe("project workspace selection", () => {
  beforeEach(() => {
    harness.queryResults.length = 0;
    harness.conditions.length = 0;
    harness.joins.length = 0;
    harness.select.mockClear();
  });

  it("honors a requested workspace after live membership is proven", async () => {
    harness.queryResults.push([{ id: 41 }]);

    await expect(
      resolveProjectWorkspaceId({ userId: "collaborator", requestedWorkspaceId: 41 }),
    ).resolves.toBe(41);
    expect(harness.select).toHaveBeenCalledTimes(1);
  });

  it("denies an unavailable explicit destination even when an owner default exists", async () => {
    harness.queryResults.push([], [{ id: 7 }]);

    await expect(
      resolveProjectWorkspaceId({ userId: "caller", requestedWorkspaceId: 999_999 }),
    ).rejects.toBeInstanceOf(ProjectWorkspaceUnavailableError);
    expect(harness.select).toHaveBeenCalledTimes(1);
    expect(harness.queryResults).toEqual([[{ id: 7 }]]);
  });

  it.each(["owner", "admin", "builder", "viewer", "billing"])(
    "enforces the %s role in the emitted destination predicate",
    async (role) => {
      const allowed = ["owner", "admin", "builder"].includes(role);
      harness.queryResults.push(allowed ? [{ id: 41 }] : []);
      const result = resolveProjectWorkspaceId({ userId: "member", requestedWorkspaceId: 41 });
      if (allowed) await expect(result).resolves.toBe(41);
      else await expect(result).rejects.toBeInstanceOf(ProjectWorkspaceUnavailableError);
      const predicate = new PgDialect().sqlToQuery(harness.conditions[0]);
      const membership = new PgDialect().sqlToQuery(harness.joins[0]);
      expect(predicate.sql).toContain('"workspace_members"."role" in');
      expect(predicate.sql).toContain('"workspaces"."deleted_at" is null');
      expect(predicate.params).toEqual([41, "owner", "admin", "builder"]);
      expect(predicate.params.includes(role)).toBe(allowed);
      expect(membership.sql).toContain('"workspace_members"."user_id"');
      expect(membership.params).toEqual(["member"]);
      expect(harness.select).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    2147483648,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects malformed explicit destination %s before querying", async (requestedWorkspaceId) => {
    await expect(
      resolveProjectWorkspaceId({ userId: "member", requestedWorkspaceId }),
    ).rejects.toBeInstanceOf(ProjectWorkspaceUnavailableError);
    expect(harness.select).not.toHaveBeenCalled();
  });

  it("rejects conflicting binding and preferred destinations", async () => {
    await expect(
      resolveProjectWorkspaceId({
        userId: "member",
        requestedWorkspaceId: 4,
        preferredWorkspaceId: 5,
      }),
    ).rejects.toBeInstanceOf(ProjectWorkspaceUnavailableError);
    expect(harness.select).not.toHaveBeenCalled();
  });

  it("keeps a copy in its preferred workspace when creation authority is present", async () => {
    harness.queryResults.push([{ id: 41 }]);
    await expect(
      resolveProjectWorkspaceId({ userId: "member", preferredWorkspaceId: 41 }),
    ).resolves.toBe(41);
    expect(harness.select).toHaveBeenCalledTimes(1);
  });

  it("preserves copy fallback to an owner workspace when the preference is unavailable", async () => {
    harness.queryResults.push([], [{ id: 7 }]);
    await expect(
      resolveProjectWorkspaceId({ userId: "member", preferredWorkspaceId: 41 }),
    ).resolves.toBe(7);
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(new PgDialect().sqlToQuery(harness.joins[1]).params).toEqual(["member", "owner"]);
  });

  it("treats a null destination as the existing owner-default flow", async () => {
    harness.queryResults.push([{ id: 7 }]);
    await expect(
      resolveProjectWorkspaceId({ userId: "member", requestedWorkspaceId: null }),
    ).resolves.toBe(7);
    expect(harness.select).toHaveBeenCalledTimes(1);
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
