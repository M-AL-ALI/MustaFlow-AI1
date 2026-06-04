// Shared persistence for Ora memory preferences. These toggles control whether
// the chat endpoint injects the user's saved memories and prior chat history.
// Stored in localStorage so they persist across sessions and are read by both
// the memory settings page and the Ora chat hook.

const SAVED_MEMORIES_KEY = "ora_reference_saved_memories";
const CHAT_HISTORY_KEY = "ora_reference_chat_history";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export function getReferenceSavedMemories(): boolean {
  return readBool(SAVED_MEMORIES_KEY, true);
}

export function setReferenceSavedMemories(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SAVED_MEMORIES_KEY, String(value));
}

export function getReferenceChatHistory(): boolean {
  return readBool(CHAT_HISTORY_KEY, true);
}

export function setReferenceChatHistory(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CHAT_HISTORY_KEY, String(value));
}
