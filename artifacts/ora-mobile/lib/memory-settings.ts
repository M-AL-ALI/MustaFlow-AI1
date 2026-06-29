import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_REF_MEMORIES = "ora_ref_memories";
const KEY_REF_HISTORY = "ora_ref_history";
const KEY_AUTO_SAVE = "ora_auto_save_mem";
const KEY_ASK_SENSITIVE = "ora_ask_before_sensitive";

let _refMemories = true;
let _refHistory = true;
let _autoSave = true;
let _askSensitive = false;

export async function loadMemorySettings(): Promise<void> {
  try {
    const results = await AsyncStorage.multiGet([
      KEY_REF_MEMORIES,
      KEY_REF_HISTORY,
      KEY_AUTO_SAVE,
      KEY_ASK_SENSITIVE,
    ]);
    const [rm, rh, as_, ask] = results;
    if (rm[1] !== null) _refMemories = rm[1] !== "false";
    if (rh[1] !== null) _refHistory = rh[1] !== "false";
    if (as_[1] !== null) _autoSave = as_[1] !== "false";
    if (ask[1] !== null) _askSensitive = ask[1] === "true";
  } catch {
    /* keep defaults */
  }
}

export function getReferenceSavedMemories(): boolean {
  return _refMemories;
}
export function setReferenceSavedMemories(v: boolean): void {
  _refMemories = v;
  void AsyncStorage.setItem(KEY_REF_MEMORIES, String(v)).catch(() => {});
}

export function getReferenceChatHistory(): boolean {
  return _refHistory;
}
export function setReferenceChatHistory(v: boolean): void {
  _refHistory = v;
  void AsyncStorage.setItem(KEY_REF_HISTORY, String(v)).catch(() => {});
}

export function getAutoSaveMemories(): boolean {
  return _autoSave;
}
export function setAutoSaveMemories(v: boolean): void {
  _autoSave = v;
  void AsyncStorage.setItem(KEY_AUTO_SAVE, String(v)).catch(() => {});
}

export function getAskBeforeSensitive(): boolean {
  return _askSensitive;
}
export function setAskBeforeSensitive(v: boolean): void {
  _askSensitive = v;
  void AsyncStorage.setItem(KEY_ASK_SENSITIVE, String(v)).catch(() => {});
}
