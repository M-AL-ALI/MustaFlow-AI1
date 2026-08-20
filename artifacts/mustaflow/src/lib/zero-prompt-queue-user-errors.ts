import { selectUserVisibleError } from "./user-visible-errors";

export const QUEUE_LOAD_FALLBACK_ERROR =
  "The queued prompts could not be loaded. Please try again.";
export const QUEUE_MUTATION_FALLBACK_ERROR =
  "The queued prompts could not be updated. Please try again.";

const USER_VISIBLE_QUEUE_ERROR_CODES = new Set([
  "queue_edit_empty",
  "queue_active_turn_not_queue_item",
  "queue_full",
  "queue_item_text_too_long",
  "queue_item_not_found",
  "queue_item_terminal",
  "queue_position_invalid",
  "queue_persistence_unavailable",
  "queue_persistence_contract_invalid",
  "queue_persistence_write_bound_exceeded",
  "queue_provenance_missing",
  "queue_request_invalid",
  "queue_unauthenticated",
  "queue_request_failed",
]);

export function selectPromptQueueError(
  value: unknown,
  fallback = QUEUE_MUTATION_FALLBACK_ERROR,
): string {
  return selectUserVisibleError(value, {
    fallback,
    allowedCodes: USER_VISIBLE_QUEUE_ERROR_CODES,
  });
}
