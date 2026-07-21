import AsyncStorage from "@react-native-async-storage/async-storage";

import type { OraPendingClarification } from "./types";

// Persistent cache of the pending clarification context so a clarifying
// question about an ambiguous uploaded-file edit still resolves after the app
// is fully closed and reopened, or after switching back to a saved
// conversation. Mirrors the website's sessionStorage cache (use-ora-chat.ts):
// keyed per conversation ("conv:<id>") with "standalone" for pre-conversation
// chat, tracked conversations capped so the map can't grow without bound.
// Cache-only: a stale pending context is harmless because the server's
// continuation guard drops contexts that no longer match the conversation.
// Never written in temporary mode; callers enforce that.
const PENDING_CLARIFICATION_STORAGE_KEY = "ora_pending_clarification";
const PENDING_CLARIFICATION_MAX_KEYS = 20;

// In-memory mirror so reads stay synchronous inside render-path callbacks
// (AsyncStorage is async; the chat screen needs sync access like the website
// gets from sessionStorage). Hydrated once via loadPendingClarificationStore().
let _map: Record<string, OraPendingClarification> = {};
let _loadPromise: Promise<void> | null = null;

function sanitizeMap(parsed: unknown): Record<string, OraPendingClarification> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const map: Record<string, OraPendingClarification> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { originalMessage?: unknown }).originalMessage === "string" &&
      typeof (value as { kind?: unknown }).kind === "string"
    ) {
      map[key] = value as OraPendingClarification;
    }
  }
  return map;
}

export function loadPendingClarificationStore(): Promise<void> {
  if (!_loadPromise) {
    _loadPromise = AsyncStorage.getItem(PENDING_CLARIFICATION_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        _map = sanitizeMap(JSON.parse(raw) as unknown);
      })
      .catch(() => {
        /* keep empty map */
      });
  }
  return _loadPromise;
}

export function getStoredPendingClarification(key: string): OraPendingClarification | null {
  return _map[key] ?? null;
}

export function storePendingClarification(
  key: string,
  pending: OraPendingClarification | null,
): void {
  if (pending == null) {
    delete _map[key];
  } else {
    _map[key] = pending;
  }
  // Cap tracked conversations so the map can't grow without bound.
  const keys = Object.keys(_map);
  if (keys.length > PENDING_CLARIFICATION_MAX_KEYS) {
    for (const stale of keys.slice(0, keys.length - PENDING_CLARIFICATION_MAX_KEYS)) {
      delete _map[stale];
    }
  }
  if (Object.keys(_map).length === 0) {
    void AsyncStorage.removeItem(PENDING_CLARIFICATION_STORAGE_KEY).catch(() => {});
  } else {
    void AsyncStorage.setItem(PENDING_CLARIFICATION_STORAGE_KEY, JSON.stringify(_map)).catch(
      () => {},
    );
  }
}

export function clearAllStoredPendingClarifications(): void {
  _map = {};
  void AsyncStorage.removeItem(PENDING_CLARIFICATION_STORAGE_KEY).catch(() => {});
}

// Test-only: reset module state between test cases.
export function __resetPendingClarificationStoreForTests(): void {
  _map = {};
  _loadPromise = null;
}
