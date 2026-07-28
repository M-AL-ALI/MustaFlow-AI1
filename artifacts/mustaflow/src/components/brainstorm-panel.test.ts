import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("BrainstormPanel handoff wiring", () => {
  it("offers plan and build exits and carries project/thread context into the billable handoff", () => {
    const panelSource = readFileSync(
      resolve(process.cwd(), "src/components/brainstorm-panel.tsx"),
      "utf8",
    );
    const composerSource = readFileSync(
      resolve(process.cwd(), "src/pages/projects/components/queue-composer.tsx"),
      "utf8",
    );

    expect(panelSource).toContain("Turn into plan");
    expect(panelSource).toContain("Build this");
    expect(panelSource).toContain("projectId");
    expect(panelSource).toContain("brainstormContext: data.brainstormContext");
    expect(panelSource).toContain("agentIntent: data.action");
    expect(composerSource).toContain("onSingleSend(prompt, action, undefined, messages)");
  });
});
