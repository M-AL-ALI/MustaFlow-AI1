import { describe, expect, it } from "vitest";
import { classifyEditIntent, isRevisionIntent } from "../edit-intent-classifier";

describe("classifyEditIntent", () => {
  describe("full_redesign", () => {
    it("matches 'redesign the whole thing'", () => {
      expect(classifyEditIntent("redesign the whole thing")).toBe("full_redesign");
    });
    it("matches 'restyle from scratch'", () => {
      expect(classifyEditIntent("restyle it from scratch")).toBe("full_redesign");
    });
    it("matches 'start over'", () => {
      expect(classifyEditIntent("start over with a new design")).toBe("full_redesign");
    });
    it("matches 'completely different version'", () => {
      expect(classifyEditIntent("make a completely different version")).toBe("full_redesign");
    });
  });

  describe("new_creation", () => {
    it("matches 'create a report about Q3 sales'", () => {
      expect(classifyEditIntent("create a report about Q3 sales")).toBe("new_creation");
    });
    it("matches 'generate a new deck on climate change'", () => {
      expect(classifyEditIntent("generate a new deck on climate change")).toBe("new_creation");
    });
    it("does NOT match create+it (has revision anchor)", () => {
      expect(classifyEditIntent("create a better version of it")).not.toBe("new_creation");
    });
  });

  describe("content_edit", () => {
    it("matches 'change the title to Project Alpha'", () => {
      expect(classifyEditIntent("change the title to Project Alpha")).toBe("content_edit");
    });
    it("matches 'fix the typo in slide 3'", () => {
      expect(classifyEditIntent("fix the typo in slide 3")).toBe("content_edit");
    });
    it("matches 'rewrite the executive summary'", () => {
      expect(classifyEditIntent("rewrite the executive summary")).toBe("content_edit");
    });
    it("matches 'translate this to French'", () => {
      expect(classifyEditIntent("translate this to French")).toBe("content_edit");
    });
    it("matches 'shorten the intro paragraph'", () => {
      expect(classifyEditIntent("shorten the intro paragraph")).toBe("content_edit");
    });
  });

  describe("style_edit", () => {
    it("matches 'change the font to Arial'", () => {
      expect(classifyEditIntent("change the font to Arial")).toBe("style_edit");
    });
    it("matches 'make the headings blue'", () => {
      expect(classifyEditIntent("make the headings blue")).toBe("style_edit");
    });
    it("matches 'apply a dark theme'", () => {
      expect(classifyEditIntent("apply a dark theme")).toBe("style_edit");
    });
    it("matches 'make the background red'", () => {
      expect(classifyEditIntent("make the background red")).toBe("style_edit");
    });
    it("matches 'improve it' (bare pronoun + improve keyword)", () => {
      expect(classifyEditIntent("improve it")).toBe("style_edit");
    });
  });

  describe("layout_edit", () => {
    it("matches 'reorder the slides'", () => {
      expect(classifyEditIntent("reorder the slides")).toBe("layout_edit");
    });
    it("matches 'move section 2 before section 1'", () => {
      expect(classifyEditIntent("move section 2 before section 1")).toBe("layout_edit");
    });
    it("matches 'center align everything'", () => {
      expect(classifyEditIntent("center align everything")).toBe("layout_edit");
    });
  });

  describe("structure_edit", () => {
    it("matches 'add a new slide about budget'", () => {
      expect(classifyEditIntent("add a new slide about budget")).toBe("structure_edit");
    });
    it("matches 'remove the last section'", () => {
      expect(classifyEditIntent("remove the last section")).toBe("structure_edit");
    });
    it("matches 'insert a header at the top'", () => {
      expect(classifyEditIntent("insert a header at the top")).toBe("structure_edit");
    });
    it("matches 'delete slide 5'", () => {
      expect(classifyEditIntent("delete slide 5")).toBe("structure_edit");
    });
  });

  describe("formula_chart", () => {
    it("matches 'add a formula for total revenue'", () => {
      expect(classifyEditIntent("add a formula for total revenue")).toBe("formula_chart");
    });
    it("matches 'insert a bar chart for Q3 data'", () => {
      expect(classifyEditIntent("insert a bar chart for Q3 data")).toBe("formula_chart");
    });
    it("matches 'calculate the average of column B'", () => {
      expect(classifyEditIntent("calculate the average of column B")).toBe("formula_chart");
    });
    it("matches 'add a VLOOKUP to match names'", () => {
      expect(classifyEditIntent("add a VLOOKUP to match names")).toBe("formula_chart");
    });
  });

  describe("revision_ambiguous", () => {
    it("matches bare 'can you improve it?'", () => {
      const result = classifyEditIntent("can you improve it?");
      expect(isRevisionIntent(result)).toBe(true);
    });
    it("matches 'make it better'", () => {
      expect(classifyEditIntent("make it better")).toBe("style_edit");
    });
    it("matches vague follow-up like 'looks good but can you tweak it a bit?'", () => {
      const result = classifyEditIntent("looks good but can you tweak it a bit?");
      expect(isRevisionIntent(result)).toBe(true);
    });
  });

  describe("unrelated", () => {
    it("returns unrelated for casual chat", () => {
      expect(classifyEditIntent("what's the weather like today?")).toBe("unrelated");
    });
    it("returns unrelated for a greeting", () => {
      expect(classifyEditIntent("thanks!")).toBe("unrelated");
    });
    it("returns unrelated for a general question", () => {
      expect(classifyEditIntent("what is photosynthesis?")).toBe("unrelated");
    });
  });
});

describe("isRevisionIntent", () => {
  it("returns true for content_edit", () => {
    expect(isRevisionIntent("content_edit")).toBe(true);
  });
  it("returns true for style_edit", () => {
    expect(isRevisionIntent("style_edit")).toBe(true);
  });
  it("returns true for layout_edit", () => {
    expect(isRevisionIntent("layout_edit")).toBe(true);
  });
  it("returns true for structure_edit", () => {
    expect(isRevisionIntent("structure_edit")).toBe(true);
  });
  it("returns true for formula_chart", () => {
    expect(isRevisionIntent("formula_chart")).toBe(true);
  });
  it("returns true for revision_ambiguous", () => {
    expect(isRevisionIntent("revision_ambiguous")).toBe(true);
  });
  it("returns false for full_redesign", () => {
    expect(isRevisionIntent("full_redesign")).toBe(false);
  });
  it("returns false for new_creation", () => {
    expect(isRevisionIntent("new_creation")).toBe(false);
  });
  it("returns false for unrelated", () => {
    expect(isRevisionIntent("unrelated")).toBe(false);
  });
});
