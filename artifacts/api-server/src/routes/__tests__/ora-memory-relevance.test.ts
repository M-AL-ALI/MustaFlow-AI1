import { describe, it, expect, vi } from "vitest";

// Force the TF-IDF fallback path deterministically by stubbing the embedding
// provider to throw — independent of whether OPENAI_API_KEY is set in the env.
vi.mock("../../lib/embeddings", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("embeddings disabled in test");
  }),
  cosineSimilarity: vi.fn(() => 0),
  buildEmbeddingInput: vi.fn((title: string, content: string) => `${title}\n${content}`),
}));

import {
  tokeniseMemory,
  selectMemoriesWithinBudget,
  rankMemoriesByRelevance,
  resolveOraMemoryRecallProfile,
  inferMemoryQueryCategories,
  type OraMemoryRow,
} from "../public-ai/chat";

// Relevance-based Ora memory recall (Task #1368).
//
// These exercise the pure ranking helpers without a DB. The embedding provider
// is mocked to throw so the ranker falls back to TF-IDF keyword overlap — which
// is exactly the path we assert.

function mem(
  id: number,
  title: string,
  content: string,
  ageDays: number,
  category: string | null = null,
): OraMemoryRow {
  return {
    id,
    title,
    content,
    category,
    embedding: null,
    createdAt: new Date(Date.now() - ageDays * 86_400_000),
  };
}

describe("tokeniseMemory", () => {
  it("lowercases and drops tokens shorter than 3 chars", () => {
    expect(tokeniseMemory("I love TypeScript, a lot!")).toEqual(["love", "typescript", "lot"]);
  });
});

describe("selectMemoriesWithinBudget", () => {
  it("always keeps at least the first entry even if it exceeds the budget", () => {
    const huge = mem(1, "big", "x".repeat(10_000), 0);
    expect(selectMemoriesWithinBudget([huge])).toHaveLength(1);
  });

  it("caps at the max-entry ceiling", () => {
    const rows = Array.from({ length: 50 }, (_, i) => mem(i, `t${i}`, "c", i));
    expect(selectMemoriesWithinBudget(rows).length).toBeLessThanOrEqual(30);
  });
});

describe("resolveOraMemoryRecallProfile", () => {
  it("gives Core and Wave deeper recall than Free", () => {
    const free = resolveOraMemoryRecallProfile("free");
    const core = resolveOraMemoryRecallProfile("core");
    const wave = resolveOraMemoryRecallProfile("wave");

    expect(core.charBudget).toBeGreaterThan(free.charBudget);
    expect(wave.charBudget).toBeGreaterThan(core.charBudget);
    expect(core.candidateLimit).toBeGreaterThan(free.candidateLimit);
    expect(wave.maxEntries).toBeGreaterThan(core.maxEntries);
  });
});

describe("inferMemoryQueryCategories", () => {
  it("detects preference, personal, project, and document query categories", () => {
    expect(inferMemoryQueryCategories("what answer style do I prefer?")).toContain("preference");
    expect(inferMemoryQueryCategories("what company do I work for?")).toContain("personal");
    expect(inferMemoryQueryCategories("what tech stack is my app using?")).toContain("project");
    expect(inferMemoryQueryCategories("what did my uploaded document say?")).toContain("document");
  });
});

describe("rankMemoriesByRelevance (TF-IDF fallback)", () => {
  it("surfaces an OLD relevant memory past the old 15-entry recency window", async () => {
    // 20 recent but unrelated memories...
    const rows: OraMemoryRow[] = Array.from({ length: 20 }, (_, i) =>
      mem(i, `Random note ${i}`, "unrelated chatter about weather", i),
    );
    // ...plus one OLD, highly relevant memory (40 days old, id 999).
    rows.push(mem(999, "Favorite database", "The user prefers PostgreSQL for projects", 40));
    // Newest-first ordering, as buildMemoryContext supplies.
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const selected = await rankMemoriesByRelevance(rows, "what postgresql database do I like");
    expect(selected[0]?.id).toBe(999);
  });

  it("does NOT pull an unrelated memory for an unrelated query (no signal → recency)", async () => {
    const rows: OraMemoryRow[] = [
      mem(1, "Favorite database", "The user prefers PostgreSQL", 40),
      mem(2, "Recent note", "Bought groceries today", 0),
      mem(3, "Another recent note", "Went for a run", 1),
    ];
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Query shares no tokens with any memory → falls back to recency ordering,
    // so the old database memory is NOT promoted to the top.
    const selected = await rankMemoriesByRelevance(rows, "tell me a joke about penguins");
    expect(selected[0]?.id).not.toBe(1);
  });

  it("uses category query intent as a tiebreaker", async () => {
    const rows: OraMemoryRow[] = [
      mem(1, "General product note", "The user ships a SaaS product", 0, "project"),
      mem(2, "Answer style", "The user prefers concise answers", 3, "preference"),
    ];

    const selected = await rankMemoriesByRelevance(
      rows,
      "what answer style do I prefer?",
      resolveOraMemoryRecallProfile("wave"),
    );
    expect(selected[0]?.id).toBe(2);
  });
});
