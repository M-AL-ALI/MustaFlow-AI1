import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mutationSucceededTerminal } from "@workspace/ora-contracts";
import { parseTaskStreamReceipt } from "@/hooks/use-task-event-stream";
import { terminalPresentationFor, terminalTaskMessage, terminalTaskStatus } from "./zero-terminal";

const terminal = mutationSucceededTerminal({
  schema: "zero-terminal-v1",
  outcome: "mutation_succeeded",
  runStatus: "completed",
  taskId: 14,
  intent: "mutate",
  intentReceiptId: 22,
  completedAt: "2026-08-22T12:00:00.000Z",
  evidence: {
    versionId: 3,
    diffRef: { kind: "task_report", taskId: 14, revision: 1 },
    preview: { promised: true, state: "ready", receiptId: "preview:14:3" },
  },
});

describe("staged terminal readers", () => {
  it("preserves legacy status and copy byte-for-byte when terminal is null", () => {
    expect(terminalTaskStatus({ terminal: null }, "completed")).toBe("completed");
    expect(terminalTaskMessage({ terminal: null }, "Changes applied.")).toBe("Changes applied.");
    expect(terminalPresentationFor({ terminal: null })).toBeNull();
  });

  it("prefers a present typed terminal and treats malformed persistence as unknown", () => {
    expect(terminalTaskStatus({ terminal }, "failed")).toBe("completed");
    expect(terminalTaskMessage({ terminal }, "Legacy failure")).toBe(
      "Changes applied. Preview is ready.",
    );
    expect(terminalPresentationFor({ terminal: { outcome: "mutation_succeeded" } })).toMatchObject({
      outcome: "unknown",
      message: "Outcome unavailable for this older run",
    });
  });

  it("lets terminal truth govern SSE status, copy, and preview refresh", () => {
    const receipt = parseTaskStreamReceipt(
      JSON.stringify({
        id: 9,
        taskId: 14,
        eventType: "failed",
        message: "legacy raw failure",
        createdAt: "2026-08-22T12:00:00.000Z",
        terminal,
      }),
      14,
    );
    expect(receipt).toMatchObject({
      terminal: true,
      event: { eventType: "completed", message: "Changes applied. Preview is ready." },
      terminalPresentation: { shouldRefreshPreview: true },
    });
  });

  it("pins every C1-C8 reader family to the canonical terminal path", () => {
    const readers: Record<string, string> = {
      "hooks/use-task-event-stream.ts": "presentPersistedZeroTerminal",
      "pages/projects/[id].tsx": "receipt.terminalPresentation",
      "components/agent-thinking-bubble.tsx": "terminalPresentationFor",
      "pages/projects/components/activity-stream.tsx": "terminalPresentationFor",
      "pages/projects/components/inline-activity-stream.tsx": "terminalPresentationFor",
      "pages/projects/components/zero-agent-panel.tsx": "terminalPresentationFor",
      "pages/projects/components/chat-history.tsx": "terminalPresentationFor",
      "pages/projects/components/inline-build-results.tsx": "terminalPresentationFor",
      "pages/projects/components/background-tasks-drawer.tsx": "terminalPresentationFor",
      "pages/projects/components/task-queue-panel.tsx": "terminalPresentationFor",
      "pages/projects/components/queue-progress-strip.tsx": "terminalPresentationFor",
      "components/background-jobs-panel.tsx": "terminalPresentationFor",
      "pages/projects/components/logs-tab.tsx": "terminalPresentationFor",
      "pages/projects/components/inline-run-recovery.tsx": "terminalPresentationFor",
      "components/notifications-bell.tsx": "terminalPresentationFor",
    };
    for (const [relative, anchor] of Object.entries(readers)) {
      const source = readFileSync(join(process.cwd(), "src", relative), "utf8");
      expect(source, relative).toContain(anchor);
    }
  });
});
