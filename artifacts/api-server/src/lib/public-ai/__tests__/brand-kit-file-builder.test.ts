import { describe, it, expect } from "vitest";
import {
  toDocxColor,
  toArgb,
  lightenArgb,
  toPdfColor,
  toPdfFont,
} from "../brand-kit-apply";

describe("toDocxColor", () => {
  it("strips # and returns uppercase 6-char hex for valid input", () => {
    expect(toDocxColor("#1E1B4B")).toBe("1E1B4B");
    expect(toDocxColor("#6366f1")).toBe("6366F1");
    expect(toDocxColor("1E1B4B")).toBe("1E1B4B");
  });

  it("returns null for invalid or empty input", () => {
    expect(toDocxColor("not-a-color")).toBeNull();
    expect(toDocxColor("#GGGGGG")).toBeNull();
    expect(toDocxColor(null)).toBeNull();
    expect(toDocxColor(undefined)).toBeNull();
    expect(toDocxColor("")).toBeNull();
  });
});

describe("toArgb", () => {
  it("adds FF alpha prefix to a valid hex color", () => {
    expect(toArgb("#1E1B4B")).toBe("FF1E1B4B");
    expect(toArgb("#6366F1")).toBe("FF6366F1");
    expect(toArgb("e94560")).toBe("FFE94560");
  });

  it("returns null for invalid input", () => {
    expect(toArgb(null)).toBeNull();
    expect(toArgb("bad")).toBeNull();
  });
});

describe("lightenArgb", () => {
  it("lightens a dark ARGB value (increases brightness)", () => {
    const result = lightenArgb("FF1E1B4B");
    expect(result).toBeTruthy();
    expect(result!.startsWith("FF")).toBe(true);
    expect(result!.length).toBe(8);
    const inSum = 0x1e + 0x1b + 0x4b;
    const outR = parseInt(result!.slice(2, 4), 16);
    const outG = parseInt(result!.slice(4, 6), 16);
    const outB = parseInt(result!.slice(6, 8), 16);
    expect(outR + outG + outB).toBeGreaterThan(inSum);
  });

  it("returns null for malformed ARGB", () => {
    expect(lightenArgb("ZZZZZZZZ")).toBeNull();
    expect(lightenArgb("1E1B4B")).toBeNull();
  });
});

describe("toPdfColor", () => {
  it("returns # prefixed 6-char hex for valid input", () => {
    expect(toPdfColor("#6366F1")).toBe("#6366F1");
    expect(toPdfColor("6366f1")).toBe("#6366F1");
  });

  it("returns null for invalid or null input", () => {
    expect(toPdfColor(null)).toBeNull();
    expect(toPdfColor("bad")).toBeNull();
  });
});

describe("toPdfFont", () => {
  it("maps common web fonts to standard PDF fonts", () => {
    expect(toPdfFont("Calibri", false)).toBe("Helvetica");
    expect(toPdfFont("Arial", false)).toBe("Helvetica");
    expect(toPdfFont("Georgia", false)).toBe("Times-Roman");
    expect(toPdfFont("Times New Roman", false)).toBe("Times-Roman");
  });

  it("returns the Bold variant when bold=true", () => {
    expect(toPdfFont(null, true)).toBe("Helvetica-Bold");
    expect(toPdfFont("Calibri", true)).toBe("Helvetica-Bold");
    expect(toPdfFont("Times New Roman", true)).toBe("Times-Bold");
  });

  it("falls back to Helvetica for null/unknown fonts", () => {
    expect(toPdfFont(null, false)).toBe("Helvetica");
    expect(toPdfFont("Unknown Font XYZ", false)).toBe("Helvetica");
  });
});
