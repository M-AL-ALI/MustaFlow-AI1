import AsyncStorage from "@react-native-async-storage/async-storage";

// Persistent cache of uploaded document/dataset refs so "Revise the deck ..."
// still targets the ORIGINAL uploaded file after the app is fully closed and
// reopened, or after switching back to a saved conversation. Mirrors the
// website's sessionStorage cache (use-ora-chat.ts): keyed per conversation
// ("conv:<id>") with "standalone" for pre-conversation chat, refs capped at
// the server max (5), tracked conversations capped so the map can't grow
// without bound. This is a cache only — stale refs are harmless because the
// server skips refs it can't resolve (and signed-in users also recover via
// the server-side durable mirror). Never written in temporary mode; callers
// enforce that.
const DOC_REFS_STORAGE_KEY = "ora_doc_refs";
export const DOC_REFS_STANDALONE_KEY = "standalone";
const DOC_REFS_MAX_KEYS = 20;
const DOC_REFS_MAX_REFS = 5;

// In-memory mirror so reads stay synchronous inside render-path callbacks
// (AsyncStorage is async; the chat screen needs sync access like the website
// gets from sessionStorage). Hydrated once via loadDocumentRefsStore().
let _map: Record<string, string[]> = {};
let _loadPromise: Promise<void> | null = null;

export function docRefsKey(conversationId: number | null | undefined): string {
  return typeof conversationId === "number" ? `conv:${conversationId}` : DOC_REFS_STANDALONE_KEY;
}

function sanitizeMap(parsed: unknown): Record<string, string[]> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const map: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      map[key] = value.filter((v): v is string => typeof v === "string");
    }
  }
  return map;
}

export function loadDocumentRefsStore(): Promise<void> {
  if (!_loadPromise) {
    _loadPromise = AsyncStorage.getItem(DOC_REFS_STORAGE_KEY)
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

export function getStoredDocumentRefs(key: string): string[] {
  return _map[key] ?? [];
}

export function storeDocumentRefs(key: string, refs: string[]): void {
  if (refs.length === 0) {
    delete _map[key];
  } else {
    // Callers maintain newest-FIRST ordering ([ref, ...prev]), so keep the
    // head of the list when capping.
    _map[key] = refs.slice(0, DOC_REFS_MAX_REFS);
  }
  // Cap tracked conversations so the map can't grow without bound.
  const keys = Object.keys(_map);
  if (keys.length > DOC_REFS_MAX_KEYS) {
    for (const stale of keys.slice(0, keys.length - DOC_REFS_MAX_KEYS)) delete _map[stale];
  }
  if (Object.keys(_map).length === 0) {
    void AsyncStorage.removeItem(DOC_REFS_STORAGE_KEY).catch(() => {});
  } else {
    void AsyncStorage.setItem(DOC_REFS_STORAGE_KEY, JSON.stringify(_map)).catch(() => {});
  }
}

export function clearAllStoredDocumentRefs(): void {
  _map = {};
  void AsyncStorage.removeItem(DOC_REFS_STORAGE_KEY).catch(() => {});
}

// Test-only: reset module state between test cases.
export function __resetDocumentRefsStoreForTests(): void {
  _map = {};
  _loadPromise = null;
}
