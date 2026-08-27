import type { StreamCompletionSummary } from "./ai-providers";
import type { ZeroTerminalStopEvidence } from "@workspace/ora-contracts";

export const CONVERSE_INTERRUPTION_CODES = [
  "stream_aborted",
  "stream_ended_without_completion",
  "completion_truncated",
  "content_filtered",
] as const;

export type ConverseInterruptionCode = (typeof CONVERSE_INTERRUPTION_CODES)[number];

export type ConverseStopEvidence = ZeroTerminalStopEvidence;

const CLEAN_FINISH_REASONS = new Set(["stop", "end_turn"]);
const LENGTH_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);
const FILTER_FINISH_REASONS = new Set([
  "content_filter",
  "content_filtered",
  "safety",
  "blocked",
  "recitation",
]);

export class ConverseCompletionInterruptedError extends Error {
  readonly code: ConverseInterruptionCode;
  readonly partialText: string;
  readonly summary: StreamCompletionSummary;

  constructor(
    code: ConverseInterruptionCode,
    partialText: string,
    summary: StreamCompletionSummary,
  ) {
    super(code);
    this.name = "ConverseCompletionInterruptedError";
    this.code = code;
    this.partialText = partialText;
    this.summary = summary;
  }
}

export function completionSummaryFromResponse(input: {
  finishReason: string | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  refusal?: boolean;
  aborted?: boolean;
}): StreamCompletionSummary {
  return {
    finishReason: input.finishReason,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    reasoningTokens: input.reasoningTokens,
    refusal: input.refusal ?? false,
    aborted: input.aborted ?? false,
  };
}

/** A converse success must be earned by an explicit provider clean-stop receipt. */
export function requireCleanConverseCompletion(
  summary: StreamCompletionSummary | null,
  partialText: string,
): ConverseStopEvidence {
  const observed =
    summary ??
    completionSummaryFromResponse({
      finishReason: null,
      aborted: false,
    });
  const normalizedReason = observed.finishReason?.trim().toLowerCase() ?? null;

  let code: ConverseInterruptionCode | null = null;
  if (observed.aborted) {
    code = "stream_aborted";
  } else if (
    observed.refusal ||
    (normalizedReason && FILTER_FINISH_REASONS.has(normalizedReason))
  ) {
    code = "content_filtered";
  } else if (normalizedReason && LENGTH_FINISH_REASONS.has(normalizedReason)) {
    code = "completion_truncated";
  } else if (!normalizedReason || !CLEAN_FINISH_REASONS.has(normalizedReason)) {
    code = "stream_ended_without_completion";
  }

  if (code) {
    throw new ConverseCompletionInterruptedError(code, partialText, observed);
  }

  return { providerReason: observed.finishReason as string };
}
