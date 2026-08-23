import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const previewSource = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/preview-tab.tsx"),
  "utf8",
);
const workspaceSource = readFileSync(resolve(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");
const changelogSource = readFileSync(
  resolve(process.cwd(), "src/pages/developers-changelog.tsx"),
  "utf8",
);

describe("workspace test-environment controls", () => {
  it("wires start, rebuild, status, and approval to the authenticated product routes", () => {
    expect(previewSource).toContain("/preview-env/status");
    expect(previewSource).toContain("/preview-env/${action}");
    expect(previewSource).toContain('action: "start" | "rebuild" | "approve"');
    expect(previewSource).toContain('effectiveTestingStatus === "ready" ? "approve"');
    expect(previewSource).toContain('effectiveTestingStatus === "building"');
  });

  it("exposes a decidable approve control and refreshes authoritative project state", () => {
    expect(previewSource).toContain('"Approve test"');
    expect(previewSource).toContain('"Start test"');
    expect(previewSource).toContain("onTestingStatusChanged?.()");
    expect(workspaceSource).toContain("onTestingStatusChanged={() =>");
    expect(workspaceSource).toContain("void refetchProject();");
  });

  it("describes a sealed candidate as awaiting approval rather than ready", () => {
    expect(changelogSource).toContain("approve the sealed test candidate for promotion");
    expect(changelogSource).not.toMatch(/snapshot as tested and ready to promote/i);
  });
});
