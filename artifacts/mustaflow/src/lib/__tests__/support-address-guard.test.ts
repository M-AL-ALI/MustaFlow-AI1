import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SOURCE_ROOTS = [
  "artifacts/mustaflow/src",
  "artifacts/api-server/src",
  "artifacts/orax-desktop/src",
  "artifacts/ora-mobile/app",
  "artifacts/ora-mobile/components",
  "artifacts/ora-mobile/constants",
  "artifacts/ora-mobile/context",
  "artifacts/ora-mobile/hooks",
  "artifacts/ora-mobile/lib",
];
const SOURCE_EXTENSIONS = new Set([".cjs", ".html", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN_SUPPORT_IDENTITIES = /@mustaflow\.(?:app|ai)\b|mechconnect/i;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") return [];
      return collectSourceFiles(absolutePath);
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [absolutePath];
  });
}

describe("support address source guard", () => {
  it("keeps obsolete MustaFlow addresses and identities out of product source", () => {
    const violations = SOURCE_ROOTS.flatMap((relativeRoot) =>
      collectSourceFiles(resolve(REPO_ROOT, relativeRoot)).flatMap((filePath) => {
        const source = readFileSync(filePath, "utf8");
        return FORBIDDEN_SUPPORT_IDENTITIES.test(source)
          ? [filePath.slice(REPO_ROOT.length + 1)]
          : [];
      }),
    );

    expect(violations).toEqual([]);
  });

  it("wires Orax help and diagnostics to the unified support destination", () => {
    const sidebar = readFileSync(
      resolve(REPO_ROOT, "artifacts/orax-desktop/src/renderer/components/Sidebar.tsx"),
      "utf8",
    );
    const settings = readFileSync(
      resolve(REPO_ROOT, "artifacts/orax-desktop/src/renderer/pages/SettingsScreen.tsx"),
      "utf8",
    );
    const health = readFileSync(
      resolve(REPO_ROOT, "artifacts/orax-desktop/src/renderer/pages/HealthScreen.tsx"),
      "utf8",
    );

    expect(sidebar).toContain('href="https://www.mustaflow.com/help?mode=report"');
    expect(settings).toContain('href="mailto:support@mustaflow.com"');
    expect(health).toContain("Send it to support@mustaflow.com.");
  });
});
