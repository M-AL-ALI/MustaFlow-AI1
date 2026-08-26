import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { selectRecentTaskIds } from "./use-project-images";

const workspaceSource = readFileSync(resolve(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");
const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
const bundleGuard = readFileSync(resolve(process.cwd(), "scripts/check-bundle-size.mjs"), "utf8");

describe("project workspace performance rails", () => {
  it("keeps heavy workspace surfaces in lazy chunks", () => {
    for (const component of [
      "PublishingTab",
      "CodeEditorTab",
      "PageMapTab",
      "ProjectImagesTab",
      "CheckpointsTab",
      "ZeroAgentPanel",
    ]) {
      expect(workspaceSource).toMatch(
        new RegExp(`const ${component} = builderLazy\\(\\(\\) =>[\\s\\S]*?${component}`),
      );
    }
  });

  it("does not load image or version history during the default preview open", () => {
    expect(workspaceSource).toContain('enabled: activeTab === "images"');
    expect(workspaceSource).not.toContain("useListVersions(projectId");
    expect(workspaceSource).toContain("queryFn: () => listVersions(projectId)");
  });

  it("caps image event history and expands it in bounded windows", () => {
    expect(selectRecentTaskIds([9, 9, 8, 7, 6, 5, 4, 3], 6)).toEqual([9, 8, 7, 6, 5, 4]);
    expect(selectRecentTaskIds([3, 2, 1], 0)).toEqual([]);
  });

  it("bounds the production workspace module-request fan-out", () => {
    expect(viteConfig).toContain('return "workspace-icons"');
    expect(viteConfig).toContain('return "workspace-ui"');
    expect(bundleGuard).toContain("WORKSPACE_SYNC_IMPORT_BUDGET = 24");
    expect(bundleGuard).toContain("checkWorkspaceImportFanout();");
  });
});
