import {
  ORA_LAST_ACTIVE_AT_STORAGE_KEY,
  shouldResumeOraConversation,
} from "@workspace/ora-contracts";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function readOraLastActiveAt(storage: ReadableStorage = window.localStorage): number | null {
  try {
    const raw = storage.getItem(ORA_LAST_ACTIVE_AT_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function markOraActive(
  atMs = Date.now(),
  storage: WritableStorage = window.localStorage,
): void {
  try {
    storage.setItem(ORA_LAST_ACTIVE_AT_STORAGE_KEY, String(atMs));
  } catch {
    /* localStorage unavailable - the next open safely starts at home. */
  }
}

/**
 * Gate a stored conversation id without mutating either storage location.
 * The id remains available for history and future explicit selection.
 */
export function idleGatedOraConversationId(
  storedConversationId: number | null,
  nowMs = Date.now(),
  storage: ReadableStorage = window.localStorage,
): number | null {
  return shouldResumeOraConversation(readOraLastActiveAt(storage), nowMs)
    ? storedConversationId
    : null;
}
