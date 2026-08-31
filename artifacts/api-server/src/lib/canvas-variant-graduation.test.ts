import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractRouteHandler } from "./source-ast-test-helper";

interface StoredFile {
  id: number;
  projectId: number;
  artifactId: number | null;
  path: string;
  content: string;
  mimeType: string;
}

interface StoredVersion {
  projectId: number;
  label: string;
  note: string;
  filesSnapshot: Array<{ path: string; content: string; mimeType: string }>;
}

interface Predicate {
  column: string;
  value: unknown;
}

interface GraduationHarness {
  rows: StoredFile[];
  versions: StoredVersion[];
  failOnMutation: number | null;
  mutationFailure: Error;
  executeValues: unknown[][];
}

const harness = vi.hoisted<GraduationHarness>(() => ({
  rows: [],
  versions: [],
  failOnMutation: null,
  mutationFailure: new Error("simulated failure"),
  executeValues: [],
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown): Predicate => ({ column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock("./builder", () => ({
  guessMime: (path: string) => (path.endsWith(".css") ? "text/css" : "text/plain"),
}));

vi.mock("./project-file-writer", () => ({
  PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS: 2_000,
  PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS: 10_000,
}));

vi.mock("./project-file-asset-usage", () => ({
  reconcileProjectFileAssetUsage: vi.fn(async () => undefined),
}));

vi.mock("@workspace/db", () => {
  const projectFilesTable = {
    id: "fileId",
    projectId: "projectId",
  };
  const projectVersionsTable = { table: "projectVersions" };

  return {
    projectFilesTable,
    projectVersionsTable,
    db: {
      transaction: vi.fn(async (callback) => {
        const workingRows = harness.rows.map((row) => ({ ...row }));
        const workingVersions = harness.versions.map((version) => ({
          ...version,
          filesSnapshot: version.filesSnapshot.map((file) => ({ ...file })),
        }));
        let mutationCount = 0;
        const failIfRequested = () => {
          mutationCount += 1;
          if (harness.failOnMutation === mutationCount) throw harness.mutationFailure;
        };
        const tx = {
          execute: vi.fn(async (query: { values?: unknown[] }) => {
            harness.executeValues.push(query.values ?? []);
          }),
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(async (predicate: Predicate) =>
                workingRows.filter((row) => row.projectId === predicate.value),
              ),
            })),
          })),
          insert: vi.fn((table: unknown) => ({
            values: vi.fn(async (value: StoredVersion | Omit<StoredFile, "id" | "artifactId">) => {
              if (table === projectVersionsTable && "filesSnapshot" in value) {
                workingVersions.push(value);
                return;
              }
              if ("filesSnapshot" in value) throw new Error("unexpected version table");
              failIfRequested();
              workingRows.push({
                id: Math.max(0, ...workingRows.map((row) => row.id)) + 1,
                artifactId: null,
                ...value,
              });
            }),
          })),
          update: vi.fn(() => ({
            set: vi.fn((value: { content: string; mimeType: string; updatedAt: Date }) => ({
              where: vi.fn(async (predicate: Predicate) => {
                failIfRequested();
                const row = workingRows.find((candidate) => candidate.id === predicate.value);
                if (row) {
                  row.content = value.content;
                  row.mimeType = value.mimeType;
                }
              }),
            })),
          })),
        };

        const result = await callback(tx);
        harness.rows = workingRows;
        harness.versions = workingVersions;
        return result;
      }),
    },
  };
});

import {
  CanvasVariantGraduationError,
  graduateCanvasVariantAtomically,
} from "./canvas-variant-graduation";
import {
  PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS,
  PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS,
} from "./project-file-writer";

const originalRows: StoredFile[] = [
  {
    id: 1,
    projectId: 51,
    artifactId: 7,
    path: "index.html",
    content: "old page",
    mimeType: "text/html",
  },
  {
    id: 2,
    projectId: 51,
    artifactId: 7,
    path: "keep.js",
    content: "keep",
    mimeType: "text/javascript",
  },
];

describe("atomic canvas variant graduation", () => {
  beforeEach(() => {
    harness.rows = originalRows.map((row) => ({ ...row }));
    harness.versions = [];
    harness.failOnMutation = null;
    harness.mutationFailure = new Error("simulated failure");
    harness.executeValues = [];
  });

  it("snapshots first, preserves existing row identity, and commits the whole variant", async () => {
    const receipt = await graduateCanvasVariantAtomically({
      projectId: 51,
      variantId: 83,
      variantLabel: "Variant B",
      files: [
        { path: "index.html", content: "new page", mimeType: "text/html" },
        { path: "style.css", content: "body{}", mimeType: "" },
      ],
    });

    expect(receipt).toEqual({ inserted: 1, updated: 1 });
    expect(harness.rows).toEqual([
      { ...originalRows[0], content: "new page" },
      originalRows[1],
      {
        id: 3,
        projectId: 51,
        artifactId: null,
        path: "style.css",
        content: "body{}",
        mimeType: "text/css",
      },
    ]);
    expect(harness.versions).toEqual([
      {
        projectId: 51,
        label: "Pre-graduation: Variant B",
        note: "Snapshot taken before graduating canvas variant #83.",
        filesSnapshot: originalRows.map(({ path, content, mimeType }) => ({
          path,
          content,
          mimeType,
        })),
      },
    ]);
    expect(harness.executeValues).toEqual([
      [`${PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS}ms`],
      [`${PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS}ms`],
    ]);
  });

  it("rolls back the snapshot and every prior row when a later file write fails", async () => {
    harness.failOnMutation = 2;
    harness.mutationFailure = new Error("simulated second-file failure");

    const operation = graduateCanvasVariantAtomically({
      projectId: 51,
      variantId: 83,
      variantLabel: "Variant B",
      files: [
        { path: "index.html", content: "new page", mimeType: "text/html" },
        { path: "style.css", content: "body{}", mimeType: "text/css" },
      ],
    });

    await expect(operation).rejects.toBeInstanceOf(CanvasVariantGraduationError);
    await expect(operation).rejects.toMatchObject({
      code: "canvas_variant_graduation_failed",
      message: "The canvas variant could not be applied. Nothing was changed; please try again.",
    });
    expect(harness.rows).toEqual(originalRows);
    expect(harness.versions).toEqual([]);
  });

  it("rolls back unchanged when PostgreSQL cancels a bounded file statement", async () => {
    harness.failOnMutation = 1;
    harness.mutationFailure = new Error("canceling statement due to statement timeout");

    await expect(
      graduateCanvasVariantAtomically({
        projectId: 51,
        variantId: 83,
        variantLabel: "Variant B",
        files: [{ path: "index.html", content: "new page", mimeType: "text/html" }],
      }),
    ).rejects.toBeInstanceOf(CanvasVariantGraduationError);

    expect(harness.rows).toEqual(originalRows);
    expect(harness.versions).toEqual([]);
  });

  it("routes the canvas graduation caller through the bounded transaction", () => {
    const source = readFileSync(new URL("../routes/canvas.ts", import.meta.url), "utf8");
    const graduationRoute = extractRouteHandler(
      source,
      "post",
      "/projects/:id/canvas/variants/:vid/graduate",
    );

    expect(graduationRoute).toContain("await graduateCanvasVariantAtomically({");
    expect(graduationRoute).not.toContain("for (const f of filesToMerge)");
    expect(graduationRoute).not.toContain("db.update(projectFilesTable)");
    expect(graduationRoute).not.toContain("db.insert(projectFilesTable)");
  });
});
