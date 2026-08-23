export interface EmptyCompletionDetails {
  finishReason: string | null;
  outputTokens: number;
  reasoningTokens?: number;
  refusal?: boolean;
}

/** A transport-successful provider completion with no user-visible text. */
export class EmptyCompletionError extends Error {
  readonly code = "empty_completion" as const;
  readonly finishReason: string | null;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly refusal: boolean;

  constructor(details: EmptyCompletionDetails = { finishReason: null, outputTokens: 0 }) {
    super("Provider returned an empty completion");
    this.name = "EmptyCompletionError";
    this.finishReason = details.finishReason;
    this.outputTokens = details.outputTokens;
    this.reasoningTokens = details.reasoningTokens;
    this.refusal = details.refusal === true;
  }
}
