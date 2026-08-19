import { describe, expect, it } from "vitest";
import { parseTaskStreamReceipt } from "./use-task-event-stream";

function frame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 19,
    taskId: 255,
    eventType: "file_diff",
    message: "saved",
    filePath: "index.html",
    createdAt: "2026-08-19T18:00:00.000Z",
    ...overrides,
  });
}

describe("task stream receipts", () => {
  it.each(["completed", "failed", "cancelled"])(
    "recognizes a replayed %s terminal receipt",
    (eventType) => {
      expect(parseTaskStreamReceipt(frame({ eventType }), 255)).toMatchObject({
        event: { id: 19, taskId: 255, eventType },
        terminal: true,
      });
    },
  );

  it("accepts a matching nonterminal receipt without calling it terminal", () => {
    expect(parseTaskStreamReceipt(frame(), 255)).toMatchObject({
      event: { id: 19, taskId: 255, eventType: "file_diff" },
      terminal: false,
    });
  });

  it("rejects empty, malformed, and task-mismatched responses", () => {
    expect(parseTaskStreamReceipt("", 255)).toBeNull();
    expect(parseTaskStreamReceipt("{}", 255)).toBeNull();
    expect(parseTaskStreamReceipt(frame({ taskId: 254 }), 255)).toBeNull();
    expect(parseTaskStreamReceipt(frame({ id: -1 }), 255)).toBeNull();
  });
});
