import AsyncStorage from "@react-native-async-storage/async-storage";
import { ORA_LAST_ACTIVE_AT_STORAGE_KEY } from "@workspace/ora-contracts";

export async function readOraLastActiveAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(ORA_LAST_ACTIVE_AT_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function markOraActive(atMs = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(ORA_LAST_ACTIVE_AT_STORAGE_KEY, String(atMs));
  } catch {
    /* AsyncStorage unavailable - the next open safely starts at home. */
  }
}
