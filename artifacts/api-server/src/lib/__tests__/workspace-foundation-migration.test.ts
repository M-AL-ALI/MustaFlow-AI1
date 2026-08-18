import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
});

import { applyWorkspaceFoundationMigration } from "../startup-migrations";

type WorkspaceRow = {
  id: number;
  owner_user_id: string;
  name: string;
  deleted_at: Date | null;
  created_at: Date;
};

class WorkspaceMigrationClient {
  readonly statements: string[] = [];
  readonly workspaces: WorkspaceRow[] = [
    {
      id: 1,
      owner_user_id: "user-active",
      name: "Existing active",
      deleted_at: null,
      created_at: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      id: 2,
      owner_user_id: "user-deleted",
      name: "Existing deleted",
      deleted_at: new Date("2026-01-01T00:00:00.000Z"),
      created_at: new Date("2025-02-01T00:00:00.000Z"),
    },
  ];
  readonly members = new Map<string, "owner">();
  readonly existingUsers = ["user-active", "user-deleted", "user-new", "user-project-only"];
  readonly displayNames = new Map([["user-new", "Casey"]]);
  nextWorkspaceId = 3;

  async query(text: string, params: unknown[] = []) {
    this.statements.push(text);

    if (/WITH existing_users AS/i.test(text)) {
      const created: WorkspaceRow[] = [];
      for (const userId of this.existingUsers) {
        const hasActive = this.workspaces.some(
          (workspace) => workspace.owner_user_id === userId && workspace.deleted_at === null,
        );
        if (hasActive) continue;
        const displayName = this.displayNames.get(userId);
        const workspace: WorkspaceRow = {
          id: this.nextWorkspaceId++,
          owner_user_id: userId,
          name: displayName ? `${displayName}'s workspace` : "My workspace",
          deleted_at: null,
          created_at: new Date("2026-08-18T00:00:00.000Z"),
        };
        this.workspaces.push(workspace);
        created.push(workspace);
      }
      return { rows: created, rowCount: created.length };
    }

    if (/INSERT INTO workspace_members/i.test(text) && /WHERE id = ANY/i.test(text)) {
      const ids = new Set((params[0] as number[]) ?? []);
      const created = this.workspaces
        .filter((workspace) => ids.has(workspace.id))
        .filter((workspace) => {
          const key = `${workspace.id}:${workspace.owner_user_id}`;
          if (this.members.has(key)) return false;
          this.members.set(key, "owner");
          return true;
        })
        .map((workspace) => ({ workspace_id: workspace.id }));
      return { rows: created, rowCount: created.length };
    }

    if (/INSERT INTO workspace_members/i.test(text) && /SELECT id, owner_user_id/i.test(text)) {
      const created = this.workspaces
        .filter((workspace) => {
          const key = `${workspace.id}:${workspace.owner_user_id}`;
          if (this.members.has(key)) return false;
          this.members.set(key, "owner");
          return true;
        })
        .map((workspace) => ({ workspace_id: workspace.id }));
      return { rows: created, rowCount: created.length };
    }

    if (/SELECT COUNT\(\*\)::text AS count/i.test(text)) {
      const count = this.workspaces.filter(
        (workspace) => !this.members.has(`${workspace.id}:${workspace.owner_user_id}`),
      ).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    return { rows: [], rowCount: null };
  }
}

function asMigrationClient(client: WorkspaceMigrationClient) {
  return client as unknown as Pick<PoolClient, "query">;
}

describe("workspace foundation startup migration", () => {
  it("backfills every owner, creates missing defaults, and is a no-op on the second run", async () => {
    const client = new WorkspaceMigrationClient();

    const first = await applyWorkspaceFoundationMigration(asMigrationClient(client));
    const stateAfterFirst = {
      workspaces: structuredClone(client.workspaces),
      members: [...client.members.entries()],
    };
    const second = await applyWorkspaceFoundationMigration(asMigrationClient(client));

    expect(first).toEqual({
      existingWorkspaceOwnerMembershipsCreated: 2,
      defaultWorkspacesCreated: 3,
      defaultWorkspaceOwnerMembershipsCreated: 3,
    });
    expect(second).toEqual({
      existingWorkspaceOwnerMembershipsCreated: 0,
      defaultWorkspacesCreated: 0,
      defaultWorkspaceOwnerMembershipsCreated: 0,
    });
    expect({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
    }).toEqual(stateAfterFirst);
    expect(client.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner_user_id: "user-new", name: "Casey's workspace" }),
        expect.objectContaining({ owner_user_id: "user-deleted", name: "My workspace" }),
        expect.objectContaining({ owner_user_id: "user-project-only", name: "My workspace" }),
      ]),
    );
    expect(client.members.size).toBe(client.workspaces.length);
  });

  it("declares the complete enum, provenance columns, and serialized idempotency", async () => {
    const client = new WorkspaceMigrationClient();
    await applyWorkspaceFoundationMigration(asMigrationClient(client));
    const ddl = client.statements.join("\n");

    expect(ddl).toContain(
      "CREATE TYPE workspace_member_role AS ENUM ('owner', 'admin', 'builder', 'viewer', 'billing')",
    );
    expect(ddl).toContain("invited_by text NOT NULL");
    expect(ddl).toContain("joined_at timestamptz NOT NULL DEFAULT now()");
    expect(ddl).toContain("LOCK TABLE workspaces IN SHARE ROW EXCLUSIVE MODE");
    expect(ddl).toContain("UNION SELECT owner_id AS user_id FROM projects");
    expect(ddl).toContain("existing_users.user_id <> 'demo-user'");
    expect(ddl).toContain("member.role = 'owner'");
  });
});
