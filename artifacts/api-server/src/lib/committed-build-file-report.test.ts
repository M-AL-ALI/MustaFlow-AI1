import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { CommittedBuildFileReport } from "./committed-build-file-report";

const file = (path: string, content = "before", mimeType = "text/plain") => ({
  path,
  content,
  mimeType,
});
const empty = { filesCreated: [], filesChanged: [], filesRemoved: [], warnings: [] };

// Exercise the real writer/tracker pairs without starting the jobs queue.
const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("jobs.ts", source, ts.ScriptTarget.Latest, true);
const pairs: Array<(context: Record<string, unknown>) => Promise<void>> = [];
function visit(node: ts.Node): void {
  if (ts.isBlock(node)) {
    node.statements.forEach((statement, index) => {
      if (statement.getText(parsed) !== "interruptedMutationCommitted = true;") return;
      const write = node.statements[index - 1]?.getText(parsed);
      const record = node.statements[index + 1]?.getText(parsed);
      if (
        !write?.startsWith("await writeProjectFilesAtomically(") ||
        !record?.startsWith("committedFileChanges.record(")
      ) {
        throw new Error("Every acknowledged file commit must immediately update its report");
      }
      const compiled = ts.transpileModule(
        `(async function (context) {
          const { writeProjectFilesAtomically, committedFileChanges, input, projectId,
            filesWithHealth, sealedWriteGuard, result, repairLoopResult,
            appliedChangedFiles, appliedRemovedPaths } = context;
          ${write}
          ${record}
        })`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
      );
      pairs.push(new Script(compiled.outputText).runInNewContext({}, { timeout: 1_000 }));
    });
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
if (pairs.length !== 4) throw new Error("Expected all four production file commit paths");

function contextFor(committedFileChanges: CommittedBuildFileReport, writer: unknown) {
  return {
    writeProjectFilesAtomically: writer,
    committedFileChanges,
    input: {},
    projectId: 61,
    filesWithHealth: [file("new.ts"), file("health.ts")],
    sealedWriteGuard: () => undefined,
    result: { changedFiles: [file("new.ts")], removedPaths: ["old.ts"] },
    repairLoopResult: { changedFiles: [file("new.ts")] },
    appliedChangedFiles: [file("new.ts")],
    appliedRemovedPaths: ["old.ts"],
  };
}

describe("acknowledged build file reports", () => {
  it("starts empty and does not treat baseline files as created", () => {
    expect(new CommittedBuildFileReport([file("existing.ts")]).toReport()).toEqual(empty);
  });

  it("compares replacements against real pre-run files, including removed paths", () => {
    const tracker = new CommittedBuildFileReport([file("kept.ts"), file("old.ts")]);
    tracker.record({ files: [file("kept.ts"), file("new.ts")], replaceAll: true });
    expect(tracker.toReport()).toMatchObject({
      filesCreated: ["new.ts"],
      filesChanged: [],
      filesRemoved: ["old.ts"],
    });
  });

  it("reports initial build and injected health files without source content", () => {
    const tracker = new CommittedBuildFileReport([]);
    tracker.record({
      files: [file("server.ts", "PRIVATE_SOURCE"), file("health.ts")],
      replaceAll: true,
    });
    expect(tracker.toReport().filesCreated).toEqual(["health.ts", "server.ts"]);
    expect(JSON.stringify(tracker.toReport())).not.toContain("PRIVATE_SOURCE");
  });

  it("tracks changes to content and MIME type, but not unchanged writes or absent removals", () => {
    const tracker = new CommittedBuildFileReport([file("a"), file("b"), file("c")]);
    tracker.record({
      files: [file("a", "after"), file("b", "before", "text/html"), file("c")],
      replaceAll: false,
      removedPaths: ["never-existed"],
    });
    expect(tracker.toReport().filesChanged).toEqual(["a", "b"]);
    expect(tracker.toReport().filesRemoved).toEqual([]);
  });

  it("accumulates repairs and reports net changes only once", () => {
    const tracker = new CommittedBuildFileReport([file("existing.ts")]);
    tracker.record({ files: [file("new.ts"), file("existing.ts", "after")], replaceAll: false });
    tracker.record({
      files: [file("new.ts", "repaired"), file("existing.ts", "repaired")],
      replaceAll: false,
    });
    expect(tracker.toReport()).toMatchObject({
      filesCreated: ["new.ts"],
      filesChanged: ["existing.ts"],
      filesRemoved: [],
    });
  });

  it("does not count reverted edits or files created and then removed", () => {
    const tracker = new CommittedBuildFileReport([file("existing.ts")]);
    tracker.record({ files: [file("new.ts"), file("existing.ts", "after")], replaceAll: false });
    tracker.record({ files: [file("existing.ts")], replaceAll: false, removedPaths: ["new.ts"] });
    expect(tracker.toReport()).toEqual(empty);
  });

  it("matches the writer's insert-after-delete behavior for overlapping paths", () => {
    const tracker = new CommittedBuildFileReport([file("same.ts")]);
    tracker.record({
      files: [file("same.ts", "after")],
      replaceAll: false,
      removedPaths: ["same.ts"],
    });
    expect(tracker.toReport()).toMatchObject({
      filesCreated: [],
      filesChanged: ["same.ts"],
      filesRemoved: [],
    });
  });

  it("copies file values so later draft mutations cannot change acknowledged evidence", () => {
    const original = file("same.ts");
    const tracker = new CommittedBuildFileReport([original]);
    original.content = "after";
    tracker.record({ files: [original], replaceAll: false });
    original.content = "before";
    expect(tracker.toReport().filesChanged).toEqual(["same.ts"]);
    const report = tracker.toReport();
    report.filesChanged.length = 0;
    expect(tracker.toReport().filesChanged).toEqual(["same.ts"]);
  });

  it.each([0, 1, 2, 3])("records production writer path %s only after success", async (index) => {
    const tracker = new CommittedBuildFileReport([file("old.ts")]);
    let finish: () => void = () => {};
    const writer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = pairs[index](contextFor(tracker, writer));
    expect(tracker.toReport()).toEqual(empty);
    expect(writer).toHaveBeenCalledOnce();
    finish();
    await pending;
    expect(tracker.toReport().filesCreated).toEqual(
      index === 0 ? ["health.ts", "new.ts"] : ["new.ts"],
    );
    expect(tracker.toReport().filesRemoved).toEqual(index === 2 ? [] : ["old.ts"]);
  });

  it.each([0, 1, 2, 3])(
    "does not advance evidence when production writer path %s rejects",
    async (index) => {
      const tracker = new CommittedBuildFileReport([file("old.ts")]);
      tracker.record({ files: [file("earlier.ts")], replaceAll: false });
      const beforeFailure = tracker.toReport();
      const failure = new Error("transaction rejected");
      const writer = vi.fn().mockRejectedValue(failure);
      await expect(pairs[index](contextFor(tracker, writer))).rejects.toBe(failure);
      expect(tracker.toReport()).toEqual(beforeFailure);
    },
  );
});
