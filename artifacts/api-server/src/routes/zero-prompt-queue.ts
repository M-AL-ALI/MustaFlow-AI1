import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { requireProjectOwnership } from "../lib/auth";
import {
  ZERO_PROMPT_QUEUE_MAX_ITEMS,
  ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS,
  type ZeroPromptQueueReference,
  type ZeroPromptQueueSnapshot,
} from "../lib/zero-prompt-queue-contract";
import { ZeroPromptQueueStore } from "../lib/zero-prompt-queue-store";
import {
  ZERO_PROMPT_QUEUE_USER_ERRORS,
  zeroPromptQueueHttpError,
} from "../lib/zero-prompt-queue-user-errors";

const MAX_IDENTIFIER_CHARS = 128;
const MAX_REFERENCES = ZERO_PROMPT_QUEUE_MAX_ITEMS;

type QueueStore = Pick<
  ZeroPromptQueueStore,
  "list" | "get" | "enqueue" | "reorder" | "edit" | "delete" | "promoteNext"
>;

export type ZeroPromptQueueRouterDependencies = {
  store?: QueueStore;
  requireOwner?: RequestHandler;
  createId?: () => string;
  now?: () => string;
};

function projectId(req: Request, res: Response): number | null {
  const value = Number(req.params.id);
  if (!Number.isSafeInteger(value) || value < 1) {
    res.status(400).json({ code: "queue_request_invalid", error: "Choose a valid project." });
    return null;
  }
  return value;
}

function actorId(req: Request, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json({ code: "queue_unauthenticated", error: "Please sign in to continue." });
    return null;
  }
  return req.userId;
}

function itemId(value: unknown, res: Response): string | null {
  if (typeof value !== "string") {
    res.status(400).json({ code: "queue_request_invalid", error: "Choose a valid queued prompt." });
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_IDENTIFIER_CHARS) {
    res.status(400).json({ code: "queue_request_invalid", error: "Choose a valid queued prompt." });
    return null;
  }
  return normalized;
}

function position(value: unknown, res: Response): number | null {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > ZERO_PROMPT_QUEUE_MAX_ITEMS
  ) {
    const spec = ZERO_PROMPT_QUEUE_USER_ERRORS.queue_position_invalid;
    res.status(spec.status).json({ code: "queue_position_invalid", error: spec.message });
    return null;
  }
  return Number(value);
}

function text(value: unknown, res: Response): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    const spec = ZERO_PROMPT_QUEUE_USER_ERRORS.queue_edit_empty;
    res.status(spec.status).json({ code: "queue_edit_empty", error: spec.message });
    return null;
  }
  if ([...value].length > ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS) {
    const spec = ZERO_PROMPT_QUEUE_USER_ERRORS.queue_item_text_too_long;
    res.status(spec.status).json({ code: "queue_item_text_too_long", error: spec.message });
    return null;
  }
  return value;
}

function references(value: unknown, res: Response): readonly ZeroPromptQueueReference[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) {
    res.status(400).json({
      code: "queue_request_invalid",
      error: "The prompt references are not valid. Check them and try again.",
    });
    return null;
  }
  const parsed: ZeroPromptQueueReference[] = [];
  for (const reference of value) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      res.status(400).json({
        code: "queue_request_invalid",
        error: "The prompt references are not valid. Check them and try again.",
      });
      return null;
    }
    const candidate = reference as Record<string, unknown>;
    if (
      candidate.kind === "ordinal" &&
      Number.isSafeInteger(candidate.targetPosition) &&
      Number(candidate.targetPosition) >= 1 &&
      Number(candidate.targetPosition) <= ZERO_PROMPT_QUEUE_MAX_ITEMS
    ) {
      parsed.push({ kind: "ordinal", targetPosition: Number(candidate.targetPosition) });
      continue;
    }
    if (candidate.kind === "explicit") {
      const target =
        typeof candidate.targetItemId === "string" ? candidate.targetItemId.trim() : "";
      if (target.length >= 1 && target.length <= MAX_IDENTIFIER_CHARS) {
        parsed.push({ kind: "explicit", targetItemId: target });
        continue;
      }
    }
    res.status(400).json({
      code: "queue_request_invalid",
      error: "The prompt references are not valid. Check them and try again.",
    });
    return null;
  }
  return parsed;
}

function listLimit(value: unknown, res: Response): number | null {
  if (value === undefined) return ZERO_PROMPT_QUEUE_MAX_ITEMS;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ZERO_PROMPT_QUEUE_MAX_ITEMS) {
    res.status(400).json({
      code: "queue_request_invalid",
      error: "Choose a list size from 1 to 50.",
    });
    return null;
  }
  return parsed;
}

function mutationProvenance(actor: string, createId: () => string, now: () => string) {
  return { eventId: createId(), actorId: actor, occurredAt: now() };
}

function respondWithQueueError(res: Response, error: unknown): void {
  const response = zeroPromptQueueHttpError(error);
  res.status(response.status).json(response.body);
}

function boundedSnapshot(snapshot: ZeroPromptQueueSnapshot, limit: number) {
  const items = snapshot.items.slice(0, limit);
  return {
    ...snapshot,
    items,
    returnedItems: items.length,
    truncated: snapshot.items.length > limit,
  };
}

export function createZeroPromptQueueRouter(
  dependencies: ZeroPromptQueueRouterDependencies = {},
): IRouter {
  const router: IRouter = Router();
  const store = dependencies.store ?? new ZeroPromptQueueStore();
  const requireOwner = dependencies.requireOwner ?? requireProjectOwnership;
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());

  router.get("/projects/:id/prompt-queue", requireOwner, async (req, res): Promise<void> => {
    const id = projectId(req, res);
    const limit = listLimit(req.query.limit, res);
    if (id === null || limit === null) return;
    try {
      res.json(boundedSnapshot(await store.list(id, limit + 1), limit));
    } catch (error) {
      respondWithQueueError(res, error);
    }
  });

  router.get(
    "/projects/:id/prompt-queue/:itemId",
    requireOwner,
    async (req, res): Promise<void> => {
      const id = projectId(req, res);
      const target = itemId(req.params.itemId, res);
      if (id === null || target === null) return;
      try {
        res.json(await store.get(id, target));
      } catch (error) {
        respondWithQueueError(res, error);
      }
    },
  );

  router.post("/projects/:id/prompt-queue", requireOwner, async (req, res): Promise<void> => {
    const id = projectId(req, res);
    const actor = actorId(req, res);
    const nextPosition = position(req.body?.position, res);
    const currentText = text(req.body?.text, res);
    const itemReferences = references(req.body?.references, res);
    if (
      id === null ||
      actor === null ||
      nextPosition === null ||
      currentText === null ||
      itemReferences === null
    ) {
      return;
    }
    try {
      const result = await store.enqueue(id, {
        kind: "enqueue",
        order: 1,
        itemId: createId(),
        projectId: String(id),
        position: nextPosition,
        text: currentText,
        references: itemReferences,
        provenance: mutationProvenance(actor, createId, now),
      });
      res.status(201).json(result);
    } catch (error) {
      respondWithQueueError(res, error);
    }
  });

  router.post(
    "/projects/:id/prompt-queue/promote-next",
    requireOwner,
    async (req, res): Promise<void> => {
      const id = projectId(req, res);
      const actor = actorId(req, res);
      const activeTurn = itemId(req.body?.activeTurnId, res);
      if (id === null || actor === null || activeTurn === null) return;
      try {
        res.json(
          await store.promoteNext(id, {
            kind: "promote-next",
            order: 1,
            activeTurn: { kind: "active-turn", id: activeTurn, projectId: String(id) },
            provenance: mutationProvenance(actor, createId, now),
          }),
        );
      } catch (error) {
        respondWithQueueError(res, error);
      }
    },
  );

  router.patch(
    "/projects/:id/prompt-queue/:itemId/position",
    requireOwner,
    async (req, res): Promise<void> => {
      const id = projectId(req, res);
      const actor = actorId(req, res);
      const target = itemId(req.params.itemId, res);
      const nextPosition = position(req.body?.position, res);
      if (id === null || actor === null || target === null || nextPosition === null) return;
      try {
        res.json(
          await store.reorder(id, {
            kind: "reorder",
            order: 1,
            target: { kind: "queue-item", itemId: target },
            position: nextPosition,
            provenance: mutationProvenance(actor, createId, now),
          }),
        );
      } catch (error) {
        respondWithQueueError(res, error);
      }
    },
  );

  router.patch(
    "/projects/:id/prompt-queue/:itemId",
    requireOwner,
    async (req, res): Promise<void> => {
      const id = projectId(req, res);
      const actor = actorId(req, res);
      const target = itemId(req.params.itemId, res);
      const currentText = text(req.body?.text, res);
      if (id === null || actor === null || target === null || currentText === null) return;
      try {
        res.json(
          await store.edit(id, {
            kind: "edit",
            order: 1,
            target: { kind: "queue-item", itemId: target },
            text: currentText,
            provenance: mutationProvenance(actor, createId, now),
          }),
        );
      } catch (error) {
        respondWithQueueError(res, error);
      }
    },
  );

  router.delete(
    "/projects/:id/prompt-queue/:itemId",
    requireOwner,
    async (req, res): Promise<void> => {
      const id = projectId(req, res);
      const actor = actorId(req, res);
      const target = itemId(req.params.itemId, res);
      if (id === null || actor === null || target === null) return;
      try {
        res.json(
          await store.delete(id, {
            kind: "delete",
            order: 1,
            target: { kind: "queue-item", itemId: target },
            deletedBy: actor,
            provenance: mutationProvenance(actor, createId, now),
          }),
        );
      } catch (error) {
        respondWithQueueError(res, error);
      }
    },
  );

  return router;
}

export default createZeroPromptQueueRouter();
