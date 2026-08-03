import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  architectReview: vi.fn(),
  publishTaskEvent: vi.fn(),
  insertValues: vi.fn(),
  insertReturning: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {},
}));

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: mocks.insertValues,
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
  },
  toolAuditTable: {},
  agentToolCallsTable: {},
  agentTasksTable: {},
  taskEventsTable: {},
  projectsTable: {
    id: {},
    ownerId: {},
  },
}));

vi.mock("../routes/credits", () => ({
  deductCreditsAtomic: vi.fn(),
}));

vi.mock("./event-bus", () => ({
  publishTaskEvent: mocks.publishTaskEvent,
}));

vi.mock("./architect", () => ({
  runArchitectReview: mocks.architectReview,
}));

import { completionKindForTerminationReason, FileWorkspace, type ToolCtx } from "./agent-loop.js";
import {
  buildAgentTaskTerminalUpdate,
  builderCompletionMessage,
  builderPersistedCompletionSummary,
  builderValidationAwareCompletionSummary,
} from "./builder-task-completion.js";
import { buildReviewerWorkspaceContext } from "./reviewer-context.js";
import {
  dispatchReviewerStandalone,
  dispatchSubagent,
  dispatchSubagentFromTool,
} from "./subagent.js";

describe("Builder Wave 7B completion honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertValues.mockReturnValue({
      returning: mocks.insertReturning,
    });
    mocks.insertReturning.mockResolvedValue([]);
    mocks.architectReview.mockImplementation(
      async (input: { fileExcerpts?: Array<{ path: string; content: string }> }) => {
        const excerpts = input.fileExcerpts ?? [];
        const excerptBlock = excerpts
          .map((file: { path: string; content: string }) => `--- ${file.path} ---\n${file.content}`)
          .join("\n\n");
        return {
          verdict: "pass",
          summary: "The scaffold satisfies the request.",
          findings: [],
          nextActions: [],
          model: "test-reviewer",
          reviewerAssembledPromptStats: {
            excerptCount: excerpts.length,
            totalExcerptChars: excerpts.reduce(
              (total: number, excerpt: { content: string }) => total + excerpt.content.length,
              0,
            ),
            excerptBlockChars: excerptBlock.length,
            selectedPaths: excerpts.map((excerpt: { path: string }) => excerpt.path),
          },
        };
      },
    );
  });

  it("maps finalized and step-cap loop terminations to first-class completion kinds", () => {
    expect(completionKindForTerminationReason("finalized")).toBe("finalized");
    expect(completionKindForTerminationReason("step-cap")).toBe("step_cap");
  });

  it("persists the true final step count in the terminal task update", () => {
    const completedAt = new Date("2026-07-27T12:00:00.000Z");

    expect(
      buildAgentTaskTerminalUpdate({
        completionKind: "step_cap",
        finalStepCount: 25,
        completedAt,
      }),
    ).toEqual({
      status: "completed",
      completionKind: "step_cap",
      currentStep: 25,
      completedAt,
    });
  });

  it("composes honest persisted task and chat summaries for step-cap and finalized runs", () => {
    expect(builderPersistedCompletionSummary("step_cap", "Built 15 files via agentic loop.")).toBe(
      "Built 15 files via agentic loop — reached the step limit — you can continue with a follow-up prompt.",
    );
    expect(builderPersistedCompletionSummary("finalized", "Built 15 files via agentic loop.")).toBe(
      "Built 15 files via agentic loop.",
    );

    const jobsSource = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(jobsSource).toContain("result: persistedAssistantSummary");
    expect(jobsSource).toContain("content: persistedAssistantSummary");
  });

  it("discloses deferred validation in chat for passed-with-warnings builds", () => {
    const warning =
      "Validation was partial because live-server infrastructure is unavailable; container-dependent checks were deferred.";
    const optimisticSummary = "The Daily Inspiration app is fully scaffolded.";

    expect(
      builderValidationAwareCompletionSummary(optimisticSummary, "passed_with_warnings", warning),
    ).toBe(`${optimisticSummary} ${warning}`);
    expect(builderValidationAwareCompletionSummary(optimisticSummary, "passed", warning)).toBe(
      optimisticSummary,
    );

    const jobsSource = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(jobsSource).toContain("builderValidationAwareCompletionSummary(");
    expect(jobsSource).toContain("PARTIAL_VALIDATION_WARNING");
    expect(jobsSource).toContain("content: persistedAssistantSummary");
  });

  it("uses the shared completion wording for checkpoint notes and changelogs", () => {
    expect(builderCompletionMessage("step_cap", "Built 16 files via agentic loop.")).toContain(
      "step limit",
    );

    const jobsSource = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(jobsSource).toContain("const checkpointSummary = builderCompletionMessage(");
    expect(jobsSource).toContain("changelogLines.push(checkpointSummary.slice(0, 180))");
    expect(jobsSource).toContain("note: checkpointSummary.slice(0, 200)");
  });

  it("defers an empty reviewer payload without calling or charging the architect", async () => {
    const initialFiles = [
      {
        path: "src/App.tsx",
        content: "export default function App(){return <main>Unchanged</main>}",
        mimeType: "application/typescript",
      },
    ];
    const workspace = new FileWorkspace(initialFiles);
    workspace.primeInitial(initialFiles);
    const parentCtx = {
      input: {
        projectId: 37,
        taskId: 111,
        agentMode: "lite",
        userPrompt: "Build the requested dashboard with a reviewed React scaffold.",
        existingFiles: initialFiles,
      },
      workspace,
    } as unknown as ToolCtx;

    const result = await dispatchSubagent({
      role: "reviewer",
      brief: "Review the fresh scaffold.",
      parentCtx,
      skipCredits: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        creditsCharged: 0,
        reviewerPayloadStats: {
          excerptCount: 0,
          totalExcerptChars: 0,
          filesAdded: 0,
          filesModified: 0,
          filesRemoved: 0,
          selectedPaths: [],
          missingRequestedPaths: [],
        },
      }),
    );
    expect(result.observation).toContain("REVIEW_DEFERRED");
    expect(result.observation).toContain("Write the files before requesting review");
    expect(mocks.architectReview).not.toHaveBeenCalled();
  });

  it("passes bounded changed-file contents to a reviewer dispatch", async () => {
    const initialFiles = [
      {
        path: "src/App.tsx",
        content: "export default function App(){return <main>Old</main>}",
        mimeType: "application/typescript",
      },
    ];
    const workspace = new FileWorkspace(initialFiles);
    workspace.primeInitial(initialFiles);
    workspace.write("src/App.tsx", "export default function App(){return <main>Reviewed</main>}");
    workspace.write("src/new.ts", "export const ready = true;");

    const parentCtx = {
      input: {
        projectId: 37,
        taskId: 111,
        agentMode: "lite",
        userPrompt: "Build the requested dashboard with a reviewed React scaffold.",
        existingFiles: initialFiles,
      },
      workspace,
    } as unknown as ToolCtx;

    const result = await dispatchSubagent({
      role: "reviewer",
      brief: "Review the fresh scaffold.",
      parentCtx,
      skipCredits: true,
    });

    expect(result.ok).toBe(true);
    expect(result.reviewerPayloadStats).toEqual({
      excerptCount: 2,
      totalExcerptChars:
        "export default function App(){return <main>Reviewed</main>}".length +
        "export const ready = true;".length,
      filesAdded: 1,
      filesModified: 1,
      filesRemoved: 0,
      selectedPaths: ["src/App.tsx", "src/new.ts"],
      missingRequestedPaths: [],
    });
    expect(result.observation).toContain("reviewerPayloadStats=");
    expect(mocks.architectReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userRequest: "Build the requested dashboard with a reviewed React scaffold.",
        reviewBrief: "Review the fresh scaffold.",
        diff: {
          filesAdded: ["src/new.ts"],
          filesModified: ["src/App.tsx"],
          filesRemoved: [],
        },
        fileExcerpts: [
          {
            path: "src/App.tsx",
            content: "export default function App(){return <main>Reviewed</main>}",
          },
          {
            path: "src/new.ts",
            content: "export const ready = true;",
          },
        ],
      }),
    );
    expect(mocks.publishTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "subagent_done",
        message: expect.stringContaining("reviewerPayloadStats"),
      }),
    );
  });

  it("treats a structured partial verdict as a successful review dispatch", async () => {
    mocks.architectReview.mockResolvedValue({
      verdict: "partial",
      summary: "The app is usable with one follow-up improvement.",
      findings: [
        {
          severity: "medium",
          title: "Add an empty state",
          detail: "The list needs an empty state.",
          file: "src/App.tsx",
        },
      ],
      nextActions: ["Add the empty state."],
      model: "test-reviewer",
      reviewExecutionStatus: "structured",
      reviewerAssembledPromptStats: {
        excerptCount: 1,
        totalExcerptChars: 30,
        excerptBlockChars: 50,
        selectedPaths: ["src/App.tsx"],
      },
    });
    const workspace = new FileWorkspace([]);
    workspace.primeInitial([]);
    workspace.write("src/App.tsx", "export default function App(){}");
    const parentCtx = {
      input: {
        projectId: 42,
        taskId: 118,
        agentMode: "lite",
        userPrompt: "Build a small React app.",
        existingFiles: [],
      },
      workspace,
    } as unknown as ToolCtx;

    const result = await dispatchSubagentFromTool(parentCtx, {
      role: "reviewer",
      brief: "Review src/App.tsx.",
    });

    expect(result.ok).toBe(true);
    expect(result.observation).toContain("verdict: partial");
    expect(result.observation).toMatch(/^\[reviewer subagent .* verdict partial\]/);
    expect(result.observation).not.toContain("failed");
  });

  it("marks thrown and unparseable reviewer calls as failed dispatches", async () => {
    const makeContext = () => {
      const workspace = new FileWorkspace([]);
      workspace.primeInitial([]);
      workspace.write("src/App.tsx", "export default function App(){}");
      return {
        input: {
          projectId: 42,
          taskId: 118,
          agentMode: "lite",
          userPrompt: "Build a small React app.",
          existingFiles: [],
        },
        workspace,
      } as unknown as ToolCtx;
    };

    mocks.architectReview.mockRejectedValueOnce(new Error("review transport failed"));
    const thrown = await dispatchSubagent({
      role: "reviewer",
      brief: "Review src/App.tsx.",
      parentCtx: makeContext(),
      skipCredits: true,
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.review).toBeUndefined();

    mocks.architectReview.mockResolvedValueOnce({
      verdict: "pass",
      summary: "Architect review produced no structured findings.",
      findings: [],
      nextActions: [],
      model: "test-reviewer",
      reviewExecutionStatus: "unparseable",
      reviewerAssembledPromptStats: {
        excerptCount: 1,
        totalExcerptChars: 30,
        excerptBlockChars: 50,
        selectedPaths: ["src/App.tsx"],
      },
    });
    const unparseable = await dispatchSubagent({
      role: "reviewer",
      brief: "Review src/App.tsx.",
      parentCtx: makeContext(),
      skipCredits: true,
    });
    expect(unparseable.ok).toBe(false);
    expect(unparseable.review?.reviewExecutionStatus).toBe("unparseable");
  });

  it("uses the same source-first excerpts for in-loop and post-build reviews", async () => {
    const changedFiles = [
      { path: "package.json", content: "p".repeat(3_000) },
      { path: "vite.config.ts", content: "v".repeat(3_000) },
      { path: "src/components/Card.tsx", content: "c".repeat(5_000) },
      { path: "src/App.tsx", content: "a".repeat(6_000) },
      { path: "src/main.tsx", content: "m".repeat(4_000) },
      { path: "src/index.css", content: "i".repeat(4_000) },
      { path: "src/hooks/useCards.ts", content: "h".repeat(3_000) },
      { path: "src/components/Form.tsx", content: "f".repeat(3_000) },
      { path: "src/components/List.tsx", content: "l".repeat(3_000) },
      { path: "src/types.ts", content: "t".repeat(2_000) },
      { path: "src/utils.ts", content: "u".repeat(2_000) },
    ];
    const workspace = new FileWorkspace([]);
    workspace.primeInitial([]);
    for (const file of changedFiles) workspace.write(file.path, file.content);
    const input = {
      projectId: 39,
      taskId: 112,
      agentMode: "lite",
      existingFiles: [],
      projectName: "Review selection",
      projectKind: "web",
      userPrompt: "Build a React app.",
      onEvent: async () => {},
      signal: new AbortController().signal,
    };
    const parentCtx = { input, workspace } as unknown as ToolCtx;

    const inLoop = await dispatchSubagent({
      role: "reviewer",
      brief: "Review src/App.tsx and the application source.",
      parentCtx,
      skipCredits: true,
    });
    const postBuild = await dispatchReviewerStandalone({
      input: input as never,
      brief: "Review src/App.tsx and the application source.",
      reviewer: {
        diff: {
          filesAdded: changedFiles.map((file) => file.path),
          filesModified: [],
          filesRemoved: [],
        },
        workspaceFiles: changedFiles,
      },
      skipCredits: true,
    });

    const inLoopInput = mocks.architectReview.mock.calls[0]?.[0];
    const postBuildInput = mocks.architectReview.mock.calls[1]?.[0];
    const inLoopPaths = inLoopInput.fileExcerpts.map((file: { path: string }) => file.path);
    const postBuildPaths = postBuildInput.fileExcerpts.map((file: { path: string }) => file.path);

    expect(inLoopPaths).toEqual(postBuildPaths);
    expect(inLoopPaths[0]).toBe("src/App.tsx");
    expect(inLoopPaths).toContain("src/main.tsx");
    expect(inLoopPaths).toContain("src/index.css");
    expect(inLoopPaths).not.toContain("package.json");
    expect(inLoopPaths).not.toContain("vite.config.ts");
    expect(inLoop.reviewerAssembledPromptStats).toEqual(
      expect.objectContaining({
        excerptCount: inLoop.reviewerPayloadStats?.excerptCount,
        totalExcerptChars: inLoop.reviewerPayloadStats?.totalExcerptChars,
        selectedPaths: inLoop.reviewerPayloadStats?.selectedPaths,
      }),
    );
    expect(postBuild.reviewerAssembledPromptStats).toEqual(
      expect.objectContaining({
        excerptCount: postBuild.reviewerPayloadStats?.excerptCount,
        totalExcerptChars: postBuild.reviewerPayloadStats?.totalExcerptChars,
        selectedPaths: postBuild.reviewerPayloadStats?.selectedPaths,
      }),
    );
    const reviewContextEvents = mocks.insertValues.mock.calls
      .map(([value]) => value)
      .filter((value) => value.eventType === "review_context");
    expect(reviewContextEvents).toHaveLength(2);
    expect(reviewContextEvents.map((event) => event.data.reviewPath)).toEqual([
      "in_loop",
      "post_build",
    ]);
    for (const event of reviewContextEvents) {
      expect(event.data.reviewerAssembledPromptStats).toEqual(
        expect.objectContaining({
          excerptCount: event.data.reviewerPayloadStats.excerptCount,
          totalExcerptChars: event.data.reviewerPayloadStats.totalExcerptChars,
          selectedPaths: event.data.reviewerPayloadStats.selectedPaths,
        }),
      );
    }
  });

  it("caps reviewer excerpts by file count, per-file size, and total size", () => {
    const changed = Array.from({ length: 10 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      content: String(index).repeat(7_000),
    }));

    const context = buildReviewerWorkspaceContext({
      existingFiles: [],
      workspace: {
        diff: () => ({ changed, removed: [] }),
      },
    });

    expect(context.fileExcerpts).toHaveLength(5);
    expect(context.fileExcerpts.every((file) => file.content.length <= 6_000)).toBe(true);
    expect(context.fileExcerpts.reduce((total, file) => total + file.content.length, 0)).toBe(
      30_000,
    );
  });
});
