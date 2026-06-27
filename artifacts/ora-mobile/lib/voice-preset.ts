import AsyncStorage from "@react-native-async-storage/async-storage";

import type { VoicePreset } from "@/lib/types";

/**
 * Product voice for Talk to Ora spoken replies, persisted CLIENT-SIDE only
 * (this device). Mirrors the website's localStorage preference; there is
 * intentionally NO server/DB persistence. "marine" = female, "mustafa" = male.
 * The server maps the preset to the underlying provider voice; the raw provider
 * voice id never reaches the device. Default is "marine".
 */
export const VOICE_PRESET_STORAGE_KEY = "ora:voicePreset";

export const DEFAULT_VOICE_PRESET: VoicePreset = "marine";

/** Display labels for the product voices. */
export const VOICE_PRESET_LABELS: Record<VoicePreset, string> = {
  marine: "Marine",
  mustafa: "Mustafa",
};

/** Read the stored product voice, defaulting to "marine" when unset/invalid. */
export async function readStoredVoicePreset(): Promise<VoicePreset> {
  try {
    const val = await AsyncStorage.getItem(VOICE_PRESET_STORAGE_KEY);
    return val === "marine" || val === "mustafa" ? val : DEFAULT_VOICE_PRESET;
  } catch {
    return DEFAULT_VOICE_PRESET;
  }
}

/** Persist the product voice for this device. Best-effort; failures are ignored. */
export async function writeStoredVoicePreset(preset: VoicePreset): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_PRESET_STORAGE_KEY, preset);
  } catch {
    /* AsyncStorage unavailable — keep the in-memory choice. */
  }
}
