import type {
  ZeroPromptQueueItem,
  ZeroPromptQueueSnapshot,
  ZeroPromptQueueWarning,
} from "./zero-prompt-queue-contract";

function queuedByPosition(
  snapshot: ZeroPromptQueueSnapshot,
): ReadonlyMap<number, ZeroPromptQueueItem> {
  return new Map(
    snapshot.items
      .filter((item) => item.state === "queued")
      .map((item) => [item.position, item] as const),
  );
}

function queuedById(snapshot: ZeroPromptQueueSnapshot): ReadonlyMap<string, ZeroPromptQueueItem> {
  return new Map(
    snapshot.items
      .filter((item) => item.state === "queued")
      .map((item) => [item.id, item] as const),
  );
}

function warningKey(warning: ZeroPromptQueueWarning): string {
  return [
    warning.code,
    warning.sourceItemId,
    warning.referenceKind,
    warning.targetItemId ?? "",
    warning.targetPosition ?? "",
  ].join("|");
}

/**
 * @dormantExport
 * No user-facing production consumer exists as of the inert-export registry anchor. This becomes
 * reachable only when a first-party producer records structured prompt references and a product
 * surface consumes the returned warnings.
 */
export function assessPromptQueueCoherence(
  before: ZeroPromptQueueSnapshot,
  after: ZeroPromptQueueSnapshot,
  mutation: "reorder" | "delete",
): readonly ZeroPromptQueueWarning[] {
  const beforePositions = queuedByPosition(before);
  const afterPositions = queuedByPosition(after);
  const beforeItems = queuedById(before);
  const afterItems = queuedById(after);
  const warnings: ZeroPromptQueueWarning[] = [];

  for (const source of [...beforeItems.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (!afterItems.has(source.id)) continue;
    for (const reference of source.references) {
      if (reference.kind === "ordinal") {
        const beforeTarget = beforePositions.get(reference.targetPosition)?.id ?? null;
        const afterTarget = afterPositions.get(reference.targetPosition)?.id ?? null;
        if (beforeTarget !== afterTarget) {
          warnings.push({
            code: "queue_coherence_ordinal_reference_shifted",
            sourceItemId: source.id,
            referenceKind: "ordinal",
            targetItemId: beforeTarget,
            targetPosition: reference.targetPosition,
          });
        }
        continue;
      }
      if (
        mutation === "delete" &&
        beforeItems.has(reference.targetItemId) &&
        !afterItems.has(reference.targetItemId)
      ) {
        warnings.push({
          code: "queue_coherence_explicit_reference_broken",
          sourceItemId: source.id,
          referenceKind: "explicit",
          targetItemId: reference.targetItemId,
          targetPosition: beforeItems.get(reference.targetItemId)?.position ?? null,
        });
      }
    }
  }

  return [...new Map(warnings.map((warning) => [warningKey(warning), warning])).values()].sort(
    (left, right) => warningKey(left).localeCompare(warningKey(right)),
  );
}
