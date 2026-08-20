import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});
import {
  ZeroPromptQueueError,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueSnapshot,
} from "../lib/zero-prompt-queue-contract";
import {
  applyZeroPromptQueueMutation,
  createZeroPromptQueueSnapshot,
} from "../lib/zero-prompt-queue";
import { ZERO_PROMPT_QUEUE_USER_ERRORS } from "../lib/zero-prompt-queue-user-errors";
import { createTaskSteeringRouter, type TaskSteeringDependencies } from "./task-steering";

type EnqueueMutation = Extract<ZeroPromptQueueMutation, { kind: "enqueue" }>;

class MemorySteeringStore {
  snapshot: ZeroPromptQueueSnapshot = createZeroPromptQueueSnapshot("7");
  readonly mutations: EnqueueMutation[] = [];

  async list(): Promise<ZeroPromptQueueSnapshot> {
    return this.snapshot;
  }

  async enqueue(_projectId: number, mutation: EnqueueMutation) {
    this.mutations.push(mutation);
    const result = applyZeroPromptQueueMutation(this.snapshot, mutation);
    this.snapshot = result.snapshot;
    return result;
  }
}

const ownerOnly: RequestHandler = (req, res, next) => {
  if (req.params.id !== "7") {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  req.userId = "owner-7";
  next();
};

function app(input: {
  store?: TaskSteeringDependencies["store"];
  requireOwner?: RequestHandler;
  taskStatus?: string;
  ids?: string[];
}) {
  const ids = input.ids ?? ["item-1", "event-1", "item-2", "event-2"];
  const server = express();
  server.use(express.json());
  server.use(
    createTaskSteeringRouter({
      requireOwner: input.requireOwner ?? ownerOnly,
      store: input.store,
      loadTask: async (_projectId, taskId) => ({
        id: taskId,
        status: input.taskStatus ?? "building",
      }),
      createId: () => ids.shift() ?? "unexpected-id",
      now: () => "2026-08-20T00:00:00.000Z",
    }),
  );
  return server;
}

describe("task steering queue cutover", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("stores two hints as two ordered queue items and returns each durable identity", async () => {
    const store = new MemorySteeringStore();
    const server = app({ store });

    const first = await request(server)
      .post("/projects/7/tasks/42/steer")
      .send({ hint: "First update" });
    const second = await request(server)
      .post("/projects/7/tasks/42/steer")
      .send({ hint: "Second update" });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ itemId: "item-1", position: 1 });
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ itemId: "item-2", position: 2 });
    expect(store.snapshot.items).toEqual([
      expect.objectContaining({ id: "item-1", position: 1, currentText: "First update" }),
      expect.objectContaining({ id: "item-2", position: 2, currentText: "Second update" }),
    ]);
    expect(store.mutations.map((mutation) => mutation.provenance.actorId)).toEqual([
      "owner-7",
      "owner-7",
    ]);
  });

  it.each([
    [
      "queue_full",
      ZERO_PROMPT_QUEUE_USER_ERRORS.queue_full.status,
      ZERO_PROMPT_QUEUE_USER_ERRORS.queue_full.message,
    ],
    [
      "queue_position_invalid",
      ZERO_PROMPT_QUEUE_USER_ERRORS.queue_position_invalid.status,
      ZERO_PROMPT_QUEUE_USER_ERRORS.queue_position_invalid.message,
    ],
  ] as const)("returns the plain queue refusal for %s", async (code, status, message) => {
    const server = app({
      store: {
        list: async () => createZeroPromptQueueSnapshot("7"),
        enqueue: vi.fn(async () => {
          throw new ZeroPromptQueueError(code);
        }),
      },
    });

    const response = await request(server)
      .post("/projects/7/tasks/42/steer")
      .send({ hint: "Save this" });

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code, error: message });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|constraint|23505/i);
  });

  it("enforces the queue text bound with the existing plain refusal", async () => {
    const response = await request(app({ store: new MemorySteeringStore() }))
      .post("/projects/7/tasks/42/steer")
      .send({ hint: "x".repeat(10_001) });

    expect(response.status).toBe(ZERO_PROMPT_QUEUE_USER_ERRORS.queue_item_text_too_long.status);
    expect(response.body).toEqual({
      code: "queue_item_text_too_long",
      error: ZERO_PROMPT_QUEUE_USER_ERRORS.queue_item_text_too_long.message,
    });
  });

  it("preserves owner-only project scoping on the steer route", async () => {
    const store = new MemorySteeringStore();
    const response = await request(app({ store }))
      .post("/projects/8/tasks/42/steer")
      .send({ hint: "Wrong project" });

    expect(response.status).toBe(404);
    expect(store.snapshot.items).toEqual([]);
  });

  it("does not claim success when persistence returns no durable queue item", async () => {
    const response = await request(
      app({
        store: {
          list: async () => createZeroPromptQueueSnapshot("7"),
          enqueue: async (_projectId, mutation) => ({
            ...applyZeroPromptQueueMutation(createZeroPromptQueueSnapshot("7"), mutation),
            snapshot: createZeroPromptQueueSnapshot("7"),
          }),
        },
      }),
    )
      .post("/projects/7/tasks/42/steer")
      .send({ hint: "Save this" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "queue_persistence_contract_invalid",
      error: ZERO_PROMPT_QUEUE_USER_ERRORS.queue_persistence_contract_invalid.message,
    });
  });

  it("keeps terminal tasks closed without writing the queue", async () => {
    const store = new MemorySteeringStore();
    const response = await request(app({ store, taskStatus: "completed" }))
      .post("/projects/7/tasks/42/steer")
      .send({ hint: "Late update" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Build has already finished — prompts cannot be added to a completed task",
    });
    expect(store.snapshot.items).toEqual([]);
  });
});
