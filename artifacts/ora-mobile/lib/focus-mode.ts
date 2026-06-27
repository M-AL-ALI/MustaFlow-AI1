import AsyncStorage from "@react-native-async-storage/async-storage";

import type { FocusMode } from "@/lib/types";

/**
 * Speaker-focus posture for Talk to Ora realtime voice, persisted CLIENT-SIDE
 * only (this device). Mirrors the website's localStorage preference; there is
 * intentionally NO server/DB persistence. Default is "focused".
 */
export const VOICE_FOCUS_STORAGE_KEY = "ora:voiceFocusMode";

export const DEFAULT_FOCUS_MODE: FocusMode = "focused";

/** Read the stored focus mode, defaulting to "focused" when unset/invalid. */
export async function readStoredFocusMode(): Promise<FocusMode> {
  try {
    const val = await AsyncStorage.getItem(VOICE_FOCUS_STORAGE_KEY);
    return val === "normal" || val === "focused" ? val : DEFAULT_FOCUS_MODE;
  } catch {
    return DEFAULT_FOCUS_MODE;
  }
}

/** Persist the focus mode for this device. Best-effort; failures are ignored. */
export async function writeStoredFocusMode(mode: FocusMode): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_FOCUS_STORAGE_KEY, mode);
  } catch {
    /* AsyncStorage unavailable — keep the in-memory choice. */
  }
}
