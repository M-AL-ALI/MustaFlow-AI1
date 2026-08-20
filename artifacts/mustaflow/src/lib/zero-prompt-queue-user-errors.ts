export const QUEUE_LOAD_FALLBACK_ERROR =
  "The queued prompts could not be loaded. Please try again.";
export const QUEUE_MUTATION_FALLBACK_ERROR =
  "The queued prompts could not be updated. Please try again.";

const TECHNICAL_ERROR_PATTERN = /postgres|constraint|sqlstate|stack|23505|internal server/i;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectPromptQueueError(
  value: unknown,
  fallback = QUEUE_MUTATION_FALLBACK_ERROR,
): string {
  if (!isRecord(value)) return fallback;
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.error === "string" ? value.error : "";
  if (
    !USER_VISIBLE_QUEUE_ERROR_CODES.has(code) ||
    message.length === 0 ||
    message.length > 240 ||
    TECHNICAL_ERROR_PATTERN.test(message)
  ) {
    return fallback;
  }
  return message;
}
