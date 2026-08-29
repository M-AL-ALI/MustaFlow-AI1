import { describe, expect, it, vi } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

import {
  ZERO_PROMPT_QUEUE_SEMANTICS,
  ZeroPromptQueueError,
  type ZeroPromptQueueItem,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueMutationResult,
  type ZeroPromptQueueSnapshot,
} from "../lib/zero-prompt-queue-contract";
import { ZeroPromptQueuePersistenceError } from "../lib/zero-prompt-queue-store";
import { ZERO_PROMPT_QUEUE_USER_ERRORS } from "../lib/zero-prompt-queue-user-errors";
import { createZeroPromptQueueRouter } from "./zero-prompt-queue";

const OWNER_ONE = "owner-one";
const OWNER_TWO = "owner-two";

function queuedItem(id = "item-1", position = 1): ZeroPromptQueueItem {
  return {
    id,
    projectId: "1",
    position,
    currentText: `Prompt ${id}`,
    state: "queued",
    references: [],
    terminalEvidence: null,
  };
}

function snapshot(items: readonly ZeroPromptQueueItem[] = [queuedItem()]): ZeroPromptQueueSnapshot {
  return { semantics: ZERO_PROMPT_QUEUE_SEMANTICS, projectId: "1", items };
}

function mutationResult(): ZeroPromptQueueMutationResult {
  return {
    snapshot: snapshot(),
    event: {
      semantics: ZERO_PROMPT_QUEUE_SEMANTICS,
      eventId: "event-result",
      projectId: "1",
      itemId: "item-1",
      actorId: OWNER_ONE,
      occurredAt: "2026-08-20T00:00:00.000Z",
      type: "queue.item.enqueued",
      position: 1,
      currentText: "Prompt item-1",
    },
    warnings: [],
  };
}

class TestQueueStore {
  async list(_projectId: number): Promise<ZeroPromptQueueSnapshot> {
    return snapshot();
  }

  async get(_projectId: number, _itemId: string): Promise<ZeroPromptQueueItem> {
    return queuedItem();
  }

  async enqueue(
    _projectId: number,
    _mutation: Extract<ZeroPromptQueueMutation, { kind: "enqueue" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return mutationResult();
  }

  async reorder(
    _projectId: number,
    _mutation: Extract<ZeroPromptQueueMutation, { kind: "reorder" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return mutationResult();
  }

  async edit(
    _projectId: number,
    _mutation: Extract<ZeroPromptQueueMutation, { kind: "edit" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return mutationResult();
  }

  async delete(
    _projectId: number,
    _mutation: Extract<ZeroPromptQueueMutation, { kind: "delete" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return mutationResult();
  }

  async promoteNext(
    _projectId: number,
    _mutation: Extract<ZeroPromptQueueMutation, { kind: "promote-next" }>,
  ): Promise<ZeroPromptQueueMutationResult> {
    return mutationResult();
  }
}

const requireOwner: RequestHandler = (req, res, next) => {
  const userId = req.header("x-test-user");
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  req.userId = userId;
  const owner = Number(req.params.id) === 1 ? OWNER_ONE : OWNER_TWO;
  if (owner !== userId) {
    res.status(403).json({ error: "You do not have access to this project" });
    return;
  }
  next();
};

function buildApp(store = new TestQueueStore()) {
  let nextId = 0;
  const assertAssets = vi.fn(async () => undefined);
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(
    createZeroPromptQueueRouter({
      store,
      requireOwner,
      createId: () => `server-id-${++nextId}`,
      now: () => "2026-08-20T00:00:00.000Z",
      assertAssets,
    }),
  );
  return { app, store, assertAssets };
}

describe("Zero prompt queue governed API", () => {
  it("requires authentication before reading the queue", async () => {
    const { app, store } = buildApp();
    const list = vi.spyOn(store, "list");

    const response = await request(app).get("/projects/1/prompt-queue");

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("denies every route when the caller does not own the addressed project", async () => {
    const { app, store } = buildApp();
    const calls = [
      vi.spyOn(store, "list"),
      vi.spyOn(store, "get"),
      vi.spyOn(store, "enqueue"),
      vi.spyOn(store, "reorder"),
      vi.spyOn(store, "edit"),
      vi.spyOn(store, "delete"),
      vi.spyOn(store, "promoteNext"),
    ];
    const attempts = [
      request(app).get("/projects/2/prompt-queue"),
      request(app).get("/projects/2/prompt-queue/item-1"),
      request(app).post("/projects/2/prompt-queue").send({ position: 1, text: "Next" }),
      request(app).patch("/projects/2/prompt-queue/item-1/position").send({ position: 1 }),
      request(app).patch("/projects/2/prompt-queue/item-1").send({ text: "Changed" }),
      request(app).delete("/projects/2/prompt-queue/item-1"),
      request(app).post("/projects/2/prompt-queue/promote-next").send({ activeTurnId: "turn-1" }),
    ];

    const responses = await Promise.all(
      attempts.map((attempt) => attempt.set("x-test-user", OWNER_ONE)),
    );

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403,
    ]);
    expect(calls.every((call) => call.mock.calls.length === 0)).toBe(true);
  });

  it("scopes all seven adapter methods to the owned project", async () => {
    const { app, store } = buildApp();
    const list = vi.spyOn(store, "list");
    const get = vi.spyOn(store, "get");
    const enqueue = vi.spyOn(store, "enqueue");
    const reorder = vi.spyOn(store, "reorder");
    const edit = vi.spyOn(store, "edit");
    const remove = vi.spyOn(store, "delete");
    const promoteNext = vi.spyOn(store, "promoteNext");
    const owner = { "x-test-user": OWNER_ONE };

    expect((await request(app).get("/projects/1/prompt-queue").set(owner)).status).toBe(200);
    expect((await request(app).get("/projects/1/prompt-queue/item-1").set(owner)).status).toBe(200);
    expect(
      (
        await request(app)
          .post("/projects/1/prompt-queue")
          .set(owner)
          .send({ position: 1, text: "Next", references: [] })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .patch("/projects/1/prompt-queue/item-1/position")
          .set(owner)
          .send({ position: 1 })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch("/projects/1/prompt-queue/item-1")
          .set(owner)
          .send({ text: "Changed", actorId: "forged" })
      ).status,
    ).toBe(200);
    expect((await request(app).delete("/projects/1/prompt-queue/item-1").set(owner)).status).toBe(
      200,
    );
    expect(
      (
        await request(app)
          .post("/projects/1/prompt-queue/promote-next")
          .set(owner)
          .send({ activeTurnId: "turn-1" })
      ).status,
    ).toBe(200);

    expect(list).toHaveBeenCalledWith(1, 51);
    expect(get).toHaveBeenCalledWith(1, "item-1");
    expect(enqueue.mock.calls[0]?.[0]).toBe(1);
    expect(reorder.mock.calls[0]?.[0]).toBe(1);
    expect(edit.mock.calls[0]?.[0]).toBe(1);
    expect(remove.mock.calls[0]?.[0]).toBe(1);
    expect(promoteNext.mock.calls[0]?.[0]).toBe(1);
    expect(edit.mock.calls[0]?.[1].provenance.actorId).toBe(OWNER_ONE);
    expect(remove.mock.calls[0]?.[1].deletedBy).toBe(OWNER_ONE);
  });

  it("binds only validated project assets to a queued prompt", async () => {
    const { app, store, assertAssets } = buildApp();
    const enqueue = vi.spyOn(store, "enqueue");

    const response = await request(app)
      .post("/projects/1/prompt-queue")
      .set("x-test-user", OWNER_ONE)
      .send({ position: 1, text: "Use these files", assetIds: [42, 42, 7] });

    expect(response.status).toBe(201);
    expect(assertAssets).toHaveBeenCalledWith({
      ownerUserId: OWNER_ONE,
      projectId: 1,
      assetIds: [42, 7],
    });
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ assetIds: [42, 7] });
  });

  it("bounds list responses and rejects an oversized requested page", async () => {
    const { app, store } = buildApp();
    const manyItems = Array.from({ length: 55 }, (_, index) =>
      queuedItem(`item-${index + 1}`, index + 1),
    );
    vi.spyOn(store, "list").mockResolvedValue(snapshot(manyItems));

    const bounded = await request(app)
      .get("/projects/1/prompt-queue?limit=10")
      .set("x-test-user", OWNER_ONE);
    expect(bounded.status).toBe(200);
    expect(bounded.body.items).toHaveLength(10);
    expect(bounded.body).toMatchObject({ returnedItems: 10, truncated: true });

    const oversized = await request(app)
      .get("/projects/1/prompt-queue?limit=51")
      .set("x-test-user", OWNER_ONE);
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toBe("Choose a list size from 1 to 50.");
  });

  it("turns the 50-item cap into a gentle refusal", async () => {
    const { app, store } = buildApp();
    vi.spyOn(store, "enqueue").mockRejectedValue(new ZeroPromptQueueError("queue_full"));

    const response = await request(app)
      .post("/projects/1/prompt-queue")
      .set("x-test-user", OWNER_ONE)
      .send({ position: 1, text: "Next" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "queue_full",
      error: "This queue already has 50 prompts. Remove one before adding another.",
    });
  });

  it("uses the existing empty-prompt refusal when a new prompt has no text", async () => {
    const { app, store } = buildApp();
    const enqueue = vi.spyOn(store, "enqueue");

    const response = await request(app)
      .post("/projects/1/prompt-queue")
      .set("x-test-user", OWNER_ONE)
      .send({ position: 1, text: "   " });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: "queue_edit_empty",
      error: "A queued prompt cannot be empty. Add some text and try again.",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("turns the 10,000-character cap into a gentle refusal before persistence", async () => {
    const { app, store } = buildApp();
    const enqueue = vi.spyOn(store, "enqueue");

    const response = await request(app)
      .post("/projects/1/prompt-queue")
      .set("x-test-user", OWNER_ONE)
      .send({ position: 1, text: "x".repeat(10_001) });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: "queue_item_text_too_long",
      error: "This prompt is too long. Keep it to 10,000 characters or fewer.",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("turns a position conflict into a gentle refusal", async () => {
    const { app, store } = buildApp();
    vi.spyOn(store, "reorder").mockRejectedValue(
      new ZeroPromptQueueError("queue_position_invalid"),
    );

    const response = await request(app)
      .patch("/projects/1/prompt-queue/item-1/position")
      .set("x-test-user", OWNER_ONE)
      .send({ position: 2 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "queue_position_invalid",
      error: "That queue position is not available. Choose a position within the current queue.",
    });
  });

  it("never exposes a raw database constraint error", async () => {
    const { app, store } = buildApp();
    const raw = Object.assign(
      new Error("duplicate key violates unique constraint queue_position"),
      {
        code: "23505",
      },
    );
    vi.spyOn(store, "enqueue").mockRejectedValue(raw);

    const response = await request(app)
      .post("/projects/1/prompt-queue")
      .set("x-test-user", OWNER_ONE)
      .send({ position: 1, text: "Next" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "queue_request_failed",
      error: "Something went wrong while updating the queued prompts. Please try again.",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|constraint|23505|queue_position/i);
  });

  it("defines a plain refusal for every queue and persistence error", () => {
    expect(ZERO_PROMPT_QUEUE_USER_ERRORS).toEqual({
      queue_edit_empty: {
        status: 400,
        message: "A queued prompt cannot be empty. Add some text and try again.",
      },
      queue_active_turn_not_queue_item: {
        status: 409,
        message: "The active prompt is already running and cannot be changed from the queue.",
      },
      queue_full: {
        status: 409,
        message: "This queue already has 50 prompts. Remove one before adding another.",
      },
      queue_item_text_too_long: {
        status: 400,
        message: "This prompt is too long. Keep it to 10,000 characters or fewer.",
      },
      queue_item_not_found: { status: 404, message: "That queued prompt could not be found." },
      queue_item_terminal: {
        status: 409,
        message: "That prompt has already left the queue and cannot be changed.",
      },
      queue_position_invalid: {
        status: 409,
        message:
          "That queue position is not available. Choose a position within the current queue.",
      },
      queue_persistence_unavailable: {
        status: 503,
        message: "The queued prompts are temporarily unavailable. Please try again.",
      },
      queue_persistence_contract_invalid: {
        status: 500,
        message: "Something went wrong while updating the queued prompts. Please try again.",
      },
      queue_persistence_write_bound_exceeded: {
        status: 500,
        message: "Something went wrong while updating the queued prompts. Please try again.",
      },
      queue_provenance_missing: {
        status: 500,
        message: "Something went wrong while updating the queued prompts. Please try again.",
      },
    });
    expect(
      Object.values(ZERO_PROMPT_QUEUE_USER_ERRORS).every(
        ({ message }) => !/postgres|constraint|sqlstate|internal/i.test(message),
      ),
    ).toBe(true);
  });

  it("maps known persistence weather without revealing implementation detail", async () => {
    const { app, store } = buildApp();
    vi.spyOn(store, "list").mockRejectedValue(
      new ZeroPromptQueuePersistenceError("queue_persistence_unavailable"),
    );

    const response = await request(app)
      .get("/projects/1/prompt-queue")
      .set("x-test-user", OWNER_ONE);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "queue_persistence_unavailable",
      error: "The queued prompts are temporarily unavailable. Please try again.",
    });
  });
});
