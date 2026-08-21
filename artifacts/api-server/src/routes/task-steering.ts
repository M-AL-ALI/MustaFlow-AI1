import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import { agentTasksTable, db } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS,
  ZeroPromptQueueError,
  type ZeroPromptQueueMutationResult,
  type ZeroPromptQueueSnapshot,
} from "../lib/zero-prompt-queue-contract";
import {
  ZERO_PROMPT_QUEUE_MAX_READ_ITEMS,
  ZeroPromptQueuePersistenceError,
  ZeroPromptQueueStore,
} from "../lib/zero-prompt-queue-store";
import { zeroPromptQueueHttpError } from "../lib/zero-prompt-queue-user-errors";

type SteeringQueueStore = Pick<ZeroPromptQueueStore, "list" | "enqueue">;

type SteeringTask = {
  id: number;
  status: string;
};

export type TaskSteeringDependencies = {
  requireOwner?: RequestHandler;
  store?: SteeringQueueStore;
  loadTask?: (projectId: number, taskId: number) => Promise<SteeringTask | null>;
  createId?: () => string;
  now?: () => string;
};

function positiveId(value: string | string[] | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function queuedCount(snapshot: ZeroPromptQueueSnapshot): number {
  return snapshot.items.filter((item) => item.state === "queued").length;
}

function acceptedItem(
  result: ZeroPromptQueueMutationResult,
  itemId: string,
): { itemId: string; position: number } {
  const item = result.snapshot.items.find(
    (candidate) => candidate.id === itemId && candidate.state === "queued",
  );
  if (!item || item.position === null) {
    throw new ZeroPromptQueuePersistenceError("queue_persistence_contract_invalid");
  }
  return { itemId: item.id, position: item.position };
}

async function loadTask(projectId: number, taskId: number): Promise<SteeringTask | null> {
  const [task] = await db
    .select({ id: agentTasksTable.id, status: agentTasksTable.status })
    .from(agentTasksTable)
    .where(and(eq(agentTasksTable.id, taskId), eq(agentTasksTable.projectId, projectId)))
    .limit(1);
  return task ?? null;
}

export function createTaskSteeringRouter(dependencies: TaskSteeringDependencies = {}): IRouter {
  const router: IRouter = Router();
  const requireOwner = dependencies.requireOwner ?? requireProjectOwnership;
  const store = dependencies.store ?? new ZeroPromptQueueStore();
  const findTask = dependencies.loadTask ?? loadTask;
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());

  router.post(
    "/projects/:id/tasks/:taskId/steer",
    requireOwner,
    async (req, res): Promise<void> => {
      const projectId = positiveId(req.params.id);
      const taskId = positiveId(req.params.taskId);
      if (projectId === null || taskId === null) {
        res.status(400).json({ error: "Choose a valid project and build." });
        return;
      }
      if (!req.userId) {
        res.status(401).json({ error: "Please sign in to continue." });
        return;
      }

      const hint = typeof req.body?.hint === "string" ? req.body.hint.trim() : "";
      if (!hint) {
        const response = zeroPromptQueueHttpError(new ZeroPromptQueueError("queue_edit_empty"));
        res.status(response.status).json(response.body);
        return;
      }
      if ([...hint].length > ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS) {
        const response = zeroPromptQueueHttpError(
          new ZeroPromptQueueError("queue_item_text_too_long"),
        );
        res.status(response.status).json(response.body);
        return;
      }

      const task = await findTask(projectId, taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      const isActive = ["building", "planning", "queued", "pending"].includes(task.status);
      if (!isActive) {
        res.status(409).json({
          error:
            task.status === "completed" || task.status === "failed" || task.status === "canceled"
              ? "Build has already finished — prompts cannot be added to a completed task"
              : "Task is not currently active",
        });
        return;
      }

      try {
        const snapshot = await store.list(projectId, ZERO_PROMPT_QUEUE_MAX_READ_ITEMS);
        const itemId = createId();
        const result = await store.enqueue(projectId, {
          kind: "enqueue",
          order: 1,
          itemId,
          projectId: String(projectId),
          position: queuedCount(snapshot) + 1,
          text: hint,
          references: [],
          provenance: {
            eventId: createId(),
            actorId: req.userId,
            occurredAt: now(),
          },
        });
        const accepted = acceptedItem(result, itemId);
        req.log?.info(
          { projectId, taskId, queueItemId: accepted.itemId, position: accepted.position },
          "steering prompt saved",
        );
        res.status(201).json(accepted);
      } catch (error) {
        const response = zeroPromptQueueHttpError(error);
        res.status(response.status).json(response.body);
      }
    },
  );

  return router;
}

export default createTaskSteeringRouter();
