import { describe, expect, it } from "vitest";
import {
  ORA_CLARIFICATION_QUESTIONS,
  planOraClarification,
  resolveClarificationContinuation,
  type OraClarificationPlanInput,
} from "../clarification-planner";
import { isUploadedFileModificationRequest } from "../prompt";
import { resolveFinalOraRoute } from "../route-resolution";
import type { OraRouteDecision } from "../orchestrator";

/**
 * Phase 4 — Clarifying Questions regression suite.
 *
 * `planOraClarification` is the deterministic pre-LLM planner that decides
 * whether Ora should ask ONE clarifying question instead of guessing on an
 * ambiguous uploaded-file edit. These tests exercise the REAL pattern helpers
 * (no mocks):
 *
 *   1. The four ambiguity kinds fire on their canonical phrasings.
 *   2. Any concrete instruction (direction, quoted text, named source,
 *      explicit format, stated modification) keeps the request CLEAR.
 *   3. One question per task max (hasPendingClarification caps it), and a
 *      clarification never fires without carried docs or against a resolved
 *      image/search/ZIP/forced-search escape.
 *   4. `resolveClarificationContinuation` merges the user's answer with the
 *      original ask (and the merged message re-routes to the file editor),
 *      while a complete new instruction bypasses a stale pending context.
 */

const DOCX_DOCS = "File: quarterly-report.docx\nContent:\nQ3 revenue summary and highlights.";
const MULTI_DOCS =
  "File: pitch-deck.pptx\nContent:\nSlide 1 overview.\n\nFile: sales-data.xlsx\nContent:\nRegion,Revenue";

function planInput(overrides: Partial<OraClarificationPlanInput>): OraClarificationPlanInput {
  return {
    message: "Make this better.",
    carriedDocs: DOCX_DOCS,
    finalTool: "file_generation",
    conflictResolution: null,
    inferredFileFormat: "docx",
    hasPendingClarification: false,
    ...overrides,
  };
}

function decision(
  tool: OraRouteDecision["tool"],
  extra?: Partial<OraRouteDecision>,
): OraRouteDecision {
  return {
    tool,
    reason: "test-orchestrator-decision",
    intent: "premium",
    confidence: "high",
    topic: "general",
    ...extra,
  };
}

describe("Phase 4 clarifying questions — ambiguous asks trigger ONE question", () => {
  it("'Make this better.' asks the layout-vs-redesign question", { timeout: 30000 }, () => {
    const plan = planOraClarification(planInput({ message: "Make this better." }));
    expect(plan?.kind).toBe("vague_file_edit");
    expect(plan?.question).toBe(ORA_CLARIFICATION_QUESTIONS.vague_file_edit);
    expect(plan?.pendingTaskContext).toEqual({
      originalMessage: "Make this better.",
      kind: "vague_file_edit",
      inferredFileFormat: "docx",
    });
  });

  it("'Return it after modification.' asks what to modify (answer route too)", () => {
    const plan = planOraClarification(
      planInput({
        message: "Return it after modification.",
        finalTool: "answer",
        inferredFileFormat: null,
      }),
    );
    expect(plan?.kind).toBe("missing_edit_instruction");
  });

  it("'Please send it back with the updates.' also counts as uninstructed", () => {
    const plan = planOraClarification(
      planInput({
        message: "Please send it back with the updates.",
        finalTool: "answer",
        inferredFileFormat: null,
      }),
    );
    expect(plan?.kind).toBe("missing_edit_instruction");
  });

  it("'Update the presentation.' with data+deck uploads asks which source to use", () => {
    const plan = planOraClarification(
      planInput({
        message: "Update the presentation.",
        carriedDocs: MULTI_DOCS,
        inferredFileFormat: "pptx",
      }),
    );
    expect(plan?.kind).toBe("multi_file_source");
    // The question names the actual carried files so the user can answer.
    expect(plan?.question).toContain("sales-data.xlsx");
    expect(plan?.question).toContain("pitch-deck.pptx");
  });

  it("'Change the pricing section.' asks for the exact replacement target", () => {
    const plan = planOraClarification(planInput({ message: "Change the pricing section." }));
    expect(plan?.kind).toBe("unclear_replacement_target");
  });

  it("destructive uploaded-file edits show a preview and wait for confirmation", () => {
    const plan = planOraClarification(
      planInput({
        message: "Delete slide 3 and return the PowerPoint file.",
        inferredFileFormat: "pptx",
        files: [{ fileRef: "pptx-1", filename: "board-review.pptx" }],
      }),
    );
    expect(plan?.kind).toBe("file_edit_preview_confirmation");
    expect(plan?.question).toContain("wait for your confirmation");
    expect(plan?.pendingTaskContext.kind).toBe("file_edit_preview_confirmation");
    expect(plan?.fileAgentPreview?.status).toBe("needs_confirmation");
    expect(plan?.fileAgentPreview?.detectedInputs).toContain("board-review.pptx");
    expect(plan?.fileAgentPreview?.plannedActions).toContain(
      "Remove the requested content from the uploaded file",
    );
  });

  it("honors an explicit preview-before-apply request even with quoted replacement text", () => {
    const plan = planOraClarification(
      planInput({
        message:
          'Preview the edit before applying: replace "Q3 targets" with "H2 goals" in the uploaded deck.',
        inferredFileFormat: "pptx",
        files: [{ fileRef: "pptx-1", filename: "board-review.pptx" }],
      }),
    );
    expect(plan?.kind).toBe("file_edit_preview_confirmation");
    expect(plan?.fileAgentPreview?.summary).toContain("wait for you to confirm");
  });
});

describe("Phase 4 clarifying questions — clear requests execute immediately", () => {
  const clearCases: Array<[string, Partial<OraClarificationPlanInput>]> = [
    [
      "a specific section + content instruction",
      {
        message:
          "Rewrite the Risk Notes section of the uploaded DOCX to mention the 2026 audit deadline.",
      },
    ],
    [
      "a directional improvement ('more professional')",
      { message: "Make this more professional." },
    ],
    [
      "quoted replacement text pinpoints the target",
      { message: 'Change the pricing section to say "starting at $99".' },
    ],
    [
      "a named data source on a multi-file edit",
      {
        message: "Update the presentation using the spreadsheet data.",
        carriedDocs: MULTI_DOCS,
        inferredFileFormat: "pptx",
      },
    ],
    [
      "a stated modification on a return-it ask",
      { message: "Return it after changing the title to Q3 Update." },
    ],
  ];

  for (const [label, overrides] of clearCases) {
    it(`${label} → no clarification`, () => {
      expect(planOraClarification(planInput(overrides))).toBeNull();
    });
  }

  it("never asks without carried docs", () => {
    expect(
      planOraClarification(
        planInput({ carriedDocs: "", finalTool: "answer", inferredFileFormat: null }),
      ),
    ).toBeNull();
  });

  it("asks at most once per task (pendingClarification echo caps it)", () => {
    expect(planOraClarification(planInput({ hasPendingClarification: true }))).toBeNull();
  });

  it("never fights a resolved image/search/ZIP/forced-search escape", () => {
    for (const conflictResolution of [
      "explicit_image_over_edit",
      "search_over_edit_current_info",
      "zip_analysis_guard",
      "force_search_pin",
    ] as const) {
      expect(planOraClarification(planInput({ conflictResolution }))).toBeNull();
    }
  });

  it("only the file-edit and answer routes are eligible", () => {
    expect(planOraClarification(planInput({ finalTool: "search" }))).toBeNull();
    expect(planOraClarification(planInput({ finalTool: "image_generation" }))).toBeNull();
  });
});

describe("Phase 4 clarifying questions — continuation merge", () => {
  const pending = {
    originalMessage: "Make this better.",
    kind: "vague_file_edit" as const,
    inferredFileFormat: "docx" as const,
  };

  it("merges the answer with the original ask and re-routes to the file editor", () => {
    const cont = resolveClarificationContinuation({
      message: "Keep the original layout, just tighten the wording",
      pending,
      carriedDocs: DOCX_DOCS,
    });
    expect(cont.applied).toBe(true);
    expect(cont.routedMessage).toContain("Make this better.");
    expect(cont.routedMessage).toContain("User clarification: Keep the original layout");
    // The merged message must read as an uploaded-file edit and re-route to
    // file_generation with the original format — otherwise the answered
    // clarification would fall back to plain chat.
    expect(isUploadedFileModificationRequest(cont.routedMessage)).toBe(true);
    const rerouted = resolveFinalOraRoute({
      decision: decision("answer"),
      message: cont.routedMessage,
      carriedDocs: DOCX_DOCS,
      forceSearch: false,
    });
    expect(rerouted.decision.tool).toBe("file_generation");
    expect(rerouted.decision.fileFormat).toBe("docx");
  });

  it("a complete new instruction bypasses a stale pending context", () => {
    const cont = resolveClarificationContinuation({
      message: "Delete slide 3 and send it back",
      pending,
      carriedDocs: DOCX_DOCS,
    });
    expect(cont.applied).toBe(false);
    expect(cont.routedMessage).toBe("Delete slide 3 and send it back");
  });

  it("no pending context is a no-op", () => {
    const cont = resolveClarificationContinuation({
      message: "Keep the original layout",
      pending: null,
      carriedDocs: DOCX_DOCS,
    });
    expect(cont.applied).toBe(false);
    expect(cont.routedMessage).toBe("Keep the original layout");
  });
});

describe("Phase 9B file edit preview confirmation continuation", () => {
  const pending = {
    originalMessage: "Delete slide 3 and return the PowerPoint file.",
    kind: "file_edit_preview_confirmation" as const,
    inferredFileFormat: "pptx" as const,
  };

  it("apply confirmation merges back to the original file edit request", () => {
    const cont = resolveClarificationContinuation({
      message: "Apply edit",
      pending,
      carriedDocs: MULTI_DOCS,
    });
    expect(cont.applied).toBe(true);
    expect(cont.routedMessage).toContain("Delete slide 3");
    expect(cont.routedMessage).toContain("apply the planned edit now");
    expect(isUploadedFileModificationRequest(cont.routedMessage)).toBe(true);
  });

  it("redesign action explicitly permits rebuilding instead of preserving layout", () => {
    const cont = resolveClarificationContinuation({
      message: "Create a redesigned copy instead",
      pending,
      carriedDocs: MULTI_DOCS,
    });
    expect(cont.applied).toBe(true);
    expect(cont.routedMessage).toContain("create a redesigned copy instead");
    expect(cont.routedMessage).toContain("preserving the original layout is not required");
  });

  it("revised instructions update the pending edit instead of ignoring the preview context", () => {
    const cont = resolveClarificationContinuation({
      message: "Delete slide 4 instead, and keep all speaker notes",
      pending,
      carriedDocs: MULTI_DOCS,
    });
    expect(cont.applied).toBe(true);
    expect(cont.routedMessage).toContain("User clarification: Delete slide 4 instead");
  });
});
