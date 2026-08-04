import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOLS, formatWorkspaceToolsForAgent } from "@workspace/nabuflow-workspace-tools";

describe("Zero workspace-tool context", () => {
  it("includes every canonical tool name, category, and exact opening instruction", () => {
    const context = formatWorkspaceToolsForAgent();
    for (const tool of WORKSPACE_TOOLS) {
      expect(context).toContain(`${tool.category} / ${tool.name}`);
      expect(context).toContain(`Open Tools and pick ${tool.name} under ${tool.category}.`);
    }
  });

  it("is included in the project context assembled for Zero", () => {
    const jobsSource = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(jobsSource).toContain("import { formatWorkspaceToolsForAgent }");
    expect(jobsSource).toContain("const workspaceTools = formatWorkspaceToolsForAgent();");
    expect(jobsSource).toContain("const parts: string[] = [workspaceTools]");
  });
});
