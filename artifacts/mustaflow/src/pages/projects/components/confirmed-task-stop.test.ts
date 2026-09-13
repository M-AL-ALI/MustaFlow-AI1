import { describe, expect, it, vi } from "vitest";
import { requestConfirmedTaskStop } from "./confirmed-task-stop";

function callbacks() {
  return {
    projectId: 7,
    taskId: 42,
    runGeneration: 1,
    currentScope: () => ({ projectId: 7, taskId: 42, runGeneration: 1 }),
    onConfirmed: vi.fn(),
    onUnconfirmed: vi.fn(),
  };
}

describe("confirmed task stop", () => {
  it("keeps the feed open while pending and only confirms after the server responds", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const state = callbacks();
    const cancel = vi.fn(() => pending);
    const operation = requestConfirmedTaskStop({ ...state, cancel });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: 7, taskId: 42 });
    expect(state.onConfirmed).not.toHaveBeenCalled();
    expect(state.onUnconfirmed).not.toHaveBeenCalled();
    resolve();
    await operation;
    expect(state.onConfirmed).toHaveBeenCalledTimes(1);
    expect(state.onUnconfirmed).not.toHaveBeenCalled();
  });

  it.each([404, 409, 503, "network failure"])(
    "does not close the feed or claim cancellation after %s",
    async (failure) => {
      const state = callbacks();
      await requestConfirmedTaskStop({ ...state, cancel: vi.fn().mockRejectedValue(failure) });
      expect(state.onConfirmed).not.toHaveBeenCalled();
      expect(state.onUnconfirmed).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { projectId: 8, taskId: 42, runGeneration: 1 },
    { projectId: 7, taskId: 43, runGeneration: 1 },
  ])("does not let an old response change another project or run: %j", async (scope) => {
    const state = callbacks();
    for (const cancel of [vi.fn().mockResolvedValue({}), vi.fn().mockRejectedValue(404)]) {
      await requestConfirmedTaskStop({ ...state, cancel, currentScope: () => scope });
    }
    expect(state.onConfirmed).not.toHaveBeenCalled();
    expect(state.onUnconfirmed).not.toHaveBeenCalled();
  });

  it("reconciles an acknowledged stop when polling already cleared the active task", async () => {
    const state = callbacks();
    await requestConfirmedTaskStop({
      ...state,
      cancel: vi.fn().mockResolvedValue({}),
      currentScope: () => ({ projectId: 7, taskId: null, runGeneration: 1 }),
    });
    expect(state.onConfirmed).toHaveBeenCalledTimes(1);
  });

  it.each(["confirmed", "rejected"] as const)(
    "ignores a delayed %s response after a new run starts without a task id",
    async (outcome) => {
      const state = callbacks();
      let scope: { projectId: number; taskId: number | null; runGeneration: number } = {
        projectId: 7,
        taskId: 42,
        runGeneration: 1,
      };
      let settle!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        settle = () => (outcome === "confirmed" ? resolve() : reject(new Error("Late failure")));
      });
      const operation = requestConfirmedTaskStop({
        ...state,
        cancel: () => pending,
        currentScope: () => scope,
      });
      scope = { projectId: 7, taskId: null, runGeneration: 2 };
      settle();
      await operation;
      expect(state.onConfirmed).not.toHaveBeenCalled();
      expect(state.onUnconfirmed).not.toHaveBeenCalled();
    },
  );

  it.each([
    { projectId: 7, taskId: 42, runGeneration: 2 },
    { projectId: 7, taskId: null, runGeneration: 3 },
  ])("ignores an earlier generation even when project/task values recur: %j", async (scope) => {
    const state = callbacks();
    for (const cancel of [vi.fn().mockResolvedValue({}), vi.fn().mockRejectedValue(503)]) {
      await requestConfirmedTaskStop({ ...state, cancel, currentScope: () => scope });
    }
    expect(state.onConfirmed).not.toHaveBeenCalled();
    expect(state.onUnconfirmed).not.toHaveBeenCalled();
  });
});
