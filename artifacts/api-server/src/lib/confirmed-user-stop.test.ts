import { describe, expect, it } from "vitest";
import { hasConfirmedUserStop } from "./confirmed-user-stop";

const terminal = {
  schema: "zero-terminal-v1",
  taskId: 42,
  intent: "mutate",
  intentReceiptId: 67,
  completedAt: "2026-09-13T00:00:00.000Z",
  outcome: "interrupted",
  runStatus: "interrupted",
  cause: "user_stop",
  evidence: { lastPhase: "agent_loop", changedPaths: [] },
};
const task = { id: 42, projectId: 7, status: "canceled", intentReceiptId: 67, terminal };
const expected = { projectId: 7, taskId: 42 };

describe("confirmed user Stop receipts", () => {
  it("recognizes the exact durable Stop without modifying the receipt", () => {
    const before = JSON.stringify(task);
    expect(hasConfirmedUserStop(task, expected)).toBe(true);
    expect(JSON.stringify(task)).toBe(before);
  });

  it.each([
    { id: 43 },
    { projectId: 8 },
    { status: "completed" },
    { status: "building" },
    { intentReceiptId: null },
    { intentReceiptId: 0 },
    { intentReceiptId: 68 },
    { terminal: null },
    { terminal: { outcome: "interrupted", cause: "user_stop" } },
    { terminal: { ...terminal, taskId: 43 } },
    { terminal: { ...terminal, intentReceiptId: 68 } },
    { terminal: { ...terminal, cause: "client_disconnect" } },
    { terminal: { ...terminal, cause: "superseded" } },
    { terminal: { ...terminal, schema: "unknown" } },
    { terminal: { ...terminal, completedAt: "" } },
  ])("rejects an unrelated, non-user, or malformed receipt: %j", (change) => {
    expect(hasConfirmedUserStop({ ...task, ...change }, expected)).toBe(false);
  });

  it("does not treat a missing task as success", () => {
    expect(hasConfirmedUserStop(null, expected)).toBe(false);
    expect(hasConfirmedUserStop(undefined, expected)).toBe(false);
  });
});
