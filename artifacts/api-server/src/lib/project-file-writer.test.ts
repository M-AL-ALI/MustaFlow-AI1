import { readFileSync } from "node:fs";
import { createSourceFile, forEachChild, isFunctionDeclaration, ScriptTarget } from "typescript";
import { describe, expect, it, beforeEach, vi } from "vitest";

function extractNamedFunction(source: string, functionName: string): string {
  const sourceFile = createSourceFile("source.ts", source, ScriptTarget.Latest, true);
  let match: string | undefined;

  function visit(node: Parameters<typeof forEachChild>[0]): void {
    if (isFunctionDeclaration(node) && node.name?.text === functionName) {
      match = node.getText(sourceFile);
      return;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!match) throw new Error(`Named function not found: ${functionName}`);
  return match;
}

interface StoredFile {
  projectId: number;
  artifactId: number | null;
  path: string;
  content: string;
  mimeType: string;
}

interface StoredVersion {
  id: number;
  projectId: number;
  label: string;
  note: string;
  changelogEntry: string;
  filesSnapshot: Array<{ path: string; content: string; mimeType: string }>;
  planSnapshot?: Record<string, unknown>;
  planSourceMessageId?: number;
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
  versions: [] as StoredVersion[],
  artifactId: 7 as number | null,
  insertFailure: null as Error | null,
  executeFailure: null as Error | null,
  versionInsertFailure: null as Error | null,
  nextVersionId: 41,
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
    content: "content",
    mimeType: "mimeType",
  };
  const projectVersionsTable = {
    id: "versionId",
  };

  return {
    projectFilesTable,
    projectVersionsTable,
    db: {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        harness.transactions += 1;
        let working = harness.rows.map((row) => ({ ...row }));
        const workingVersions = harness.versions.map((version) => ({ ...version }));
        const tx = {
          execute: vi.fn(async (query: { values?: unknown[] }) => {
            if (harness.executeFailure) throw harness.executeFailure;
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
                  (artifactId !== undefined && row.artifactId !== artifactId) ||
                  (paths !== undefined && !paths.includes(row.path)),
              );
            }),
          })),
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(async (predicate: Predicate) => {
                const projectId = findPredicate(predicate, "eq", "projectId")?.value;
                return working
                  .filter((row) => row.projectId === projectId)
                  .map(({ path, content, mimeType }) => ({ path, content, mimeType }));
              }),
            })),
          })),
          insert: vi.fn((table: unknown) => ({
            values: vi.fn((values: StoredFile[] | Omit<StoredVersion, "id">) => {
              if (table === projectFilesTable) {
                return (async () => {
                  if (harness.insertFailure) throw harness.insertFailure;
                  working.push(...(values as StoredFile[]).map((value) => ({ ...value })));
                })();
              }
              return {
                returning: vi.fn(async () => {
                  if (harness.versionInsertFailure) throw harness.versionInsertFailure;
                  const version = {
                    ...(values as Omit<StoredVersion, "id">),
                    id: harness.nextVersionId,
                  };
                  workingVersions.push(version);
                  return [{ id: version.id }];
                }),
              };
            }),
          })),
        };

        const result = await callback(tx);
        harness.rows = working;
        harness.versions = workingVersions;
        return result;
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
  ProjectFileVersionHandoffError,
  ProjectFileWriteError,
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
    harness.versions = [];
    harness.artifactId = 7;
    harness.insertFailure = null;
    harness.executeFailure = null;
    harness.versionInsertFailure = null;
    harness.nextVersionId = 41;
    harness.transactions = 0;
    harness.executeValues = [];
  });

  it("replaces only the resolved artifact and commits the new complete file set", async () => {
    await writeProjectFilesAtomically({
      projectId: 51,
      scope: { kind: "artifact" },
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
        scope: { kind: "artifact" },
        replaceAll: true,
        files: [{ path: "index.ts", content: "new", mimeType: "text/typescript" }],
      }),
    ).rejects.toMatchObject({
      name: "ProjectFileWriteError",
      code: "project_file_write_failed",
      message: "Your project changes could not be saved. Nothing was changed; please try again.",
    });

    expect(harness.rows).toEqual(originalRows);
  });

  it("preserves every prior project row when a rollback restore fails after deletion", async () => {
    harness.insertFailure = new Error("simulated rollback insert failure");

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        scope: { kind: "project" },
        replaceAll: true,
        files: [{ path: "index.ts", content: "restored", mimeType: "text/typescript" }],
      }),
    ).rejects.toBeInstanceOf(ProjectFileWriteError);

    expect(harness.transactions).toBe(1);
    expect(harness.rows).toEqual(originalRows);
  });

  it("replaces every project row only when project-wide scope is explicitly requested", async () => {
    await writeProjectFilesAtomically({
      projectId: 51,
      scope: { kind: "project" },
      replaceAll: true,
      files: [{ path: "index.ts", content: "restored", mimeType: "text/typescript" }],
    });

    expect(harness.rows).toEqual([
      {
        projectId: 51,
        artifactId: null,
        path: "index.ts",
        content: "restored",
        mimeType: "text/typescript",
      },
    ]);
  });

  it("preserves every original row when PostgreSQL cancels a bounded statement", async () => {
    harness.insertFailure = new Error("canceling statement due to statement timeout");

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        scope: { kind: "artifact" },
        replaceAll: true,
        files: [{ path: "index.ts", content: "new", mimeType: "text/typescript" }],
      }),
    ).rejects.toBeInstanceOf(ProjectFileWriteError);

    expect(harness.rows).toEqual(originalRows);
  });

  it("returns the same readable rollback refusal when PostgreSQL times out on the lock", async () => {
    harness.executeFailure = new Error("canceling statement due to lock timeout");

    const operation = writeProjectFilesAtomically({
      projectId: 51,
      scope: { kind: "artifact" },
      replaceAll: true,
      files: [{ path: "index.ts", content: "new", mimeType: "text/typescript" }],
    });

    await expect(operation).rejects.toMatchObject({
      name: "ProjectFileWriteError",
      code: "project_file_write_failed",
      message: "Your project changes could not be saved. Nothing was changed; please try again.",
    });

    expect(harness.rows).toEqual(originalRows);
  });

  it("applies changed and removed paths in one partial transaction", async () => {
    await writeProjectFilesAtomically({
      projectId: 51,
      scope: { kind: "artifact" },
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

  it("commits the complete project snapshot and authoritative version with the file set", async () => {
    const receipt = await writeProjectFilesAtomically({
      projectId: 51,
      scope: { kind: "artifact" },
      replaceAll: true,
      files: [{ path: "index.ts", content: "new index", mimeType: "text/typescript" }],
      authoritativeVersion: {
        label: "Apply Task #99",
        note: "Updated the page",
        changelogEntry: "Applied the staged review",
        planSnapshot: { steps: [] },
        planSourceMessageId: 88,
      },
    });

    expect(receipt.authoritativeVersion).toEqual({
      id: 41,
      filesSnapshot: [
        { path: "sibling.ts", content: "sibling", mimeType: "text/typescript" },
        { path: "index.ts", content: "new index", mimeType: "text/typescript" },
      ],
    });
    expect(harness.versions).toEqual([
      {
        id: 41,
        projectId: 51,
        label: "Apply Task #99",
        note: "Updated the page",
        changelogEntry: "Applied the staged review",
        filesSnapshot: receipt.authoritativeVersion?.filesSnapshot,
        planSnapshot: { steps: [] },
        planSourceMessageId: 88,
      },
    ]);
  });

  it("rolls the files back and returns a recoverable typed refusal when version insertion fails", async () => {
    harness.versionInsertFailure = new Error("simulated database detail");

    const operation = writeProjectFilesAtomically({
      projectId: 51,
      scope: { kind: "artifact" },
      replaceAll: true,
      files: [{ path: "index.ts", content: "new index", mimeType: "text/typescript" }],
      authoritativeVersion: {
        label: "Apply Task #99",
        note: "Updated the page",
        changelogEntry: "Applied the staged review",
      },
    });

    await expect(operation).rejects.toMatchObject({
      name: "ProjectFileVersionHandoffError",
      code: "project_file_version_handoff_failed",
      message:
        "Your files and version could not be saved together. Nothing was changed; please try again.",
    });
    await expect(operation).rejects.toBeInstanceOf(ProjectFileVersionHandoffError);
    expect(harness.rows).toEqual(originalRows);
    expect(harness.versions).toEqual([]);
  });

  it("refuses a missing artifact scope before opening a transaction or deleting rows", async () => {
    harness.artifactId = null;

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        scope: { kind: "artifact" },
        replaceAll: true,
        files: [],
      }),
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
    expect(source.match(/scope: \{ kind: "artifact" \}/g)).toHaveLength(6);
    expect(source).not.toContain("writeFiles has durably updated the DB snapshot");
  });

  it("binds staged Apply files to the authoritative version in the same atomic call", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const applyFlow = source.slice(
      source.indexOf("export async function applyTaskAgentStaging"),
      source.indexOf("export async function discardTaskAgentStaging"),
    );

    expect(applyFlow).toContain("authoritativeVersion: {");
    expect(applyFlow).toContain("const version = fileWriteReceipt.authoritativeVersion;");
    expect(applyFlow).not.toContain("Failed to save apply-stage version snapshot");
    expect(applyFlow).not.toContain("revision: version?.id ?? null");
  });

  it("routes project-wide version rollback through the same atomic helper", () => {
    const source = readFileSync(new URL("../routes/versions.ts", import.meta.url), "utf8");
    const rollbackRoute = source.slice(
      source.indexOf('"/projects/:id/versions/:versionId/rollback"'),
      source.indexOf("// ── POST /api/projects/:id/versions/:versionId/approve-testing"),
    );

    expect(rollbackRoute).toContain("await writeProjectFilesAtomically({");
    expect(rollbackRoute).toContain('scope: { kind: "project" }');
    expect(rollbackRoute).toContain("replaceAll: true");
    expect(rollbackRoute).not.toContain("db.delete(projectFilesTable)");
    expect(rollbackRoute).not.toContain("db.insert(projectFilesTable)");
  });

  it("preserves every mobile-settings row when insertion fails after replacement starts", async () => {
    harness.rows = [
      {
        projectId: 51,
        artifactId: null,
        path: "app.json",
        content: "old settings",
        mimeType: "application/json",
      },
      {
        projectId: 51,
        artifactId: null,
        path: "assets/icon.png",
        content: "old icon",
        mimeType: "image/png",
      },
    ];
    const priorRows = harness.rows.map((row) => ({ ...row }));
    harness.insertFailure = new Error("simulated mobile settings insert failure");

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        scope: { kind: "project" },
        replaceAll: false,
        files: [
          { path: "app.json", content: "new settings", mimeType: "application/json" },
          { path: "assets/icon.png", content: "new icon", mimeType: "image/png" },
        ],
        authoritativeVersion: {
          label: "Settings: app name",
          note: "App settings updated: app name",
          changelogEntry: "App settings updated: app name",
        },
      }),
    ).rejects.toBeInstanceOf(ProjectFileWriteError);

    expect(harness.rows).toEqual(priorRows);
    expect(harness.versions).toEqual([]);
  });

  it("routes mobile settings files and their rollback snapshot through one atomic call", () => {
    const source = readFileSync(new URL("../routes/mobile-settings.ts", import.meta.url), "utf8");
    const writeFlow = extractNamedFunction(source, "commitFilesAndVersion");

    expect(writeFlow).toContain("await writeProjectFilesAtomically({");
    expect(writeFlow).toContain('scope: { kind: "project" }');
    expect(writeFlow).toContain("replaceAll: false");
    expect(writeFlow).toContain("authoritativeVersion: {");
    expect(source).not.toContain("async function writeFiles(");
    expect(source).not.toContain("async function snapshotFiles(");
  });

  it("leaves neither a file change nor an extra version when one suggested-file write fails", async () => {
    const priorRows = harness.rows.map((row) => ({ ...row }));
    harness.insertFailure = new Error("simulated suggested-file insert failure");

    await expect(
      writeProjectFilesAtomically({
        projectId: 51,
        scope: { kind: "artifact", artifactId: 7 },
        replaceAll: false,
        files: [
          {
            path: "index.ts",
            content: "suggested index",
            mimeType: "text/typescript",
          },
        ],
        authoritativeVersion: {
          label: "Assistant edit: index.ts",
          note: "Saved after applying an Assistant suggestion.",
          changelogEntry: "Updated index.ts",
        },
      }),
    ).rejects.toBeInstanceOf(ProjectFileWriteError);

    expect(harness.rows).toEqual(priorRows);
    expect(harness.versions).toEqual([]);
  });

  it("routes a single suggested-file write and its version through one atomic call", () => {
    const source = readFileSync(new URL("../routes/files.ts", import.meta.url), "utf8");
    const applySuggestionRoute = source.slice(
      source.indexOf('"/projects/:id/files/apply-suggestion"'),
      source.indexOf("export default router"),
    );

    expect(applySuggestionRoute).toContain("await writeProjectFilesAtomically({");
    expect(applySuggestionRoute).toContain("authoritativeVersion: {");
    expect(applySuggestionRoute).not.toContain("Snapshot current state BEFORE the write");
    expect(applySuggestionRoute).not.toContain("db.insert(projectVersionsTable)");
    expect(applySuggestionRoute).not.toContain("db.update(projectFilesTable)");
  });

  it("keeps checkpoint file replacement and restored-version recording in one transaction", () => {
    const source = readFileSync(new URL("../routes/checkpoints.ts", import.meta.url), "utf8");
    const restoreTransaction = source.slice(
      source.indexOf("// 3) Restore files and append the restored state"),
      source.indexOf("if (!restoredCheckpointId)"),
    );

    expect(restoreTransaction).toContain("await db.transaction(async (tx) => {");
    expect(restoreTransaction).toContain("await tx.delete(projectFilesTable)");
    expect(restoreTransaction).toContain("await tx.insert(projectFilesTable)");
    expect(restoreTransaction).toContain(".insert(projectVersionsTable)");
  });
});
