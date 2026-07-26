import { describe, expect, it } from "vitest";
import { BUILDER_ENABLED, resolveBuilderAccess } from "./builder-flag";

describe("AI Builder access fallback", () => {
  it("honors explicit server access decisions", () => {
    expect(resolveBuilderAccess(true)).toBe(true);
    expect(resolveBuilderAccess(false)).toBe(false);
  });

  it("remains closed while preferences are unavailable", () => {
    expect(BUILDER_ENABLED).toBe(false);
    expect(resolveBuilderAccess(undefined)).toBe(false);
    expect(resolveBuilderAccess(null)).toBe(false);
  });
});
