import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  architectReview: vi.fn(),
  readVersion: vi.fn(),
  insertValues: vi.fn(),
  insertReturning: vi.fn(),
  publishTaskEvent: vi.fn(),
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mocks.readVersion })) })),
    insert: vi.fn(() => ({ values: mocks.insertValues })),
  },
  toolAuditTable: {},
  agentToolCallsTable: {},
  agentTasksTable: {},
  taskEventsTable: {},
  projectsTable: { id: {}, ownerId: {} },
  projectVersionsTable: { id: {}, projectId: {}, filesSnapshot: {} },
}));
vi.mock("../routes/credits", () => ({ deductCreditsAtomic: vi.fn() }));
vi.mock("./event-bus", () => ({ publishTaskEvent: mocks.publishTaskEvent }));
vi.mock("./architect", () => ({ runArchitectReview: mocks.architectReview }));

import { buildReviewerContextFromFiles } from "./reviewer-context.js";
import { dispatchReviewerStandalone } from "./subagent.js";

const savedFiles = [
  { path: "src/index.ts", content: "export const source = 'saved-version-179';" },
];
const emptyDiff = () => ({
  filesAdded: [] as string[],
  filesModified: [] as string[],
  filesRemoved: [] as string[],
});
function args(): Parameters<typeof dispatchReviewerStandalone>[0] {
  return {
    input: {
      mode: "refine",
      projectId: 61,
      taskId: 336,
      agentMode: "lite",
      existingFiles: [],
      projectName: "Team Notebook",
      projectKind: "web",
      projectFormat: null,
      stack: null,
      userPrompt: "Review the saved application.",
      onEvent: async () => {},
      signal: new AbortController().signal,
    },
    savedVersionId: 179,
    brief: "Review the saved application despite an empty residual diff.",
    reviewer: {
      diff: emptyDiff(),
      workspaceFiles: [{ path: "src/index.ts", content: "export const source = 'later-draft';" }],
    },
  };
}
function structuredReview(
  input: { fileExcerpts?: Array<{ path: string; content: string }> },
  verdict: "pass" | "partial" | "fail" = "pass",
) {
  const excerpts = input.fileExcerpts ?? [];
  return {
    verdict,
    summary: "The saved source was reviewed.",
    findings: [],
    nextActions: [],
    model: "test-reviewer",
    reviewExecutionStatus: "structured",
    reviewerAssembledPromptStats: {
      excerptCount: excerpts.length,
      totalExcerptChars: excerpts.reduce((n, f) => n + f.content.length, 0),
      excerptBlockChars: excerpts.reduce((n, f) => n + f.path.length + f.content.length, 0),
      selectedPaths: excerpts.map((f) => f.path),
    },
  };
}

describe("saved-version review prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readVersion
      .mockReset()
      .mockResolvedValue([{ id: 179, projectId: 61, filesSnapshot: savedFiles }]);
    mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
    mocks.insertReturning.mockResolvedValue([]);
    mocks.architectReview.mockReset().mockImplementation(async (input) => structuredReview(input));
  });
  it("reviews persisted source, not the later draft, despite an empty residual diff", async () => {
    const request = args();
    const result = await dispatchReviewerStandalone(request);
    expect(mocks.readVersion).toHaveBeenCalledTimes(1);
    expect(mocks.architectReview).toHaveBeenCalledTimes(1);
    const input = mocks.architectReview.mock.calls[0]![0];
    expect(input.diff).toEqual(emptyDiff());
    expect(input.fileExcerpts).toEqual([
      { ...savedFiles[0], truncated: false, originalChars: savedFiles[0]!.content.length },
    ]);
    expect(JSON.stringify(input.fileExcerpts)).not.toContain("later-draft");
    expect(result.ok).toBe(true);
    expect(result.review?.reviewExecutionStatus).toBe("structured");
    expect(result.observation).not.toContain("REVIEW_DEFERRED");
    expect(request.reviewer.diff).toEqual(emptyDiff());
  });
  it("does not fabricate added or modified paths for unchanged source", () => {
    const diff = emptyDiff();
    const context = buildReviewerContextFromFiles({
      diff,
      workspaceFiles: savedFiles,
      includeUnchangedFiles: true,
    });
    expect(context.diff).toBe(diff);
    expect(context.diff).toEqual(emptyDiff());
    expect(context.fileExcerpts[0]?.content).toBe(savedFiles[0]!.content);
  });
  it("preserves legacy deferral when no saved-version review was requested", async () => {
    const request = args();
    delete request.savedVersionId;
    const result = await dispatchReviewerStandalone(request);
    expect(mocks.readVersion).not.toHaveBeenCalled();
    expect(mocks.architectReview).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.review).toBeUndefined();
    expect(result.observation).toContain("REVIEW_DEFERRED");
  });
  it.each([
    { rows: [] },
    { rows: [{ id: 180, projectId: 61, filesSnapshot: savedFiles }] },
    { rows: [{ id: 179, projectId: 62, filesSnapshot: savedFiles }] },
    { rows: [{ id: 179, projectId: 61, filesSnapshot: null }] },
  ])("rejects missing or mismatched saved-version rows %#", async ({ rows }) => {
    mocks.readVersion.mockResolvedValue(rows);
    await expect(dispatchReviewerStandalone(args())).rejects.toThrow("exact saved snapshot");
    expect(mocks.architectReview).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.NaN])("rejects invalid id %s", async (id) => {
    const request = args();
    request.savedVersionId = id;
    await expect(dispatchReviewerStandalone(request)).rejects.toThrow("valid version id");
    expect(mocks.readVersion).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { path: "src/index.ts" },
    { path: " ", content: "bad" },
    { path: "src/index.ts", content: 7 },
  ])("rejects malformed saved files %#", async (file) => {
    mocks.readVersion.mockResolvedValue([{ id: 179, projectId: 61, filesSnapshot: [file] }]);
    await expect(dispatchReviewerStandalone(args())).rejects.toThrow("invalid review file");
    expect(mocks.architectReview).not.toHaveBeenCalled();
  });
  it.each([{ filesSnapshot: [] }, { filesSnapshot: [{ path: "empty.ts", content: " \n " }] }])(
    "rejects snapshots without reviewable content %#",
    async ({ filesSnapshot }) => {
      mocks.readVersion.mockResolvedValue([{ id: 179, projectId: 61, filesSnapshot }]);
      await expect(dispatchReviewerStandalone(args())).rejects.toThrow(
        "no reviewable file excerpts",
      );
      expect(mocks.architectReview).not.toHaveBeenCalled();
    },
  );
  it.each([
    { label: "oversized blank source", content: " \t\n".repeat(12_000) },
    {
      label: "source only beyond the excerpt budget",
      content: " ".repeat(40_000) + "export const beyondBudget = true;",
    },
  ])("rejects $label despite a generated truncation notice", async ({ content }) => {
    mocks.readVersion.mockResolvedValue([
      { id: 179, projectId: 61, filesSnapshot: [{ path: "src/index.ts", content }] },
    ]);
    await expect(dispatchReviewerStandalone(args())).rejects.toThrow("no reviewable file excerpts");
    expect(mocks.architectReview).not.toHaveBeenCalled();
  });
  it("accepts actual source before the truncation boundary", async () => {
    const content = "export const valid = true;\n" + " ".repeat(40_000);
    mocks.readVersion.mockResolvedValue([
      { id: 179, projectId: 61, filesSnapshot: [{ path: "src/index.ts", content }] },
    ]);
    const result = await dispatchReviewerStandalone(args());
    expect(result.ok).toBe(true);
    const excerpt = mocks.architectReview.mock.calls[0]![0].fileExcerpts[0];
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.content).toContain("export const valid = true;");
    expect(excerpt.content).toContain("REVIEW CONTEXT TRUNCATED");
  });
  it("propagates snapshot and reviewer failures", async () => {
    mocks.readVersion.mockRejectedValueOnce(new Error("snapshot read failed"));
    await expect(dispatchReviewerStandalone(args())).rejects.toThrow("snapshot read failed");
    expect(mocks.architectReview).not.toHaveBeenCalled();
    mocks.architectReview.mockRejectedValueOnce(new Error("review transport failed"));
    await expect(dispatchReviewerStandalone(args())).rejects.toThrow("review transport failed");
  });
  it.each(["unparseable", undefined])(
    "requires structured execution metadata: %s",
    async (status) => {
      mocks.architectReview.mockImplementationOnce(async (input) => ({
        ...structuredReview(input),
        reviewExecutionStatus: status,
      }));
      await expect(dispatchReviewerStandalone(args())).rejects.toThrow(
        "executed structured assessment",
      );
    },
  );
  it.each(["partial", "fail"] as const)(
    "preserves a genuinely executed %s verdict",
    async (verdict) => {
      mocks.architectReview.mockImplementationOnce(async (input) =>
        structuredReview(input, verdict),
      );
      const result = await dispatchReviewerStandalone(args());
      expect(result.ok).toBe(true);
      expect(result.review?.verdict).toBe(verdict);
    },
  );
  it("retains excerpt budgets and explicit truncation", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: "src/file-" + i + ".ts",
      content: String(i).repeat(7000),
    }));
    const context = buildReviewerContextFromFiles({
      diff: emptyDiff(),
      workspaceFiles: files,
      includeUnchangedFiles: true,
    });
    expect(context.fileExcerpts.length).toBeGreaterThan(0);
    expect(context.fileExcerpts.length).toBeLessThanOrEqual(8);
    expect(context.fileExcerpts.reduce((n, f) => n + f.content.length, 0)).toBeLessThanOrEqual(
      30000,
    );
    expect(context.fileExcerpts.find((f) => f.truncated)?.content).toContain(
      "REVIEW CONTEXT TRUNCATED",
    );
  });
});

describe("the actual completion writer", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "jobs.ts"), "utf8");
  const anchor = source.indexOf(
    "// Architect review is included in the published flat build price.",
  );
  const gateStart = source.indexOf("const totalFilesTouched =", anchor);
  const gateEnd = source.indexOf("if (skipReason) {", gateStart);
  if (anchor < 0 || gateStart < 0 || gateEnd < 0) throw new Error("Actual review gate missing");
  const gateCode = ts.transpileModule(source.slice(gateStart, gateEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  function gate(
    version: { id: number } | undefined,
    overrides: {
      enabled?: boolean;
      domain?: boolean;
      diff?: ReturnType<typeof emptyDiff> & { linesAdded?: number };
    } = {},
  ) {
    return new Function(
      "diffSummary",
      "version",
      "project",
      "isDomainRewrite",
      "isArchitectAutoFix",
      gateCode + "\nreturn {reviewSavedSnapshot, skipReason};",
    )(
      overrides.diff ?? emptyDiff(),
      version,
      { architectReviewEnabled: overrides.enabled ?? true },
      overrides.domain ?? false,
      false,
    ) as { reviewSavedSnapshot: boolean; skipReason: string | null };
  }
  it("reviews a saved version after earlier accepted changes leave no residual diff", () => {
    expect(gate({ id: 179 })).toEqual({ reviewSavedSnapshot: true, skipReason: null });
    expect(gate(undefined)).toEqual({ reviewSavedSnapshot: false, skipReason: "no-diff" });
  });
  it("retains explicit opt-out, domain rewrite and genuine trivial-edit gates", () => {
    expect(gate({ id: 179 }, { enabled: false }).skipReason).toBe("disabled");
    expect(gate({ id: 179 }, { domain: true }).skipReason).toBe("domain-rewrite");
    expect(
      gate({ id: 179 }, { diff: { ...emptyDiff(), filesModified: ["style.css"], linesAdded: 1 } })
        .skipReason,
    ).toBe("trivial-edit");
  });
  it("passes the saved version into dispatch and rejects unsuccessful dispatch", () => {
    expect(source).toContain("savedVersionId: reviewSavedSnapshot ? version?.id : undefined");
    expect(source).toMatch(/if \(!dispatchResult\.ok \|\| !dispatchResult\.review\)/);
  });
  it("does not preserve an earlier pass when final review fails", () => {
    const parsed = ts.createSourceFile("jobs.ts", source, ts.ScriptTarget.Latest, true);
    let catchBody: ts.Block | undefined;
    function visit(node: ts.Node): void {
      if (
        ts.isCatchClause(node) &&
        node.getStart(parsed) > anchor &&
        node.variableDeclaration?.name.getText(parsed) === "architectErr"
      )
        catchBody = node.block;
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    if (!catchBody) throw new Error("Actual architect failure handler missing");
    const code = ts.transpileModule("const run = () => " + catchBody.getText(parsed), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const report: { architectReview?: { verdict: string }; warnings: string[] } = {
      architectReview: { verdict: "pass" },
      warnings: ["Keep earlier warnings."],
    };
    new Function("report", "logger", "architectErr", "projectId", "taskId", code + "\nrun();")(
      report,
      { warn: vi.fn() },
      new Error("failed"),
      61,
      336,
    );
    expect(report.architectReview).toBeUndefined();
    expect(report.warnings[0]).toBe("Keep earlier warnings.");
    expect(report.warnings.join(" ")).toContain("readiness remains unverified");
  });
});
