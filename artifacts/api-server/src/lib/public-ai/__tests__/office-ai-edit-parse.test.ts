import { describe, expect, it } from "vitest";
import { extractPlannerJson, parsePlannerJson } from "../office-ai-edit.js";

describe("extractPlannerJson", () => {
  it("returns clean JSON untouched", () => {
    const raw = '{"mode":"edit","operations":[]}';
    expect(extractPlannerJson(raw)).toBe(raw);
  });

  it("extracts JSON from a fenced code block", () => {
    const raw = 'Here is the plan:\n```json\n{"mode":"edit","operations":[]}\n```\nDone.';
    expect(extractPlannerJson(raw)).toBe('{"mode":"edit","operations":[]}');
  });

  it("extracts the balanced object when prose surrounds it", () => {
    const raw = 'Sure! {"mode":"edit","operations":[{"find":"a","replace":"b"}]} hope that helps';
    expect(extractPlannerJson(raw)).toBe(
      '{"mode":"edit","operations":[{"find":"a","replace":"b"}]}',
    );
  });

  it("handles braces inside string values", () => {
    const raw = '{"mode":"edit","operations":[{"find":"if (x) { y }","replace":"z"}]}';
    expect(extractPlannerJson(raw)).toBe(raw);
  });

  it("returns null when there is no object at all", () => {
    expect(extractPlannerJson("I cannot produce a plan for that.")).toBeNull();
  });

  it("returns null for an unterminated object", () => {
    expect(extractPlannerJson('{"mode":"edit","operations":[')).toBeNull();
  });
});

describe("parsePlannerJson", () => {
  it("parses valid JSON", () => {
    expect(parsePlannerJson('{"mode":"edit","operations":[]}')).toEqual({
      mode: "edit",
      operations: [],
    });
  });

  it("repairs trailing commas in objects and arrays", () => {
    expect(
      parsePlannerJson('{"mode":"edit","operations":[{"find":"a","replace":"b",},],}'),
    ).toEqual({
      mode: "edit",
      operations: [{ find: "a", replace: "b" }],
    });
  });

  it("parses JSON wrapped in a code fence with prose", () => {
    expect(
      parsePlannerJson('The plan:\n```json\n{"mode":"regenerate","operations":[]}\n```'),
    ).toEqual({ mode: "regenerate", operations: [] });
  });

  it("returns null for irreparably malformed content", () => {
    expect(parsePlannerJson('{"mode": edit-not-a-string}')).toBeNull();
    expect(parsePlannerJson("no json here")).toBeNull();
  });
});
