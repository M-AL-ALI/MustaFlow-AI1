import { describe, expect, it } from "vitest";
import {
  ZERO_PROMPT_QUEUE_SEMANTICS,
  type ZeroPromptQueueItem,
  type ZeroPromptQueueSnapshot,
} from "./zero-prompt-queue-contract";
import { assessPromptQueueCoherence } from "./zero-prompt-queue-coherence";

function item(
  id: string,
  position: number,
  references: ZeroPromptQueueItem["references"] = [],
): ZeroPromptQueueItem {
  return {
    id,
    projectId: "project-52",
    position,
    currentText: id,
    state: "queued",
    references,
    terminalEvidence: null,
  };
}

function snapshot(items: readonly ZeroPromptQueueItem[]): ZeroPromptQueueSnapshot {
  return { semantics: ZERO_PROMPT_QUEUE_SEMANTICS, projectId: "project-52", items };
}

describe("Zero prompt queue structural coherence", () => {
  it("warns when reorder changes an ordinal reference target", () => {
    const source = item("source", 1, [{ kind: "ordinal", targetPosition: 2 }]);
    const before = snapshot([source, item("second", 2), item("third", 3)]);
    const after = snapshot([source, item("third", 2), item("second", 3)]);
    expect(assessPromptQueueCoherence(before, after, "reorder")).toEqual([
      {
        code: "queue_coherence_ordinal_reference_shifted",
        sourceItemId: "source",
        referenceKind: "ordinal",
        targetItemId: "second",
        targetPosition: 2,
      },
    ]);
  });

  it("warns when delete breaks explicit and ordinal references", () => {
    const source = item("source", 1, [
      { kind: "explicit", targetItemId: "second" },
      { kind: "ordinal", targetPosition: 2 },
    ]);
    const deleted: ZeroPromptQueueItem = {
      ...item("second", 2),
      state: "deleted",
      terminalEvidence: {
        kind: "deleted",
        deletedBy: "user-1",
        provenanceEventId: "event-1",
        occurredAt: "2026-08-20T05:30:00.000Z",
      },
    };
    expect(
      assessPromptQueueCoherence(
        snapshot([source, item("second", 2)]),
        snapshot([source, deleted]),
        "delete",
      ),
    ).toEqual([
      {
        code: "queue_coherence_explicit_reference_broken",
        sourceItemId: "source",
        referenceKind: "explicit",
        targetItemId: "second",
        targetPosition: 2,
      },
      {
        code: "queue_coherence_ordinal_reference_shifted",
        sourceItemId: "source",
        referenceKind: "ordinal",
        targetItemId: "second",
        targetPosition: 2,
      },
    ]);
  });

  it("does not infer semantic references from prose", () => {
    const before = snapshot([
      { ...item("first", 1), currentText: "Do the next item before the last one" },
      item("second", 2),
    ]);
    const after = snapshot([item("second", 1), { ...before.items[0], position: 2 }]);
    expect(assessPromptQueueCoherence(before, after, "reorder")).toEqual([]);
  });

  it("is deterministic across input ordering", () => {
    const source = item("source", 1, [{ kind: "ordinal", targetPosition: 2 }]);
    const before = [source, item("second", 2), item("third", 3)];
    const after = [source, item("third", 2), item("second", 3)];
    expect(
      assessPromptQueueCoherence(
        snapshot([...before].reverse()),
        snapshot([...after].reverse()),
        "reorder",
      ),
    ).toEqual(assessPromptQueueCoherence(snapshot(before), snapshot(after), "reorder"));
  });
});
