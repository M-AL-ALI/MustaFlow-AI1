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
const agentThinkingBubbleSource = readFileSync(
  resolve(process.cwd(), "src/components/agent-thinking-bubble.tsx"),
  "utf8",
);
const devWorkspaceSource = readFileSync(
  resolve(process.cwd(), "src/pages/dev-workspace/index.tsx"),
  "utf8",
);
const devChatPanelSource = readFileSync(
  resolve(process.cwd(), "src/pages/dev-workspace/components/dev-chat-panel.tsx"),
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
    expect(devWorkspaceSource).toContain("<DevChatPanel");
    expect(devChatPanelSource).toContain(
      'import { ZeroPromptQueueDrawer } from "@/pages/projects/components/zero-prompt-queue-drawer";',
    );
    expect(devChatPanelSource).toContain("<ZeroPromptQueueDrawer");
  });

  it("feeds the real task phase into the real workspace drawer", () => {
    expect(zeroAgentPanelSource.match(/onRunPhaseChange=\{handleRunPhaseChange\}/g)).toHaveLength(
      2,
    );
    expect(zeroAgentPanelSource).toContain("phase={runPhase}");
    expect(zeroAgentPanelSource).toContain("activeTaskId={activeTaskId}");
    expect(devChatPanelSource).toContain("phase={runPhase}");
    expect(devChatPanelSource).toContain("activeTaskId={activeTaskId}");
  });

  it("keeps the live steering path mounted and reports only a confirmed queue receipt", () => {
    expect(zeroAgentPanelSource).toContain(
      'import { AgentThinkingBubble } from "@/components/agent-thinking-bubble";',
    );
    expect(zeroAgentPanelSource.match(/<AgentThinkingBubble/g)).toHaveLength(2);
    expect(agentThinkingBubbleSource).toContain(
      "<SteeringInput projectId={projectId} taskId={taskId} />",
    );
    expect(agentThinkingBubbleSource).toContain(
      "`/api/projects/${projectId}/tasks/${taskId}/steer`",
    );
    expect(agentThinkingBubbleSource).toContain('typeof data?.itemId !== "string"');
    expect(agentThinkingBubbleSource).toContain("!Number.isSafeInteger(data?.position)");
    expect(agentThinkingBubbleSource).toContain(
      "Prompt saved in position {savedPosition}. Zero will apply it at the next safe pause.",
    );
    expect(agentThinkingBubbleSource).toContain("{sendError}</span>");
    expect(agentThinkingBubbleSource).toContain(
      'import { selectPromptQueueError } from "@/lib/zero-prompt-queue-user-errors";',
    );
    expect(agentThinkingBubbleSource).toContain("selectPromptQueueError(data, fallback)");
    expect(agentThinkingBubbleSource).not.toContain('typeof data?.error === "string"');
    expect(agentThinkingBubbleSource).not.toContain(
      "Hint queued — the agent will apply it on the next step.",
    );
  });
});
