import { describe, expect, it, vi } from "vitest";

vi.mock("./ai-providers", () => ({
  createChatCompletion: vi.fn(),
  resolveStageProvider: vi.fn(),
}));

import { assembleArchitectReviewPrompt } from "./architect";
import { boundReviewerFileExcerpts, buildReviewerContextFromFiles } from "./reviewer-context";

const diff = {
  filesAdded: [],
  filesModified: ["src/routes/notes.ts", "src/routes/home.ts", "src/routes/settings.ts"],
  filesRemoved: [],
};

describe("reviewer source coverage after a saved build", () => {
  it("keeps all changed routes complete before spending space on unchanged entry files", () => {
    const routes = [
      { path: diff.filesModified[0], content: "n".repeat(12_000) },
      { path: diff.filesModified[1], content: "h".repeat(4_000) },
      { path: diff.filesModified[2], content: "s".repeat(3_000) },
    ];
    const selected = buildReviewerContextFromFiles({
      diff,
      workspaceFiles: [
        { path: "src/index.ts", content: "i".repeat(18_000) },
        { path: "src/html.ts", content: "t".repeat(16_000) },
        ...routes,
      ],
      includeUnchangedFiles: true,
    });
    expect(selected.fileExcerpts.slice(0, 3).map((file) => file.path)).toEqual(diff.filesModified);
    for (const route of routes) {
      expect(selected.fileExcerpts.find((file) => file.path === route.path)).toMatchObject({
        ...route,
        truncated: false,
        originalChars: route.content.length,
      });
    }
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Preserve the page and note when switching languages.",
      agentMode: "lite",
      diff,
      fileExcerpts: selected.fileExcerpts,
    });
    expect(assembled.userMessage).toContain("Changed files without supplied source (0): none");
    expect(assembled.reviewerAssembledPromptStats.selectedPaths).toEqual(
      selected.fileExcerpts.map((file) => file.path),
    );
    expect(assembled.reviewerAssembledPromptStats.totalExcerptChars).toBeLessThanOrEqual(30_000);
  });

  it("reserves source for every selected changed file when the first file exceeds the budget", () => {
    const files = [
      { path: "src/routes/notes.ts", content: "n".repeat(60_000) },
      { path: "src/routes/home.ts", content: "home source complete" },
      { path: "src/routes/settings.ts", content: "settings source complete" },
    ];
    const selected = buildReviewerContextFromFiles({ diff, workspaceFiles: files });
    const byPath = new Map(selected.fileExcerpts.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual([...diff.filesModified].sort());
    expect(byPath.get("src/routes/notes.ts")?.truncated).toBe(true);
    expect(byPath.get("src/routes/notes.ts")?.content).toContain("REVIEW CONTEXT TRUNCATED");
    expect(byPath.get("src/routes/notes.ts")?.originalChars).toBe(60_000);
    expect(byPath.get("src/routes/home.ts")?.content).toBe("home source complete");
    expect(byPath.get("src/routes/settings.ts")?.content).toBe("settings source complete");
  });

  it("fairly bounds eight large files without dropping the final file", () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      path: `src/route-${index}.ts`,
      content: String(index).repeat(40_000),
    }));
    const bounded = boundReviewerFileExcerpts(files);
    expect(bounded).toHaveLength(8);
    for (const file of bounded) {
      expect(file.truncated).toBe(true);
      expect(file.originalChars).toBe(40_000);
      expect(file.content.length).toBeGreaterThan(3_000);
      expect(file.content).toContain("REVIEW CONTEXT TRUNCATED");
    }
    expect(bounded.reduce((total, file) => total + file.content.length, 0)).toBeLessThanOrEqual(
      30_000,
    );
  });

  it("enforces identical coverage for callers that pass oversized excerpts directly", () => {
    const files = [
      { path: "src/routes/notes.ts", content: "n".repeat(70_000) },
      { path: "src/routes/home.ts", content: "home route" },
      { path: "src/routes/settings.ts", content: "settings route" },
    ];
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Review all changed routes.",
      agentMode: "lite",
      diff,
      fileExcerpts: files,
    });
    expect(assembled.reviewerAssembledPromptStats.selectedPaths).toEqual(diff.filesModified);
    expect(assembled.userMessage).toContain("home route");
    expect(assembled.userMessage).toContain("settings route");
    expect(assembled.userMessage).toContain("Truncated supplied files (1): src/routes/notes.ts");
    expect(assembled.reviewerAssembledPromptStats.totalExcerptChars).toBeLessThanOrEqual(30_000);
  });

  it("identifies genuinely omitted changes rather than implying full review", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({
      path: `src/route-${index}.ts`,
      content: `route ${index}`,
    }));
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Review the saved app.",
      agentMode: "lite",
      diff: { filesAdded: files.map((file) => file.path), filesModified: [], filesRemoved: [] },
      fileExcerpts: files,
    });
    expect(assembled.reviewerAssembledPromptStats.excerptCount).toBe(8);
    expect(assembled.userMessage).toContain(
      "Changed files without supplied source (2): src/route-8.ts, src/route-9.ts",
    );
    expect(assembled.userMessage).toContain("not proof of defective source");
  });

  it("retains explicit supporting-file requests while protecting changed routes", () => {
    const selected = buildReviewerContextFromFiles({
      diff,
      includeUnchangedFiles: true,
      reviewRequest: "Review src/html.ts and the changed routes.",
      workspaceFiles: [
        { path: "src/index.ts", content: "i".repeat(50_000) },
        { path: "src/html.ts", content: "t".repeat(50_000) },
        ...diff.filesModified.map((path) => ({ path, content: "route source" })),
      ],
    });
    expect(selected.fileExcerpts[0].path).toBe("src/html.ts");
    for (const path of diff.filesModified) {
      expect(selected.fileExcerpts.find((file) => file.path === path)?.content).toBe(
        "route source",
      );
    }
  });

  it("keeps explicitly requested supporting source in the final prompt beside an oversized change", () => {
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Review the saved app.",
      reviewBrief: "Review src/html.ts and the changed home route.",
      agentMode: "lite",
      diff: { filesAdded: [], filesModified: ["src/routes/home.ts"], filesRemoved: [] },
      fileExcerpts: [
        { path: "src/html.ts", content: "requested supporting source complete" },
        { path: "src/routes/home.ts", content: "h".repeat(60_000) },
      ],
    });
    expect(assembled.reviewerAssembledPromptStats.selectedPaths).toEqual([
      "src/html.ts",
      "src/routes/home.ts",
    ]);
    expect(assembled.userMessage).toContain(
      "--- src/html.ts ---\nrequested supporting source complete",
    );
    expect(assembled.userMessage).toContain("--- src/routes/home.ts ---\n");
    expect(assembled.userMessage).toContain("Changed files without supplied source (0): none");
    expect(assembled.userMessage).toContain("Truncated supplied files (1): src/routes/home.ts");
    expect(assembled.reviewerAssembledPromptStats.totalExcerptChars).toBeLessThanOrEqual(30_000);
  });

  it.each([
    { requested: "./src/home.ts", supplied: "src/home.ts" },
    { requested: "src\\routes\\home.ts", supplied: "src/routes/home.ts" },
    { requested: "SRC/Routes/Home.ts", supplied: "src/routes/home.ts" },
  ])("uses selection path normalization for coverage: $requested", ({ requested, supplied }) => {
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Review all changed files.",
      agentMode: "lite",
      diff: { filesAdded: [requested], filesModified: [], filesRemoved: [] },
      fileExcerpts: [{ path: supplied, content: "complete selected source" }],
    });
    expect(assembled.userMessage).toContain("Changed files without supplied source (0): none");
    expect(assembled.reviewerAssembledPromptStats.selectedPaths).toEqual([supplied]);
  });

  it("still discloses genuinely absent source alongside normalized matching paths", () => {
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Review all changed files.",
      agentMode: "lite",
      diff: {
        filesAdded: ["./src/home.ts"],
        filesModified: ["src/missing.ts"],
        filesRemoved: [],
      },
      fileExcerpts: [{ path: "src/home.ts", content: "complete home source" }],
    });
    expect(assembled.userMessage).toContain(
      "Changed files without supplied source (1): src/missing.ts",
    );
  });

  it("reuses unusable supporting shares for a complete small file and a marked prefix", () => {
    const main = { path: "src/changed.ts", content: "m".repeat(29_400) };
    const app = { path: "src/App.tsx", content: "a".repeat(100) };
    const selected = buildReviewerContextFromFiles({
      diff: { filesAdded: [], filesModified: [main.path], filesRemoved: [] },
      reviewRequest: "Review src/changed.ts.",
      includeUnchangedFiles: true,
      workspaceFiles: [
        main,
        ...Array.from({ length: 6 }, (_, index) => ({
          path: "src/support-" + index + ".tsx",
          content: "s".repeat(5_000),
        })),
        app,
      ],
    });
    expect(selected.fileExcerpts.find((file) => file.path === main.path)).toMatchObject({
      ...main,
      truncated: false,
    });
    expect(selected.fileExcerpts.find((file) => file.path === app.path)).toMatchObject({
      ...app,
      truncated: false,
    });
    const partials = selected.fileExcerpts.filter((file) => file.truncated);
    expect(partials.length).toBeGreaterThan(0);
    for (const file of partials) {
      expect(file.content).toContain("REVIEW CONTEXT TRUNCATED");
      expect(file.originalChars).toBe(5_000);
    }
    const chars = selected.fileExcerpts.reduce((total, file) => total + file.content.length, 0);
    expect(chars).toBeGreaterThan(29_500);
    expect(chars).toBeLessThanOrEqual(30_000);
    expect(selected.fileExcerpts.length).toBeLessThanOrEqual(8);
  });

  it.each([1, 99, 100, 185, 200, 600, 1_000])(
    "respects complete-source and marker boundaries with %i supporting characters",
    (remaining) => {
      const main = { path: "src/main.ts", content: "m".repeat(30_000 - remaining) };
      const app = { path: "src/App.tsx", content: "a".repeat(100) };
      const files = [
        main,
        { path: "src/large-a.ts", content: "x".repeat(5_000) },
        { path: "src/large-b.ts", content: "y".repeat(5_000) },
        app,
      ];
      const before = structuredClone(files);
      const selected = boundReviewerFileExcerpts(files, [main.path]);
      expect(selected.find((file) => file.path === main.path)?.content).toBe(main.content);
      if (remaining >= app.content.length) {
        expect(selected.find((file) => file.path === app.path)).toMatchObject({
          ...app,
          truncated: false,
        });
      } else {
        expect(selected.find((file) => file.path === app.path)).toBeUndefined();
      }
      for (const file of selected.filter((file) => file.truncated)) {
        expect(file.content).toContain("REVIEW CONTEXT TRUNCATED");
      }
      expect(selected.reduce((total, file) => total + file.content.length, 0)).toBeLessThanOrEqual(
        30_000,
      );
      expect(files).toEqual(before);
    },
  );

  it("preserves complete small files and prior truncation metadata without mutating inputs", () => {
    const files = [
      { path: "src/a.ts", content: "short", truncated: false, originalChars: 5 },
      {
        path: "src/b.ts",
        content: "prefix\n\n[REVIEW CONTEXT TRUNCATED: existing bound]",
        truncated: true,
        originalChars: 90_000,
      },
    ];
    const before = structuredClone(files);
    expect(boundReviewerFileExcerpts(files)).toEqual(files);
    expect(files).toEqual(before);
    expect(boundReviewerFileExcerpts([])).toEqual([]);
  });
});
