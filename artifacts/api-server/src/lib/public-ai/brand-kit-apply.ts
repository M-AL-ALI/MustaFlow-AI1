/**
 * Brand Kit types and pure color/font helper utilities for the file builders.
 * No DB imports — this module stays AI-free and DB-free so it can be imported
 * by file-builder.ts without adding new heavy transitive dependencies.
 */

export interface BrandKit {
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  headingFont: string | null;
  bodyFont: string | null;
  logoBuf: Buffer | null;
  logoMimeType: string | null;
}

/** Validates a raw hex color string and returns null when invalid. */
export function normalizeHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : null;
}

/**
 * Returns the hex color WITHOUT the leading "#" for DOCX TextRun.color and
 * PptxGenJS color properties. Returns null when the color is falsy or invalid.
 */
export function toDocxColor(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Returns "#RRGGBB" (with hash) for PDFKit fillColor / strokeColor.
 * Returns null when the color is falsy or invalid.
 */
export function toPdfColor(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toUpperCase()}` : null;
}

/**
 * Returns "FFRRGGBB" (ARGB with full-opacity alpha prefix) for ExcelJS
 * font/fill color properties. Returns null when the color is falsy or invalid.
 */
export function toArgb(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `FF${m[1].toUpperCase()}` : null;
}

/**
 * Lightens an ARGB color 80% toward white, suitable for alternating table
 * row backgrounds derived from the primary brand color.
 */
export function lightenArgb(argb: string | null | undefined): string | null {
  if (!argb || argb.length < 8) return null;
  const parse = (s: string, o: number) => parseInt(s.slice(o, o + 2), 16);
  const r = parse(argb, 2);
  const g = parse(argb, 4);
  const b = parse(argb, 6);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  const blend = (c: number) =>
    Math.round(c + (255 - c) * 0.8)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `FF${blend(r)}${blend(g)}${blend(b)}`;
}

/**
 * Maps a brand font name to the nearest PDFKit built-in font. PDFKit only
 * ships with Helvetica, Times, and Courier families; everything else falls
 * back to Helvetica/Helvetica-Bold.
 */
export function toPdfFont(fontName: string | null | undefined, bold = false): string {
  if (!fontName) return bold ? "Helvetica-Bold" : "Helvetica";
  const n = fontName.toLowerCase();
  if (n.includes("times") || n.includes("georgia")) {
    return bold ? "Times-Bold" : "Times-Roman";
  }
  if (n.includes("courier") || n.includes("mono")) {
    return bold ? "Courier-Bold" : "Courier";
  }
  return bold ? "Helvetica-Bold" : "Helvetica";
}
