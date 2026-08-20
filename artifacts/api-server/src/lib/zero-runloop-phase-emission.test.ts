import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS } from "./zero-prompt-queue-boundary-contract";
import {
  emitZeroRunLoopPhase,
  ZERO_RUN_LOOP_EMITTABLE_PHASES,
  ZERO_RUN_LOOP_PHASE_EMIT_TIMEOUT_MS,
  ZERO_RUN_LOOP_PHASE_EVENT_TYPE,
} from "./zero-runloop-phase-emission";

const AGENT_LOOP_PHASES = [
  "between_steps",
  "createChatCompletion",
  "parallel_tool_batch",
  "serial_tool_call",
  "executeSingleFileWrite",
  "executeBatchFileWrite",
  "finalize_check",
  "auto_check",
  "post_loop_check",
  "e2e_smoke",
  "e2e_auto_fix",
] as const;

function quotedOccurrenceCount(source: string, value: string): number {
  return source.split(`"${value}"`).length - 1;
}

describe("Zero run-loop phase emission", () => {
  it("derives the emittable set from the closed boundary vocabulary", () => {
    expect(ZERO_RUN_LOOP_EMITTABLE_PHASES).toEqual([
      ...AGENT_LOOP_PHASES,
      "project_files_commit",
      "runPostWriteMigrationSync",
    ]);
    expect(ZERO_RUN_LOOP_EMITTABLE_PHASES).not.toContain("production_publish");
  });

  it.each(ZERO_RUN_LOOP_EMITTABLE_PHASES)(
    "emits %s exactly once through the existing two-field event envelope",
    async (phase) => {
      const sink = vi.fn();

      await emitZeroRunLoopPhase(sink, phase);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]).toHaveLength(2);
      expect(sink).toHaveBeenCalledWith(
        ZERO_RUN_LOOP_PHASE_EVENT_TYPE,
        JSON.stringify({
          semantics: ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
          phase,
        }),
      );
    },
  );

  it("never throws into the run loop when observation delivery fails", async () => {
    await expect(
      emitZeroRunLoopPhase(() => {
        throw new Error("synchronous observation failure");
      }, "between_steps"),
    ).resolves.toBeUndefined();

    await expect(
      emitZeroRunLoopPhase(
        async () => Promise.reject(new Error("asynchronous observation failure")),
        "between_steps",
      ),
    ).resolves.toBeUndefined();
  });

  it("drops a hanging observation at the bounded deadline without retaining a timer", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const emission = emitZeroRunLoopPhase(
        () => new Promise<void>(() => undefined),
        "between_steps",
      ).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(ZERO_RUN_LOOP_PHASE_EMIT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(emission).resolves.toBeUndefined();
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires every in-loop phase once at its declared source point", () => {
    const source = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");

    for (const phase of AGENT_LOOP_PHASES) {
      expect(quotedOccurrenceCount(source, phase), phase).toBe(1);
    }
    expect(source).toContain('"loop:step"');
    expect(source).toContain("stepIndex: toolCalls.length + 1");
  });

  it("wires commit and migration phases without claiming production publish", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");

    expect(quotedOccurrenceCount(source, "project_files_commit")).toBe(5);
    expect(quotedOccurrenceCount(source, "runPostWriteMigrationSync")).toBe(1);
    expect(quotedOccurrenceCount(source, "production_publish")).toBe(0);
  });

  it("does not announce migration work when there are no migration files", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const functionStart = source.indexOf("async function runPostWriteMigrationSync(");
    const fileSelection = source.indexOf("const drizzleFiles = files.filter(", functionStart);
    const noWorkReturn = source.indexOf(
      "if (drizzleFiles.length === 0) return { ok: true };",
      functionStart,
    );
    const phaseEmission = source.indexOf('"runPostWriteMigrationSync"', functionStart);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(fileSelection).toBeGreaterThan(functionStart);
    expect(noWorkReturn).toBeGreaterThan(fileSelection);
    expect(phaseEmission).toBeGreaterThan(noWorkReturn);
  });
});
