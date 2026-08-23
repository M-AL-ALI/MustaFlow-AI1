import { EmptyCompletionError } from "./empty-completion";

export const EMPTY_COMPLETION_USER_MESSAGE =
  "Zero couldn't finish this response. Please try again." as const;

export type ConverseFailure = {
  code: "empty_completion" | "conversation_failed";
  message: string;
};

/** Maps provider failures to the typed, human-facing terminal truth. */
export function describeConverseFailure(error: unknown): ConverseFailure {
  return error instanceof EmptyCompletionError
    ? { code: "empty_completion", message: EMPTY_COMPLETION_USER_MESSAGE }
    : { code: "conversation_failed", message: "I wasn't able to answer that request." };
}
