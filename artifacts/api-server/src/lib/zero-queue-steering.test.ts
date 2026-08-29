import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

import {
  ZERO_PROMPT_QUEUE_SEMANTICS,
  ZeroPromptQueueError,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueMutationResult,
  type ZeroPromptQueueSnapshot,
} from "./zero-prompt-queue-contract";
import { createZeroPromptQueueSnapshot } from "./zero-prompt-queue";
import {
  ZeroPromptQueueStore,
  type ZeroPromptQueuePersistenceDriver,
  type ZeroPromptQueuePersistenceTransaction,
} from "./zero-prompt-queue-store";
import {
  applyZeroSteeringAtBoundary,
  promoteQueuedSteeringAtBoundary,
  ZERO_QUEUE_STEERING_PROMOTION_TIMEOUT_MS,
  type ZeroQueuePromoteNext,
} from "./zero-queue-steering";

type PromoteMutation = Extract<ZeroPromptQueueMutation, { kind: "promote-next" }>;

function queuedSnapshot(): ZeroPromptQueueSnapshot {
  return createZeroPromptQueueSnapshot("7", [
    {
      id: "queue-1",
      projectId: "7",
      position: 1,
      currentText: "Queue update",
      state: "queued",
      references: [],
      terminalEvidence: null,
    },
  ]);
}

function promotedResult(mutation: PromoteMutation): ZeroPromptQueueMutationResult {
  const item = queuedSnapshot().items[0]!;
  return {
    snapshot: createZeroPromptQueueSnapshot("7", [
      {
        ...item,
        state: "promoted",
        terminalEvidence: {
          kind: "promoted",
          activeTurnId: mutation.activeTurn.id,
          provenanceEventId: mutation.provenance.eventId,
          occurredAt: mutation.provenance.occurredAt,
        },
      },
    ]),
    event: {
      semantics: ZERO_PROMPT_QUEUE_SEMANTICS,
      eventId: mutation.provenance.eventId,
      projectId: "7",
      itemId: item.id,
      actorId: mutation.provenance.actorId,
      occurredAt: mutation.provenance.occurredAt,
      type: "queue.item.promoted",
      fromPosition: 1,
      activeTurnId: mutation.activeTurn.id,
    },
    warnings: [],
  };
}

class RollbackMemoryDriver implements ZeroPromptQueuePersistenceDriver {
  snapshot = queuedSnapshot();

  constructor(private readonly failure: "throw" | "hang-until-abort") {}

  async readProject(): Promise<ZeroPromptQueueSnapshot> {
    return this.snapshot;
  }

  async readItem() {
    return null;
  }

  async transaction<T>(
    operation: (tx: ZeroPromptQueuePersistenceTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let staged = this.snapshot;
    const tx: ZeroPromptQueuePersistenceTransaction = {
      readProject: async () => staged,
      persistMutation: async (_projectId, _mutation, result) => {
        staged = result.snapshot;
        return 1;
      },
      appendProvenance: async () => {
        if (this.failure === "throw") throw new Error("persistence failed");
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("promotion aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("promotion aborted")), {
            once: true,
          });
        });
        return 1;
      },
    };
    const result = await operation(tx);
    if (signal?.aborted) throw new Error("promotion aborted");
    this.snapshot = staged;
    return result;
  }
}

const deterministic = {
  createEventId: () => "event-queue-1",
  occurredAt: () => "2026-08-20T00:00:00.000Z",
};

describe("queue-backed steering at the declared boundary", () => {
  it("applies one queued prompt through the existing injection callback", async () => {
    const order: string[] = [];
    const promoteNext: ZeroQueuePromoteNext = async (_projectId, mutation) => {
      order.push("promote-queue");
      return promotedResult(mutation);
    };

    const receipt = await applyZeroSteeringAtBoundary({
      projectId: 7,
      taskId: 42,
      actorId: "owner-7",
      inject: async (text) => {
        order.push(`inject:${text}`);
      },
      promoteNext,
      ...deterministic,
    });

    expect(order).toEqual(["promote-queue", "inject:Queue update"]);
    expect(receipt).toEqual({
      kind: "promoted",
      itemId: "queue-1",
      text: "Queue update",
      assetIds: [],
      activeTurnId: "42",
    });
  });

  it("records the running task and project as the promoted active-turn identity", async () => {
    let observed: { projectId: number; mutation: PromoteMutation } | undefined;
    const promoteNext: ZeroQueuePromoteNext = async (projectId, mutation) => {
      observed = { projectId, mutation };
      return promotedResult(mutation);
    };

    await promoteQueuedSteeringAtBoundary({
      projectId: 7,
      taskId: 42,
      actorId: "owner-7",
      promoteNext,
      ...deterministic,
    });

    expect(observed).toEqual({
      projectId: 7,
      mutation: {
        kind: "promote-next",
        order: 1,
        activeTurn: { kind: "active-turn", id: "42", projectId: "7" },
        provenance: {
          eventId: "event-queue-1",
          actorId: "owner-7",
          occurredAt: "2026-08-20T00:00:00.000Z",
        },
      },
    });
  });

  it("is silent when the queue has nothing to promote", async () => {
    const inject = vi.fn();
    const receipt = await applyZeroSteeringAtBoundary({
      projectId: 7,
      taskId: 42,
      actorId: "owner-7",
      inject,
      promoteNext: async () => {
        throw new ZeroPromptQueueError("queue_item_not_found");
      },
      ...deterministic,
    });

    expect(receipt).toEqual({ kind: "empty" });
    expect(inject).not.toHaveBeenCalled();
  });

  it("drops a hanging adapter at the bounded deadline and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      let settled = false;
      const promotion = promoteQueuedSteeringAtBoundary({
        projectId: 7,
        taskId: 42,
        actorId: "owner-7",
        promoteNext: async (_projectId, _mutation, signal) => {
          observedSignal = signal;
          return new Promise<ZeroPromptQueueMutationResult>(() => undefined);
        },
        ...deterministic,
      }).then((receipt) => {
        settled = true;
        return receipt;
      });

      await vi.advanceTimersByTimeAsync(ZERO_QUEUE_STEERING_PROMOTION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(promotion).resolves.toEqual({ kind: "delayed" });
      expect(observedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["throw", "hang-until-abort"] as const)(
    "keeps the item queued when the transactional adapter ends by %s",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const driver = new RollbackMemoryDriver(failure);
        const store = new ZeroPromptQueueStore(driver);
        const promotion = promoteQueuedSteeringAtBoundary({
          projectId: 7,
          taskId: 42,
          actorId: "owner-7",
          promoteNext: (projectId, mutation, signal) =>
            store.promoteNext(projectId, mutation, signal),
          ...deterministic,
        });

        if (failure === "hang-until-abort") {
          await vi.advanceTimersByTimeAsync(ZERO_QUEUE_STEERING_PROMOTION_TIMEOUT_MS);
        }
        await expect(promotion).resolves.toEqual({ kind: "delayed" });
        await Promise.resolve();

        expect(driver.snapshot.items).toEqual([
          expect.objectContaining({ id: "queue-1", state: "queued", terminalEvidence: null }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("is wired once before between_steps and never inside a tool-call batch", () => {
    const source = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");
    const boundaryCall = "await applyZeroSteeringAtBoundary({";
    const boundaryIndex = source.indexOf(boundaryCall);
    const betweenStepsIndex = source.indexOf(
      'await emitZeroRunLoopPhase(input.onEvent, "between_steps")',
    );
    const parallelBatchIndex = source.indexOf('"parallel_tool_batch"');
    const serialToolIndex = source.indexOf('"serial_tool_call"');

    expect(source.split(boundaryCall)).toHaveLength(2);
    expect(boundaryIndex).toBeLessThan(betweenStepsIndex);
    expect(boundaryIndex).toBeLessThan(parallelBatchIndex);
    expect(boundaryIndex).toBeLessThan(serialToolIndex);
  });

  it("passes the non-null project owner into every production loop invocation", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    expect(source.split("queuePromotionActorId: project.ownerId")).toHaveLength(4);
  });

  it("has no reachable legacy single-slot store", () => {
    const legacyStore = new URL("./steering-hints.ts", import.meta.url);
    const loopSource = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");
    const routeSource = readFileSync(
      new URL("../routes/task-steering.ts", import.meta.url),
      "utf8",
    );
    const verificationSource = readFileSync(
      new URL("../verify-phase2g.ts", import.meta.url),
      "utf8",
    );

    expect(existsSync(legacyStore)).toBe(false);
    expect(loopSource).not.toContain("consumeSteeringHint");
    expect(routeSource).not.toContain("setSteeringHint");
    expect(verificationSource).not.toContain("steering-hints");
  });
});
