import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const projectWorkspaceSource = readFileSync(
  resolve(process.cwd(), "src/pages/projects/[id].tsx"),
  "utf8",
);
const zeroAgentPanelSource = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/zero-agent-panel.tsx"),
  "utf8",
);

describe("Zero prompt queue reachability", () => {
  it("keeps an unbroken route-to-drawer path through the real project workspace", () => {
    expect(appSource).toContain(
      'const ProjectWorkspacePage = builderLazy(() => import("./pages/projects/[id]"));',
    );
    expect(appSource).toMatch(
      /<Route path="\/projects\/:id">[\s\S]*?<ProjectWorkspacePage \/>[\s\S]*?<\/Route>/,
    );
    expect(projectWorkspaceSource).toMatch(
      /const ZeroAgentPanel = builderLazy\(\(\) =>[\s\S]*?\.\/components\/zero-agent-panel/,
    );
    expect(projectWorkspaceSource).toContain("<ZeroAgentPanel");
    expect(zeroAgentPanelSource).toContain(
      'import { ZeroPromptQueueDrawer } from "./zero-prompt-queue-drawer";',
    );
    expect(zeroAgentPanelSource).toContain('aria-label="Open queued prompts"');
    expect(zeroAgentPanelSource).toContain("<ZeroPromptQueueDrawer");
  });

  it("feeds the real task phase into the real workspace drawer", () => {
    expect(zeroAgentPanelSource.match(/onRunPhaseChange=\{handleRunPhaseChange\}/g)).toHaveLength(
      2,
    );
    expect(zeroAgentPanelSource).toContain("phase={runPhase}");
    expect(zeroAgentPanelSource).toContain("activeTaskId={activeTaskId}");
  });
});
