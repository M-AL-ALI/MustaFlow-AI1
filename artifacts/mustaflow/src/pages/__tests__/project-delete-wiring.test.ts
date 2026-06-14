import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PAGES_SRC = join(__dirname, "..");

function readPage(relPath: string): string {
  return readFileSync(join(PAGES_SRC, relPath), "utf-8");
}

describe("project delete wiring", () => {
  it("exposes recoverable project deletion from the main projects dashboard", () => {
    const src = readPage("projects.tsx");

    expect(src).toContain("useDeleteProject");
    expect(src).toContain("Move project to Trash");
    expect(src).toContain("restore it from Trash for 30 days");
    expect(src).toContain("getGetProjectsSummaryQueryKey");
    expect(src).toContain("getGetRecentActivityQueryKey");
    expect(src).toContain("getListTrashedProjectsQueryKey");
    expect(src).toContain("Trash2");
  });

  it("exposes recoverable project deletion from developer project cards", () => {
    const src = readPage("dev-home.tsx");

    expect(src).toContain("useDeleteProject");
    expect(src).toContain("Move project to Trash");
    expect(src).toContain("restore it from Trash for 30 days");
    expect(src).toContain("getListTrashedProjectsQueryKey");
    expect(src).toContain("Trash2");
    expect(src).toContain("bg-background/80");
    expect(src).not.toContain("opacity-0 transition-opacity");
  });
});
