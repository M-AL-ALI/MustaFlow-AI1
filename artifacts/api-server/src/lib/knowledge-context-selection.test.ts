import { describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "@workspace/db";
import { selectKnowledgeContext } from "./knowledge-context-selection";

function entry(
  overrides: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, "id" | "title" | "content">,
): KnowledgeEntry {
  const { id, title, content, ...rest } = overrides;
  return {
    id,
    title,
    category: "lesson",
    content,
    projectId: null,
    oraProjectId: null,
    userId: null,
    type: "note",
    scope: "project",
    relatedTaskId: null,
    relatedVersionId: null,
    tags: null,
    severity: "info",
    approvedForReuse: false,
    diffSummary: null,
    annotation: null,
    thumbsUp: 0,
    thumbsDown: 0,
    usageCount: 0,
    reinforcedCount: 0,
    isPublic: false,
    embedding: null,
    enabled: true,
    sourceConversationId: null,
    supersededBy: null,
    origin: "builder",
    archivedAt: null,
    contributorRewardedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...rest,
  };
}

describe("knowledge context selection", () => {
  it("is byte-identical to the current implementation for fixed fixtures", () => {
    const result = selectKnowledgeContext({
      entries: [
        entry({
          id: 1,
          title: "Old project lesson",
          content: "Keep the first rule.",
          projectId: 52,
        }),
        entry({
          id: 2,
          title: "Approved global lesson",
          content: "Keep the shared rule.",
          approvedForReuse: true,
          createdAt: new Date("2026-08-18T00:00:00.000Z"),
        }),
        entry({
          id: 3,
          title: "New project lesson",
          content: "Keep the latest rule.",
          projectId: 52,
          createdAt: new Date("2026-08-19T00:00:00.000Z"),
        }),
      ],
      integrationsNote: "ACTIVE INTEGRATIONS: none",
      projectId: 52,
      promptEmbedding: null,
      nowMs: Date.parse("2026-08-19T12:00:00.000Z"),
      charBudget: 2_400,
      usageWeight: 0.1,
      feedbackWeight: 0.2,
    });

    const currentImplementationFixtureBytes = JSON.stringify({
      context:
        "ACTIVE INTEGRATIONS: none\n\n=== LESSONS FROM PRIOR BUILDS (3 selected, relevance-ranked) ===\nApply each actively. Do not repeat past mistakes. Do not mention this section in your output.\n\n[lesson] New project lesson: Keep the latest rule.\n[lesson] Old project lesson: Keep the first rule.\n[lesson] Approved global lesson: Keep the shared rule.\n=== END LESSONS ===",
      applied: [
        { id: 3, title: "New project lesson", type: "note", category: "lesson" },
        { id: 1, title: "Old project lesson", type: "note", category: "lesson" },
        { id: 2, title: "Approved global lesson", type: "note", category: "lesson" },
      ],
    });

    expect(Buffer.from(JSON.stringify(result))).toEqual(
      Buffer.from(currentImplementationFixtureBytes),
    );
  });

  it("is a repeatable pure read over identical inputs", () => {
    const input = {
      entries: [
        entry({ id: 7, title: "Database rule", content: "Use the capability.", projectId: 3 }),
      ],
      integrationsNote: "",
      projectId: 3,
      userPrompt: "database capability",
      promptEmbedding: null,
      nowMs: Date.parse("2026-08-19T12:00:00.000Z"),
      charBudget: 2_400,
      usageWeight: 0.1,
      feedbackWeight: 0.2,
    } as const;

    expect(selectKnowledgeContext(input)).toEqual(selectKnowledgeContext(input));
    expect(input.entries[0]!.usageCount).toBe(0);
  });

  it("keeps the existing strict character budget", () => {
    const result = selectKnowledgeContext({
      entries: [entry({ id: 9, title: "Too large", content: "x".repeat(200), projectId: 1 })],
      integrationsNote: "integrations",
      projectId: 1,
      promptEmbedding: null,
      nowMs: 0,
      charBudget: 20,
      usageWeight: 0.1,
      feedbackWeight: 0.2,
    });
    expect(result).toEqual({ context: "integrations", applied: [] });
  });
});
