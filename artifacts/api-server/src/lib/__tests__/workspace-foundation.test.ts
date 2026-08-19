import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  nextWorkspaceId: 1,
  workspaces: [] as Array<Record<string, unknown>>,
  memberships: [] as Array<Record<string, unknown>>,
  creditUsers: new Set<string>(),
  failMembershipWrite: false,
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();

  function snapshot() {
    return {
      nextWorkspaceId: state.nextWorkspaceId,
      workspaces: structuredClone(state.workspaces),
      memberships: structuredClone(state.memberships),
      creditUsers: new Set(state.creditUsers),
    };
  }

  function restore(saved: ReturnType<typeof snapshot>) {
    state.nextWorkspaceId = saved.nextWorkspaceId;
    state.workspaces = saved.workspaces;
    state.memberships = saved.memberships;
    state.creditUsers = saved.creditUsers;
  }

  const tx = {
    execute: async () => [],
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === actual.workspacesTable ? state.workspaces.filter((w) => !w.deletedAt) : [];
          return {
            orderBy: () => ({ limit: async () => rows.slice(0, 1) }),
            limit: async () => rows.slice(0, 1),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (raw: Record<string, unknown>) => {
        if (table === actual.userCreditsTable) {
          return {
            onConflictDoNothing: async () => {
              state.creditUsers.add(String(raw.userId));
            },
          };
        }

        if (table === actual.workspaceMembersTable) {
          return {
            onConflictDoUpdate: async () => {
              if (state.failMembershipWrite) throw new Error("membership_write_failed");
              const index = state.memberships.findIndex(
                (m) => m.workspaceId === raw.workspaceId && m.userId === raw.userId,
              );
              if (index >= 0) state.memberships[index] = { ...state.memberships[index], ...raw };
              else state.memberships.push({ ...raw });
            },
          };
        }

        const created = {
          id: state.nextWorkspaceId++,
          description: null,
          deletedAt: null,
          createdAt: new Date("2026-08-18T00:00:00.000Z"),
          updatedAt: new Date("2026-08-18T00:00:00.000Z"),
          ...raw,
        };
        return {
          returning: async () => {
            state.workspaces.push(created);
            return [created];
          },
        };
      },
    }),
  };

  return {
    ...actual,
    db: {
      transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => {
        const saved = snapshot();
        try {
          return await callback(tx);
        } catch (error) {
          restore(saved);
          throw error;
        }
      },
    },
  };
});

import { WORKSPACE_MEMBER_ROLES, workspaceMemberRoleEnum } from "@workspace/db";
import {
  createOwnedWorkspace,
  defaultWorkspaceName,
  ensureUserSignupFoundation,
} from "../workspace-foundation";

describe("workspace foundation", () => {
  beforeEach(() => {
    state.nextWorkspaceId = 1;
    state.workspaces = [];
    state.memberships = [];
    state.creditUsers = new Set();
    state.failMembershipWrite = false;
  });

  it("ships the complete role enum", () => {
    expect(WORKSPACE_MEMBER_ROLES).toEqual(["owner", "admin", "builder", "viewer", "billing"]);
    expect(workspaceMemberRoleEnum.enumValues).toEqual(WORKSPACE_MEMBER_ROLES);
  });

  it("treats the name as display copy with the exact fallback", () => {
    expect(defaultWorkspaceName("  Ada   Lovelace ")).toBe("Ada Lovelace's workspace");
    expect(defaultWorkspaceName(" ")).toBe("My workspace");
    expect(defaultWorkspaceName(null)).toBe("My workspace");
  });

  it("collapses duplicate Clerk user.created delivery into one credits row, workspace, and membership", async () => {
    const first = await ensureUserSignupFoundation({ userId: "user-a", displayName: "Ada" });
    const second = await ensureUserSignupFoundation({ userId: "user-a", displayName: "Renamed" });

    expect(first.workspaceCreated).toBe(true);
    expect(second.workspaceCreated).toBe(false);
    expect(state.creditUsers).toEqual(new Set(["user-a"]));
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]).toMatchObject({
      ownerUserId: "user-a",
      name: "Ada's workspace",
    });
    expect(state.memberships).toEqual([
      expect.objectContaining({
        workspaceId: 1,
        userId: "user-a",
        role: "owner",
        invitedBy: "user-a",
      }),
    ]);
  });

  it("repairs the owner membership when signup finds an existing workspace", async () => {
    state.workspaces.push({
      id: 7,
      ownerUserId: "user-existing",
      name: "Existing label",
      type: "team",
      deletedAt: null,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      description: null,
    });

    const result = await ensureUserSignupFoundation({ userId: "user-existing" });

    expect(result.workspaceCreated).toBe(false);
    expect(state.workspaces).toHaveLength(1);
    expect(state.memberships).toEqual([
      expect.objectContaining({ workspaceId: 7, userId: "user-existing", role: "owner" }),
    ]);
  });

  it("rolls back a manual workspace if its owner membership cannot be written", async () => {
    state.failMembershipWrite = true;

    await expect(
      createOwnedWorkspace({ ownerUserId: "owner-a", name: "Label", type: "personal" }),
    ).rejects.toThrow("membership_write_failed");
    expect(state.workspaces).toEqual([]);
    expect(state.memberships).toEqual([]);
  });
});
