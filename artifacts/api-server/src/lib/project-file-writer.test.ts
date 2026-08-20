import { readFileSync } from "node:fs";
import { describe, expect, it, beforeEach, vi } from "vitest";

interface StoredFile {
  projectId: number;
  artifactId: number;
  path: string;
  content: string;
  mimeType: string;
}

interface Predicate {
  kind: "eq" | "in" | "and";
  column?: string;
  value?: unknown;
  values?: unknown[];
  predicates?: Predicate[];
}

const harness = vi.hoisted(() => ({
  rows: [] as StoredFile[],
  artifactId: 7 as number | null,
  insertFailure: null as Error | null,
  transactions: 0,
  executeValues: [] as unknown[][],
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown): Predicate => ({ kind: "eq", column, value }),
  inArray: (column: string, values: unknown[]): Predicate => ({ kind: "in", column, values }),
  and: (...predicates: Predicate[]): Predicate => ({ kind: "and", predicates }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

function findPredicate(predicate: Predicate, kind: "eq" | "in", column: string): Predicate | null {
  if (predicate.kind === kind && predicate.column === column) return predicate;
  for (const child of predicate.predicates ?? []) {
    const found = findPredicate(child, kind, column);
    if (found) return found;
  }
  return null;
}

vi.mock("@workspace/db", () => {
  const projectFilesTable = {
    projectId: "projectId",
    artifactId: "artifactId",
    path: "path",
  };

  return {
    projectFilesTable,
    db: {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) => {
        harness.transactions += 1;
        let working = harness.rows.map((row) => ({ ...row }));
        const tx = {
          execute: vi.fn(async (query: { values?: unknown[] }) => {
            harness.executeValues.push(query.values ?? []);
          }),
          delete: vi.fn(() => ({
            where: vi.fn(async (predicate: Predicate) => {
              const projectId = findPredicate(predicate, "eq", "projectId")?.value;
              const artifactId = findPredicate(predicate, "eq", "artifactId")?.value;
              const paths = findPredicate(predicate, "in", "path")?.values;
              working = working.filter(
                (row) =>
                  row.projectId !== projectId ||
                  row.artifactId !== artifactId ||
                  (paths !== undefined && !paths.includes(row.path)),
              );
            }),
          })),
          insert: vi.fn(() => ({
            values: vi.fn(async (values: StoredFile[]) => {
              if (harness.insertFailure) throw harness.insertFailure;
              working.push(...values.map((value) => ({ ...value })));
            }),
          })),
        };

        await callback(tx);
        harness.rows = working;
      }),
    },
  };
});

vi.mock("./artifacts", () => ({
  resolveArtifactId: vi.fn(async () => harness.artifactId),
}));

import {
  PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS,
  PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS,
  ProjectFileArtifactScopeError,
  writeProjectFilesAtomically,
} from "./project-file-writer";

const originalRows: StoredFile[] = [
  {
    projectId: 51,
    artifactId: 7,
    path: "index.ts",
    content: "old index",
    mimeType: "text/typescript",
  },
  {
    projectId: 51,
    artifactId: 7,
    path: "old.ts",
    content: "old file",
    mimeType: "text/typescript",
  },
  {
    projectId: 51,
    artifactId: 8,
    path: "sibling.ts",
    content: "sibling",
    mimeType: "text/typescript",
  },
];

describe("atomic project file writes", () => {
  beforeEach(() => {
    harness.rows = originalRows.map((row) => ({ ...row }));
    harness.artifactId = 7;
    harness.insertFailure = null;
    harness.transactions = 0;
    harness.executeValues = [];
  });

  it("replaces only the resolved artifact and commits the new complete file set", async () => {
    await writeProjectFilesAtomically({
      projectId: 51,
      replaceAll: true,
      files: [
        {
          path: "index.ts",
          content: "new index",
          mimeType: "text/typescript",
        },
      ],
    });

    expect(harness.rows).toEqual([
      originalRows[2],
      {
        projectId: 51,
        artifactId: 7,
        path: "index.ts",
        content: "new index",
        mimeType: "text/typescript",
      },
    ]);
    expect(harness.executeValues).toEqual([
      [`${PROJECT_FILE_WRITE_LOCK_TIMEOUT_MS}ms`],
      [`${PROJECT_FILE_WRITE_STATEMENT_TIMEOUT_MS}ms`],
    ]);
  });

  it("preserves every original row when insertion fails after deletion", async () => {
    harness.insertFailure = new Error("simulated insert failure");

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        replaceAll: true,
        files: [{ path: "index.ts", content: "new", mimeType: "text/typescript" }],
      }),
    ).rejects.toThrow("simulated insert failure");

    expect(harness.rows).toEqual(originalRows);
  });

  it("preserves every original row when PostgreSQL cancels a bounded statement", async () => {
    harness.insertFailure = new Error("canceling statement due to statement timeout");

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        replaceAll: true,
        files: [{ path: "index.ts", content: "new", mimeType: "text/typescript" }],
      }),
    ).rejects.toThrow("statement timeout");

    expect(harness.rows).toEqual(originalRows);
  });

  it("applies changed and removed paths in one partial transaction", async () => {
    await writeProjectFilesAtomically({
      projectId: 51,
      replaceAll: false,
      files: [{ path: "index.ts", content: "new", mimeType: "text/typescript" }],
      removedPaths: ["old.ts"],
    });

    expect(harness.transactions).toBe(1);
    expect(harness.rows).toEqual([
      originalRows[2],
      {
        projectId: 51,
        artifactId: 7,
        path: "index.ts",
        content: "new",
        mimeType: "text/typescript",
      },
    ]);
  });

  it("refuses a missing artifact scope before opening a transaction or deleting rows", async () => {
    harness.artifactId = null;

    await expect(
      writeProjectFilesAtomically({ projectId: 51, replaceAll: true, files: [] }),
    ).rejects.toBeInstanceOf(ProjectFileArtifactScopeError);

    expect(harness.transactions).toBe(0);
    expect(harness.rows).toEqual(originalRows);
  });

  it("routes complete, refine, and preview-repair writes through the atomic helper", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");

    expect(source).not.toContain("async function writeFiles(");
    expect(source).not.toContain("async function deleteFiles(");
    expect(source).toContain("files: result.changedFiles");
    expect(source).toContain("removedPaths: result.removedPaths");
    expect(source).toContain("files: appliedChangedFiles");
    expect(source).toContain("removedPaths: appliedRemovedPaths");
    expect(source).not.toContain("writeFiles has durably updated the DB snapshot");
  });
});
