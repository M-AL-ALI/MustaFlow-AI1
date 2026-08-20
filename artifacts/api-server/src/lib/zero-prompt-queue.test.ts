import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ZERO_PROMPT_QUEUE_MAX_ITEMS,
  ZERO_PROMPT_QUEUE_SEMANTICS,
  ZeroPromptQueueError,
  type ZeroPromptQueueItem,
  type ZeroPromptQueueMutation,
} from "./zero-prompt-queue-contract";
import {
  applyZeroPromptQueueMutation,
  applyZeroPromptQueueOperations,
  createZeroPromptQueueSnapshot,
} from "./zero-prompt-queue";

const occurredAt = "2026-08-20T05:30:00.000Z";

function provenance(eventId: string) {
  return { eventId, actorId: "user-1", occurredAt };
}

type OperationInput = ZeroPromptQueueMutation extends infer Mutation
  ? Mutation extends ZeroPromptQueueMutation
    ? Omit<Mutation, "order" | "provenance"> & Partial<Pick<Mutation, "order" | "provenance">>
    : never
  : never;

function queueItem(id: string, position: number): ZeroPromptQueueItem {
  return {
    id,
    projectId: "project-52",
    position,
    currentText: `Prompt ${id}`,
    state: "queued",
    references: [],
    terminalEvidence: null,
  };
}

function operation(input: OperationInput): ZeroPromptQueueMutation {
  return { order: 1, provenance: provenance("event-1"), ...input } as ZeroPromptQueueMutation;
}

describe("Zero prompt queue decision engine", () => {
  it("enqueues at the caller-provided explicit priority and emits exactly one event", () => {
    const result = applyZeroPromptQueueMutation(
      createZeroPromptQueueSnapshot("project-52", [queueItem("a", 1)]),
      operation({
        kind: "enqueue",
        itemId: "b",
        projectId: "project-52",
        position: 1,
        text: "Build the hero",
        references: [],
      }),
    );
    expect(result.snapshot.items.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "b", position: 1 },
      { id: "a", position: 2 },
    ]);
    expect(result.event).toMatchObject({ type: "queue.item.enqueued", itemId: "b", position: 1 });
    expect(result.warnings).toEqual([]);
  });

  it("reorders by explicit integer priority and emits one advisory event", () => {
    const result = applyZeroPromptQueueMutation(
      createZeroPromptQueueSnapshot("project-52", [queueItem("a", 1), queueItem("b", 2)]),
      operation({ kind: "reorder", target: { kind: "queue-item", itemId: "b" }, position: 1 }),
    );
    expect(result.snapshot.items.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "b", position: 1 },
      { id: "a", position: 2 },
    ]);
    expect(result.event).toMatchObject({
      type: "queue.item.reordered",
      fromPosition: 2,
      toPosition: 1,
    });
  });

  it("edits without changing state or position and retains original text in provenance", () => {
    const before = queueItem("a", 1);
    const result = applyZeroPromptQueueMutation(
      createZeroPromptQueueSnapshot("project-52", [before]),
      operation({ kind: "edit", target: { kind: "queue-item", itemId: "a" }, text: "New text" }),
    );
    expect(result.snapshot.items[0]).toMatchObject({
      state: "queued",
      position: 1,
      currentText: "New text",
    });
    expect(result.event).toMatchObject({
      type: "queue.item.edited",
      originalText: before.currentText,
      currentText: "New text",
      position: 1,
    });
  });

  it("deletes into an evidenced terminal and keeps positions dense", () => {
    const result = applyZeroPromptQueueMutation(
      createZeroPromptQueueSnapshot("project-52", [queueItem("a", 1), queueItem("b", 2)]),
      operation({
        kind: "delete",
        target: { kind: "queue-item", itemId: "a" },
        deletedBy: "user-1",
      }),
    );
    expect(result.snapshot.items).toEqual([
      queueItem("b", 1),
      {
        ...queueItem("a", 2),
        state: "deleted",
        terminalEvidence: {
          kind: "deleted",
          deletedBy: "user-1",
          provenanceEventId: "event-1",
          occurredAt,
        },
      },
    ]);
    expect(result.event).toMatchObject({ type: "queue.item.deleted", deletedBy: "user-1" });
  });

  it("promotes the highest-priority item into a distinct active turn with terminal evidence", () => {
    const result = applyZeroPromptQueueMutation(
      createZeroPromptQueueSnapshot("project-52", [queueItem("a", 1), queueItem("b", 2)]),
      operation({
        kind: "promote-next",
        activeTurn: { kind: "active-turn", id: "turn-9", projectId: "project-52" },
      }),
    );
    expect(result.snapshot.items[1]).toMatchObject({
      id: "a",
      state: "promoted",
      terminalEvidence: { kind: "promoted", activeTurnId: "turn-9" },
    });
    expect(result.event).toMatchObject({
      type: "queue.item.promoted",
      itemId: "a",
      activeTurnId: "turn-9",
    });
  });

  it.each(["reorder", "edit", "delete"] as const)(
    "rejects an active turn addressed by %s as not being a queue item",
    (kind) => {
      const base = createZeroPromptQueueSnapshot("project-52", [queueItem("a", 1)]);
      const target = { kind: "active-turn", activeTurnId: "turn-1" } as const;
      const input =
        kind === "reorder"
          ? operation({ kind, target, position: 1 })
          : kind === "edit"
            ? operation({ kind, target, text: "Updated" })
            : operation({ kind, target, deletedBy: "user-1" });
      expect(() => applyZeroPromptQueueMutation(base, input)).toThrowError(
        expect.objectContaining({ code: "queue_active_turn_not_queue_item" }),
      );
    },
  );

  it("enforces empty-edit, text-length, queue-size, not-found, terminal, and position bounds", () => {
    const one = createZeroPromptQueueSnapshot("project-52", [queueItem("a", 1)]);
    expect(() =>
      applyZeroPromptQueueMutation(
        one,
        operation({ kind: "edit", target: { kind: "queue-item", itemId: "a" }, text: "  " }),
      ),
    ).toThrowError(expect.objectContaining({ code: "queue_edit_empty" }));
    expect(() =>
      applyZeroPromptQueueMutation(
        one,
        operation({
          kind: "edit",
          target: { kind: "queue-item", itemId: "a" },
          text: "x".repeat(10_001),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "queue_item_text_too_long" }));
    expect(() =>
      applyZeroPromptQueueMutation(
        one,
        operation({
          kind: "reorder",
          target: { kind: "queue-item", itemId: "missing" },
          position: 1,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "queue_item_not_found" }));
    expect(() =>
      applyZeroPromptQueueMutation(
        one,
        operation({ kind: "reorder", target: { kind: "queue-item", itemId: "a" }, position: 2 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "queue_position_invalid" }));

    const promoted = applyZeroPromptQueueMutation(
      one,
      operation({
        kind: "promote-next",
        activeTurn: { kind: "active-turn", id: "turn-1", projectId: "project-52" },
      }),
    ).snapshot;
    expect(() =>
      applyZeroPromptQueueMutation(
        promoted,
        operation({ kind: "edit", target: { kind: "queue-item", itemId: "a" }, text: "Again" }),
      ),
    ).toThrowError(expect.objectContaining({ code: "queue_item_terminal" }));

    const full = createZeroPromptQueueSnapshot(
      "project-52",
      Array.from({ length: ZERO_PROMPT_QUEUE_MAX_ITEMS }, (_, index) =>
        queueItem(`item-${index}`, index + 1),
      ),
    );
    expect(() =>
      applyZeroPromptQueueMutation(
        full,
        operation({
          kind: "enqueue",
          itemId: "overflow",
          projectId: "project-52",
          position: 51,
          text: "Overflow",
          references: [],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "queue_full" }));
  });

  it("is deterministic across snapshot and operation input ordering", () => {
    const snapshot = createZeroPromptQueueSnapshot("project-52", [
      queueItem("a", 1),
      queueItem("b", 2),
    ]);
    const operations: ZeroPromptQueueMutation[] = [
      operation({
        kind: "edit",
        target: { kind: "queue-item", itemId: "b" },
        text: "Edited",
        order: 2,
        provenance: provenance("event-2"),
      }),
      operation({
        kind: "reorder",
        target: { kind: "queue-item", itemId: "b" },
        position: 1,
        order: 1,
        provenance: provenance("event-1"),
      }),
    ];
    const forward = applyZeroPromptQueueOperations(snapshot, operations);
    const reversed = applyZeroPromptQueueOperations(
      { ...snapshot, items: [...snapshot.items].reverse() },
      [...operations].reverse(),
    );
    expect(reversed).toEqual(forward);
    expect(forward.events).toHaveLength(2);
  });

  it("contains no runtime I/O, ambient clock, scoring, or user-prose emission path", async () => {
    const source = await readFile(new URL("./zero-prompt-queue.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:fs|fetch\(|Date\.now|new Date|Math\.random|score|weight/i);
    expect(source).not.toMatch(/message\s*:/);
    expect(source).toContain("operation.position");
  });

  it("returns only the declared semantics and JSON-safe closed result fields", () => {
    const result = applyZeroPromptQueueMutation(
      createZeroPromptQueueSnapshot("project-52"),
      operation({
        kind: "enqueue",
        itemId: "a",
        projectId: "project-52",
        position: 1,
        text: "Prompt a",
        references: [],
      }),
    );
    expect(result.snapshot.semantics).toBe(ZERO_PROMPT_QUEUE_SEMANTICS);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(ZeroPromptQueueError).toBeTypeOf("function");
  });
});
