import { describe, expect, it, vi } from "vitest";
vi.mock("./page-map-repository", () => ({ pageMapRepository: {} }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
import { mergeWithExisting, type PageMapNode, type PageMapPlatform } from "./page-map";
import { PAGE_MAP_TRANSITION_FIELDS, type PageMapTransition } from "./page-map-transition";

function node(overrides: Partial<PageMapNode> = {}): PageMapNode {
  return {
    id: "home",
    label: "Home",
    pageType: "other",
    filePath: "src/Home.tsx",
    position: { x: 12, y: 24 },
    isNew: false,
    hasError: false,
    aiGenerated: true,
    notes: "Route: /home",
    ...overrides,
  };
}
function claims(): PageMapTransition {
  return {
    version: 1,
    action: { kind: "click", label: "Continue" },
    control: { kind: "button" },
    condition: { kind: "unknown", branch: "unknown" },
    outcome: { kind: "navigate" },
    destination: { kind: "unknown" },
    evidence: [
      {
        basis: "source",
        fields: ["action", "control"],
        source: {
          filePath: "src/Home.tsx",
          contentSha256: "a".repeat(64),
          startOffset: 10,
          endOffset: 30,
        },
      },
    ],
    unknowns: ["The destination is computed; execution is not verified."],
  };
}
function graph(page = node()): PageMapPlatform {
  return {
    nodes: [page],
    edges: [],
    unresolvedTransitions: [{ id: "candidate-1", source: page.id, transition: claims() }],
  };
}
function expectManual(result: PageMapPlatform, current: PageMapPlatform): void {
  expect(result.unresolvedTransitions).toHaveLength(1);
  expect(result.unresolvedTransitions![0].transition).toEqual({
    ...current.unresolvedTransitions![0].transition,
    evidence: [{ basis: "manual", fields: [...PAGE_MAP_TRANSITION_FIELDS] }],
  });
  expect(current.unresolvedTransitions![0].transition.evidence[0].basis).toBe("source");
}

describe("Page Map extraction candidate binding", () => {
  it.each([
    ["file replacement", { filePath: "src/Other.tsx" }],
    ["canonical route replacement", { notes: "Route: /other" }],
  ] as const)("downgrades historical authority for same-ID %s", (_label, change) => {
    const current = graph();
    expectManual(mergeWithExisting([node(change)], [], current), current);
  });

  it("downgrades a same-ID planned page when it becomes implemented", () => {
    const current = graph(node({ planned: true }));
    const result = mergeWithExisting([node()], [], current);
    expect(result.nodes[0].planned).toBe(false);
    expectManual(result, current);
  });

  it("downgrades a planned candidate rebound by its page label", () => {
    const current = graph(node({ id: "planned-home", planned: true }));
    const result = mergeWithExisting([node()], [], current);
    expect(result.unresolvedTransitions![0].source).toBe("home");
    expectManual(result, current);
  });

  it("preserves historical evidence for unchanged bindings and layout-only changes", () => {
    const current = graph();
    const result = mergeWithExisting([node({ position: { x: 900, y: 800 } })], [], current);
    expect(result.unresolvedTransitions).toEqual(current.unresolvedTransitions);
    expect(result.nodes[0].position).toEqual({ x: 12, y: 24 });
  });

  it("preserves unattributed candidates without inventing a source page", () => {
    const current = graph();
    delete current.unresolvedTransitions![0].source;
    expect(
      mergeWithExisting([node({ filePath: "src/Other.tsx" })], [], current).unresolvedTransitions,
    ).toEqual(current.unresolvedTransitions);
  });

  it("drops candidates for removed source pages", () => {
    expect(mergeWithExisting([], [], graph()).unresolvedTransitions).toEqual([]);
  });

  it("keeps legacy graphs free of fabricated candidates", () => {
    const current = graph();
    delete current.unresolvedTransitions;
    expect(mergeWithExisting([node()], [], current).unresolvedTransitions).toBeUndefined();
  });
});
