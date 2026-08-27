import { describe, expect, it } from "vitest";
import {
  localClarificationFallback,
  providerFailureBehaviorForCapability,
} from "./zero-contract-fallbacks";

describe("Zero provider-failure contract fallbacks", () => {
  it("enumerates all 15 commissioned capability contracts exactly once", () => {
    const ids = [
      "Z-A",
      "Z-B",
      "Z-C",
      "Z-D",
      "Z-F",
      "Z-G",
      "Z-J",
      "Z-K",
      "Z-L",
      "Z-M",
      "Z-N",
      "Z-O",
      "Z-P",
      "Z-S",
      "Z-AA",
    ] as const;
    expect(ids.map((id) => providerFailureBehaviorForCapability(id))).toHaveLength(15);
    expect(providerFailureBehaviorForCapability("Z-B")).toEqual({
      behavior: "local_clarification",
      preserves: "one focused question",
    });
  });

  it.each([
    ["Something is broken", "Should I investigate what is wrong, or repair it now?"],
    ["Maybe change the page", "Should I change the content, the layout, or the visual style?"],
    [
      "Do something with the app",
      "Should I explain the current app, plan a change, or build it now?",
    ],
    ["Maybe later", "Should I explain it, plan it, or change it now?"],
  ])("returns one deterministic local question for %s", (prompt, question) => {
    const first = localClarificationFallback(prompt);
    const second = localClarificationFallback(prompt);
    expect(first).toEqual(second);
    expect(first.question).toBe(question);
    expect(first.question.match(/\?/g)).toHaveLength(1);
    expect(first.options.length).toBeGreaterThanOrEqual(2);
    expect(first.options.length).toBeLessThanOrEqual(3);
    expect(first.stopEvidence).toEqual({
      source: "local_contract_fallback",
      fallbackCode: "clarification_provider_unavailable",
    });
  });

  it("never reflects raw input into the local question or options", () => {
    const secretMarker = "never-repeat-this-marker";
    const result = localClarificationFallback(secretMarker);
    expect(`${result.question} ${result.options.join(" ")}`).not.toContain(secretMarker);
  });
});
