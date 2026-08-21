import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractJsxElementByAttribute } from "../../../api-server/src/lib/source-ast-test-helper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Mobile Brand Kit wiring (settings.tsx)", () => {
  const settings = read("../../app/(home)/settings.tsx");
  const brandKitSection = extractJsxElementByAttribute(
    settings,
    "SectionCard",
    "title",
    "Brand Kit",
  );

  it("renders a Brand Kit section", () => {
    expect(settings).toContain("Brand Kit");
  });

  it("provides an 'Edit Brand Kit' link button (not a native editor)", () => {
    expect(settings).toContain('label="Edit Brand Kit"');
  });

  it("'Edit Brand Kit' opens the website settings URL via WebBrowser", () => {
    expect(brandKitSection).toContain('label="Edit Brand Kit"');
    expect(brandKitSection).toContain("WebBrowser");
    expect(brandKitSection).toContain("/ora/settings");
  });

  it("does NOT render a native color picker or logo thumbnail for Brand Kit", () => {
    expect(brandKitSection).toContain('title="Brand Kit"');
    expect(brandKitSection).not.toMatch(/ColorPicker/i);
    expect(brandKitSection).not.toMatch(/logoThumbnail/i);
    expect(brandKitSection).not.toMatch(/primaryColor.*swatch/i);
  });

  it("mobile Brand Kit section does not claim to show read-only swatches or thumbnails", () => {
    expect(brandKitSection).toContain("Configure on the website.");
    expect(brandKitSection).not.toContain("swatch");
    expect(brandKitSection).not.toContain("thumbnail");
    expect(brandKitSection).not.toContain("color preview");
  });
});
