import { describe, expect, it } from "vitest";
import { pageMapUpdateSchema, parseStoredPageMap } from "./page-map-validation";
const node = {
  id: "home",
  label: "Home",
  pageType: "other",
  filePath: "index.html",
  position: { x: 0, y: 0 },
  isNew: false,
  hasError: false,
  aiGenerated: true,
  notes: "",
};
describe("Page Map payload boundary", () => {
  it("accepts a valid partial-platform update", () => {
    expect(pageMapUpdateSchema.safeParse({ web: { nodes: [node], edges: [] } }).success).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { web: null },
    { web: { nodes: [null], edges: [] } },
    { web: { nodes: [node, node], edges: [] } },
    { web: { nodes: [{ ...node, filePath: "../ora" }], edges: [] } },
    { web: { nodes: [{ ...node, position: { x: Infinity, y: 0 } }], edges: [] } },
    {
      web: {
        nodes: [node],
        edges: [
          { id: "e", source: "home", target: "missing", connectionType: "nav", aiGenerated: false },
        ],
      },
    },
  ])("rejects malformed payload %j", (payload) => {
    expect(pageMapUpdateSchema.safeParse(payload).success).toBe(false);
  });
  it("normalizes malformed persisted maps without sending broken nodes to the canvas", () => {
    const result = parseStoredPageMap({
      web: {
        nodes: [null, node, node],
        edges: [
          null,
          { id: "e", source: "home", target: "missing", connectionType: "nav", aiGenerated: true },
        ],
      },
    });
    expect(result.web.nodes).toHaveLength(1);
    expect(result.web.edges).toEqual([]);
    expect(result.ios).toEqual({ nodes: [], edges: [] });
  });
  it("bounds map payload size", () => {
    expect(
      pageMapUpdateSchema.safeParse({
        web: {
          nodes: Array.from({ length: 501 }, (_, i) => ({ ...node, id: String(i) })),
          edges: [],
        },
      }).success,
    ).toBe(false);
  });
});
