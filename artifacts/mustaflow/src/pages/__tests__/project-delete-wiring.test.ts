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
    expect(src).toContain("<ProjectTrashDialog");
    expect(src).toContain("setTrashProject(project)");
    expect(src).not.toContain("window.confirm(");
    expect(src).toContain("getGetProjectsSummaryQueryKey");
    expect(src).toContain("getGetRecentActivityQueryKey");
    expect(src).toContain("getListTrashedProjectsQueryKey");
    expect(src).toContain("Trash2");
    expect(src).toContain('href="/trash"');
    expect(src).toContain("Open Trash");
    expect(src).not.toContain('href="/projects/all"');
  });

  it("exposes recoverable project deletion from developer project cards", () => {
    const src = readPage("dev-home.tsx");

    expect(src).toContain("useDeleteProject");
    expect(src).toContain("Move project to Trash");
    expect(src).toContain("<ProjectTrashDialog");
    expect(src).toContain("onDelete={setTrashProject}");
    expect(src).not.toContain("window.confirm(");
    expect(src).toContain("getListTrashedProjectsQueryKey");
    expect(src).toContain("Trash2");
    expect(src).toContain("bg-background/80");
    expect(src).not.toContain("opacity-0 transition-opacity");
  });

  it("wires scheduled and owner-triggered permanent deletion into Trash", () => {
    const src = readPage("trash.tsx");
    const control = readPage("trash-permanent-deletion.tsx");

    expect(src).toContain("then are permanently deleted");
    expect(src).toContain("ProjectPermanentDeletionControl");
    expect(control).toContain("Automatic permanent deletion is scheduled.");
    expect(src).not.toContain("is not active yet");
  });
});
