import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  CommittedBuildFileReport,
  describeCommittedFileChanges,
} from "./committed-build-file-report";

const file = (path: string, content = "before", mimeType = "text/plain") => ({
  path,
  content,
  mimeType,
});
const empty = { filesCreated: [], filesChanged: [], filesRemoved: [], warnings: [] };

// Exercise the real writer/receipt pairs without starting the jobs queue.
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
        !write?.startsWith("const fileWriteReceipt = await writeProjectFilesAtomically(") ||
        !record?.startsWith("committedFileChanges.record(fileWriteReceipt.effectiveFileChanges)")
      ) {
        throw new Error(
          "Every acknowledged file commit must immediately record its effective-result receipt",
        );
      }
      const compiled = ts.transpileModule(
        "(async function (context) { const { writeProjectFilesAtomically, committedFileChanges, input, projectId, filesWithHealth, sealedWriteGuard, result, repairLoopResult, appliedChangedFiles, appliedRemovedPaths } = context; " +
          write +
          record +
          " })",
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
    filesWithHealth: [file("requested.ts")],
    sealedWriteGuard: () => undefined,
    result: { changedFiles: [file("requested.ts")], removedPaths: ["legacy.ts"] },
    repairLoopResult: { changedFiles: [file("requested.ts")] },
    appliedChangedFiles: [file("requested.ts")],
    appliedRemovedPaths: ["legacy.ts"],
  };
}

describe("acknowledged effective-file reports", () => {
  it("starts empty and ignores effective no-ops", () => {
    const tracker = new CommittedBuildFileReport();
    tracker.record(describeCommittedFileChanges([file("legacy.ts")], [file("legacy.ts")]));
    expect(tracker.toReport()).toEqual(empty);
  });

  it("reports actual additions, modifications and removals without storing source", () => {
    const changes = describeCommittedFileChanges(
      [file("changed.ts"), file("removed.ts"), file("kept.ts")],
      [file("changed.ts", "PRIVATE_SOURCE"), file("created.ts"), file("kept.ts")],
    );
    const tracker = new CommittedBuildFileReport();
    tracker.record(changes);
    expect(tracker.toReport()).toMatchObject({
      filesCreated: ["created.ts"],
      filesChanged: ["changed.ts"],
      filesRemoved: ["removed.ts"],
    });
    expect(JSON.stringify(changes)).not.toContain("PRIVATE_SOURCE");
    expect(JSON.stringify(tracker.toReport())).not.toContain("PRIVATE_SOURCE");
    expect(changes[0].before).toMatch(/^[a-f0-9]{64}$/);
  });

  it("counts an exposed legacy fallback as a change, not a removal", () => {
    const tracker = new CommittedBuildFileReport();
    tracker.record(
      describeCommittedFileChanges([file("same.ts", "scoped")], [file("same.ts", "legacy")]),
    );
    expect(tracker.toReport()).toMatchObject({
      filesCreated: [],
      filesChanged: ["same.ts"],
      filesRemoved: [],
    });
  });

  it("distinguishes empty files from absent files and tracks MIME changes", () => {
    const tracker = new CommittedBuildFileReport();
    tracker.record(
      describeCommittedFileChanges(
        [file("old.ts", ""), file("mime", "")],
        [file("new.ts", ""), file("mime", "", "text/html")],
      ),
    );
    expect(tracker.toReport()).toMatchObject({
      filesCreated: ["new.ts"],
      filesChanged: ["mime"],
      filesRemoved: ["old.ts"],
    });
  });

  it("aggregates repeated repairs into one net change per path", () => {
    const tracker = new CommittedBuildFileReport();
    tracker.record(
      describeCommittedFileChanges([file("existing")], [file("existing", "after"), file("new")]),
    );
    tracker.record(
      describeCommittedFileChanges(
        [file("existing", "after"), file("new")],
        [file("existing", "repaired"), file("new", "repaired")],
      ),
    );
    expect(tracker.toReport()).toMatchObject({
      filesCreated: ["new"],
      filesChanged: ["existing"],
      filesRemoved: [],
    });
  });

  it("drops changes that were completely reverted by later acknowledged writes", () => {
    const tracker = new CommittedBuildFileReport();
    const before = [file("existing")];
    const changed = [file("existing", "after"), file("temporary")];
    tracker.record(describeCommittedFileChanges(before, changed));
    tracker.record(describeCommittedFileChanges(changed, before));
    expect(tracker.toReport()).toEqual(empty);
  });

  it("copies receipt values and does not expose mutable report state", () => {
    const tracker = new CommittedBuildFileReport();
    const changes = describeCommittedFileChanges([], [file("created")]);
    tracker.record(changes);
    changes.length = 0;
    const report = tracker.toReport();
    report.filesCreated.length = 0;
    expect(tracker.toReport().filesCreated).toEqual(["created"]);
  });

  it.each([0, 1, 2, 3])(
    "records production writer %s only after its captured receipt resolves",
    async (index) => {
      const tracker = new CommittedBuildFileReport();
      const receipt = {
        authoritativeVersion: null,
        effectiveFileChanges: describeCommittedFileChanges([], [file("actually-saved.ts")]),
      };
      let finish: (value: typeof receipt) => void = () => {};
      const writer = vi.fn(
        () =>
          new Promise<typeof receipt>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = pairs[index](contextFor(tracker, writer));
      expect(tracker.toReport()).toEqual(empty);
      expect(writer).toHaveBeenCalledWith(
        expect.objectContaining({ captureEffectiveFileChanges: true, scope: { kind: "artifact" } }),
      );
      finish(receipt);
      await pending;
      expect(tracker.toReport().filesCreated).toEqual(["actually-saved.ts"]);
      expect(tracker.toReport().filesRemoved).toEqual([]);
    },
  );

  it.each([0, 1, 2, 3])(
    "does not invent saved changes when production writer %s rejects",
    async (index) => {
      const tracker = new CommittedBuildFileReport();
      tracker.record(describeCommittedFileChanges([], [file("earlier.ts")]));
      const beforeFailure = tracker.toReport();
      const failure = new Error("transaction rejected");
      await expect(
        pairs[index](contextFor(tracker, vi.fn().mockRejectedValue(failure))),
      ).rejects.toBe(failure);
      expect(tracker.toReport()).toEqual(beforeFailure);
    },
  );
});
