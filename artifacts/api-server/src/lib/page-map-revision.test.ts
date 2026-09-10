import { describe, expect, it } from "vitest";
import { pageMapRevision } from "./page-map-revision";

describe("stored Page Map revision", () => {
  it("survives JSONB object-key reordering at every level", () => {
    const first = {
      web: { nodes: [{ id: "home", position: { x: 1, y: 2 } }], edges: [] },
      ios: null,
    };
    const reordered = {
      ios: null,
      web: { edges: [], nodes: [{ position: { y: 2, x: 1 }, id: "home" }] },
    };
    expect(pageMapRevision(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(pageMapRevision(first)).toBe(pageMapRevision(reordered));
  });
  it("distinguishes array order and persisted changes, including unknown fields", () => {
    expect(pageMapRevision({ nodes: [1, 2] })).not.toBe(pageMapRevision({ nodes: [2, 1] }));
    expect(pageMapRevision({ web: {}, legacy: true })).not.toBe(pageMapRevision({ web: {} }));
  });
  it("treats SQL NULL and decoded JSON null consistently", () => {
    expect(pageMapRevision(null)).toBe(pageMapRevision(undefined));
    expect(pageMapRevision(null)).not.toBe(pageMapRevision({}));
  });
});
