import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  architectReview: vi.fn(),
  publishTaskEvent: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {},
}));

vi.mock("@workspace/db", () => ({
  db: {
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
  builderPersistedCompletionSummary,
} from "./builder-task-completion.js";
import { buildReviewerWorkspaceContext } from "./reviewer-context.js";
import { dispatchSubagent } from "./subagent.js";

describe("Builder Wave 7B completion honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.architectReview.mockResolvedValue({
      verdict: "pass",
      summary: "The scaffold satisfies the request.",
      findings: [],
      nextActions: [],
      model: "test-reviewer",
    });
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
    expect(
      builderPersistedCompletionSummary("step_cap", "Built 15 files via agentic loop."),
    ).toBe(
      "Built 15 files via agentic loop — reached the step limit — you can continue with a follow-up prompt.",
    );
    expect(
      builderPersistedCompletionSummary("finalized", "Built 15 files via agentic loop."),
    ).toBe("Built 15 files via agentic loop.");

    const jobsSource = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(jobsSource).toContain("result: persistedAssistantSummary");
    expect(jobsSource).toContain("content: persistedAssistantSummary");
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
