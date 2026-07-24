import { describe, it, expect } from "vitest";
import {
  toDocxColor,
  toArgb,
  lightenArgb,
  toPdfColor,
  toPdfFont,
} from "../brand-kit-apply";
import type { BrandKit } from "../brand-kit-apply";
import type { ColumnType } from "../file-builder";

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

describe("buildPptx smoke tests (with brand kit)", () => {
  const minimalPresentation = {
    title: "Test Deck",
    subtitle: "Smoke test",
    slides: [
      { heading: "Slide One", bullets: ["Point A", "Point B"] },
    ],
    charts: [],
  };

  const kitWithLogo: BrandKit = {
    primaryColor: "#1a1a2e",
    secondaryColor: null,
    accentColor: "#e94560",
    headingFont: "Arial",
    bodyFont: "Calibri",
    logoBuf: Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]),
    logoMimeType: "image/png",
  };

  const kitNoLogo: BrandKit = {
    primaryColor: "#1a1a2e",
    secondaryColor: null,
    accentColor: "#e94560",
    headingFont: "Georgia",
    bodyFont: "Times New Roman",
    logoBuf: null,
    logoMimeType: null,
  };

  it("returns a non-empty Buffer without a brand kit", async () => {
    const { buildPptx } = await import("../file-builder");
    const buf = await buildPptx(minimalPresentation);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);

  it("returns a non-empty Buffer with a brand kit (no logo)", async () => {
    const { buildPptx } = await import("../file-builder");
    const buf = await buildPptx(minimalPresentation, kitNoLogo);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);

  it("produces a larger buffer when a logo is included", async () => {
    const { buildPptx } = await import("../file-builder");
    const bufNoLogo = await buildPptx(minimalPresentation, kitNoLogo);
    const bufWithLogo = await buildPptx(minimalPresentation, kitWithLogo);
    expect(bufWithLogo.length).toBeGreaterThan(bufNoLogo.length);
  }, 30000);
});

describe("buildDocx smoke tests (with brand kit)", () => {
  const minimalDocument = {
    title: "Test Doc",
    subtitle: "Subtitle",
    sections: [
      {
        heading: "Introduction",
        content: "This is some body text.\n\nSecond paragraph.",
        bullets: ["Bullet one", "Bullet two"],
      },
    ],
    charts: [],
  };

  const kitWithBothFonts: BrandKit = {
    primaryColor: "#1a1a2e",
    secondaryColor: null,
    accentColor: "#e94560",
    headingFont: "Georgia",
    bodyFont: "Arial",
    logoBuf: Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]),
    logoMimeType: "image/png",
  };

  it("returns a non-empty Buffer without a brand kit", async () => {
    const { buildDocx } = await import("../file-builder");
    const buf = await buildDocx(minimalDocument);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);

  it("returns a non-empty Buffer with a full brand kit (logo + both fonts)", async () => {
    const { buildDocx } = await import("../file-builder");
    const buf = await buildDocx(minimalDocument, kitWithBothFonts);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);

  it("produces a larger buffer when a logo is included in the document header", async () => {
    const { buildDocx } = await import("../file-builder");
    const noLogo: BrandKit = { ...kitWithBothFonts, logoBuf: null, logoMimeType: null };
    const bufNoLogo = await buildDocx(minimalDocument, noLogo);
    const bufWithLogo = await buildDocx(minimalDocument, kitWithBothFonts);
    expect(bufWithLogo.length).toBeGreaterThan(bufNoLogo.length);
  }, 30000);
});

describe("buildXlsx smoke tests (with brand kit)", () => {
  const minimalTabular = {
    title: "Sales Report",
    sheetName: "Sales",
    headers: ["Month", "Revenue", "Units"],
    columnTypes: ["text", "currency", "number"] as ColumnType[],
    rows: [
      ["January", "12000", "150"],
      ["February", "15500", "190"],
    ],
  };

  const kitForXlsx: BrandKit = {
    primaryColor: "#0f172a",
    secondaryColor: null,
    accentColor: "#2563eb",
    headingFont: "Calibri",
    bodyFont: "Arial",
    logoBuf: null,
    logoMimeType: null,
  };

  it("returns a non-empty Buffer without a brand kit", async () => {
    const { buildXlsx } = await import("../file-builder");
    const buf = await buildXlsx(minimalTabular);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);

  it("returns a non-empty Buffer with a brand kit applied", async () => {
    const { buildXlsx } = await import("../file-builder");
    const buf = await buildXlsx(minimalTabular, kitForXlsx);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  }, 30000);
});
