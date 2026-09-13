import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual writer's transaction/merge decision with deterministic
// dependencies. This is not a real PostgreSQL or embedding-provider receipt.
const source = readFileSync(new URL("./knowledge.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("knowledge.ts", source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "writeKnowledge",
);
if (declarations.length !== 1) throw new Error("Expected one production knowledge writer");
const writerCode = ts.transpileModule(
  "(" + declarations[0]!.getText(ast).replace(/^export\s+/, "") + ")",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

type Candidate = {
  id: number;
  relatedTaskId: number | null;
  severity: string;
  embedding: number[];
  content: string;
  reinforcedCount: number;
};
type WriteInput = {
  title: string;
  content: string;
  type: string;
  severity: string;
  projectId: number;
  userId: string;
  relatedTaskId: number;
};
const failure: WriteInput = {
  title: 'Build failed: "same truncated title"',
  content: "A recorded compatibility failure",
  type: "build",
  severity: "error",
  projectId: 61,
  userId: "owner-61",
  relatedTaskId: 321,
};
const candidate = (taskId: number | null, severity = "error"): Candidate => ({
  id: 856,
  relatedTaskId: taskId,
  severity,
  embedding: [1, 0],
  content: "Existing diagnostic",
  reinforcedCount: 0,
});

function setup(candidates: Candidate[], sourceProjectId = 61) {
  const predicates: unknown[] = [];
  const inserted = vi.fn();
  const updated = vi.fn();
  const provenance = vi.fn(async () => undefined);
  const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tx = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          predicates.push(condition);
          return {
            limit: async () => [{ projectId: sourceProjectId }],
            // Return the supplied candidates even if a mock ignores SQL filters.
            // The writer must independently refuse a wrong-task merge target.
            orderBy: () => ({ limit: async () => candidates }),
          };
        },
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        inserted(value);
        return { returning: async () => [{ id: 900 }] };
      },
    }),
    update: () => ({
      set: (value: unknown) => {
        updated(value);
        return { where: async () => undefined };
      },
    }),
  };
  const table = (name: string) => ({
    id: name + ".id",
    projectId: name + ".projectId",
    type: name + ".type",
    relatedTaskId: name + ".relatedTaskId",
    relatedVersionId: name + ".relatedVersionId",
    severity: name + ".severity",
    approvedForReuse: name + ".approvedForReuse",
    scope: name + ".scope",
    origin: name + ".origin",
    archivedAt: name + ".archivedAt",
    embedding: name + ".embedding",
    createdAt: name + ".createdAt",
  });
  const op =
    (name: string) =>
    (...args: unknown[]) => ({ op: name, args });
  const writer = runInNewContext(writerCode, {
    db: { transaction: async (callback: (session: typeof tx) => Promise<unknown>) => callback(tx) },
    logger,
    buildEmbeddingInput: (...values: unknown[]) => values.join(" "),
    generateEmbedding: async () => [1, 0],
    cosineSimilarity: () => 1,
    KNOWLEDGE_DEDUP_THRESHOLD: 0.9,
    anonymiseContent: (value: string) => value,
    readCurrentProjectVersionId: async () => 7,
    appendKnowledgeProvenanceReceipt: provenance,
    agentTasksTable: table("tasks"),
    projectVersionsTable: table("versions"),
    chatMessagesTable: table("messages"),
    knowledgeEntriesTable: table("knowledge"),
    and: op("and"),
    or: op("or"),
    eq: op("eq"),
    ne: op("ne"),
    isNull: op("isNull"),
    isNotNull: op("isNotNull"),
    inArray: op("inArray"),
    desc: op("desc"),
  }) as (input: WriteInput) => Promise<{ outcome: string; entryId: number } | null>;
  return { writer, inserted, updated, provenance, predicates, logger };
}

describe("task-bound failure knowledge deduplication", () => {
  it.each([null, 320])(
    "does not merge Task321 into a similar failure linked to %s",
    async (taskId) => {
      const subject = setup([candidate(taskId)]);
      await expect(subject.writer(failure)).resolves.toEqual({ outcome: "inserted", entryId: 900 });
      expect(subject.updated).not.toHaveBeenCalled();
      expect(subject.inserted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          projectId: 61,
          relatedTaskId: 321,
          severity: "error",
          origin: "builder",
        }),
      );
      const candidatePredicate = subject.predicates.at(-1);
      expect(JSON.stringify(candidatePredicate)).toContain(
        '"args":["knowledge.relatedTaskId",321]',
      );
      expect(JSON.stringify(candidatePredicate)).toContain('"args":["knowledge.severity","error"]');
      expect(subject.provenance).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({
          knowledgeEntryId: 900,
          sourceTaskId: 321,
          outcome: "inserted",
        }),
      );
    },
  );

  it("can reinforce another error record from the same execution", async () => {
    const subject = setup([candidate(321)]);
    await expect(subject.writer(failure)).resolves.toEqual({ outcome: "reinforced", entryId: 856 });
    expect(subject.inserted).not.toHaveBeenCalled();
    expect(subject.updated).toHaveBeenCalledOnce();
    expect(subject.provenance).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        knowledgeEntryId: 856,
        sourceTaskId: 321,
        outcome: "reinforced",
      }),
    );
  });

  it("does not convert an informational record into the retry target for a failure", async () => {
    const subject = setup([candidate(321, "info")]);
    await expect(subject.writer(failure)).resolves.toEqual({ outcome: "inserted", entryId: 900 });
    expect(subject.updated).not.toHaveBeenCalled();
  });

  it("retains ordinary non-error semantic knowledge reinforcement", async () => {
    const subject = setup([candidate(320, "info")]);
    await expect(subject.writer({ ...failure, type: "lesson", severity: "info" })).resolves.toEqual(
      {
        outcome: "reinforced",
        entryId: 856,
      },
    );
    expect(subject.inserted).not.toHaveBeenCalled();
    expect(subject.updated).toHaveBeenCalledOnce();
  });

  it("rejects a source task owned by a different project before inserting or reinforcing", async () => {
    const subject = setup([candidate(321)], 99);
    await expect(subject.writer(failure)).resolves.toBeNull();
    expect(subject.inserted).not.toHaveBeenCalled();
    expect(subject.updated).not.toHaveBeenCalled();
    expect(subject.provenance).not.toHaveBeenCalled();
    expect(subject.logger.error).toHaveBeenCalledOnce();
  });
});
