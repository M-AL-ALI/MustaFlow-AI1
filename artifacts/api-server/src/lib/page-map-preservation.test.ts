import { describe, expect, it, vi } from "vitest";
import { discoverSourcePageMap } from "./page-map-source";
import {
  mergeWithExisting,
  extractPageMapForFiles,
  type PageMapNode,
  type PageMapEdge,
} from "./page-map";
const ai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: ai.create } } },
}));
const node = (id: string, label: string, extra: Partial<PageMapNode> = {}): PageMapNode => ({
  id,
  label,
  pageType: "other",
  filePath: id + ".html",
  position: { x: 0, y: 0 },
  isNew: false,
  hasError: false,
  aiGenerated: true,
  notes: "",
  ...extra,
});
const edge = (source: string, target: string): PageMapEdge => ({
  id: source + "-" + target,
  source,
  target,
  connectionType: "nav",
  aiGenerated: false,
});
describe("Page-map preservation", () => {
  it("ignores invented files, malformed nodes, duplicate IDs and unsupported model enums", async () => {
    ai.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              nodes: [
                null,
                {
                  id: "safe",
                  label: "Home",
                  filePath: "index.html",
                  pageType: "invalid",
                  notes: { unexpected: true },
                },
                { id: "safe", label: "Duplicate", filePath: "index.html" },
                { id: "outside", label: "Outside", filePath: "../../ora" },
              ],
              edges: [
                null,
                { id: "bad", source: "safe", target: "outside", connectionType: "nav" },
              ],
            }),
          },
        },
      ],
    });
    const files = [{ path: "index.html", content: "<h1>Home</h1>", mimeType: "text/html" }];
    const sourceNode = discoverSourcePageMap(files).nodes[0];
    const result = await extractPageMapForFiles(files, "web");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: sourceNode.id,
      filePath: "index.html",
      pageType: "other",
      label: "Home",
      notes: sourceNode.notes,
    });
    expect(result.edges).toHaveLength(0);
  });
  it("retains manually added pages and their connections when analysis omits them", () => {
    const manual = node("manual", "Custom page", { aiGenerated: false });
    const result = mergeWithExisting([node("home", "Home")], [], {
      nodes: [manual],
      edges: [edge("home", "manual")],
    });
    expect(result.nodes.map((n) => n.id)).toEqual(["home", "manual"]);
    expect(result.edges).toHaveLength(1);
  });
  it("does not collapse distinct Arabic page labels into an empty matching key", () => {
    const result = mergeWithExisting([node("login", "\u062f\u062e\u0648\u0644")], [], {
      nodes: [node("plan", "\u062d\u0633\u0627\u0628", { planned: true })],
      edges: [],
    });
    expect(result.nodes.map((n) => n.id)).toEqual(["login", "plan"]);
  });
  it("remaps connections when a planned page becomes a built page", () => {
    const result = mergeWithExisting([node("home", "Home"), node("built", "Account")], [], {
      nodes: [
        node("planned", "Account", {
          planned: true,
          notes: "Keep this",
          position: { x: 50, y: 80 },
        }),
      ],
      edges: [edge("home", "planned")],
    });
    expect(result.edges[0].target).toBe("built");
    expect(result.nodes.find((n) => n.id === "built")).toMatchObject({
      notes: "Keep this",
      position: { x: 50, y: 80 },
    });
  });
  it("keeps ambiguous planned labels and removes dangling edges", () => {
    const result = mergeWithExisting([node("one", "Settings"), node("two", "Settings")], [], {
      nodes: [node("planned", "Settings", { planned: true })],
      edges: [edge("gone", "planned")],
    });
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(0);
  });
});
