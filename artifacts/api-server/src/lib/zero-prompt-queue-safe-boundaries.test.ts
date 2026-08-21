import { describe, expect, it } from "vitest";
import type { ZeroPromptQueueItem } from "./zero-prompt-queue-contract";
import {
  ZERO_PROMPT_QUEUE_BOUNDARY_ERROR_CODES,
  ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
  ZERO_PROMPT_QUEUE_RUN_PHASES,
  ZeroPromptQueueBoundaryError,
} from "./zero-prompt-queue-boundary-contract";
import {
  ZERO_PROMPT_QUEUE_PHASE_RULES,
  planPromptQueueLandings,
} from "./zero-prompt-queue-safe-boundaries";

function queued(id: string, position: number): ZeroPromptQueueItem {
  return {
    id,
    projectId: "project-1",
    position,
    currentText: `prompt ${id}`,
    state: "queued",
    references: [],
    terminalEvidence: null,
  };
}

describe("zero prompt queue safe boundaries", () => {
  it("defines the closed phase and error contracts once", () => {
    expect(ZERO_PROMPT_QUEUE_RUN_PHASES).toEqual([
      "between_steps",
      "createChatCompletion",
      "parallel_tool_batch",
      "serial_tool_call",
      "executeSingleFileWrite",
      "executeBatchFileWrite",
      "finalize_check",
      "auto_check",
      "post_loop_check",
      "e2e_smoke",
      "e2e_auto_fix",
      "project_files_commit",
      "runPostWriteMigrationSync",
      "production_publish",
    ]);
    expect(ZERO_PROMPT_QUEUE_BOUNDARY_ERROR_CODES).toEqual([
      "queue_boundary_phase_invalid",
      "queue_boundary_item_not_queued",
      "queue_boundary_position_invalid",
    ]);
    expect(ZERO_PROMPT_QUEUE_PHASE_RULES.map((rule) => rule.phase)).toEqual(
      ZERO_PROMPT_QUEUE_RUN_PHASES,
    );
  });

  it.each(ZERO_PROMPT_QUEUE_PHASE_RULES)(
    "declares $phase without inference",
    ({ phase, safeLanding, nextSafeBoundary }) => {
      expect(nextSafeBoundary).toBe("between_steps");
      expect(safeLanding).toBe(phase === "between_steps");

      const [landing] = planPromptQueueLandings({
        currentPhase: phase,
        items: [queued("item-1", 1)],
      });
      expect(landing).toEqual({
        semantics: ZERO_PROMPT_QUEUE_BOUNDARY_SEMANTICS,
        itemId: "item-1",
        position: 1,
        currentPhase: phase,
        decision: phase === "between_steps" ? "lands_now" : "lands_later",
        landingPhase: "between_steps",
      });
    },
  );

  it("pins file-write, migration, publish, and batch phases as unsafe", () => {
    const unsafe = new Set(
      ZERO_PROMPT_QUEUE_PHASE_RULES.filter((rule) => !rule.safeLanding).map((rule) => rule.phase),
    );
    expect(unsafe).toEqual(
      new Set([
        "createChatCompletion",
        "parallel_tool_batch",
        "serial_tool_call",
        "executeSingleFileWrite",
        "executeBatchFileWrite",
        "finalize_check",
        "auto_check",
        "post_loop_check",
        "e2e_smoke",
        "e2e_auto_fix",
        "project_files_commit",
        "runPostWriteMigrationSync",
        "production_publish",
      ]),
    );
  });

  it("is deterministic across caller item ordering", () => {
    const ordered = [queued("item-a", 1), queued("item-b", 2), queued("item-c", 3)];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    const first = planPromptQueueLandings({ currentPhase: "auto_check", items: ordered });
    const second = planPromptQueueLandings({ currentPhase: "auto_check", items: shuffled });
    expect(second).toEqual(first);
    expect(first.map((landing) => landing.itemId)).toEqual(["item-a", "item-b", "item-c"]);
  });

  it("returns an empty deterministic plan for an empty queue", () => {
    expect(planPromptQueueLandings({ currentPhase: "between_steps", items: [] })).toEqual([]);
  });

  it("rejects an unknown phase with a typed error", () => {
    expect(() =>
      planPromptQueueLandings({ currentPhase: "mid_file_guess", items: [queued("item-1", 1)] }),
    ).toThrowError(
      expect.objectContaining<Partial<ZeroPromptQueueBoundaryError>>({
        name: "ZeroPromptQueueBoundaryError",
        code: "queue_boundary_phase_invalid",
      }),
    );
  });

  it("rejects terminal items and invalid positions with typed errors", () => {
    const terminal: ZeroPromptQueueItem = {
      ...queued("item-1", 1),
      state: "deleted",
      terminalEvidence: {
        kind: "deleted",
        deletedBy: "owner-user",
        provenanceEventId: "event-1",
        occurredAt: "2026-08-20T00:00:00.000Z",
      },
    };
    expect(() =>
      planPromptQueueLandings({ currentPhase: "between_steps", items: [terminal] }),
    ).toThrowError(expect.objectContaining({ code: "queue_boundary_item_not_queued" }));

    expect(() =>
      planPromptQueueLandings({
        currentPhase: "between_steps",
        items: [queued("item-1", 1), queued("item-2", 1)],
      }),
    ).toThrowError(expect.objectContaining({ code: "queue_boundary_position_invalid" }));
  });
});
