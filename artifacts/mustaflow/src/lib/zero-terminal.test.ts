import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interruptedTerminal, mutationSucceededTerminal } from "@workspace/ora-contracts";
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
  it.each(["completed", "failed", "canceled", "cancelled", "discarded"])(
    "renders a null %s terminal as an older-run unknown without inventing success",
    (status) => {
      expect(terminalTaskStatus({ terminal: null, status }, status)).toBe(status);
      expect(terminalTaskMessage({ terminal: null, status }, "Changes applied.")).toBe(
        "Outcome unavailable for this older run",
      );
      expect(terminalPresentationFor({ terminal: null, status })).toMatchObject({
        outcome: "unknown",
        tone: "unknown",
        message: "Outcome unavailable for this older run",
      });
    },
  );

  it("does not turn an active null-terminal task into a terminal", () => {
    expect(terminalPresentationFor({ terminal: null, status: "building" })).toBeNull();
    expect(terminalTaskStatus({ terminal: null, status: "building" }, "building")).toBe("building");
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

  it("never celebrates or refreshes for a cut-short response", () => {
    const interrupted = interruptedTerminal({
      schema: "zero-terminal-v1",
      outcome: "interrupted",
      runStatus: "interrupted",
      taskId: 15,
      intent: "answer",
      intentReceiptId: 23,
      completedAt: "2026-08-23T05:31:23.000Z",
      cause: "completion_truncated",
      evidence: { lastPhase: "response_stream", changedPaths: [] },
    });
    const receipt = parseTaskStreamReceipt(
      JSON.stringify({
        id: 10,
        taskId: 15,
        eventType: "completed",
        message: "legacy success",
        createdAt: "2026-08-23T05:31:23.000Z",
        terminal: interrupted,
      }),
      15,
    );

    expect(receipt).toMatchObject({
      terminal: true,
      event: {
        eventType: "cancelled",
        message: "Zero's response was cut short. Please try again.",
      },
      terminalPresentation: {
        tone: "interrupted",
        shouldRefreshPreview: false,
      },
    });
    expect(receipt.terminalPresentation?.message).not.toMatch(/response sent|finished|ready/i);
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

    const drawer = readFileSync(
      join(process.cwd(), "src/pages/projects/components/background-tasks-drawer.tsx"),
      "utf8",
    );
    expect(drawer).not.toContain('terminal?.message ?? "Changes applied."');

    const strictNullGuards: Record<string, string> = {
      "components/agent-thinking-bubble.tsx": "terminalNeedsAttention",
      "components/notifications-bell.tsx": 'n.type === "build_complete"',
      "pages/projects/components/activity-stream.tsx": "const statusText = isWarning",
      "pages/projects/components/chat-history.tsx": "const outcomeUnavailable",
      "pages/projects/components/inline-build-results.tsx": 'status: "completed"',
      "pages/projects/components/inline-run-recovery.tsx":
        'terminal?.tone === "warning" || terminal?.tone === "unknown"',
      "pages/projects/components/logs-tab.tsx":
        'const unavailable = taskTerminals.filter((terminal) => terminal?.tone === "unknown")',
      "pages/projects/components/queue-progress-strip.tsx":
        "Queue finished — some outcomes are unavailable",
      "pages/projects/components/task-queue-panel.tsx": "1 outcome unavailable",
    };
    for (const [relative, guard] of Object.entries(strictNullGuards)) {
      const source = readFileSync(join(process.cwd(), "src", relative), "utf8");
      expect(source, relative).toContain(guard);
    }
  });
});
