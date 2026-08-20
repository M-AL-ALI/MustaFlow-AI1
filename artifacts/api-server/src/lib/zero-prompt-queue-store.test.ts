import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

import {
  ZERO_PROMPT_QUEUE_MAX_ITEMS,
  ZeroPromptQueueError,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueMutationResult,
  type ZeroPromptQueueSnapshot,
} from "./zero-prompt-queue-contract";
import { createZeroPromptQueueSnapshot } from "./zero-prompt-queue";
import {
  ZERO_PROMPT_QUEUE_MAX_WRITE_STATEMENTS,
  ZeroPromptQueuePersistenceError,
  ZeroPromptQueueStore,
  type ZeroPromptQueuePersistenceDriver,
  type ZeroPromptQueuePersistenceTransaction,
} from "./zero-prompt-queue-store";

type QueueEvent = ZeroPromptQueueMutationResult["event"];

class MemoryQueueDriver implements ZeroPromptQueuePersistenceDriver {
  readonly snapshots = new Map<number, ZeroPromptQueueSnapshot>();
  readonly events: QueueEvent[] = [];
  readCount = 0;
  writeStatements = 0;
  nextPersistenceStatements = 1;

  async readProject(projectId: number): Promise<ZeroPromptQueueSnapshot> {
    this.readCount += 1;
    return this.snapshots.get(projectId) ?? createZeroPromptQueueSnapshot(String(projectId));
  }

  async transaction<T>(
    operation: (tx: ZeroPromptQueuePersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.snapshots);
    const eventCount = this.events.length;
    const writeCount = this.writeStatements;
    const tx: ZeroPromptQueuePersistenceTransaction = {
      readProject: (projectId) => this.readProject(projectId),
      persistMutation: async (projectId, _mutation, result) => {
        this.snapshots.set(projectId, result.snapshot);
        this.writeStatements += this.nextPersistenceStatements;
        return this.nextPersistenceStatements;
      },
      appendProvenance: async (_projectId, event, _references) => {
        this.events.push(event);
        this.writeStatements += 1;
        return 1;
      },
    };
    try {
      return await operation(tx);
    } catch (error) {
      this.snapshots.clear();
      for (const [projectId, snapshot] of before) this.snapshots.set(projectId, snapshot);
      this.events.length = eventCount;
      this.writeStatements = writeCount;
      throw error;
    }
  }
}

function provenance(index: number) {
  return {
    eventId: `event-${String(index).padStart(3, "0")}`,
    actorId: "owner-user",
    occurredAt: `2026-08-19T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

function enqueue(
  index: number,
  itemId: string,
  position: number,
  text = `Prompt ${itemId}`,
): Extract<ZeroPromptQueueMutation, { kind: "enqueue" }> {
  return {
    kind: "enqueue",
    order: index,
    itemId,
    projectId: "17",
    position,
    text,
    references: [],
    provenance: provenance(index),
  };
}

async function runRoundTrip(): Promise<{
  snapshot: ZeroPromptQueueSnapshot;
  events: readonly QueueEvent[];
}> {
  const driver = new MemoryQueueDriver();
  const store = new ZeroPromptQueueStore(driver);
  await store.enqueue(17, enqueue(1, "a", 1, "First draft"));
  await store.enqueue(17, enqueue(2, "b", 2, "Second draft"));
  await store.reorder(17, {
    kind: "reorder",
    order: 3,
    target: { kind: "queue-item", itemId: "b" },
    position: 1,
    provenance: provenance(3),
  });
  await store.edit(17, {
    kind: "edit",
    order: 4,
    target: { kind: "queue-item", itemId: "a" },
    text: "First final",
    provenance: provenance(4),
  });
  await store.delete(17, {
    kind: "delete",
    order: 5,
    target: { kind: "queue-item", itemId: "a" },
    deletedBy: "owner-user",
    provenance: provenance(5),
  });
  await store.promoteNext(17, {
    kind: "promote-next",
    order: 6,
    activeTurn: { kind: "active-turn", id: "turn-9", projectId: "17" },
    provenance: provenance(6),
  });
  return { snapshot: await store.list(17), events: [...driver.events] };
}

describe("zero prompt queue persistence", () => {
  it("round-trips all five mutations through one project-scoped adapter", async () => {
    const result = await runRoundTrip();
    expect(result.snapshot.items).toEqual([
      expect.objectContaining({
        id: "a",
        position: 1,
        currentText: "First final",
        state: "deleted",
        terminalEvidence: expect.objectContaining({ kind: "deleted", deletedBy: "owner-user" }),
      }),
      expect.objectContaining({
        id: "b",
        position: 2,
        state: "promoted",
        terminalEvidence: expect.objectContaining({ kind: "promoted", activeTurnId: "turn-9" }),
      }),
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      "queue.item.enqueued",
      "queue.item.enqueued",
      "queue.item.reordered",
      "queue.item.edited",
      "queue.item.deleted",
      "queue.item.promoted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "queue.item.edited",
      originalText: "First draft",
      currentText: "First final",
    });
  });

  it("keeps list and get metadata-only with zero writes", async () => {
    const driver = new MemoryQueueDriver();
    const store = new ZeroPromptQueueStore(driver);
    driver.snapshots.set(
      17,
      createZeroPromptQueueSnapshot("17", [
        {
          id: "a",
          projectId: "17",
          position: 1,
          currentText: "Read only",
          state: "queued",
          references: [],
          terminalEvidence: null,
        },
      ]),
    );
    expect((await store.get(17, "a")).currentText).toBe("Read only");
    expect((await store.list(17)).items).toHaveLength(1);
    expect(driver.readCount).toBe(2);
    expect(driver.writeStatements).toBe(0);
    expect(driver.events).toEqual([]);
  });

  it("emits exactly one existing-ledger provenance event for each mutation", async () => {
    const driver = new MemoryQueueDriver();
    const store = new ZeroPromptQueueStore(driver);
    await store.enqueue(17, enqueue(1, "a", 1));
    await store.edit(17, {
      kind: "edit",
      order: 2,
      target: { kind: "queue-item", itemId: "a" },
      text: "Edited",
      provenance: provenance(2),
    });
    expect(driver.events).toHaveLength(2);
    expect(driver.events[1]).toMatchObject({
      eventId: "event-002",
      projectId: "17",
      itemId: "a",
      originalText: "Prompt a",
    });
  });

  it("enforces queue and text bounds without leaving a partial write", async () => {
    const driver = new MemoryQueueDriver();
    const store = new ZeroPromptQueueStore(driver);
    for (let index = 1; index <= ZERO_PROMPT_QUEUE_MAX_ITEMS; index += 1) {
      await store.enqueue(17, enqueue(index, `item-${index}`, index));
    }
    const writesAtBound = driver.writeStatements;
    await expect(store.enqueue(17, enqueue(51, "overflow", 51))).rejects.toMatchObject({
      code: "queue_full",
    });
    await expect(
      new ZeroPromptQueueStore(new MemoryQueueDriver()).enqueue(
        17,
        enqueue(1, "long", 1, "x".repeat(10_001)),
      ),
    ).rejects.toMatchObject({ code: "queue_item_text_too_long" });
    expect(driver.writeStatements).toBe(writesAtBound);
    expect((await store.list(17)).items).toHaveLength(50);
  });

  it("fails typed and atomically if the fixed write-statement ceiling is exceeded", async () => {
    const driver = new MemoryQueueDriver();
    driver.nextPersistenceStatements = ZERO_PROMPT_QUEUE_MAX_WRITE_STATEMENTS;
    const store = new ZeroPromptQueueStore(driver);
    await expect(store.enqueue(17, enqueue(1, "a", 1))).rejects.toBeInstanceOf(
      ZeroPromptQueuePersistenceError,
    );
    await expect(store.list(17)).resolves.toMatchObject({ items: [] });
    expect(driver.events).toEqual([]);
  });

  it("replays the same inputs with byte-stable snapshot and provenance ordering", async () => {
    const first = await runRoundTrip();
    const second = await runRoundTrip();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps production persistence project-scoped, DB-clock owned, and on the existing ledger", () => {
    const production = readFileSync(
      new URL("./zero-prompt-queue-store.ts", import.meta.url),
      "utf8",
    );
    expect(production).toContain("FROM zero_prompt_queue_items q");
    expect(production).toContain("WHERE q.project_id = $1");
    expect(production).toContain("INSERT INTO project_activity");
    expect(production).not.toContain("zero_prompt_queue_provenance");
    expect(production).toContain("CURRENT_TIMESTAMP");
    expect(production).not.toContain("Date.now(");
  });

  it("keeps projects isolated and rejects invalid project identities", async () => {
    const driver = new MemoryQueueDriver();
    const store = new ZeroPromptQueueStore(driver);
    await store.enqueue(17, enqueue(1, "a", 1));
    expect((await store.list(18)).items).toEqual([]);
    await expect(async () => store.list(0)).rejects.toBeInstanceOf(ZeroPromptQueuePersistenceError);
    await expect(store.get(17, "missing")).rejects.toBeInstanceOf(ZeroPromptQueueError);
  });
});
