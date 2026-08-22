import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { interruptedTerminal, mutationSucceededTerminal } from "@workspace/ora-contracts";

const mocks = vi.hoisted(() => ({
  taskSets: [] as Array<Record<string, unknown>>,
  eventValues: [] as Array<Record<string, unknown>>,
  publish: vi.fn(),
  returnTask: true,
}));

vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
}));

vi.mock("@workspace/db", () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        mocks.taskSets.push(value);
        return {
          where: () => ({
            returning: async () => (mocks.returnTask ? [{ id: 41 }] : []),
          }),
        };
      },
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        mocks.eventValues.push(value);
        return {
          returning: async () => [
            {
              id: 7,
              taskId: value.taskId,
              eventType: value.eventType,
              message: value.message,
              filePath: value.filePath,
              data: value.data,
              createdAt: value.createdAt,
            },
          ],
        };
      },
    }),
  };
  return {
    agentTasksTable: { id: "id", status: "status" },
    taskEventsTable: { id: "id", taskId: "taskId", eventType: "eventType" },
    db: { transaction: (run: (value: typeof tx) => unknown) => run(tx) },
  };
});

vi.mock("./event-bus", () => ({ publishTaskEvent: mocks.publish }));

import { persistZeroTerminal } from "./zero-terminal-persistence";

describe("B3b terminal honesty flip", () => {
  beforeEach(() => {
    mocks.taskSets.length = 0;
    mocks.eventValues.length = 0;
    mocks.publish.mockReset();
    mocks.returnTask = true;
  });

  it("writes the identical terminal into the task and its one terminal event", async () => {
    const terminal = mutationSucceededTerminal({
      schema: "zero-terminal-v1",
      taskId: 41,
      intent: "mutate",
      intentReceiptId: 19,
      completedAt: "2026-08-22T12:00:00.000Z",
      outcome: "mutation_succeeded",
      runStatus: "completed",
      evidence: {
        versionId: 88,
        diffRef: { kind: "task_report", taskId: 41, revision: 1 },
        preview: { promised: true, state: "ready", receiptId: "version:88" },
      },
    });

    await expect(persistZeroTerminal({ terminal, allowedStatuses: ["building"] })).resolves.toBe(
      true,
    );
    expect(mocks.taskSets).toHaveLength(1);
    expect(mocks.eventValues).toHaveLength(1);
    expect(mocks.taskSets[0]?.terminal).toBe(terminal);
    expect(mocks.eventValues[0]?.data).toBe(terminal);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("records an interrupted foreground mutation once and never calls it success", async () => {
    const terminal = interruptedTerminal({
      schema: "zero-terminal-v1",
      taskId: 52,
      intent: "mutate",
      intentReceiptId: 23,
      completedAt: "2026-08-22T12:01:00.000Z",
      outcome: "interrupted",
      runStatus: "interrupted",
      cause: "user_stop",
      evidence: { lastPhase: "agent_loop", changedPaths: [] },
    });

    await persistZeroTerminal({ terminal, allowedStatuses: ["building"] });
    expect(mocks.eventValues).toHaveLength(1);
    expect(mocks.eventValues[0]).toMatchObject({
      eventType: "cancelled",
      message: "This run was interrupted.",
      data: terminal,
    });
    expect(JSON.stringify(mocks.taskSets)).not.toContain("mutation_succeeded");
  });

  it("does not emit a terminal event when the compare-and-set loses", async () => {
    mocks.returnTask = false;
    const terminal = interruptedTerminal({
      schema: "zero-terminal-v1",
      taskId: 53,
      intent: "mutate",
      intentReceiptId: 24,
      completedAt: "2026-08-22T12:02:00.000Z",
      outcome: "interrupted",
      runStatus: "interrupted",
      cause: "superseded",
      evidence: { lastPhase: null, changedPaths: [] },
    });
    await expect(persistZeroTerminal({ terminal })).resolves.toBe(false);
    expect(mocks.eventValues).toHaveLength(0);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("removes manufactured success prose and routes every projection through terminal truth", () => {
    const messages = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");
    const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const agentLoop = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");
    const mobile = readFileSync(new URL("../routes/mobile-settings.ts", import.meta.url), "utf8");
    const rollback = readFileSync(new URL("../routes/versions.ts", import.meta.url), "utf8");
    const snapshot = readFileSync(
      new URL("../routes/snapshot-observe.ts", import.meta.url),
      "utf8",
    );
    const drawer = readFileSync(
      new URL(
        "../../../mustaflow/src/pages/projects/components/background-tasks-drawer.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const dormant = readFileSync(new URL("./dormant-exports.json", import.meta.url), "utf8");
    const allRuntime = `${messages}\n${jobs}`;

    for (const forbidden of [
      "I generated your app",
      "I applied your changes",
      "Refresh the Preview tab",
    ]) {
      expect(allRuntime).not.toContain(forbidden);
    }
    expect(messages).not.toContain('kind: "task-done"');
    expect(messages).toContain("presentPersistedZeroTerminal(refreshed?.terminal)");
    expect(agentLoop).toContain("observation: AgentLoopObservation");
    expect(agentLoop).not.toContain("Built ${allFiles.length}");
    expect(jobs).toContain('code: "version_receipt_missing"');
    expect(jobs).not.toContain("your changes are still applied");
    expect(jobs).toContain(
      "Quality checks need attention before the staged changes can be applied.",
    );
    expect(jobs).toContain(
      "Staged changes are ready for review. Apply or discard them to finish this run.",
    );
    expect(jobs).toContain("terminalRef: zeroTerminalRef(terminal)");
    expect(mobile).toContain("versionId: committed.versionId");
    expect(rollback).toContain("terminal: rollbackTerminal");
    expect(snapshot.indexOf(".insert(chatMessagesTable)")).toBeLessThan(
      snapshot.indexOf("persistZeroTerminal({ terminal, allowedStatuses"),
    );
    expect(snapshot).toContain("terminalRef: zeroTerminalRef(terminal)");
    expect(jobs).toContain("report.terminalRef = zeroTerminalRef(terminal)");
    expect(jobs).toContain("persistInterruptedZeroTerminal({");
    expect(drawer).toContain('terminalTaskMessage(task, task.result ?? "")');
    expect(dormant).not.toContain("terminalTaskMessage");
  });
});
