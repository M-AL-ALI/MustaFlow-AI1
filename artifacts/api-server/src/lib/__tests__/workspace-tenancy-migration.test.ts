import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
});

import { applyWorkspaceTenancyMigration } from "../startup-migrations";

type WorkspaceRow = {
  id: number;
  owner_user_id: string;
  system_key: string | null;
  deleted_at: Date | null;
  created_at: Date;
};

type ProjectRow = {
  id: number;
  owner_id: string;
  workspace_id: number | null;
  deleted_at: Date | null;
};

class WorkspaceTenancyMigrationClient {
  readonly statements: string[] = [];
  readonly workspaces: WorkspaceRow[] = [
    {
      id: 1,
      owner_user_id: "owner-a",
      system_key: null,
      deleted_at: null,
      created_at: new Date("2025-01-01T00:00:00.000Z"),
    },
  ];
  readonly members = new Map<string, { role: string; invitedBy: string; joinedAt: Date }>([
    [
      "1:owner-a",
      {
        role: "owner",
        invitedBy: "owner-a",
        joinedAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ],
  ]);
  readonly projects: ProjectRow[] = [
    { id: 1, owner_id: "demo-user", workspace_id: null, deleted_at: null },
    {
      id: 2,
      owner_id: "demo-user",
      workspace_id: null,
      deleted_at: new Date("2026-01-01T00:00:00.000Z"),
    },
    { id: 3, owner_id: "owner-a", workspace_id: null, deleted_at: null },
    {
      id: 4,
      owner_id: "owner-a",
      workspace_id: null,
      deleted_at: new Date("2026-02-01T00:00:00.000Z"),
    },
    { id: 5, owner_id: "owner-a", workspace_id: 1, deleted_at: null },
  ];
  nextWorkspaceId = 2;

  async query(text: string, params: unknown[] = []) {
    this.statements.push(text);

    if (/SELECT id, owner_user_id, deleted_at/i.test(text) && /system_key = \$1/i.test(text)) {
      const rows = this.workspaces
        .filter((workspace) => workspace.system_key === params[0])
        .map(({ id, owner_user_id, deleted_at }) => ({ id, owner_user_id, deleted_at }));
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO workspaces \(owner_user_id, system_key, name, type\)/i.test(text)) {
      const workspace: WorkspaceRow = {
        id: this.nextWorkspaceId++,
        owner_user_id: String(params[0]),
        system_key: String(params[1]),
        deleted_at: null,
        created_at: new Date("2026-08-18T00:00:00.000Z"),
      };
      this.workspaces.push(workspace);
      return { rows: [{ id: workspace.id }], rowCount: 1 };
    }

    if (/INSERT INTO workspace_members/i.test(text) && /VALUES \(\$1, \$2/i.test(text)) {
      const workspaceId = Number(params[0]);
      const userId = String(params[1]);
      const key = `${workspaceId}:${userId}`;
      const existing = this.members.get(key);
      if (existing?.role === "owner" && existing.invitedBy === userId) {
        return { rows: [], rowCount: 0 };
      }
      this.members.set(key, { role: "owner", invitedBy: userId, joinedAt: new Date() });
      return { rows: [{ workspace_id: workspaceId }], rowCount: 1 };
    }

    if (/UPDATE projects/i.test(text) && /WHERE owner_id = 'demo-user'/i.test(text)) {
      const rows = this.projects
        .filter((project) => project.owner_id === "demo-user")
        .map((project) => {
          project.owner_id = String(params[0]);
          project.workspace_id = Number(params[1]);
          return { deleted_at: project.deleted_at };
        });
      return { rows, rowCount: rows.length };
    }

    if (/SELECT COUNT\(\*\)::text AS count/i.test(text) && /owner_id = 'demo-user'/i.test(text)) {
      const count = this.projects.filter((project) => project.owner_id === "demo-user").length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    if (/WITH project_defaults AS/i.test(text)) {
      const rows: Array<{ deleted_at: Date | null }> = [];
      for (const project of this.projects.filter((row) => row.workspace_id === null)) {
        const candidate = this.workspaces
          .filter((workspace) => workspace.deleted_at === null)
          .filter(
            (workspace) =>
              this.members.get(`${workspace.id}:${project.owner_id}`)?.role === "owner",
          )
          .sort(
            (left, right) =>
              left.created_at.getTime() - right.created_at.getTime() || left.id - right.id,
          )[0];
        if (!candidate) continue;
        project.workspace_id = candidate.id;
        rows.push({ deleted_at: project.deleted_at });
      }
      return { rows, rowCount: rows.length };
    }

    if (/SELECT COUNT\(\*\)::text AS count/i.test(text) && /workspace_id IS NULL/i.test(text)) {
      const count = this.projects.filter((project) => project.workspace_id === null).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }

    return { rows: [], rowCount: null };
  }
}

function migrationClient(client: WorkspaceTenancyMigrationClient) {
  return client as unknown as Pick<PoolClient, "query">;
}

describe("workspace tenancy startup migration", () => {
  it("adopts legacy rows, backfills active and deleted projects, and is a no-op on rerun", async () => {
    const client = new WorkspaceTenancyMigrationClient();

    const first = await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");
    const stateAfterFirst = structuredClone({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
      projects: client.projects,
    });
    const second = await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");

    expect(first).toEqual({
      legacyWorkspaceCreated: 1,
      legacyOwnerMembershipsCreatedOrCorrected: 1,
      demoProjectsAdoptedActive: 1,
      demoProjectsAdoptedSoftDeleted: 1,
      projectsBackfilledActive: 1,
      projectsBackfilledSoftDeleted: 1,
      projectsWithNullWorkspace: 0,
    });
    expect(second).toEqual({
      legacyWorkspaceCreated: 0,
      legacyOwnerMembershipsCreatedOrCorrected: 0,
      demoProjectsAdoptedActive: 0,
      demoProjectsAdoptedSoftDeleted: 0,
      projectsBackfilledActive: 0,
      projectsBackfilledSoftDeleted: 0,
      projectsWithNullWorkspace: 0,
    });
    expect({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
      projects: client.projects,
    }).toEqual(stateAfterFirst);
    expect(client.projects.every((project) => project.workspace_id !== null)).toBe(true);
    expect(client.projects.filter((project) => project.id <= 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner_id: "founder-fixture", workspace_id: 2 }),
      ]),
    );
  });

  it("fails explicitly when first-time adoption has no owner", async () => {
    const client = new WorkspaceTenancyMigrationClient();
    delete process.env.LEGACY_ADOPTION_OWNER_ID;

    await expect(
      applyWorkspaceTenancyMigration(migrationClient(client), undefined),
    ).rejects.toThrow("legacy_adoption_owner_id_missing");
    expect(client.statements).toContain("ROLLBACK");
  });

  it("uses completed durable adoption state when a deployment preview has no owner", async () => {
    const client = new WorkspaceTenancyMigrationClient();
    await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");
    const stateAfterAdoption = structuredClone({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
      projects: client.projects,
    });

    const previewRun = await applyWorkspaceTenancyMigration(migrationClient(client), undefined);

    expect(previewRun).toEqual({
      legacyWorkspaceCreated: 0,
      legacyOwnerMembershipsCreatedOrCorrected: 0,
      demoProjectsAdoptedActive: 0,
      demoProjectsAdoptedSoftDeleted: 0,
      projectsBackfilledActive: 0,
      projectsBackfilledSoftDeleted: 0,
      projectsWithNullWorkspace: 0,
    });
    expect({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
      projects: client.projects,
    }).toEqual(stateAfterAdoption);
  });

  it("uses completed durable adoption state when a deployment preview carries another owner", async () => {
    const client = new WorkspaceTenancyMigrationClient();
    await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");
    const stateAfterAdoption = structuredClone({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
      projects: client.projects,
    });

    const previewRun = await applyWorkspaceTenancyMigration(
      migrationClient(client),
      "preview-owner-fixture",
    );

    expect(previewRun).toEqual({
      legacyWorkspaceCreated: 0,
      legacyOwnerMembershipsCreatedOrCorrected: 0,
      demoProjectsAdoptedActive: 0,
      demoProjectsAdoptedSoftDeleted: 0,
      projectsBackfilledActive: 0,
      projectsBackfilledSoftDeleted: 0,
      projectsWithNullWorkspace: 0,
    });
    expect({
      workspaces: client.workspaces,
      members: [...client.members.entries()],
      projects: client.projects,
    }).toEqual(stateAfterAdoption);
  });

  it("refuses a mismatched owner when legacy rows still require adoption", async () => {
    const client = new WorkspaceTenancyMigrationClient();
    await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");
    client.projects.push({
      id: 6,
      owner_id: "demo-user",
      workspace_id: null,
      deleted_at: null,
    });

    await expect(
      applyWorkspaceTenancyMigration(migrationClient(client), "preview-owner-fixture"),
    ).rejects.toThrow("legacy_adoption_workspace_owner_mismatch");
    expect(client.projects.find((project) => project.id === 6)).toEqual(
      expect.objectContaining({ owner_id: "demo-user", workspace_id: null }),
    );
  });

  it("requires an explicit owner when a completed copy gains a new legacy row", async () => {
    const client = new WorkspaceTenancyMigrationClient();
    await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");
    client.projects.push({
      id: 6,
      owner_id: "demo-user",
      workspace_id: null,
      deleted_at: null,
    });

    await expect(
      applyWorkspaceTenancyMigration(migrationClient(client), undefined),
    ).rejects.toThrow("legacy_adoption_owner_id_missing");
    expect(client.projects.find((project) => project.id === 6)).toEqual(
      expect.objectContaining({ owner_id: "demo-user", workspace_id: null }),
    );
  });

  it("declares durable identity, serialized writes, FK verification, and the NOT NULL fence", async () => {
    const client = new WorkspaceTenancyMigrationClient();
    await applyWorkspaceTenancyMigration(migrationClient(client), "founder-fixture");
    const ddl = client.statements.join("\n");

    expect(ddl).toContain("ADD COLUMN IF NOT EXISTS system_key");
    expect(ddl).toContain("workspaces_system_key_unique");
    expect(ddl).toContain("LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE");
    expect(ddl).toContain("FOREIGN KEY (workspace_id) REFERENCES workspaces(id)");
    expect(ddl).toContain("ALTER COLUMN workspace_id SET NOT NULL");
    expect(ddl).toContain("workspace.deleted_at IS NULL");
  });
});
