import { describe, expect, it, vi } from "vitest";

vi.mock("./ai-providers", () => ({
  createChatCompletion: vi.fn(),
  resolveStageProvider: vi.fn(),
}));

import { assembleArchitectReviewPrompt } from "./architect";
import {
  buildReviewerContextFromFiles,
  buildReviewerWorkspaceContext,
} from "./reviewer-context";

type TestFile = { path: string; content: string };

function workspace(changed: TestFile[], all = changed) {
  return {
    diff: () => ({ changed, removed: [] }),
    all: () => all,
  };
}

describe("Wave 7B-3 reviewer excerpt selection", () => {
  it("selects requested source files first, then entry and large source files before config", () => {
    const changed = [
      { path: "package.json", content: "p".repeat(3_000) },
      { path: "vite.config.ts", content: "v".repeat(3_000) },
      { path: "tsconfig.json", content: "t".repeat(3_000) },
      { path: "src/components/BookForm.tsx", content: "f".repeat(2_000) },
      { path: "src/hooks/useBookJournal.ts", content: "h".repeat(2_500) },
      { path: "src/components/BookCard.tsx", content: "c".repeat(5_500) },
      { path: "src/components/FilterBar.tsx", content: "b".repeat(5_000) },
      { path: "src/components/EmptyState.tsx", content: "e".repeat(3_500) },
      { path: "src/components/StatusBadge.tsx", content: "s".repeat(3_000) },
      { path: "src/App.tsx", content: "a".repeat(6_500) },
      { path: "src/main.tsx", content: "m".repeat(4_500) },
      { path: "src/index.css", content: "i".repeat(4_000) },
    ];

    const context = buildReviewerWorkspaceContext({
      existingFiles: [],
      workspace: workspace(changed),
      reviewRequest:
        "Review src/components/BookForm.tsx and src/hooks/useBookJournal.ts, then check the application source.",
    });

    const selectedPaths = context.fileExcerpts.map((file) => file.path);
    expect(selectedPaths.slice(0, 2)).toEqual([
      "src/components/BookForm.tsx",
      "src/hooks/useBookJournal.ts",
    ]);
    expect(selectedPaths.indexOf("src/App.tsx")).toBeLessThan(
      selectedPaths.indexOf("src/components/BookCard.tsx"),
    );
    expect(selectedPaths).toContain("src/main.tsx");
    expect(selectedPaths).toContain("src/index.css");
    expect(selectedPaths).not.toContain("package.json");
    expect(selectedPaths).not.toContain("vite.config.ts");
    expect(selectedPaths).not.toContain("tsconfig.json");
    expect(context.fileExcerpts).toHaveLength(8);
    expect(
      context.fileExcerpts.reduce((total, excerpt) => total + excerpt.content.length, 0),
    ).toBe(30_000);
  });

  it("reports requested files that are missing from the workspace", () => {
    const changed = [
      { path: "src/App.tsx", content: "export default function App() { return null; }" },
      { path: "package.json", content: '{"private":true}' },
    ];

    const context = buildReviewerWorkspaceContext({
      existingFiles: [],
      workspace: workspace(changed),
      reviewRequest: "Review src/App.tsx and src/missing.ts before finalizing.",
    });

    expect(context.fileExcerpts[0]?.path).toBe("src/App.tsx");
    expect(context.missingRequestedPaths).toEqual(["src/missing.ts"]);
  });

  it("resolves a requested bare filename by a unique workspace basename", () => {
    const changed = [
      { path: "src/hooks/useBooks.ts", content: "export const useBooks = () => [];" },
      { path: "src/App.tsx", content: "export default function App() { return null; }" },
    ];

    const context = buildReviewerWorkspaceContext({
      existingFiles: [],
      workspace: workspace(changed),
      reviewRequest: "Review useBooks.ts and App.tsx.",
    });

    expect(context.fileExcerpts.slice(0, 2).map((file) => file.path)).toEqual([
      "src/hooks/useBooks.ts",
      "src/App.tsx",
    ]);
    expect(context.missingRequestedPaths).toEqual([]);
  });

  it("leaves an ambiguous bare filename unmatched", () => {
    const changed = [
      { path: "src/features/books/Card.tsx", content: "export const Card = () => null;" },
      { path: "src/features/auth/Card.tsx", content: "export const Card = () => null;" },
    ];

    const context = buildReviewerWorkspaceContext({
      existingFiles: [],
      workspace: workspace(changed),
      reviewRequest: "Review Card.tsx.",
    });

    expect(context.missingRequestedPaths).toEqual(["Card.tsx"]);
  });

  it("keeps a genuinely absent bare filename in missingRequestedPaths", () => {
    const changed = [
      { path: "src/App.tsx", content: "export default function App() { return null; }" },
    ];

    const context = buildReviewerWorkspaceContext({
      existingFiles: [],
      workspace: workspace(changed),
      reviewRequest: "Review MissingPanel.tsx.",
    });

    expect(context.missingRequestedPaths).toEqual(["MissingPanel.tsx"]);
  });

  it("keeps selection and assembled-prompt stats directly comparable", () => {
    const changed = [
      { path: "package.json", content: "p".repeat(2_000) },
      { path: "src/App.tsx", content: "a".repeat(6_000) },
      { path: "src/main.tsx", content: "m".repeat(4_000) },
      { path: "src/index.css", content: "i".repeat(3_000) },
    ];
    const selected = buildReviewerContextFromFiles({
      diff: {
        filesAdded: changed.map((file) => file.path),
        filesModified: [],
        filesRemoved: [],
      },
      workspaceFiles: changed,
      reviewRequest: "Review src/App.tsx and the application source.",
    });
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Build a React application.",
      agentMode: "lite",
      diff: selected.diff,
      fileExcerpts: selected.fileExcerpts,
    });

    expect(assembled.reviewerAssembledPromptStats).toEqual(
      expect.objectContaining({
        excerptCount: selected.fileExcerpts.length,
        totalExcerptChars: selected.fileExcerpts.reduce(
          (total, excerpt) => total + excerpt.content.length,
          0,
        ),
        selectedPaths: selected.fileExcerpts.map((excerpt) => excerpt.path),
      }),
    );
    expect(assembled.reviewerAssembledPromptStats.excerptBlockChars).toBeGreaterThan(
      assembled.reviewerAssembledPromptStats.totalExcerptChars,
    );
    for (const path of assembled.reviewerAssembledPromptStats.selectedPaths) {
      expect(assembled.userMessage).toContain(`--- ${path} ---`);
    }
  });

  it("records honest zero assembled stats when no files are eligible", () => {
    const selected = buildReviewerContextFromFiles({
      diff: { filesAdded: [], filesModified: [], filesRemoved: [] },
      workspaceFiles: [],
    });
    const assembled = assembleArchitectReviewPrompt({
      userRequest: "Review the build.",
      agentMode: "lite",
      diff: selected.diff,
      fileExcerpts: selected.fileExcerpts,
    });

    expect(selected.fileExcerpts).toEqual([]);
    expect(assembled.reviewerAssembledPromptStats).toEqual({
      excerptCount: 0,
      totalExcerptChars: 0,
      excerptBlockChars: 0,
      selectedPaths: [],
    });
  });
});
