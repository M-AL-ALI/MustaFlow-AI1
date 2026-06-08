import { describe, it, expect } from "vitest";
import {
  tokenizeMemory,
  shouldSupersede,
  findMemoriesToSupersede,
} from "./memory-consolidation";

describe("tokenizeMemory", () => {
  it("drops stopwords, short tokens, and lowercases", () => {
    const tokens = tokenizeMemory("I prefer Dark Mode");
    expect(tokens).toEqual(new Set(["prefer", "dark", "mode"]));
  });

  it("treats save-imperative scaffolding as noise", () => {
    const tokens = tokenizeMemory("Remember that I prefer dark mode");
    expect(tokens).toEqual(new Set(["prefer", "dark", "mode"]));
  });

  it("drops the verb 'like' so distinct objects stay distinct", () => {
    expect(tokenizeMemory("I like coffee")).toEqual(new Set(["coffee"]));
    expect(tokenizeMemory("I like tea")).toEqual(new Set(["tea"]));
  });

  it("normalises a trailing plural s", () => {
    const tokens = tokenizeMemory("budget dollars");
    expect(tokens.has("dollar")).toBe(true);
    expect(tokens.has("budget")).toBe(true);
  });
});

describe("shouldSupersede — supersedes overlapping facts", () => {
  it("dark mode -> light mode", () => {
    expect(
      shouldSupersede(
        { title: "I prefer light mode", content: "" },
        { title: "I prefer dark mode", content: "" },
      ),
    ).toBe(true);
  });

  it("budget amount change", () => {
    expect(
      shouldSupersede(
        { title: "my budget is 8000 dollars", content: "" },
        { title: "my budget is 5000 dollars", content: "" },
      ),
    ).toBe(true);
  });
});

describe("shouldSupersede — keeps distinct facts (conservative)", () => {
  it("coffee vs tea — no shared significant tokens", () => {
    expect(
      shouldSupersede(
        { title: "I like coffee", content: "" },
        { title: "I like tea", content: "" },
      ),
    ).toBe(false);
  });

  it("different companies — only one shared noun", () => {
    expect(
      shouldSupersede(
        { title: "my company is Acme", content: "" },
        { title: "my company is Globex", content: "" },
      ),
    ).toBe(false);
  });

  it("entirely unrelated facts", () => {
    expect(
      shouldSupersede(
        { title: "I live in Berlin", content: "" },
        { title: "I prefer dark mode", content: "" },
      ),
    ).toBe(false);
  });

  it("too few significant tokens to judge", () => {
    expect(
      shouldSupersede(
        { title: "dogs", content: "" },
        { title: "cats", content: "" },
      ),
    ).toBe(false);
  });
});

describe("findMemoriesToSupersede", () => {
  it("returns only the ids of overlapping active memories", () => {
    const existing = [
      { id: 1, title: "I prefer dark mode", content: "" },
      { id: 2, title: "I like coffee", content: "" },
      { id: 3, title: "my company is Acme", content: "" },
    ];
    const ids = findMemoriesToSupersede(
      { title: "I prefer light mode", content: "" },
      existing,
    );
    expect(ids).toEqual([1]);
  });

  it("returns an empty array when nothing overlaps", () => {
    const existing = [
      { id: 1, title: "I like coffee", content: "" },
      { id: 2, title: "I live in Berlin", content: "" },
    ];
    expect(
      findMemoriesToSupersede({ title: "I prefer dark mode", content: "" }, existing),
    ).toEqual([]);
  });
});
