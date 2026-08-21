import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { emitTaskEventBounded, TASK_EVENT_EMIT_TIMEOUT_MS } from "./task-event-emission";
import { extractNamedFunction } from "./source-ast-test-helper";

describe("bounded task-event emission", () => {
  it("persists and publishes a normal event exactly once", async () => {
    const persist = vi.fn(async () => ({ id: 41 }));
    const publish = vi.fn();
    const recordDrop = vi.fn();

    await emitTaskEventBounded({ persist, publish, recordDrop });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ id: 41 });
    expect(recordDrop).not.toHaveBeenCalled();
  });

  it("continues the run after a hanging insert and records the timed-out observation", async () => {
    vi.useFakeTimers();
    try {
      let runContinued = false;
      const publish = vi.fn();
      const recordDrop = vi.fn();
      const emission = emitTaskEventBounded({
        persist: () => new Promise<never>(() => undefined),
        publish,
        recordDrop,
      }).then(() => {
        runContinued = true;
      });

      await vi.advanceTimersByTimeAsync(TASK_EVENT_EMIT_TIMEOUT_MS - 1);
      expect(runContinued).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(emission).resolves.toBeUndefined();
      expect(runContinued).toBe(true);
      expect(publish).not.toHaveBeenCalled();
      expect(recordDrop).toHaveBeenCalledWith({
        stage: "persist",
        reason: "timeout",
        timeoutMs: TASK_EVENT_EMIT_TIMEOUT_MS,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles a late insert rejection after timeout without failing the run", async () => {
    vi.useFakeTimers();
    try {
      let rejectInsert: ((error: Error) => void) | undefined;
      const recordDrop = vi.fn();
      const emission = emitTaskEventBounded({
        persist: () =>
          new Promise<never>((_resolve, reject) => {
            rejectInsert = reject;
          }),
        publish: vi.fn(),
        recordDrop,
      });

      await vi.advanceTimersByTimeAsync(TASK_EVENT_EMIT_TIMEOUT_MS);
      await expect(emission).resolves.toBeUndefined();
      rejectInsert?.(new Error("late database detail"));
      await Promise.resolve();

      expect(recordDrop).toHaveBeenCalledTimes(1);
      expect(recordDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "timeout", stage: "persist" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a sanitized failure and never exposes raw insert detail", async () => {
    const recordDrop = vi.fn();

    await expect(
      emitTaskEventBounded({
        persist: async () => Promise.reject(new TypeError("private database detail")),
        publish: vi.fn(),
        recordDrop,
      }),
    ).resolves.toBeUndefined();

    expect(recordDrop).toHaveBeenCalledWith({
      stage: "persist",
      reason: "failure",
      timeoutMs: TASK_EVENT_EMIT_TIMEOUT_MS,
      errorClass: "TypeError",
    });
    expect(JSON.stringify(recordDrop.mock.calls)).not.toContain("private database detail");
  });

  it("wires the task event insert and drop logger through the bounded helper", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const emitEventSource = extractNamedFunction(source, "emitEvent");

    expect(emitEventSource).toContain("await emitTaskEventBounded({");
    expect(emitEventSource).toContain("persist: async () =>");
    expect(emitEventSource).toContain('"Task event observation dropped"');
    expect(emitEventSource).not.toContain('"Failed to emit task event"');
  });

  it("routes mobile-settings observations through the same bounded helper", () => {
    const source = readFileSync(new URL("../routes/mobile-settings.ts", import.meta.url), "utf8");
    const emitEventSource = extractNamedFunction(source, "emitEvent");

    expect(emitEventSource).toContain("await emitTaskEventBounded({");
    expect(emitEventSource).toContain("persist: async () =>");
    expect(emitEventSource).toContain('"Mobile-settings task event observation dropped"');
    expect(emitEventSource).not.toContain('"Failed to emit mobile-settings task event"');
  });
});
