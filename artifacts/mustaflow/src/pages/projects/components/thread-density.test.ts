import { describe, expect, it } from "vitest";
import { threadDensityForMode, visibleThreadEntries } from "./thread-density";

describe("thread density", () => {
  it("maps builder modes without changing the underlying data", () => {
    expect(threadDensityForMode("lite")).toBe("minimal");
    expect(threadDensityForMode("eco")).toBe("standard");
    expect(threadDensityForMode("power")).toBe("standard");
    expect(threadDensityForMode("pro")).toBe("detailed");
  });

  it("scales default visibility while preserving the source array", () => {
    const entries = Array.from({ length: 12 }, (_, index) => index + 1);

    expect(visibleThreadEntries(entries, "minimal")).toEqual([12]);
    expect(visibleThreadEntries(entries, "standard")).toEqual([7, 8, 9, 10, 11, 12]);
    expect(visibleThreadEntries(entries, "detailed")).toEqual(entries);
    expect(entries).toHaveLength(12);
  });
});
