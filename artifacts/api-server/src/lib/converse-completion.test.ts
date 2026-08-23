import { describe, expect, it } from "vitest";
import { interruptedTerminal, presentZeroTerminalV1 } from "@workspace/ora-contracts";
import {
  completionSummaryFromResponse,
  CONVERSE_INTERRUPTION_CODES,
  ConverseCompletionInterruptedError,
  requireCleanConverseCompletion,
} from "./converse-completion";

function summary(
  finishReason: string | null,
  overrides: Partial<ReturnType<typeof completionSummaryFromResponse>> = {},
) {
  return { ...completionSummaryFromResponse({ finishReason }), ...overrides };
}

describe("converse clean-stop classification", () => {
  it.each(["stop", "end_turn", "STOP"])(
    "earns response success only from the provider clean-stop reason %s",
    (providerReason) => {
      expect(requireCleanConverseCompletion(summary(providerReason), "Complete answer.")).toEqual({
        providerReason,
      });
    },
  );

  it.each([
    [null, "stream_ended_without_completion"],
    ["unknown", "stream_ended_without_completion"],
    ["length", "completion_truncated"],
    ["max_tokens", "completion_truncated"],
    ["MAX_TOKENS", "completion_truncated"],
    ["content_filter", "content_filtered"],
    ["SAFETY", "content_filtered"],
  ] as const)("classifies %s as %s", (finishReason, code) => {
    expect(() => requireCleanConverseCompletion(summary(finishReason), "Partial answer")).toThrow(
      expect.objectContaining({
        name: "ConverseCompletionInterruptedError",
        code,
        partialText: "Partial answer",
      }),
    );
  });

  it("classifies an abort before every provider finish reason", () => {
    expect(() =>
      requireCleanConverseCompletion(summary("stop", { aborted: true }), "Partial answer"),
    ).toThrow(expect.objectContaining({ code: "stream_aborted" }));
  });

  it("classifies a provider refusal as filtered and keeps the partial text", () => {
    try {
      requireCleanConverseCompletion(summary("stop", { refusal: true }), "Safe partial text");
      throw new Error("expected classification to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConverseCompletionInterruptedError);
      expect(error).toMatchObject({
        code: "content_filtered",
        partialText: "Safe partial text",
      });
    }
  });

  it("fails closed when a stream caller receives no summary", () => {
    expect(() => requireCleanConverseCompletion(null, "Partial answer")).toThrow(
      expect.objectContaining({ code: "stream_ended_without_completion" }),
    );
  });

  it("gives every closed interruption code a classifier path and honest presenter copy", () => {
    const inputs = {
      stream_aborted: summary("stop", { aborted: true }),
      stream_ended_without_completion: summary(null),
      completion_truncated: summary("length"),
      content_filtered: summary("content_filter"),
    } satisfies Record<(typeof CONVERSE_INTERRUPTION_CODES)[number], ReturnType<typeof summary>>;

    for (const code of CONVERSE_INTERRUPTION_CODES) {
      let observedCode: string | null = null;
      try {
        requireCleanConverseCompletion(inputs[code], "Partial answer");
      } catch (error) {
        expect(error).toBeInstanceOf(ConverseCompletionInterruptedError);
        observedCode = (error as ConverseCompletionInterruptedError).code;
      }
      expect(observedCode).toBe(code);

      const presentation = presentZeroTerminalV1(
        interruptedTerminal({
          schema: "zero-terminal-v1",
          taskId: 41,
          intent: "answer",
          intentReceiptId: 91,
          completedAt: "2026-08-23T05:31:23.000Z",
          outcome: "interrupted",
          runStatus: "interrupted",
          cause: code,
          evidence: { lastPhase: "response_stream", changedPaths: [] },
        }),
      );
      expect(presentation).toMatchObject({
        tone: "interrupted",
        taskStatus: "canceled",
        shouldRefreshPreview: false,
      });
      expect(`${presentation.title} ${presentation.message}`).not.toMatch(
        /response sent|finished|ready/i,
      );
      expect(presentation.message).toMatch(/please/i);
    }
  });
});
