import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Brand Kit wiring (settings.tsx)", () => {
  const settings = read("../../app/(home)/settings.tsx");

  it("renders a Brand Kit section", () => {
    expect(settings).toContain("Brand Kit");
  });

  it("provides an 'Edit Brand Kit' link button (not a native editor)", () => {
    expect(settings).toContain('label="Edit Brand Kit"');
  });

  it("'Edit Brand Kit' opens the website settings URL via WebBrowser", () => {
    const btnStart = settings.indexOf('label="Edit Brand Kit"');
    expect(btnStart).toBeGreaterThan(-1);
    const vicinity = settings.slice(Math.max(0, btnStart - 300), btnStart + 300);
    expect(vicinity).toContain("WebBrowser");
    expect(vicinity).toContain("/ora/settings");
  });

  it("does NOT render a native color picker or logo thumbnail for Brand Kit", () => {
    const sectionStart = settings.indexOf("{/* ── Brand Kit");
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionEnd = settings.indexOf("{/* ──", sectionStart + 1);
    const sectionBody =
      sectionEnd > sectionStart
        ? settings.slice(sectionStart, sectionEnd)
        : settings.slice(sectionStart, sectionStart + 600);

    expect(sectionBody).not.toMatch(/ColorPicker/i);
    expect(sectionBody).not.toMatch(/logoThumbnail/i);
    expect(sectionBody).not.toMatch(/primaryColor.*swatch/i);
  });

  it("mobile Brand Kit section does not claim to show read-only swatches or thumbnails", () => {
    const sectionStart = settings.indexOf("Brand Kit");
    expect(sectionStart).toBeGreaterThan(-1);
    const vicinity = settings.slice(sectionStart, sectionStart + 800);
    expect(vicinity).not.toContain("swatch");
    expect(vicinity).not.toContain("thumbnail");
    expect(vicinity).not.toContain("color preview");
  });
});
