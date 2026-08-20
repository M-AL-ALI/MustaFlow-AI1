import {
  ZERO_PROMPT_QUEUE_MAX_ITEMS,
  ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS,
  ZERO_PROMPT_QUEUE_SEMANTICS,
  ZeroPromptQueueError,
  type ZeroPromptQueueBatchResult,
  type ZeroPromptQueueEvent,
  type ZeroPromptQueueItem,
  type ZeroPromptQueueItemAddress,
  type ZeroPromptQueueMutation,
  type ZeroPromptQueueMutationResult,
  type ZeroPromptQueueSnapshot,
  type ZeroPromptQueueWarning,
} from "./zero-prompt-queue-contract";
import { assessPromptQueueCoherence } from "./zero-prompt-queue-coherence";

function textLength(value: string): number {
  return [...value].length;
}

function assertText(value: string, operation: "enqueue" | "edit"): void {
  if (value.trim().length === 0) {
    throw new ZeroPromptQueueError(
      operation === "edit" ? "queue_edit_empty" : "queue_item_not_found",
    );
  }
  if (textLength(value) > ZERO_PROMPT_QUEUE_MAX_TEXT_CHARS) {
    throw new ZeroPromptQueueError("queue_item_text_too_long");
  }
}

function canonicalReferences(item: ZeroPromptQueueItem): ZeroPromptQueueItem["references"] {
  return [...item.references].sort((left, right) => {
    const leftKey =
      left.kind === "ordinal" ? `ordinal|${left.targetPosition}` : `explicit|${left.targetItemId}`;
    const rightKey =
      right.kind === "ordinal"
        ? `ordinal|${right.targetPosition}`
        : `explicit|${right.targetItemId}`;
    return leftKey.localeCompare(rightKey);
  });
}

function validateAndCanonicalize(snapshot: ZeroPromptQueueSnapshot): ZeroPromptQueueSnapshot {
  if (snapshot.semantics !== ZERO_PROMPT_QUEUE_SEMANTICS || !snapshot.projectId) {
    throw new ZeroPromptQueueError("queue_position_invalid");
  }
  const items = [...snapshot.items].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
  const ids = new Set<string>();
  const queuedCount = items.filter((item) => item.state === "queued").length;
  if (queuedCount > ZERO_PROMPT_QUEUE_MAX_ITEMS) {
    throw new ZeroPromptQueueError("queue_full");
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (
      !item.id ||
      ids.has(item.id) ||
      item.projectId !== snapshot.projectId ||
      item.position !== index + 1 ||
      !Number.isInteger(item.position) ||
      (item.state === "queued" && item.position > queuedCount) ||
      (item.state !== "queued" && item.position <= queuedCount)
    ) {
      throw new ZeroPromptQueueError("queue_position_invalid");
    }
    assertText(item.currentText, "enqueue");
    if (
      (item.state === "queued" && item.terminalEvidence !== null) ||
      (item.state === "promoted" && item.terminalEvidence?.kind !== "promoted") ||
      (item.state === "deleted" && item.terminalEvidence?.kind !== "deleted")
    ) {
      throw new ZeroPromptQueueError("queue_item_terminal");
    }
    ids.add(item.id);
  }
  return {
    semantics: ZERO_PROMPT_QUEUE_SEMANTICS,
    projectId: snapshot.projectId,
    items: items.map((item) => ({ ...item, references: canonicalReferences(item) })),
  };
}

function reposition(items: readonly ZeroPromptQueueItem[]): readonly ZeroPromptQueueItem[] {
  return items.map((item, index) => ({ ...item, position: index + 1 }));
}

function queuedCount(snapshot: ZeroPromptQueueSnapshot): number {
  return snapshot.items.filter((item) => item.state === "queued").length;
}

function resolveQueuedItem(
  snapshot: ZeroPromptQueueSnapshot,
  target: ZeroPromptQueueItemAddress,
): ZeroPromptQueueItem {
  if (target.kind === "active-turn") {
    throw new ZeroPromptQueueError("queue_active_turn_not_queue_item");
  }
  const item = snapshot.items.find((candidate) => candidate.id === target.itemId);
  if (!item) throw new ZeroPromptQueueError("queue_item_not_found");
  if (item.state !== "queued") throw new ZeroPromptQueueError("queue_item_terminal");
  return item;
}

function eventBase(
  snapshot: ZeroPromptQueueSnapshot,
  operation: ZeroPromptQueueMutation,
  itemId: string,
) {
  return {
    semantics: ZERO_PROMPT_QUEUE_SEMANTICS,
    eventId: operation.provenance.eventId,
    projectId: snapshot.projectId,
    itemId,
    actorId: operation.provenance.actorId,
    occurredAt: operation.provenance.occurredAt,
  } as const;
}

export function createZeroPromptQueueSnapshot(
  projectId: string,
  items: readonly ZeroPromptQueueItem[] = [],
): ZeroPromptQueueSnapshot {
  return validateAndCanonicalize({ semantics: ZERO_PROMPT_QUEUE_SEMANTICS, projectId, items });
}

export function applyZeroPromptQueueMutation(
  input: ZeroPromptQueueSnapshot,
  operation: ZeroPromptQueueMutation,
): ZeroPromptQueueMutationResult {
  const snapshot = validateAndCanonicalize(input);
  let nextItems: readonly ZeroPromptQueueItem[];
  let event: ZeroPromptQueueEvent;
  let warnings: readonly ZeroPromptQueueWarning[] = [];

  if (operation.kind === "enqueue") {
    if (operation.projectId !== snapshot.projectId) {
      throw new ZeroPromptQueueError("queue_item_not_found");
    }
    const activeCount = queuedCount(snapshot);
    if (activeCount >= ZERO_PROMPT_QUEUE_MAX_ITEMS) {
      throw new ZeroPromptQueueError("queue_full");
    }
    if (
      !Number.isInteger(operation.position) ||
      operation.position < 1 ||
      operation.position > activeCount + 1
    ) {
      throw new ZeroPromptQueueError("queue_position_invalid");
    }
    if (snapshot.items.some((item) => item.id === operation.itemId)) {
      throw new ZeroPromptQueueError("queue_item_terminal");
    }
    assertText(operation.text, "enqueue");
    const item: ZeroPromptQueueItem = {
      id: operation.itemId,
      projectId: snapshot.projectId,
      position: operation.position,
      currentText: operation.text,
      state: "queued",
      references: [...operation.references],
      terminalEvidence: null,
    };
    nextItems = reposition([
      ...snapshot.items.slice(0, operation.position - 1),
      item,
      ...snapshot.items.slice(operation.position - 1),
    ]);
    event = {
      ...eventBase(snapshot, operation, item.id),
      type: "queue.item.enqueued",
      position: operation.position,
      currentText: operation.text,
    };
  } else if (operation.kind === "reorder") {
    const item = resolveQueuedItem(snapshot, operation.target);
    const activeCount = queuedCount(snapshot);
    if (
      !Number.isInteger(operation.position) ||
      operation.position < 1 ||
      operation.position > activeCount
    ) {
      throw new ZeroPromptQueueError("queue_position_invalid");
    }
    const without = snapshot.items.filter((candidate) => candidate.id !== item.id);
    nextItems = reposition([
      ...without.slice(0, operation.position - 1),
      item,
      ...without.slice(operation.position - 1),
    ]);
    event = {
      ...eventBase(snapshot, operation, item.id),
      type: "queue.item.reordered",
      fromPosition: item.position,
      toPosition: operation.position,
    };
  } else if (operation.kind === "edit") {
    const item = resolveQueuedItem(snapshot, operation.target);
    assertText(operation.text, "edit");
    nextItems = snapshot.items.map((candidate) =>
      candidate.id === item.id ? { ...candidate, currentText: operation.text } : candidate,
    );
    event = {
      ...eventBase(snapshot, operation, item.id),
      type: "queue.item.edited",
      position: item.position,
      originalText: item.currentText,
      currentText: operation.text,
    };
  } else if (operation.kind === "delete") {
    const item = resolveQueuedItem(snapshot, operation.target);
    const remaining = snapshot.items.filter((candidate) => candidate.id !== item.id);
    nextItems = reposition([
      ...remaining,
      {
        ...item,
        state: "deleted",
        position: snapshot.items.length,
        terminalEvidence: {
          kind: "deleted",
          deletedBy: operation.deletedBy,
          provenanceEventId: operation.provenance.eventId,
          occurredAt: operation.provenance.occurredAt,
        },
      },
    ]);
    event = {
      ...eventBase(snapshot, operation, item.id),
      type: "queue.item.deleted",
      fromPosition: item.position,
      deletedBy: operation.deletedBy,
    };
  } else {
    if (operation.activeTurn.projectId !== snapshot.projectId) {
      throw new ZeroPromptQueueError("queue_item_not_found");
    }
    const item = snapshot.items.find((candidate) => candidate.state === "queued");
    if (!item) throw new ZeroPromptQueueError("queue_item_not_found");
    const remaining = snapshot.items.filter((candidate) => candidate.id !== item.id);
    nextItems = reposition([
      ...remaining,
      {
        ...item,
        state: "promoted",
        position: snapshot.items.length,
        terminalEvidence: {
          kind: "promoted",
          activeTurnId: operation.activeTurn.id,
          provenanceEventId: operation.provenance.eventId,
          occurredAt: operation.provenance.occurredAt,
        },
      },
    ]);
    event = {
      ...eventBase(snapshot, operation, item.id),
      type: "queue.item.promoted",
      fromPosition: item.position,
      activeTurnId: operation.activeTurn.id,
    };
  }

  const next = validateAndCanonicalize({ ...snapshot, items: nextItems });
  if (operation.kind === "reorder" || operation.kind === "delete") {
    warnings = assessPromptQueueCoherence(snapshot, next, operation.kind);
  }
  return { snapshot: next, event, warnings };
}

export function applyZeroPromptQueueOperations(
  input: ZeroPromptQueueSnapshot,
  operations: readonly ZeroPromptQueueMutation[],
): ZeroPromptQueueBatchResult {
  const ordered = [...operations].sort(
    (left, right) =>
      left.order - right.order || left.provenance.eventId.localeCompare(right.provenance.eventId),
  );
  if (
    ordered.some(
      (operation, index) =>
        !Number.isInteger(operation.order) ||
        operation.order < 1 ||
        (index > 0 && operation.order === ordered[index - 1].order),
    )
  ) {
    throw new ZeroPromptQueueError("queue_position_invalid");
  }
  let snapshot = validateAndCanonicalize(input);
  const events: ZeroPromptQueueEvent[] = [];
  const warnings: ZeroPromptQueueWarning[] = [];
  for (const operation of ordered) {
    const result = applyZeroPromptQueueMutation(snapshot, operation);
    snapshot = result.snapshot;
    events.push(result.event);
    warnings.push(...result.warnings);
  }
  return { snapshot, events, warnings };
}
