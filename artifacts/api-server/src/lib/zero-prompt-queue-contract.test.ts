import { describe, expect, it } from "vitest";
import {
  ZERO_PROMPT_QUEUE_ERROR_CODES,
  ZERO_PROMPT_QUEUE_EVENT_TYPES,
  ZERO_PROMPT_QUEUE_ITEM_STATES,
  ZERO_PROMPT_QUEUE_MUTATIONS,
  ZERO_PROMPT_QUEUE_SEMANTICS,
  ZERO_PROMPT_QUEUE_WARNING_CODES,
  ZeroPromptQueueError,
  type ZeroPromptQueueActiveTurn,
  type ZeroPromptQueueSnapshot,
} from "./zero-prompt-queue-contract";

describe("Zero prompt queue contract", () => {
  it("pins every closed typed set", () => {
    expect(ZERO_PROMPT_QUEUE_SEMANTICS).toBe("zero-prompt-queue-v1");
    expect(ZERO_PROMPT_QUEUE_ITEM_STATES).toEqual(["queued", "promoted", "deleted"]);
    expect(ZERO_PROMPT_QUEUE_MUTATIONS).toEqual([
      "enqueue",
      "reorder",
      "edit",
      "delete",
      "promote-next",
    ]);
    expect(ZERO_PROMPT_QUEUE_EVENT_TYPES).toEqual([
      "queue.item.enqueued",
      "queue.item.reordered",
      "queue.item.edited",
      "queue.item.deleted",
      "queue.item.promoted",
    ]);
    expect(ZERO_PROMPT_QUEUE_ERROR_CODES).toEqual([
      "queue_edit_empty",
      "queue_active_turn_not_queue_item",
      "queue_full",
      "queue_item_text_too_long",
      "queue_item_not_found",
      "queue_item_terminal",
      "queue_position_invalid",
    ]);
    expect(ZERO_PROMPT_QUEUE_WARNING_CODES).toEqual([
      "queue_coherence_ordinal_reference_shifted",
      "queue_coherence_explicit_reference_broken",
    ]);
  });

  it("keeps active turns structurally distinct from queue items", () => {
    const activeTurn: ZeroPromptQueueActiveTurn = {
      kind: "active-turn",
      id: "turn-7",
      projectId: "project-52",
    };
    expect(activeTurn).toEqual({ kind: "active-turn", id: "turn-7", projectId: "project-52" });
    expect(activeTurn).not.toHaveProperty("position");
    expect(activeTurn).not.toHaveProperty("state");
  });

  it("is JSON serialization-ready without Date or Map instances", () => {
    const snapshot: ZeroPromptQueueSnapshot = {
      semantics: ZERO_PROMPT_QUEUE_SEMANTICS,
      projectId: "project-52",
      items: [
        {
          id: "item-1",
          projectId: "project-52",
          position: 1,
          currentText: "Add the flag",
          state: "queued",
          references: [{ kind: "ordinal", targetPosition: 2 }],
          terminalEvidence: null,
        },
      ],
    };
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("emits typed codes rather than user-facing prose", () => {
    const error = new ZeroPromptQueueError("queue_full");
    expect(error).toMatchObject({ name: "ZeroPromptQueueError", code: "queue_full" });
    expect(error.message).toBe("queue_full");
  });
});
