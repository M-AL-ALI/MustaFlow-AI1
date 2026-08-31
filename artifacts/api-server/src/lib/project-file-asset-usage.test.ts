import { beforeEach, describe, expect, it, vi } from "vitest";

type Predicate =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "null"; column: string }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "and" | "or"; predicates: Predicate[] };

type AssetRow = { id: number; projectId: number | null; state: string };
type UsageRow = {
  assetId: number;
  projectId: number | null;
  artifactId: number | null;
  filePath: string | null;
  consumer: string;
};

const harness = vi.hoisted(() => ({
  assets: [] as AssetRow[],
  usages: [] as UsageRow[],
  operations: [] as string[],
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown): Predicate => ({ kind: "eq", column, value }),
  isNull: (column: string): Predicate => ({ kind: "null", column }),
  inArray: (column: string, values: unknown[]): Predicate => ({ kind: "in", column, values }),
  and: (...predicates: Predicate[]): Predicate => ({ kind: "and", predicates }),
  or: (...predicates: Predicate[]): Predicate => ({ kind: "or", predicates }),
}));

vi.mock("@workspace/db", () => ({
  assetsTable: { id: "asset.id", projectId: "asset.projectId", state: "asset.state" },
  assetUsageTable: {
    assetId: "usage.assetId",
    projectId: "usage.projectId",
    artifactId: "usage.artifactId",
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
        where: vi.fn(async (predicate: Predicate) => {
          if ("state" in table) {
            harness.operations.push("select-assets");
            return harness.assets
              .filter((row) => matches(row, predicate))
              .map(({ id, projectId }) => ({ id, projectId }));
          }
          harness.operations.push("select-history");
          return harness.usages
            .filter((row) => matches(row, predicate))
            .map(({ assetId }) => ({ assetId }));
        }),
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
      { id: 2, projectId: 10, state: "ready" },
      { id: 3, projectId: 10, state: "reserved" },
      { id: 4, projectId: 11, state: "ready" },
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
  });

  it("replaces only the exact file consumers with same-project ready URL references", async () => {
    await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
      projectId: 10,
      artifactId: 21,
      filePath: "src/app.tsx",
      nextContent:
        '<img src="/api/assets/2/content"><img src="https://app.test/api/assets/2/content?x=1"><img src="/api/assets/3/content"><img src="/api/assets/4/content">',
    });

    expect(harness.operations).toEqual([
      "delete-usage",
      "select-assets",
      "select-history",
      "insert-usage",
    ]);
    expect(harness.usages).toEqual(
      expect.arrayContaining([
        {
          assetId: 2,
          projectId: 10,
          artifactId: 21,
          filePath: "src/app.tsx",
          consumer: "project-file",
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
      ]),
    );
    expect(harness.usages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: 3, consumer: "project-file" }),
        expect.objectContaining({ assetId: 4, projectId: 10, consumer: "project-file" }),
        expect.objectContaining({ assetId: 7, consumer: "project-file:src/app.tsx" }),
      ]),
    );
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

  it("records a trusted duplicate consumer against the target while resolving the source asset", async () => {
    await reconcileProjectFileAssetUsage(fakeTransaction() as never, {
      projectId: 10,
      artifactId: null,
      filePath: "src/copied.tsx",
      nextContent: '<img src="/api/assets/4/content">',
      referenceProjectId: 11,
    });

    expect(harness.usages).toContainEqual({
      assetId: 4,
      projectId: 10,
      artifactId: null,
      filePath: "src/copied.tsx",
      consumer: "project-file",
    });
  });

  it("extracts unique content URLs and rejects malformed or unsafe ids", () => {
    expect(
      extractProjectFileAssetIds(
        "/api/assets/12/content /api/assets/12/content?download=1 /api/assets/0/content /api/assets/12/contentious /api/assets/999999999999999999999/content",
      ),
    ).toEqual([12]);
  });
});
