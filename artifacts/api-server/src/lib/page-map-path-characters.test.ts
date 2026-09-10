import { describe, expect, it } from "vitest";
import { hasPageMapControlCharacter } from "./page-map-path-characters";

describe("Page Map path character policy", () => {
  it.each(Array.from({ length: 128 }, (_, code) => code))(
    "preserves the existing ASCII boundary for character %i",
    (code) => {
      const value = "pages/a" + String.fromCharCode(code) + "b.tsx";
      expect(hasPageMapControlCharacter(value)).toBe(code <= 31);
      expect(hasPageMapControlCharacter(value, true)).toBe(code <= 32);
    },
  );

  it("does not reject empty or non-ASCII text as an ASCII control", () => {
    for (const value of ["", "\u0645\u0631\u062d\u0628\u0627", "\u9875\u9762", "\ud83d\ude97"]) {
      expect(hasPageMapControlCharacter(value)).toBe(false);
      expect(hasPageMapControlCharacter(value, true)).toBe(false);
    }
  });
});
