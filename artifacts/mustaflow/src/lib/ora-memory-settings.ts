// Shared persistence for Ora memory preferences. These toggles control whether
// the chat endpoint injects the user's saved memories and prior chat history.
// Stored in localStorage so they persist across sessions and are read by both
// the memory settings page and the Ora chat hook.

const SAVED_MEMORIES_KEY = "ora_reference_saved_memories";
const CHAT_HISTORY_KEY = "ora_reference_chat_history";
const AUTO_SAVE_MEMORIES_KEY = "ora_auto_save_memories";
const ASK_BEFORE_SENSITIVE_KEY = "ora_ask_before_sensitive";

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

// When enabled (the default), durable, non-sensitive memory candidates Ora
// detects are saved automatically without an extra click — so useful facts are
// captured by default instead of relying on the user to press "save". Sensitive
// candidates are still gated by the ask-before-sensitive safeguard, and the
// whole behavior can be turned off. Auto-save additionally requires
// reference-saved-memories to be on, since saving is pointless if Ora will never
// read the memory back.
export function getAutoSaveMemories(): boolean {
  return readBool(AUTO_SAVE_MEMORIES_KEY, true);
}

export function setAutoSaveMemories(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTO_SAVE_MEMORIES_KEY, String(value));
}

// When enabled (the default), Ora always asks for confirmation before saving a
// memory it detects as sensitive (passwords, financial details, etc.) instead
// of auto-saving it. The server independently forces sensitive candidates to
// low confidence so they are never auto-saved — this toggle is the client-side
// expression of that safeguard.
export function getAskBeforeSensitive(): boolean {
  return readBool(ASK_BEFORE_SENSITIVE_KEY, true);
}

export function setAskBeforeSensitive(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ASK_BEFORE_SENSITIVE_KEY, String(value));
}
