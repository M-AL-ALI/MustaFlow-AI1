import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  deleteAssetObject: vi.fn(),
  headAssetObject: vi.fn(),
  deleteSnapshotBlob: vi.fn(),
  snapshotBlobExists: vi.fn(),
  getLegacyObject: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { query: mocks.poolQuery, connect: mocks.poolConnect },
}));
vi.mock("./asset-r2", () => ({
  deleteAssetObject: mocks.deleteAssetObject,
  headAssetObject: mocks.headAssetObject,
}));
vi.mock("./snapshot-storage", () => ({
  deleteSnapshotBlob: mocks.deleteSnapshotBlob,
  snapshotBlobExists: mocks.snapshotBlobExists,
}));
vi.mock("./project-retirement-contract", () => ({
  hasCurrentProjectRetirementCompletionEvidence: vi.fn(() => true),
  PROJECT_LIFECYCLE_LOCK_NAMESPACE: 1,
}));
vi.mock("./objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {
    getObjectEntityFile = mocks.getLegacyObject;
  },
}));

import {
  applyProjectRelationalPurge,
  inventoryProjectPurgeResources,
  readProjectReferenceCatalog,
  releaseProjectAssetStorage,
  releaseProjectSnapshotStorage,
  validateProjectReferenceCatalog,
  type ProjectPurgeResourceInventory,
} from "./project-purge-resources";

function inventory(
  overrides: Partial<ProjectPurgeResourceInventory> = {},
): ProjectPurgeResourceInventory {
  return {
    projectId: 51,
    ownerId: "owner-user",
    projectName: "Project 51",
    deletedAt: new Date("2026-09-01T00:00:00.000Z"),
    retirementOperationId: "retirement-51",
    retirementProgress: {},
    neonProjectIds: [],
    productionNeonProjectName: "mf-project-51",
    previewNeonProjectName: "mf-preview-51",
    assetTargets: [],
    legacyGeneratedImageTargets: [],
    uploadTargets: [],
    snapshotObjectKeys: [],
    tableCounts: [],
    activeAddonCount: 0,
    digestSha256: "a".repeat(64),
    ...overrides,
  };
}

function assetClaimClient(
  shared = false,
  state = "ready",
  aliases: readonly string[] = [],
  options: {
    storageKeys?: readonly string[];
    rawSharedKeys?: readonly string[];
  } = {},
) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (statement: string, values: readonly unknown[] = []) => {
    const sql = statement.replace(/\s+/gu, " ").trim();
    statements.push({ sql, values });
    if (sql.startsWith("SELECT state FROM assets")) {
      return { rows: [{ state }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT storage_key FROM asset_storage_objects")) {
      const rows = (options.storageKeys ?? []).map((storage_key) => ({ storage_key }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT '/api/images/'")) {
      return { rows: aliases.map((alias) => ({ alias })), rowCount: aliases.length };
    }
    if (sql.includes("public.durable_asset_reference_exists")) {
      return { rows: [{ shared }], rowCount: 1 };
    }
    if (sql.endsWith(") AS shared")) {
      const storageKey = String(values[1] ?? "");
      return {
        rows: [{ shared: shared || (options.rawSharedKeys ?? []).includes(storageKey) }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT 1 FROM durable_asset_deletion_claims")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO durable_asset_deletion_claims")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO asset_usage")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("UPDATE assets SET state='deleting'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE asset_storage_objects SET state='deleting'")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, release: vi.fn(), statements };
}

function noForeignKey(tableName: string, columnName: "project_id" | "source_project_id") {
  return {
    tableName,
    columnName,
    deleteAction: "no_fk" as const,
    foreignKeyCount: 0,
    referencedTableSchema: null,
    referencedTableName: null,
    referencedColumnName: null,
  };
}

function projectsForeignKey(
  tableName: string,
  columnName: "project_id" | "source_project_id",
  deleteAction: "cascade" | "set_null" | "restrict",
) {
  return {
    tableName,
    columnName,
    deleteAction,
    foreignKeyCount: 1,
    referencedTableSchema: "public",
    referencedTableName: "projects",
    referencedColumnName: "id",
  };
}

function relationalClient(input: { leaseVersion: number; expectedLeaseVersion?: number }) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (statement: string, values: readonly unknown[] = []) => {
    const sql = statement.replace(/\s+/gu, " ").trim();
    statements.push({ sql, values });
    if (sql.startsWith("SELECT state, lease_version FROM project_purge_operations")) {
      return { rows: [{ state: "running", lease_version: input.leaseVersion }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT DISTINCT asset_row.id")) return { rows: [], rowCount: 0 };
    if (sql.includes("COALESCE(SUM(asset_row.size_bytes)")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT 0::integer AS ordinal")) {
      return {
        rows: [
          { ordinal: 0, row_count: 0 },
          { ordinal: 1, row_count: 0 },
        ],
        rowCount: 2,
      };
    }
    if (sql === "SELECT 1 FROM projects WHERE id=$1") return { rows: [], rowCount: 0 };
    if (sql === "DELETE FROM projects WHERE id=$1") return { rows: [], rowCount: 1 };
    if (sql.startsWith("DELETE FROM project_github_connections")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE notifications SET project_id=NULL")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE purchased_domains SET project_id=NULL")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE project_purge_operations SET state='completed'")) {
      const expected = input.expectedLeaseVersion ?? input.leaseVersion;
      return { rows: [], rowCount: values[3] === expected ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, release: vi.fn(), statements };
}

describe("project purge resource safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockReset().mockResolvedValue({ rows: [{ shared: false }], rowCount: 1 });
    mocks.poolConnect.mockReset().mockImplementation(async () => assetClaimClient(false));
    mocks.deleteAssetObject.mockReset();
    mocks.headAssetObject.mockReset();
    mocks.deleteSnapshotBlob.mockReset();
    mocks.snapshotBlobExists.mockReset();
    mocks.getLegacyObject.mockReset();
  });

  it("accepts declared project references and fails closed on a new undeclared table", () => {
    expect(
      validateProjectReferenceCatalog([
        projectsForeignKey("support_access_grants", "project_id", "restrict"),
        noForeignKey("purchased_domains", "project_id"),
        projectsForeignKey("project_files", "project_id", "cascade"),
      ]),
    ).toMatchObject({ ok: true });
    expect(
      validateProjectReferenceCatalog([noForeignKey("new_project_store", "project_id")]),
    ).toEqual({ ok: false, unknown: ["new_project_store.project_id"] });
  });

  it("rejects a same-named cascade that does not reference public projects(id)", () => {
    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("project_files", "project_id", "cascade"),
          referencedTableName: "other_projects",
        },
      ]),
    ).toEqual({ ok: false, unknown: ["project_files.project_id"] });
    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("project_files", "project_id", "cascade"),
          foreignKeyCount: 2,
        },
      ]),
    ).toEqual({ ok: false, unknown: ["project_files.project_id"] });
  });

  it("reads the target schema, table, column, and full foreign-key count from the live catalog", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "project_files",
          column_name: "project_id",
          delete_action: "cascade",
          foreign_key_count: 1,
          referenced_table_schema: "public",
          referenced_table_name: "projects",
          referenced_column_name: "id",
        },
      ],
    });

    await expect(readProjectReferenceCatalog()).resolves.toEqual([
      projectsForeignKey("project_files", "project_id", "cascade"),
    ]);
    const query = String(mocks.poolQuery.mock.calls[0]?.[0]);
    expect(query).toContain("COUNT(*)::integer AS foreign_key_count");
    expect(query).toContain("referenced_namespace.nspname");
    expect(query).not.toContain("LIMIT 1");
  });

  it("accepts declared other-product foreign keys without weakening project-owned FK validation", () => {
    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("orax_threads", "project_id", "restrict"),
          referencedTableName: "orax_desktop_local_folders",
        },
        {
          ...projectsForeignKey("orax_usage_events", "project_id", "restrict"),
          referencedTableName: "orax_desktop_local_folders",
        },
      ]),
    ).toMatchObject({ ok: true });

    expect(
      validateProjectReferenceCatalog([
        {
          ...projectsForeignKey("project_files", "project_id", "restrict"),
          referencedTableName: "orax_desktop_local_folders",
        },
      ]),
    ).toMatchObject({
      ok: false,
      unknown: ["project_files.project_id"],
    });
  });

  it("classifies every real Orax project-shaped column as another product", () => {
    const migration = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const oraxTables = [
      ...migration.matchAll(/CREATE TABLE IF NOT EXISTS (orax_[a-z_]+)\s*\(([\s\S]*?)\n\s*\)/gu),
    ]
      .filter(([, , body]) => /\bproject_id\b/u.test(body ?? ""))
      .map(([, tableName]) => tableName!)
      .sort();
    expect(oraxTables).toEqual([
      "orax_audit_log",
      "orax_project_sources",
      "orax_threads",
      "orax_usage_events",
    ]);
    expect(
      validateProjectReferenceCatalog(
        oraxTables.map((tableName) => ({
          ...noForeignKey(tableName, "project_id"),
        })),
      ),
    ).toMatchObject({ ok: true });
  });

  it("selects the newest retirement receipt without hiding a newer failed receipt", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await expect(inventoryProjectPurgeResources(51)).resolves.toBeNull();
    const projectQuery = String(mocks.poolQuery.mock.calls[1]?.[0]);
    expect(projectQuery).toContain("ORDER BY operation.created_at DESC");
    expect(projectQuery).toContain("operation.state");
    expect(projectQuery).toContain("operation.completed_at");
    expect(projectQuery).not.toContain("operation.state='completed'");
  });

  it("classifies a mirrored legacy upload as shared from surviving storage and usage references", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 51,
            owner_id: "owner-user",
            name: "Project 51",
            deleted_at: new Date("2026-09-01T00:00:00.000Z"),
            neon_project_id: null,
            db_connection_id: null,
            retirement_operation_id: "retirement-51",
            retirement_state: "completed",
            retirement_completed_at: new Date("2026-09-01T00:00:00.000Z"),
            retirement_progress: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ object_path: "/objects/shared-upload", shared: true }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active_count: 0 }] });

    const result = await inventoryProjectPurgeResources(51);
    expect(result?.uploadTargets).toEqual([{ objectPath: "/objects/shared-upload", shared: true }]);
    const uploadQuery = String(mocks.poolQuery.mock.calls[3]?.[0]);
    expect(uploadQuery).toContain("FROM asset_storage_objects storage_row");
    expect(uploadQuery).toContain("FROM asset_usage usage_row");
    expect(uploadQuery).toContain("other_upload.project_id IS DISTINCT FROM $1");
    mocks.poolConnect.mockResolvedValueOnce(assetClaimClient(true));
    await expect(releaseProjectAssetStorage(result!)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
  });

  it("preserves every shared R2 object and deletes only final references", async () => {
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValue(null);
    const input = inventory({
      assetTargets: [
        {
          assetId: 1,
          ownerUserId: "owner-user",
          shared: true,
          storageBackend: "r2",
          storageKey: "accounts/owner/shared.webp",
          sizeBytes: 10,
        },
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/owned.webp",
          sizeBytes: 20,
        },
      ],
      legacyGeneratedImageTargets: [
        { storageBackend: "r2", storageKey: "legacy/shared.webp", shared: true },
        { storageBackend: "r2", storageKey: "legacy/owned.webp", shared: false },
      ],
    });
    mocks.poolConnect
      .mockReset()
      .mockResolvedValueOnce(assetClaimClient(true))
      .mockResolvedValueOnce(assetClaimClient(false))
      .mockResolvedValueOnce(assetClaimClient(true))
      .mockResolvedValueOnce(assetClaimClient(false));

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 2,
      detachedObjects: 2,
      complete: true,
    });
    expect(mocks.deleteAssetObject.mock.calls.map(([key]) => key)).toEqual([
      "accounts/owner/owned.webp",
      "legacy/owned.webp",
    ]);
    expect(mocks.deleteAssetObject.mock.calls.flat()).not.toContain("accounts/owner/shared.webp");
    expect(mocks.deleteAssetObject.mock.calls.flat()).not.toContain("legacy/shared.webp");
  });

  it("locks and rechecks a formerly unshared asset before physical deletion", async () => {
    const claim = assetClaimClient(true);
    mocks.poolConnect.mockResolvedValueOnce(claim);
    const input = inventory({
      assetTargets: [
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/newly-shared.webp",
          sizeBytes: 20,
        },
      ],
    });

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    const sql = claim.statements.map((entry) => entry.sql);
    expect(sql.findIndex((statement) => statement.includes("FOR UPDATE"))).toBeLessThan(
      sql.findIndex((statement) => statement.includes("durable_asset_reference_exists")),
    );
    expect(sql).toContain("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(sql.some((statement) => statement.includes("UPDATE assets SET state='deleting'"))).toBe(
      false,
    );
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
  });

  it("locks and preserves every object when only a secondary R2 object is referenced", async () => {
    const fullKey = "assets/owner/image/00000000-0000-4000-8000-000000000051/full.webp";
    const thumbnailKey = "assets/owner/image/00000000-0000-4000-8000-000000000051/thumb.webp";
    const options = {
      storageKeys: [fullKey, thumbnailKey],
      rawSharedKeys: [thumbnailKey],
    };
    const fullClaim = assetClaimClient(false, "ready", [], options);
    const thumbnailClaim = assetClaimClient(false, "ready", [], options);
    mocks.poolConnect
      .mockReset()
      .mockResolvedValueOnce(fullClaim)
      .mockResolvedValueOnce(thumbnailClaim);

    await expect(
      releaseProjectAssetStorage(
        inventory({
          assetTargets: [
            {
              assetId: 51,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "r2",
              storageKey: fullKey,
              sizeBytes: 20,
            },
            {
              assetId: 51,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "r2",
              storageKey: thumbnailKey,
              sizeBytes: 5,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ deletedObjects: 0, detachedObjects: 2, complete: true });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    for (const claim of [fullClaim, thumbnailClaim]) {
      const locks = claim.statements
        .filter((entry) => entry.sql.includes("pg_advisory_xact_lock"))
        .map((entry) => entry.values[0]);
      expect(locks).toEqual([fullKey, thumbnailKey]);
      const checks = claim.statements
        .filter(
          (entry) =>
            entry.sql.endsWith(") AS shared") &&
            !entry.sql.includes("public.durable_asset_reference_exists"),
        )
        .map((entry) => entry.values[1]);
      expect(checks).toEqual([fullKey, thumbnailKey]);
      const marker = claim.statements.find((entry) =>
        entry.sql.startsWith("INSERT INTO asset_usage"),
      );
      expect(marker?.sql).toContain("'project-purge-preserved-direct:' || $2::text");
      expect(marker?.values).toEqual([51, 51]);
    }
  });

  it("keeps purge preservation markers retry-stable, temporary, and delimiter-safe", () => {
    const source = readFileSync(new URL("./project-purge-resources.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "usage_row.consumer IS DISTINCT FROM\n                     'project-purge-preserved-direct:' || $1::text",
    );
    expect(source).toContain("OR consumer='project-purge-preserved-direct:' || $1::text");

    const migration = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const escapedBackslash = "\\".repeat(4);
    expect(migration.split(`${escapedBackslash}[:space:]`)).toHaveLength(3);
    expect(migration).toContain("?#<>(){},;]+)");
    expect(migration).toContain("FROM candidate_keys candidate_key");
    expect(migration).toContain("'project-purge-preserved-direct:' || excluded_project_id::text");
    expect(migration).toContain(
      "SET consumer='project-purge-preserved-direct:' || asset_row.project_id::text",
    );
    expect(migration).toContain("legacy_usage.consumer='project-purge-preserved-direct'");
  });

  it("canonicalizes every surviving legacy alias before source metadata can disappear", async () => {
    const claim = assetClaimClient(true, "ready", [
      "/api/images/91/file",
      "/api/projects/51/uploads/7/content",
    ]);
    mocks.poolConnect.mockResolvedValueOnce(claim);
    const input = inventory({
      assetTargets: [
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/alias.webp",
          sizeBytes: 20,
        },
      ],
    });

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
    });
    const updates = claim.statements.filter((entry) => entry.sql.startsWith("UPDATE "));
    for (const table of [
      "chat_messages",
      "agent_tasks",
      "agent_tool_calls",
      "zero_prompt_queue_items",
      "knowledge_entries",
      "project_files",
      "project_versions",
      "canvas_variants",
      "canvas_variant_library",
      "gallery_templates",
      "agent_inbox",
      "task_events",
      "project_activity",
      "visual_edit_changes",
      "generated_images",
    ]) {
      expect(updates.some((entry) => entry.sql.startsWith(`UPDATE ${table}`))).toBe(true);
    }
    expect(updates.every((entry) => entry.values[2] === "/api/assets/2/content")).toBe(true);
    expect(updates.find((entry) => entry.sql.startsWith("UPDATE agent_tool_calls"))?.sql).toContain(
      "call_row.project_id IS DISTINCT FROM $1",
    );
    expect(
      updates.find((entry) => entry.sql.startsWith("UPDATE agent_tool_calls"))?.sql,
    ).not.toContain("task.id=call_row.task_id");
    expect(
      claim.statements.findIndex((entry) => entry.sql.includes("durable_asset_reference_exists")),
    ).toBeGreaterThan(
      claim.statements.findIndex((entry) => entry.sql.startsWith("UPDATE chat_messages")),
    );
  });

  it("makes a final-reference asset non-attachable before deleting its provider object", async () => {
    const claim = assetClaimClient(false);
    mocks.poolConnect.mockResolvedValueOnce(claim);
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValue(null);

    await expect(
      releaseProjectAssetStorage(
        inventory({
          assetTargets: [
            {
              assetId: 2,
              ownerUserId: "owner-user",
              shared: false,
              storageBackend: "r2",
              storageKey: "accounts/owner/final.webp",
              sizeBytes: 20,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ deletedObjects: 1, detachedObjects: 0 });
    expect(claim.statements.map((entry) => entry.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FOR UPDATE"),
        expect.stringContaining("pg_advisory_xact_lock"),
        expect.stringContaining("UPDATE assets SET state='deleting'"),
        expect.stringContaining("UPDATE asset_storage_objects SET state='deleting'"),
        expect.stringContaining("INSERT INTO durable_asset_deletion_claims"),
      ]),
    );
    expect(mocks.deleteAssetObject).toHaveBeenCalledWith("accounts/owner/final.webp");
    const migration = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF asset_id, project_id ON asset_usage");
  });

  it.each(["reserved", "uploading", "rejected"])(
    "cleans an incomplete %s asset instead of trapping the project in Trash",
    async (state) => {
      const claim = assetClaimClient(false, state);
      mocks.poolConnect.mockResolvedValueOnce(claim);
      mocks.deleteAssetObject.mockResolvedValue(undefined);
      mocks.headAssetObject.mockResolvedValue(null);

      await expect(
        releaseProjectAssetStorage(
          inventory({
            assetTargets: [
              {
                assetId: 3,
                ownerUserId: "owner-user",
                shared: false,
                storageBackend: "r2",
                storageKey: `accounts/owner/${state}.webp`,
                sizeBytes: 20,
              },
            ],
          }),
        ),
      ).resolves.toMatchObject({ deletedObjects: 1, complete: true });
    },
  );

  it("never deletes a legacy upload object while a durable shared reference survives", async () => {
    const input = inventory({
      uploadTargets: [{ objectPath: "/objects/shared-upload", shared: true }],
    });

    mocks.poolConnect.mockResolvedValueOnce(assetClaimClient(true));
    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
  });

  it("rechecks legacy and snapshot keys immediately before every physical delete", async () => {
    const legacyClaim = assetClaimClient(true);
    const uploadClaim = assetClaimClient(true);
    const snapshotClaim = assetClaimClient(true);
    mocks.poolConnect
      .mockReset()
      .mockResolvedValueOnce(legacyClaim)
      .mockResolvedValueOnce(uploadClaim)
      .mockResolvedValueOnce(snapshotClaim);
    const input = inventory({
      legacyGeneratedImageTargets: [
        { storageBackend: "r2", storageKey: "legacy/new-reference.webp", shared: false },
      ],
      uploadTargets: [{ objectPath: "/objects/new-reference", shared: false }],
      snapshotObjectKeys: ["db-snapshots/51/new-reference.sql"],
    });

    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 2,
      complete: true,
    });
    await expect(releaseProjectSnapshotStorage(input)).resolves.toMatchObject({
      removed: 0,
      detached: 1,
      complete: true,
    });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
    expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
    for (const claim of [legacyClaim, uploadClaim, snapshotClaim]) {
      const sql = claim.statements.map((entry) => entry.sql);
      expect(
        sql.findIndex((statement) => statement.includes("pg_advisory_xact_lock")),
      ).toBeLessThan(sql.findIndex((statement) => statement.endsWith(") AS shared")));
      expect(
        sql.some((statement) => statement.includes("INSERT INTO durable_asset_deletion_claims")),
      ).toBe(false);
      expect(sql.at(-1)).toBe("COMMIT");
    }
    const referenceSql = legacyClaim.statements.find((entry) =>
      entry.sql.endsWith(") AS shared"),
    )?.sql;
    expect(referenceSql).toContain("asset_storage_objects");
    expect(referenceSql).toContain("project_uploads");
    expect(referenceSql).toContain("project_files");
    expect(referenceSql).toContain("project_versions");
    expect(referenceSql).toContain("chat_messages");
    expect(referenceSql).toContain("agent_tasks");
    expect(referenceSql).toContain("agent_tool_calls");
    expect(referenceSql).toContain("call_row.project_id");
    expect(referenceSql).toContain("zero_prompt_queue_items");
    expect(referenceSql).toContain("knowledge_entries");
    expect(referenceSql).toContain("canvas_variant_library");
    expect(referenceSql).toContain("gallery_templates");
    expect(referenceSql).toContain("visual_edit_changes");
    expect(referenceSql).toContain("generated_images");
    expect(referenceSql).toContain("db_snapshots");
  });

  it("bounds each provider pass and resumes exactly after its durable cursor", async () => {
    const input = inventory({
      assetTargets: Array.from({ length: 30 }, (_, index) => ({
        assetId: index + 1,
        ownerUserId: "owner-user",
        shared: true,
        storageBackend: "r2",
        storageKey: `accounts/owner/shared-${index + 1}.webp`,
        sizeBytes: 1,
      })),
    });

    mocks.poolConnect.mockImplementation(async () => assetClaimClient(true));
    const first = await releaseProjectAssetStorage(input);
    expect(first).toMatchObject({
      deletedObjects: 0,
      detachedObjects: 25,
      cursor: { assetIndex: 25, legacyImageIndex: 0, uploadIndex: 0 },
      complete: false,
    });
    const second = await releaseProjectAssetStorage(input, first.cursor);
    expect(second).toMatchObject({
      deletedObjects: 0,
      detachedObjects: 5,
      cursor: { assetIndex: 30, legacyImageIndex: 0, uploadIndex: 0 },
      complete: true,
    });
    expect(mocks.deleteAssetObject).not.toHaveBeenCalled();
  });

  it("fails closed instead of accepting a cursor that could skip a resource", async () => {
    const input = inventory({
      uploadTargets: [{ objectPath: "/objects/owned-upload", shared: false }],
      snapshotObjectKeys: ["db-snapshots/51/one.sql"],
    });
    await expect(
      releaseProjectAssetStorage(input, {
        assetIndex: 0,
        legacyImageIndex: 0,
        uploadIndex: 2,
      }),
    ).rejects.toThrow("project_purge_asset_release_failed");
    await expect(releaseProjectSnapshotStorage(input, { snapshotIndex: 2 })).rejects.toThrow(
      "project_purge_snapshot_release_failed",
    );
    expect(mocks.getLegacyObject).not.toHaveBeenCalled();
    expect(mocks.deleteSnapshotBlob).not.toHaveBeenCalled();
  });

  it("fails without an R2 absence receipt and succeeds safely on retry", async () => {
    mocks.deleteAssetObject.mockResolvedValue(undefined);
    mocks.headAssetObject.mockResolvedValueOnce({ sizeBytes: 20 }).mockResolvedValueOnce(null);
    const input = inventory({
      assetTargets: [
        {
          assetId: 2,
          ownerUserId: "owner-user",
          shared: false,
          storageBackend: "r2",
          storageKey: "accounts/owner/owned.webp",
          sizeBytes: 20,
        },
      ],
    });

    await expect(releaseProjectAssetStorage(input)).rejects.toThrow(
      "project_purge_asset_release_failed",
    );
    await expect(releaseProjectAssetStorage(input)).resolves.toMatchObject({
      deletedObjects: 1,
      detachedObjects: 0,
      complete: true,
    });
    expect(mocks.deleteAssetObject).toHaveBeenCalledTimes(2);
  });

  it("requires snapshot absence and makes a failed attempt retry-safe", async () => {
    mocks.deleteSnapshotBlob.mockResolvedValue(true);
    mocks.snapshotBlobExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const input = inventory({ snapshotObjectKeys: ["db-snapshots/51/one.sql"] });

    await expect(releaseProjectSnapshotStorage(input)).rejects.toThrow(
      "project_purge_snapshot_release_failed",
    );
    await expect(releaseProjectSnapshotStorage(input)).resolves.toMatchObject({
      removed: 1,
      complete: true,
    });
    expect(mocks.deleteSnapshotBlob).toHaveBeenCalledTimes(2);
  });

  it("rejects untrusted terminal counts and preserves only scrubbed purge notifications", async () => {
    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "not-a-digest",
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 1,
      }),
    ).rejects.toThrow("project_purge_relational_delete_failed");

    const source = readFileSync(new URL("./project-purge-resources.ts", import.meta.url), "utf8");
    expect(source).toContain("resource_type IS DISTINCT FROM 'project_purge'");
    expect(source).toContain("resource_type='project_purge'");
    expect(source).toContain("SET project_id=NULL");
    expect(source).toContain("title='Project deletion receipt'");
    expect(source).toContain("body='A project deletion milestone was recorded.'");
    const terminal = source.slice(source.indexOf("const terminalEvidence ="));
    expect(terminal).not.toContain("projectName");
    expect(terminal).not.toContain("ownerId");
    expect(terminal).not.toContain("storageKey");
  });

  it("detaches purchased domains, removes only local GitHub metadata, preserves the receipt, and proves zero references", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          table_name: "project_github_connections",
          column_name: "project_id",
          delete_action: "no_fk",
          foreign_key_count: 0,
          referenced_table_schema: null,
          referenced_table_name: null,
          referenced_column_name: null,
        },
        {
          table_name: "purchased_domains",
          column_name: "project_id",
          delete_action: "no_fk",
          foreign_key_count: 0,
          referenced_table_schema: null,
          referenced_table_name: null,
          referenced_column_name: null,
        },
      ],
    });
    const client = relationalClient({ leaseVersion: 4 });
    mocks.poolConnect.mockResolvedValueOnce(client);

    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 3,
        providerDetached: 2,
        leaseVersion: 4,
      }),
    ).resolves.toMatchObject({ removedResourceCount: 5, detachedResourceCount: 4 });

    const sql = client.statements.map((entry) => entry.sql).join("\n");
    expect(sql).toContain("DELETE FROM project_github_connections WHERE project_id=$1");
    expect(sql).toContain("UPDATE purchased_domains SET project_id=NULL");
    expect(sql).not.toContain("DELETE FROM purchased_domains");
    expect(sql).not.toContain("DELETE FROM project_purge_operations");
    expect(sql).toContain("UPDATE project_purge_operations SET state='completed'");
    expect(sql).toContain("SELECT 1 FROM projects WHERE id=$1");
    const terminal = client.statements.find((entry) =>
      entry.sql.startsWith("UPDATE project_purge_operations SET state='completed'"),
    );
    expect(terminal?.values[3]).toBe(4);
    expect(String(terminal?.values[2])).not.toContain("Project 51");
    expect(String(terminal?.values[2])).not.toContain("owner-user");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses relational deletion and terminalization when the worker lease is stale", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    const client = relationalClient({ leaseVersion: 8 });
    mocks.poolConnect.mockResolvedValueOnce(client);

    await expect(
      applyProjectRelationalPurge(51, "operation-51", {
        inventoryDigestSha256: "a".repeat(64),
        providerRemoved: 0,
        providerDetached: 0,
        leaseVersion: 7,
      }),
    ).rejects.toThrow("project_purge_operation_conflict");
    const sql = client.statements.map((entry) => entry.sql).join("\n");
    expect(sql).not.toContain("DELETE FROM projects WHERE id=$1");
    expect(sql).not.toContain("SET state='completed'");
    expect(sql).toContain("ROLLBACK");
  });
});
