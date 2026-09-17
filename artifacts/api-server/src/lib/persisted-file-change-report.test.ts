import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { persistedFileChangeReport } from "./persisted-file-change-report";

describe("persisted build-report file changes", () => {
  it("reports existing-file overwrites as modified rather than created", () => {
    const report = {
      filesCreated: ["src/db.ts", "src/routes/notes.ts"],
      filesChanged: [] as string[],
      filesRemoved: [] as string[],
      warnings: ["Execution evidence is incomplete"],
      versionId: 181,
    };
    Object.assign(
      report,
      persistedFileChangeReport({
        filesAdded: [],
        filesModified: ["src/db.ts", "src/routes/notes.ts"],
        filesRemoved: [],
      }),
    );
    expect(report).toEqual({
      filesCreated: [],
      filesChanged: ["src/db.ts", "src/routes/notes.ts"],
      filesRemoved: [],
      warnings: ["Execution evidence is incomplete"],
      versionId: 181,
    });
  });

  it("keeps additions, modifications and deletions distinct", () => {
    expect(
      persistedFileChangeReport({
        filesAdded: ["src/new.ts"],
        filesModified: ["src/index.ts"],
        filesRemoved: ["src/old.ts"],
      }),
    ).toEqual({
      filesCreated: ["src/new.ts"],
      filesChanged: ["src/index.ts"],
      filesRemoved: ["src/old.ts"],
    });
  });

  it("does not invent a change for a persisted no-op", () => {
    expect(
      persistedFileChangeReport({ filesAdded: [], filesModified: [], filesRemoved: [] }),
    ).toEqual({ filesCreated: [], filesChanged: [], filesRemoved: [] });
  });

  it("does not let later report edits mutate the authoritative diff", () => {
    const diff = {
      filesAdded: ["a.ts"],
      filesModified: ["b.ts"],
      filesRemoved: ["c.ts"],
    };
    const report = persistedFileChangeReport(diff);
    report.filesCreated.push("extra.ts");
    report.filesChanged.length = 0;
    report.filesRemoved[0] = "other.ts";
    expect(diff).toEqual({
      filesAdded: ["a.ts"],
      filesModified: ["b.ts"],
      filesRemoved: ["c.ts"],
    });
  });

  it("preserves exact paths and the persisted order", () => {
    const paths = ["src/Z.ts", "src/a b.ts", "src/\\u0627.ts"];
    expect(
      persistedFileChangeReport({ filesAdded: paths, filesModified: [], filesRemoved: [] })
        .filesCreated,
    ).toEqual(paths);
  });

  it("uses the persisted diff in the job save path before constructing its changelog", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const start = source.indexOf(
      "// Build changelog entry: combine action context with diff summary",
    );
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("const changelogLines:", start);
    expect(end).toBeGreaterThan(start);
    const savePath = source.slice(start, end);
    expect(savePath).toContain("if (diffSummary)");
    expect(savePath).toContain('await import("./persisted-file-change-report")');
    expect(savePath).toContain("Object.assign(report, persistedFileChangeReport(diffSummary))");
  });
});
