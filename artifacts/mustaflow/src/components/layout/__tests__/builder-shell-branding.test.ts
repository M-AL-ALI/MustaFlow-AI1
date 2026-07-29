import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(directory, "../slide-out-nav.tsx"), "utf8");

describe("NabuFlow builder shell branding", () => {
  it("uses the dedicated NabuFlow mark and wordmark", () => {
    expect(source).toContain('"/logos/nabuflow-icon.png"');
    expect(source).toContain('alt="NabuFlow"');
    expect(source).toContain(">NabuFlow</span>");
    expect(source).not.toContain('"/logo.png"');
    expect(source).not.toContain(">MustaFlow</span>");
  });

  it("hides the navigation trigger while the drawer logo is visible", () => {
    expect(source).toContain("aria-hidden={open}");
    expect(source).toContain('open ? "pointer-events-none opacity-0" : "opacity-100"');
  });
});
