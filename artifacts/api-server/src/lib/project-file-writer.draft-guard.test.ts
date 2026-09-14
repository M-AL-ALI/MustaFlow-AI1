import { beforeEach, describe, expect, it, vi } from "vitest";

interface StoredFile {
  id: number;
  projectId: number;
  artifactId: number | null;
  path: string;
  content: string;
  mimeType: string;
}

interface Predicate {
  kind: "eq" | "in" | "and" | "or" | "isNull";
  column?: string;
  value?: unknown;
  values?: unknown[];
  predicates?: Predicate[];
}

interface Usage {
  projectId: number;
  artifactId: number | null;
  filePath: string;
  nextContent: string | null;
}

const harness = vi.hoisted(() => ({
  rows: [] as StoredFile[],
  project: { id: 61, ownerId: "owner-61", deletedAt: null as string | null },
  task: { id: 320, projectId: 61, status: "building" } as {
    id: number;
    projectId: number;
    status: string;
  } | null,
  primary: { id: 7, projectId: 61, isPrimary: true, deletedAt: null as string | null },
  resolvedArtifactId: 7,
  nextFileId: 100,
  events: [] as string[],
  transactions: 0,
  rollbacks: 0,
  beforeLock: null as (() => void) | null,
  pendingUsage: [] as Usage[],
  committedUsage: [] as Usage[],
  reconciliationFailure: null as Error | null,
  failEvidenceReadAfterMutation: false,
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (column: string, value: unknown): Predicate => ({ kind: "eq", column, value }),
  inArray: (column: string, values: unknown[]): Predicate => ({ kind: "in", column, values }),
  and: (...predicates: Predicate[]): Predicate => ({ kind: "and", predicates }),
  or: (...predicates: Predicate[]): Predicate => ({ kind: "or", predicates }),
  isNull: (column: string): Predicate => ({ kind: "isNull", column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

function matches(row: Record<string, unknown>, predicate: Predicate): boolean {
  const field = predicate.column?.split(".").pop() ?? "";
  switch (predicate.kind) {
    case "eq":
      return row[field] === predicate.value;
    case "in":
      return predicate.values?.includes(row[field]) ?? false;
    case "isNull":
      return row[field] == null;
    case "and":
      return (predicate.predicates ?? []).every((part) => matches(row, part));
    case "or":
      return (predicate.predicates ?? []).some((part) => matches(row, part));
    default:
      throw new Error("Unexpected predicate in draft-guard harness");
  }
}

vi.mock("@workspace/db", () => {
  const table = (name: string, fields: string[]) =>
    Object.fromEntries([["__name", name], ...fields.map((field) => [field, name + "." + field])]);
  const projectsTable = table("projects", ["id", "ownerId", "deletedAt"]);
  const agentTasksTable = table("tasks", ["id", "projectId", "status"]);
  const projectArtifactsTable = table("artifacts", ["id", "projectId", "isPrimary", "deletedAt"]);
  const projectFilesTable = table("files", [
    "id",
    "projectId",
    "artifactId",
    "path",
    "content",
    "mimeType",
  ]);
  const projectVersionsTable = table("versions", ["id", "projectId"]);
  return {
    projectsTable,
    agentTasksTable,
    projectArtifactsTable,
    projectFilesTable,
    projectVersionsTable,
    db: {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        harness.transactions += 1;
        let working = harness.rows.map((row) => ({ ...row }));
        harness.pendingUsage = [];
        const tx = {
          execute: vi.fn(async (query: { strings?: readonly string[] }) => {
            if (query.strings?.join("").toLowerCase().includes("pg_advisory_xact_lock")) {
              harness.events.push("lifecycle-lock");
              const change = harness.beforeLock;
              harness.beforeLock = null;
              change?.();
              // Model a concurrent commit visible after acquiring the lifecycle lock.
              working = harness.rows.map((row) => ({ ...row }));
            }
          }),
          select: vi.fn((projection?: Record<string, string>) => ({
            from: vi.fn((source: Record<string, string>) => {
              let predicate: Predicate | undefined;
              let limit: number | undefined;
              const query = {
                where: vi.fn((value: Predicate) => {
                  predicate = value;
                  return query;
                }),
                limit: vi.fn((value: number) => {
                  limit = value;
                  return query;
                }),
                orderBy: vi.fn(() => query),
                for: vi.fn((mode: string) => {
                  harness.events.push("lock:" + source.__name + ":" + mode);
                  return query;
                }),
                then: (
                  resolve: (rows: Record<string, unknown>[]) => unknown,
                  reject?: (error: unknown) => unknown,
                ) =>
                  Promise.resolve()
                    .then(() => {
                      harness.events.push("read:" + source.__name);
                      let rows: Record<string, unknown>[];
                      switch (source.__name) {
                        case "projects":
                          rows = [{ ...harness.project }];
                          break;
                        case "tasks":
                          rows = harness.task ? [{ ...harness.task }] : [];
                          break;
                        case "artifacts":
                          rows = [{ ...harness.primary }];
                          break;
                        case "files":
                          if (
                            harness.failEvidenceReadAfterMutation &&
                            harness.events.includes("delete:files")
                          )
                            throw new Error("evidence snapshot read failed");
                          rows = working.map((row) => ({ ...row }));
                          break;
                        default:
                          throw new Error("Unexpected table read: " + source.__name);
                      }
                      if (predicate) rows = rows.filter((row) => matches(row, predicate!));
                      if (limit !== undefined) rows = rows.slice(0, limit);
                      if (projection) {
                        rows = rows.map((row) =>
                          Object.fromEntries(
                            Object.entries(projection).map(([key, column]) => [
                              key,
                              row[column.split(".").pop()!],
                            ]),
                          ),
                        );
                      }
                      return rows;
                    })
                    .then(resolve, reject),
              };
              return query;
            }),
          })),
          delete: vi.fn((source: Record<string, string>) => ({
            where: vi.fn(async (predicate: Predicate) => {
              harness.events.push("delete:" + source.__name);
              if (source !== projectFilesTable) throw new Error("Unexpected delete");
              working = working.filter((row) => !matches({ ...row }, predicate));
            }),
          })),
          insert: vi.fn((source: Record<string, string>) => ({
            values: vi.fn(async (values: Array<Omit<StoredFile, "id">>) => {
              harness.events.push("insert:" + source.__name);
              if (source !== projectFilesTable) throw new Error("Unexpected insert");
              working.push(...values.map((row) => ({ ...row, id: harness.nextFileId++ })));
            }),
          })),
        };
        try {
          const result = await callback(tx);
          harness.rows = working;
          harness.committedUsage.push(...harness.pendingUsage);
          return result;
        } catch (error) {
          harness.rollbacks += 1;
          throw error;
        } finally {
          harness.pendingUsage = [];
        }
      }),
    },
  };
});

// This file exercises business-row guards with a transactional double.
// The integration script separately proves genuine PostgreSQL lock composition.
vi.mock("./project-lifecycle", async () => {
  const { db } = await import("@workspace/db");
  return {
    transactionHoldsProjectLifecycleLock: () => false,
    withResponseProjectLifecycleTransaction: (
      _res: unknown,
      _projectId: number,
      work: Parameters<typeof db.transaction>[0],
    ) => db.transaction(work),
  };
});

// Keep the real pure primary/legacy overlay selection, wherever the writer imports it.
vi.mock("./artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifacts")>()),
  resolveArtifactId: vi.fn(async () => harness.resolvedArtifactId),
}));

vi.mock("./project-file-asset-usage", () => ({
  reconcileProjectFileAssetUsage: vi.fn(async (_tx: unknown, input: Usage) => {
    harness.events.push("reconcile");
    if (harness.reconciliationFailure) throw harness.reconciliationFailure;
    harness.pendingUsage.push({ ...input });
  }),
}));

import {
  writeProjectFilesAtomically,
  ProjectFileWriteError,
  type ProjectFileMutation,
} from "./project-file-writer";
import { FailedDraftRecoveryError, failedDraftFingerprint } from "./zero-sealed-failed-draft";
import { CommittedBuildFileReport } from "./committed-build-file-report";

const initialRows: StoredFile[] = [
  {
    id: 1,
    projectId: 61,
    artifactId: null,
    path: "src/index.ts",
    content: "legacy shadow",
    mimeType: "text/typescript",
  },
  {
    id: 2,
    projectId: 61,
    artifactId: 7,
    path: "src/index.ts",
    content: "primary source",
    mimeType: "text/typescript",
  },
  {
    id: 3,
    projectId: 61,
    artifactId: 7,
    path: "obsolete.ts",
    content: "obsolete",
    mimeType: "text/typescript",
  },
  {
    id: 4,
    projectId: 61,
    artifactId: null,
    path: "README.md",
    content: "retained legacy notes",
    mimeType: "text/markdown",
  },
  {
    id: 5,
    projectId: 61,
    artifactId: 8,
    path: "sibling.ts",
    content: "other artifact",
    mimeType: "text/typescript",
  },
  {
    id: 6,
    projectId: 62,
    artifactId: 7,
    path: "outside.ts",
    content: "other project",
    mimeType: "text/typescript",
  },
];

function guardedInput(): ProjectFileMutation {
  // Independent expected overlay: primary beats same-path legacy; legacy-only
  // files remain, while other artifacts and projects are excluded.
  const base = [initialRows[1], initialRows[2], initialRows[3]].map(
    ({ path, content, mimeType }) => ({ path, content, mimeType }),
  );
  return {
    projectId: 61,
    scope: { kind: "artifact" },
    replaceAll: false,
    files: [{ path: "src/index.ts", content: "corrected source", mimeType: "text/typescript" }],
    removedPaths: ["obsolete.ts"],
    expectedBase: {
      fingerprint: failedDraftFingerprint(base),
      taskId: 320,
      ownerUserId: "owner-61",
    },
  };
}

async function expectBlocked(input: ProjectFileMutation): Promise<void> {
  await expect(writeProjectFilesAtomically(input)).rejects.toBeInstanceOf(FailedDraftRecoveryError);
  expect(
    harness.events.filter(
      (event) =>
        event.startsWith("delete:") || event.startsWith("insert:") || event === "reconcile",
    ),
  ).toEqual([]);
  expect(harness.committedUsage).toEqual([]);
  expect(harness.transactions).toBe(1);
}

beforeEach(() => {
  harness.rows = initialRows.map((row) => ({ ...row }));
  harness.project = { id: 61, ownerId: "owner-61", deletedAt: null };
  harness.task = { id: 320, projectId: 61, status: "building" };
  harness.primary = { id: 7, projectId: 61, isPrimary: true, deletedAt: null };
  harness.resolvedArtifactId = 7;
  harness.nextFileId = 100;
  harness.events = [];
  harness.transactions = 0;
  harness.rollbacks = 0;
  harness.beforeLock = null;
  harness.pendingUsage = [];
  harness.committedUsage = [];
  harness.reconciliationFailure = null;
  harness.failEvidenceReadAfterMutation = false;
});

describe("failed-draft guarded project file writes", () => {
  it("does not report removal of legacy-only rows that the scoped writer retains", async () => {
    const tracker = new CommittedBuildFileReport();
    const receipt = await writeProjectFilesAtomically({
      ...guardedInput(),
      files: [],
      removedPaths: ["README.md"],
      captureEffectiveFileChanges: true,
    });
    tracker.record(receipt.effectiveFileChanges);
    expect(harness.rows).toEqual(initialRows);
    expect(receipt.effectiveFileChanges).toEqual([]);
    expect(tracker.toReport()).toEqual({
      filesCreated: [],
      filesChanged: [],
      filesRemoved: [],
      warnings: [],
    });
  });

  it("reports an override removal as a change when its legacy fallback becomes visible", async () => {
    const tracker = new CommittedBuildFileReport();
    const receipt = await writeProjectFilesAtomically({
      ...guardedInput(),
      files: [],
      removedPaths: ["src/index.ts"],
      captureEffectiveFileChanges: true,
    });
    tracker.record(receipt.effectiveFileChanges);
    expect(tracker.toReport()).toMatchObject({
      filesCreated: [],
      filesChanged: ["src/index.ts"],
      filesRemoved: [],
    });
    expect(harness.rows).toContainEqual(initialRows[0]);
    expect(harness.rows).not.toContainEqual(initialRows[1]);
    expect(JSON.stringify(receipt)).not.toContain("legacy shadow");
    expect(JSON.stringify(receipt)).not.toContain("primary source");
  });

  it("retains legacy, sibling and other-project files when reporting a full scoped replacement", async () => {
    const tracker = new CommittedBuildFileReport();
    const receipt = await writeProjectFilesAtomically({
      ...guardedInput(),
      replaceAll: true,
      captureEffectiveFileChanges: true,
    });
    tracker.record(receipt.effectiveFileChanges);
    expect(tracker.toReport()).toMatchObject({
      filesCreated: [],
      filesChanged: ["src/index.ts"],
      filesRemoved: ["obsolete.ts"],
    });
    for (const index of [0, 3, 4, 5]) expect(harness.rows).toContainEqual(initialRows[index]);
  });

  it("does not include a concurrent edit committed before the file-write lock", async () => {
    harness.beforeLock = () => {
      harness.rows[3].content = "other writer's saved notes";
    };
    const receipt = await writeProjectFilesAtomically({
      ...guardedInput(),
      expectedBase: undefined,
      removedPaths: [],
      captureEffectiveFileChanges: true,
    });
    expect(receipt.effectiveFileChanges.map((change) => change.path)).toEqual(["src/index.ts"]);
    expect(harness.rows[3].content).toBe("other writer's saved notes");
    expect(harness.events.indexOf("read:files")).toBeGreaterThan(
      harness.events.indexOf("lifecycle-lock"),
    );
  });

  it("rolls back the file mutation if its effective-result read fails", async () => {
    harness.failEvidenceReadAfterMutation = true;
    await expect(
      writeProjectFilesAtomically({
        ...guardedInput(),
        captureEffectiveFileChanges: true,
      }),
    ).rejects.toBeInstanceOf(ProjectFileWriteError);
    expect(harness.rows).toEqual(initialRows);
    expect(harness.committedUsage).toEqual([]);
    expect(harness.rollbacks).toBe(1);
  });

  it("leaves receipt capture off for existing callers and rejects project-wide capture", async () => {
    const receipt = await writeProjectFilesAtomically(guardedInput());
    expect(receipt.effectiveFileChanges).toBeUndefined();
    const transactions = harness.transactions;
    const rows = harness.rows.map((row) => ({ ...row }));
    await expect(
      writeProjectFilesAtomically({
        projectId: 61,
        scope: { kind: "project" },
        files: [],
        replaceAll: true,
        captureEffectiveFileChanges: true,
      }),
    ).rejects.toMatchObject({ code: "project_file_artifact_scope_unavailable" });
    expect(harness.transactions).toBe(transactions);
    expect(harness.rows).toEqual(rows);
  });

  it("commits a matching primary/legacy overlay only after lifecycle and task locks", async () => {
    await writeProjectFilesAtomically(guardedInput());
    expect(harness.rows).toContainEqual(
      expect.objectContaining({
        projectId: 61,
        artifactId: 7,
        path: "src/index.ts",
        content: "corrected source",
      }),
    );
    expect(
      harness.rows.some(
        (row) => row.projectId === 61 && row.artifactId === 7 && row.path === "obsolete.ts",
      ),
    ).toBe(false);
    for (const index of [0, 3, 4, 5]) expect(harness.rows).toContainEqual(initialRows[index]);
    const lifecycle = harness.events.indexOf("lifecycle-lock");
    const taskLock = harness.events.indexOf("lock:tasks:update");
    const mutation = harness.events.indexOf("delete:files");
    expect(lifecycle).toBeGreaterThanOrEqual(0);
    expect(taskLock).toBeGreaterThan(lifecycle);
    expect(mutation).toBeGreaterThan(taskLock);
    expect(harness.committedUsage).toHaveLength(2);
  });

  it("rejects a newer source base without changing its files or references", async () => {
    const input = guardedInput();
    harness.rows[1].content = "newer user revision";
    const newer = harness.rows.map((row) => ({ ...row }));
    await expectBlocked(input);
    expect(harness.rows).toEqual(newer);
  });

  it("rejects an owner change that becomes visible when the lifecycle lock is acquired", async () => {
    harness.beforeLock = () => {
      harness.project.ownerId = "different-owner";
    };
    await expectBlocked(guardedInput());
    expect(harness.rows).toEqual(initialRows);
  });

  it.each(["cancelled", "missing from this project"] as const)(
    "rejects a task that is %s at the guarded write boundary",
    async (state) => {
      harness.beforeLock = () => {
        harness.task =
          state === "cancelled"
            ? { id: 320, projectId: 61, status: "cancelled" }
            : { id: 320, projectId: 62, status: "building" };
      };
      await expectBlocked(guardedInput());
      expect(harness.rows).toEqual(initialRows);
    },
  );

  it("rejects a different active primary artifact before touching files", async () => {
    harness.primary.id = 8;
    await expectBlocked(guardedInput());
    expect(harness.rows).toEqual(initialRows);
  });

  it("rolls back guarded deletes and inserts when asset reconciliation fails", async () => {
    harness.reconciliationFailure = new Error("asset usage write failed");
    await expect(writeProjectFilesAtomically(guardedInput())).rejects.toBeInstanceOf(
      ProjectFileWriteError,
    );
    expect(harness.events).toEqual(
      expect.arrayContaining(["delete:files", "insert:files", "reconcile"]),
    );
    expect(harness.rows).toEqual(initialRows);
    expect(harness.committedUsage).toEqual([]);
    expect(harness.rollbacks).toBe(1);
  });

  it("keeps unguarded callers independent of failed-draft owner, task, and primary checks", async () => {
    const { expectedBase: _expectedBase, ...input } = guardedInput();
    harness.project.ownerId = "different-owner";
    harness.task = null;
    harness.primary.id = 8;
    await writeProjectFilesAtomically(input);
    expect(harness.rows).toContainEqual(
      expect.objectContaining({
        projectId: 61,
        artifactId: 7,
        path: "src/index.ts",
        content: "corrected source",
      }),
    );
    expect(harness.events).not.toContain("read:tasks");
    expect(harness.events).not.toContain("lock:tasks:update");
    expect(harness.events).not.toContain("read:artifacts");
    expect(harness.committedUsage).toHaveLength(2);
  });
});
