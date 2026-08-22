import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("answering task status reader census", () => {
  it.each([
    ["../components/background-jobs-panel.tsx", '"answering"'],
    ["../pages/projects/[id].tsx", '"queued", "answering", "planning"'],
    ["../pages/projects/components/background-tasks-drawer.tsx", '"answering"'],
    ["../pages/projects/components/logs-tab.tsx", '"answering", "building", "planning"'],
    ["../pages/projects/components/queue-progress-strip.tsx", '"answering"'],
    ["../pages/projects/components/run-rehydration.ts", '"answering"'],
    ["../pages/projects/components/task-queue-panel.tsx", '"answering"'],
  ] as const)("keeps %s aware that answer work is active", (path, expected) => {
    expect(source(path)).toContain(expected);
  });
});
