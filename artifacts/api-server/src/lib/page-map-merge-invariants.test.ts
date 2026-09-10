import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPageMapForFiles, mergeWithExisting, type PageMapNode } from "./page-map";
import { PageMapAnalysisValidationError } from "./page-map-validation";

const create = vi.hoisted(() => vi.fn());
vi.mock("./page-map-repository", () => ({ pageMapRepository: {} }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create } } },
}));
const node = (id: string): PageMapNode => ({
  id,
  label: id,
  pageType: "other",
  filePath: "",
  position: { x: 0, y: 0 },
  isNew: false,
  hasError: false,
  aiGenerated: false,
  notes: "Keep this note",
});
beforeEach(() => create.mockReset());

describe("Page Map merge invariants", () => {
  it("refuses overflow instead of saving a map that will truncate manual pages on read", () => {
    const existing = {
      nodes: Array.from({ length: 500 }, (_, index) => node("manual-" + index)),
      edges: [],
    };
    expect(() => mergeWithExisting([node("new-route")], [], existing)).toThrow(
      PageMapAnalysisValidationError,
    );
    expect(existing.nodes).toHaveLength(500);
    expect(existing.nodes[499].notes).toBe("Keep this note");
  });
  it("accepts the exact limit and rejects duplicate generated identities", () => {
    const existing = {
      nodes: Array.from({ length: 499 }, (_, index) => node("manual-" + index)),
      edges: [],
    };
    expect(mergeWithExisting([node("new-route")], [], existing).nodes).toHaveLength(500);
    expect(() =>
      mergeWithExisting([node("duplicate"), node("duplicate")], [], { nodes: [], edges: [] }),
    ).toThrow(PageMapAnalysisValidationError);
  });
  it("does not restore commented HTML links after successful AI enrichment", async () => {
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              nodes: [
                {
                  id: "ai-home",
                  label: "Home",
                  pageType: "landing",
                  filePath: "index.html",
                  notes: "",
                },
                {
                  id: "ai-about",
                  label: "About",
                  pageType: "other",
                  filePath: "about.html",
                  notes: "",
                },
                {
                  id: "ai-hidden",
                  label: "Hidden",
                  pageType: "other",
                  filePath: "hidden.html",
                  notes: "",
                },
              ],
              edges: [],
            }),
          },
        },
      ],
    });
    const result = await extractPageMapForFiles(
      [
        {
          path: "index.html",
          mimeType: "text/html",
          content: '<!-- <a href="hidden.html">Comment only</a> --><a href="about.html">About</a>',
        },
        { path: "about.html", mimeType: "text/html", content: "<h1>About</h1>" },
        { path: "hidden.html", mimeType: "text/html", content: "<h1>Hidden</h1>" },
      ],
      "web",
    );
    expect(create).toHaveBeenCalledOnce();
    expect(result.edges).toHaveLength(1);
    const home = result.nodes.find((page) => page.filePath === "index.html")!;
    const about = result.nodes.find((page) => page.filePath === "about.html")!;
    const hidden = result.nodes.find((page) => page.filePath === "hidden.html")!;
    expect(result.edges[0]).toMatchObject({ source: home.id, target: about.id });
    expect(result.edges.some((edge) => edge.target === hidden.id)).toBe(false);
    expect(home).toMatchObject({ label: "Home", pageType: "landing" });
  });
});
