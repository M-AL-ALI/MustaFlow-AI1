import { describe, expect, it } from "vitest";
import { builderIntentChipLabel } from "./builder-intent-chip";

describe("builderIntentChipLabel", () => {
  it.each([
    ["answer", "Answer"],
    ["clarify", "Clarify"],
    ["plan", "Plan"],
    ["mutate", "Change"],
    ["observe", "Observe"],
  ] as const)("uses the fixed receipt-backed label for %s", (intent, label) => {
    expect(builderIntentChipLabel(intent)).toBe(label);
  });

  it("renders no chip without a closed persisted receipt intent", () => {
    expect(builderIntentChipLabel(undefined)).toBeNull();
    expect(builderIntentChipLabel("build")).toBeNull();
    expect(builderIntentChipLabel("debug")).toBeNull();
  });
});
