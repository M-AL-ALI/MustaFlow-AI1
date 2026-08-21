import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractCallContainingIdentifier,
  extractNamedDeclaration,
  extractNamedInterface,
} from "../../../../api-server/src/lib/source-ast-test-helper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

describe("Brand Kit website wiring (ora-settings.tsx)", () => {
  const src = read("../ora-settings.tsx");

  it("BrandKitApiResponse exposes only `kit` at the top level", () => {
    const iface = extractNamedInterface(src, "BrandKitApiResponse", "tsx");
    expect(iface).toContain("interface BrandKitApiResponse");
    const topLevelKeys = [...iface.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(topLevelKeys).toEqual(["kit"]);
    expect(iface).toMatch(/^ {4}primaryColor\?:/m);
    expect(iface).toContain("logoPreviewUrl");
    expect(iface).not.toContain("logoUrl?:");
  });

  it("useEffect reads colors/fonts/logo from d.kit (not flat d)", () => {
    const effectBody = extractCallContainingIdentifier(src, "useEffect", "logoPreviewUrl", "tsx");

    expect(effectBody).toContain('authFetch("/api/ora/brand-kit")');
    expect(effectBody).toContain("d.kit");
    expect(effectBody).toContain("kit.primaryColor");
    expect(effectBody).toContain("kit.accentColor");
    expect(effectBody).toContain("kit.headingFont");
    expect(effectBody).toContain("kit.bodyFont");
    expect(effectBody).toContain("kit.logoPreviewUrl");
    expect(effectBody).not.toContain("d.primaryColor");
    expect(effectBody).not.toContain("d.logoUrl");
  });

  it("handleLogoUpload sends JSON (not FormData) with base64 data", () => {
    const fnBody = extractNamedDeclaration(src, "handleLogoUpload", "tsx");

    expect(fnBody).toContain("handleLogoUpload = async");
    expect(fnBody).not.toContain("new FormData()");
    expect(fnBody).not.toContain("form.append");
    expect(fnBody).toContain("FileReader");
    expect(fnBody).toContain("readAsDataURL");
    expect(fnBody).toContain("JSON.stringify");
    expect(fnBody).toContain('"Content-Type": "application/json"');
    expect(fnBody).toContain("mimeType: file.type");
    expect(fnBody).toContain("fileName: file.name");
  });

  it("handleLogoUpload reads previewUrl from the response (not logoUrl)", () => {
    const fnBody = extractNamedDeclaration(src, "handleLogoUpload", "tsx");

    expect(fnBody).toContain("handleLogoUpload = async");
    expect(fnBody).toContain("previewUrl");
    expect(fnBody).not.toContain("d.logoUrl");
  });

  it("handleLogoUpload validates PNG/JPEG only — rejects other types", () => {
    const fnBody = extractNamedDeclaration(src, "handleLogoUpload", "tsx");

    expect(fnBody).toContain("handleLogoUpload = async");
    expect(fnBody).toContain('"image/png"');
    expect(fnBody).toContain('"image/jpeg"');
    expect(fnBody).toContain("PNG or JPEG");
  });

  it("file input accept attribute restricts to PNG and JPEG only", () => {
    expect(src).toContain('accept="image/png,image/jpeg"');
    expect(src).not.toContain("image/webp");
    expect(src).not.toContain("image/svg+xml");
    expect(src).not.toContain("image/gif");
  });

  it("UI copy mentions PNG or JPEG only — no webp or svg in logo description", () => {
    expect(src).toContain("PNG or JPEG");
    const logoDescIdx = src.indexOf("PNG or JPEG");
    const descContext = src.slice(logoDescIdx, logoDescIdx + 100);
    expect(descContext).not.toContain("WebP");
    expect(descContext).not.toContain("SVG");
  });

  it("SAFE_FONTS_WEB does not include Tahoma", () => {
    const fontsBlock = extractNamedDeclaration(src, "SAFE_FONTS_WEB", "tsx");

    expect(fontsBlock).toContain("SAFE_FONTS_WEB = [");
    expect(fontsBlock).not.toContain("Tahoma");
    expect(fontsBlock).toContain('"Calibri"');
    expect(fontsBlock).toContain('"Arial"');
    expect(fontsBlock).toContain('"Georgia"');
  });
});
