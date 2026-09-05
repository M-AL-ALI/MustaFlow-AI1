import { beforeEach, describe, expect, it, vi } from "vitest";

type Predicate =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "null"; column: string }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "and" | "or"; predicates: Predicate[] };

type AssetRow = {
  id: number;
  projectId: number | null;
  state: string;
  productScope: "nabuflow" | "ora" | null;
};
type UsageRow = {
  assetId: number;
  projectId: number | null;
  artifactId: number | null;
  versionId?: number | null;
  filePath: string | null;
  consumer: string;
};

const harness = vi.hoisted(() => ({
  assets: [] as AssetRow[],
  usages: [] as UsageRow[],
  operations: [] as string[],
  locks: [] as string[],
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown): Predicate => ({ kind: "eq", column, value }),
  isNull: (column: string): Predicate => ({ kind: "null", column }),
  inArray: (column: string, values: unknown[]): Predicate => ({ kind: "in", column, values }),
  and: (...predicates: Predicate[]): Predicate => ({ kind: "and", predicates }),
  or: (...predicates: Predicate[]): Predicate => ({ kind: "or", predicates }),
}));

vi.mock("@workspace/db", () => ({
  assetsTable: {
    id: "asset.id",
    projectId: "asset.projectId",
    state: "asset.state",
    productScope: "asset.productScope",
  },
  assetUsageTable: {
    assetId: "usage.assetId",
    projectId: "usage.projectId",
    artifactId: "usage.artifactId",
    versionId: "usage.versionId",
    filePath: "usage.filePath",
    consumer: "usage.consumer",
  },
  db: { transaction: vi.fn() },
}));

function columnValue(row: AssetRow | UsageRow, column: string): unknown {
  const key = column.slice(column.indexOf(".") + 1);
  return (row as unknown as Record<string, unknown>)[key];
}

function matches(row: AssetRow | UsageRow, predicate: Predicate): boolean {
  if (predicate.kind === "eq") return columnValue(row, predicate.column) === predicate.value;
  if (predicate.kind === "null") return columnValue(row, predicate.column) === null;
  if (predicate.kind === "in") return predicate.values.includes(columnValue(row, predicate.column));
  if (predicate.kind === "and") return predicate.predicates.every((part) => matches(row, part));
  return predicate.predicates.some((part) => matches(row, part));
}

function fakeTransaction() {
  return {
    delete: vi.fn(() => ({
      where: vi.fn(async (predicate: Predicate) => {
        harness.operations.push("delete-usage");
        harness.usages = harness.usages.filter((row) => !matches(row, predicate));
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: Record<string, unknown>) => ({
        where: vi.fn((predicate: Predicate) => ({
          orderBy: vi.fn(() => ({
            for: vi.fn(async (mode: string) => {
              const isAsset = "state" in table;
              harness.locks.push(`${isAsset ? "assets" : "grants"}:${mode}`);
              if (isAsset) {
                harness.operations.push("select-assets");
                return harness.assets
                  .filter((row) => matches(row, predicate))
                  .map(({ id, projectId }) => ({ id, projectId }));
              }
              harness.operations.push("select-grants");
              return harness.usages
                .filter((row) => matches(row, predicate))
                .map(({ assetId }) => ({ assetId }));
            }),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: UsageRow[]) => ({
        onConflictDoNothing: vi.fn(async () => {
          harness.operations.push("insert-usage");
          for (const row of rows) {
            if (
              !harness.usages.some(
                (existing) =>
                  existing.assetId === row.assetId &&
                  existing.projectId === row.projectId &&
                  existing.artifactId === row.artifactId &&
                  existing.filePath === row.filePath &&
                  existing.consumer === row.consumer,
              )
            ) {
              harness.usages.push({ ...row });
            }
          }
        }),
      })),
    })),
  };
}

import {
  extractProjectFileAssetIds,
  reconcileProjectFileAssetUsage,
} from "./project-file-asset-usage";

describe("project-file asset usage reconciliation", () => {
  beforeEach(() => {
    harness.assets = [
      { id: 2, projectId: 10, state: "ready", productScope: "nabuflow" },
      { id: 3, projectId: 10, state: "reserved", productScope: "nabuflow" },
      { id: 4, projectId: 11, state: "ready", productScope: "nabuflow" },
    ];
    harness.usages = [
      {
        assetId: 1,
        projectId: 10,
        artifactId: 21,
        filePath: "src/app.tsx",
        consumer: "project-file",
      },
      {
        assetId: 7,
        projectId: 10,
        artifactId: 21,
        filePath: "src/app.tsx",
        consumer: "project-file:src/app.tsx",
      },
      {
        assetId: 1,
        projectId: 10,
        artifactId: 21,
        filePath: "src/other.tsx",
        consumer: "project-file",
      },
      {
        assetId: 1,
        projectId: 10,
        artifactId: 21,
        filePath: "src/app.tsx",
        consumer: "chat-message:9",
      },
      {
        assetId: 1,
        projectId: 11,
        artifactId: 21,
        filePath: "src/app.tsx",
        consumer: "project-file",
      },
    ];
    harness.operations = [];
    harness.locks = [];
  });

  it("rejects the whole file write when any asset URL is missing or belongs to another project", async () => {
    await expect(
      reconcileProjectFileAssetUsage(fakeTransaction() as never, {
        projectId: 10,
        artifactId: 21,
        filePath: "src/app.tsx",
        nextContent:
          '<img src="/api/assets/2/content"><img src="https://app.test/api/assets/2/content?x=1"><img src="/api/assets/3/content"><img src="/api/assets/4/content">',
      }),
    ).rejects.toThrow("project_file_asset_reference_unavailable");

    expect(harness.operations).toEqual(["delete-usage", "select-assets", "select-grants"]);
  });

  it("records every authorized same-project asset URL in one atomic reconciliation", async () => {
    await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
      projectId: 10,
      artifactId: 21,
      filePath: "src/app.tsx",
      nextContent:
        '<img src="/api/assets/2/content"><img src="https://app.test/api/assets/2/content?x=1">',
    });

    expect(harness.operations).toEqual([
      "delete-usage",
      "select-assets",
      "select-grants",
      "insert-usage",
    ]);
    expect(harness.usages).toContainEqual({
      assetId: 2,
      projectId: 10,
      artifactId: 21,
      filePath: "src/app.tsx",
      consumer: "project-file",
    });
    expect(harness.usages).toContainEqual({
      assetId: 2,
      projectId: 10,
      artifactId: null,
      filePath: null,
      consumer: "project-asset-history",
    });
  });

  it("removes an exact deleted file consumer without reading or mutating other consumers", async () => {
    await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
      projectId: 10,
      artifactId: 21,
      filePath: "src/app.tsx",
      nextContent: null,
    });

    expect(harness.operations).toEqual(["delete-usage"]);
    expect(harness.usages).toEqual([
      {
        assetId: 1,
        projectId: 10,
        artifactId: 21,
        filePath: "src/other.tsx",
        consumer: "project-file",
      },
      {
        assetId: 1,
        projectId: 10,
        artifactId: 21,
        filePath: "src/app.tsx",
        consumer: "chat-message:9",
      },
      {
        assetId: 1,
        projectId: 11,
        artifactId: 21,
        filePath: "src/app.tsx",
        consumer: "project-file",
      },
    ]);
  });

  it("does not let referenceProjectId grant cross-project copy access", async () => {
    await expect(
      reconcileProjectFileAssetUsage(fakeTransaction() as never, {
        projectId: 10,
        artifactId: null,
        filePath: "src/copied.tsx",
        nextContent: '<img src="/api/assets/4/content">',
        referenceProjectId: 11,
      }),
    ).rejects.toThrow("project_file_asset_reference_unavailable");
    expect(harness.operations).not.toContain("insert-usage");
  });

  it("uses the actual target even when legacy copy metadata names another project", async () => {
    await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
      projectId: 10,
      artifactId: null,
      filePath: "public/local.bin",
      nextContent: `@nabuflow/asset-ref:v1:2:1:${"a".repeat(64)}`,
      referenceProjectId: 11,
    });
    expect(harness.usages).toContainEqual({
      assetId: 2,
      projectId: 10,
      artifactId: null,
      filePath: "public/local.bin",
      consumer: "project-file",
    });
    expect(harness.locks).toEqual(["assets:share", "grants:share"]);
    expect(harness.usages.some((row) => row.consumer === "explicit-project-use:v1")).toBe(false);
  });

  it.each(["project-asset-history", "project-file", "asset-derivative:2", "generated-image:7"])(
    "does not convert automatic %s retention into reuse authority",
    async (consumer) => {
      const retained: UsageRow = {
        assetId: 4,
        projectId: 10,
        artifactId: null,
        versionId: null,
        filePath: null,
        consumer,
      };
      harness.usages.push(retained);
      await expect(
        reconcileProjectFileAssetUsage(fakeTransaction() as never, {
          projectId: 10,
          artifactId: null,
          filePath: "public/copied.bin",
          nextContent: `@nabuflow/asset-ref:v1:4:1:${"a".repeat(64)}`,
        }),
      ).rejects.toThrow("project_file_asset_reference_unavailable");
      expect(harness.usages).toContainEqual(retained);
      expect(harness.operations).not.toContain("insert-usage");
    },
  );

  it.each([11, null])(
    "accepts an existing exact target grant for an asset from project %s",
    async (assetProjectId) => {
      harness.assets.find((asset) => asset.id === 4)!.projectId = assetProjectId;
      const grant: UsageRow = {
        assetId: 4,
        projectId: 10,
        artifactId: null,
        versionId: null,
        filePath: null,
        consumer: "explicit-project-use:v1",
      };
      harness.usages.push(grant);
      await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
        projectId: 10,
        artifactId: null,
        filePath: "public/copied.bin",
        nextContent: `@nabuflow/asset-ref:v1:4:1:${"a".repeat(64)}`,
        referenceProjectId: 11,
      });
      expect(harness.usages).toContainEqual({
        assetId: 4,
        projectId: 10,
        artifactId: null,
        filePath: "public/copied.bin",
        consumer: "project-file",
      });
      expect(harness.usages).toContainEqual({
        assetId: 4,
        projectId: 10,
        artifactId: null,
        filePath: null,
        consumer: "project-asset-history",
      });
      expect(harness.usages.filter((row) => row.consumer === "explicit-project-use:v1")).toEqual([
        grant,
      ]);
    },
  );

  it.each([
    { name: "wrong target", projectId: 11, artifactId: null, versionId: null, filePath: null },
    { name: "artifact-scoped", projectId: 10, artifactId: 7, versionId: null, filePath: null },
    { name: "version-scoped", projectId: 10, artifactId: null, versionId: 7, filePath: null },
    {
      name: "file-scoped",
      projectId: 10,
      artifactId: null,
      versionId: null,
      filePath: "public/other.bin",
    },
  ])("rejects a $name explicit-use marker", async ({ name: _name, ...shape }) => {
    harness.usages.push({ assetId: 4, consumer: "explicit-project-use:v1", ...shape });
    await expect(
      reconcileProjectFileAssetUsage(fakeTransaction() as never, {
        projectId: 10,
        artifactId: null,
        filePath: "public/copied.bin",
        nextContent: `@nabuflow/asset-ref:v1:4:1:${"a".repeat(64)}`,
        referenceProjectId: 11,
      }),
    ).rejects.toThrow("project_file_asset_reference_unavailable");
    expect(harness.operations).not.toContain("insert-usage");
  });

  it.each([null, "ora"] as const)(
    "rejects %s provenance despite same-project identity and an explicit marker",
    async (productScope) => {
      harness.assets.find((asset) => asset.id === 2)!.productScope = productScope;
      harness.usages.push({
        assetId: 2,
        projectId: 10,
        artifactId: null,
        versionId: null,
        filePath: null,
        consumer: "explicit-project-use:v1",
      });
      for (const nextContent of [
        `@nabuflow/asset-ref:v1:2:1:${"a".repeat(64)}`,
        '<img src="/api/assets/2/content">',
        '<img src="/api/ora/canonical-assets/2/content">',
      ]) {
        await expect(
          reconcileProjectFileAssetUsage(fakeTransaction() as never, {
            projectId: 10,
            artifactId: null,
            filePath: "public/hidden.bin",
            nextContent,
          }),
        ).rejects.toThrow("project_file_asset_reference_unavailable");
      }
      expect(harness.operations).not.toContain("insert-usage");
    },
  );

  it("does not discard historical retention when a file is removed", async () => {
    const historical: UsageRow[] = [
      {
        assetId: 4,
        projectId: 10,
        artifactId: null,
        versionId: null,
        filePath: null,
        consumer: "project-asset-history",
      },
      {
        assetId: 4,
        projectId: 11,
        artifactId: null,
        versionId: null,
        filePath: null,
        consumer: "project-asset-history",
      },
    ];
    harness.assets.find((asset) => asset.id === 4)!.productScope = "ora";
    harness.usages.push(...historical);
    await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
      projectId: 10,
      artifactId: 21,
      filePath: "src/app.tsx",
      nextContent: null,
    });
    for (const retained of historical) expect(harness.usages).toContainEqual(retained);
    expect(harness.operations).toEqual(["delete-usage"]);
  });

  it("extracts unique content URLs and rejects malformed or unsafe ids", () => {
    expect(
      extractProjectFileAssetIds(
        "/api/assets/12/content /api/assets/12/content?download=1 /api/assets/0/content /api/assets/12/contentious /api/assets/999999999999999999999/content",
      ),
    ).toEqual([12]);
    expect(
      extractProjectFileAssetIds("/api/ora/canonical-assets/18/content /api/assets/12/content"),
    ).toEqual([18, 12]);
  });
});
