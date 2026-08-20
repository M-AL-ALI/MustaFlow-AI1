export const ZERO_PROMPT_QUEUE_SEMANTICS = "zero-prompt-queue-v1" as const;
export const ZERO_PROMPT_QUEUE_MAX_ITEMS = 50 as const;
export const ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS = 10_000 as const;

export const ZERO_PROMPT_QUEUE_ITEM_STATES = ["queued", "promoted", "deleted"] as const;
export const ZERO_PROMPT_QUEUE_MUTATIONS = [
  "enqueue",
  "reorder",
  "edit",
  "delete",
  "promote-next",
] as const;
export const ZERO_PROMPT_QUEUE_EVENT_TYPES = [
  "queue.item.enqueued",
  "queue.item.reordered",
  "queue.item.edited",
  "queue.item.deleted",
  "queue.item.promoted",
] as const;
export const ZERO_PROMPT_QUEUE_ERROR_CODES = [
  "queue_edit_empty",
  "queue_active_turn_not_queue_item",
  "queue_full",
  "queue_item_text_too_long",
  "queue_item_not_found",
  "queue_item_terminal",
  "queue_position_invalid",
] as const;
export const ZERO_PROMPT_QUEUE_WARNING_CODES = [
  "queue_coherence_ordinal_reference_shifted",
  "queue_coherence_explicit_reference_broken",
] as const;

export type ZeroPromptQueueItemState = (typeof ZERO_PROMPT_QUEUE_ITEM_STATES)[number];
export type ZeroPromptQueueMutationKind = (typeof ZERO_PROMPT_QUEUE_MUTATIONS)[number];
export type ZeroPromptQueueEventType = (typeof ZERO_PROMPT_QUEUE_EVENT_TYPES)[number];
export type ZeroPromptQueueErrorCode = (typeof ZERO_PROMPT_QUEUE_ERROR_CODES)[number];
export type ZeroPromptQueueWarningCode = (typeof ZERO_PROMPT_QUEUE_WARNING_CODES)[number];

export type ZeroPromptQueueReference =
  | { kind: "ordinal"; targetPosition: number }
  | { kind: "explicit"; targetItemId: string };

export type ZeroPromptQueueTerminalEvidence =
  | {
      kind: "promoted";
      activeTurnId: string;
      provenanceEventId: string;
      occurredAt: string;
    }
  | {
      kind: "deleted";
      deletedBy: string;
      provenanceEventId: string;
      occurredAt: string;
    };

export type ZeroPromptQueueItem = {
  id: string;
  projectId: string;
  position: number;
  currentText: string;
  state: ZeroPromptQueueItemState;
  references: readonly ZeroPromptQueueReference[];
  terminalEvidence: ZeroPromptQueueTerminalEvidence | null;
};

export type ZeroPromptQueueSnapshot = {
  semantics: typeof ZERO_PROMPT_QUEUE_SEMANTICS;
  projectId: string;
  items: readonly ZeroPromptQueueItem[];
};

export type ZeroPromptQueueItemAddress =
  | { kind: "queue-item"; itemId: string }
  | { kind: "active-turn"; activeTurnId: string };

export type ZeroPromptQueueActiveTurn = {
  kind: "active-turn";
  id: string;
  projectId: string;
};

export type ZeroPromptQueueProvenance = {
  eventId: string;
  actorId: string;
  occurredAt: string;
};

type OrderedMutation = {
  order: number;
  provenance: ZeroPromptQueueProvenance;
};

export type ZeroPromptQueueMutation =
  | (OrderedMutation & {
      kind: "enqueue";
      itemId: string;
      projectId: string;
      position: number;
      text: string;
      references: readonly ZeroPromptQueueReference[];
    })
  | (OrderedMutation & {
      kind: "reorder";
      target: ZeroPromptQueueItemAddress;
      position: number;
    })
  | (OrderedMutation & {
      kind: "edit";
      target: ZeroPromptQueueItemAddress;
      text: string;
    })
  | (OrderedMutation & {
      kind: "delete";
      target: ZeroPromptQueueItemAddress;
      deletedBy: string;
    })
  | (OrderedMutation & {
      kind: "promote-next";
      activeTurn: ZeroPromptQueueActiveTurn;
    });

type EventBase = {
  semantics: typeof ZERO_PROMPT_QUEUE_SEMANTICS;
  eventId: string;
  projectId: string;
  itemId: string;
  actorId: string;
  occurredAt: string;
};

export type ZeroPromptQueueEvent =
  | (EventBase & {
      type: "queue.item.enqueued";
      position: number;
      currentText: string;
    })
  | (EventBase & {
      type: "queue.item.reordered";
      fromPosition: number;
      toPosition: number;
    })
  | (EventBase & {
      type: "queue.item.edited";
      position: number;
      originalText: string;
      currentText: string;
    })
  | (EventBase & {
      type: "queue.item.deleted";
      fromPosition: number;
      deletedBy: string;
    })
  | (EventBase & {
      type: "queue.item.promoted";
      fromPosition: number;
      activeTurnId: string;
    });

export type ZeroPromptQueueWarning = {
  code: ZeroPromptQueueWarningCode;
  sourceItemId: string;
  referenceKind: ZeroPromptQueueReference["kind"];
  targetItemId: string | null;
  targetPosition: number | null;
};

export type ZeroPromptQueueMutationResult = {
  snapshot: ZeroPromptQueueSnapshot;
  event: ZeroPromptQueueEvent;
  warnings: readonly ZeroPromptQueueWarning[];
};

export type ZeroPromptQueueBatchResult = {
  snapshot: ZeroPromptQueueSnapshot;
  events: readonly ZeroPromptQueueEvent[];
  warnings: readonly ZeroPromptQueueWarning[];
};

export class ZeroPromptQueueError extends Error {
  readonly name = "ZeroPromptQueueError";

  constructor(readonly code: ZeroPromptQueueErrorCode) {
    super(code);
  }
}
