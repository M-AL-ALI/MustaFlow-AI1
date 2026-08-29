import { randomUUID } from "node:crypto";
import {
  ZeroPromptQueueError,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueMutationResult,
} from "./zero-prompt-queue-contract";

/**
 * Queue promotion shares the phase-emitter's 250 ms ceiling. The queue is a
 * convenience on the live-turn hot path: a slow persistence dependency may
 * delay a prompt, but it must never delay the agent turn.
 */
export const ZERO_QUEUE_STEERING_PROMOTION_TIMEOUT_MS = 250;

type PromoteNextMutation = Extract<ZeroPromptQueueMutation, { kind: "promote-next" }>;

export type ZeroQueuePromoteNext = (
  projectId: number,
  mutation: PromoteNextMutation,
  signal: AbortSignal,
) => Promise<ZeroPromptQueueMutationResult>;

export type ZeroQueuePromotionOutcome =
  | {
      kind: "promoted";
      itemId: string;
      text: string;
      assetIds: readonly number[];
      activeTurnId: string;
    }
  | { kind: "empty" }
  | { kind: "delayed" };

async function defaultPromoteNext(
  projectId: number,
  mutation: PromoteNextMutation,
  signal: AbortSignal,
): Promise<ZeroPromptQueueMutationResult> {
  const { ZeroPromptQueueStore } = await import("./zero-prompt-queue-store");
  return new ZeroPromptQueueStore().promoteNext(projectId, mutation, signal);
}

export async function promoteQueuedSteeringAtBoundary(input: {
  projectId: number;
  taskId: number;
  actorId: string;
  promoteNext?: ZeroQueuePromoteNext;
  timeoutMs?: number;
  createEventId?: () => string;
  occurredAt?: () => string;
}): Promise<ZeroQueuePromotionOutcome> {
  const promoteNext = input.promoteNext ?? defaultPromoteNext;
  const controller = new AbortController();
  const activeTurnId = String(input.taskId);
  const mutation: PromoteNextMutation = {
    kind: "promote-next",
    order: 1,
    activeTurn: {
      kind: "active-turn",
      id: activeTurnId,
      projectId: String(input.projectId),
    },
    provenance: {
      eventId: (input.createEventId ?? randomUUID)(),
      actorId: input.actorId,
      occurredAt: (input.occurredAt ?? (() => new Date().toISOString()))(),
    },
  };

  const promotion = Promise.resolve()
    .then(() => promoteNext(input.projectId, mutation, controller.signal))
    .then<ZeroQueuePromotionOutcome>((result) => {
      const item = result.snapshot.items.find(
        (candidate) =>
          candidate.id === result.event.itemId &&
          candidate.state === "promoted" &&
          candidate.terminalEvidence?.kind === "promoted" &&
          candidate.terminalEvidence.activeTurnId === activeTurnId,
      );
      if (!item) return { kind: "delayed" };
      return {
        kind: "promoted",
        itemId: item.id,
        text: item.currentText,
        assetIds: item.assetIds ?? [],
        activeTurnId,
      };
    })
    .catch<ZeroQueuePromotionOutcome>((error: unknown) =>
      error instanceof ZeroPromptQueueError && error.code === "queue_item_not_found"
        ? { kind: "empty" }
        : { kind: "delayed" },
    );

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ZeroQueuePromotionOutcome>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ kind: "delayed" });
    }, input.timeoutMs ?? ZERO_QUEUE_STEERING_PROMOTION_TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
  });

  try {
    return await Promise.race([promotion, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function applyZeroSteeringAtBoundary(input: {
  projectId: number;
  taskId: number;
  actorId: string;
  inject: (text: string, assetIds: readonly number[]) => Promise<void>;
  promoteNext?: ZeroQueuePromoteNext;
  timeoutMs?: number;
  createEventId?: () => string;
  occurredAt?: () => string;
}): Promise<ZeroQueuePromotionOutcome> {
  const queue = await promoteQueuedSteeringAtBoundary(input);
  if (queue.kind === "promoted") await input.inject(queue.text, queue.assetIds);
  return queue;
}
