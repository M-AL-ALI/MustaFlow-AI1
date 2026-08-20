import { ZeroPromptQueueError, type ZeroPromptQueueErrorCode } from "./zero-prompt-queue-contract";
import {
  ZeroPromptQueuePersistenceError,
  type ZeroPromptQueuePersistenceErrorCode,
} from "./zero-prompt-queue-store";

type QueueErrorSpec = {
  status: number;
  message: string;
};

export const ZERO_PROMPT_QUEUE_USER_ERRORS = {
  queue_edit_empty: {
    status: 400,
    message: "A queued prompt cannot be empty. Add some text and try again.",
  },
  queue_active_turn_not_queue_item: {
    status: 409,
    message: "The active prompt is already running and cannot be changed from the queue.",
  },
  queue_full: {
    status: 409,
    message: "This queue already has 50 prompts. Remove or promote one before adding another.",
  },
  queue_item_text_too_long: {
    status: 400,
    message: "This prompt is too long. Keep it to 10,000 characters or fewer.",
  },
  queue_item_not_found: {
    status: 404,
    message: "That queued prompt could not be found.",
  },
  queue_item_terminal: {
    status: 409,
    message: "That prompt has already left the queue and cannot be changed.",
  },
  queue_position_invalid: {
    status: 409,
    message: "That queue position is not available. Choose a position within the current queue.",
  },
  queue_persistence_unavailable: {
    status: 503,
    message: "The queued prompts are temporarily unavailable. Please try again.",
  },
  queue_persistence_contract_invalid: {
    status: 500,
    message: "Something went wrong while updating the queued prompts. Please try again.",
  },
  queue_persistence_write_bound_exceeded: {
    status: 500,
    message: "Something went wrong while updating the queued prompts. Please try again.",
  },
  queue_provenance_missing: {
    status: 500,
    message: "Something went wrong while updating the queued prompts. Please try again.",
  },
} as const satisfies Record<
  ZeroPromptQueueErrorCode | ZeroPromptQueuePersistenceErrorCode,
  QueueErrorSpec
>;

const UNKNOWN_QUEUE_ERROR: QueueErrorSpec = {
  status: 500,
  message: "Something went wrong while updating the queued prompts. Please try again.",
};

export type ZeroPromptQueueHttpError = {
  status: number;
  body: {
    code: ZeroPromptQueueErrorCode | ZeroPromptQueuePersistenceErrorCode | "queue_request_failed";
    error: string;
  };
};

export function zeroPromptQueueHttpError(error: unknown): ZeroPromptQueueHttpError {
  const typed =
    error instanceof ZeroPromptQueueError || error instanceof ZeroPromptQueuePersistenceError;
  const spec = typed ? ZERO_PROMPT_QUEUE_USER_ERRORS[error.code] : UNKNOWN_QUEUE_ERROR;
  return {
    status: spec.status,
    body: {
      code: typed ? error.code : "queue_request_failed",
      error: spec.message,
    },
  };
}
