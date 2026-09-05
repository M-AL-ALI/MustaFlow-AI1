/**
 * In-memory ephemeral image store for Ora Phase 5 (PNG/JPG/WEBP analysis).
 *
 * Stores base64-encoded processed images (EXIF stripped, dimensions capped).
 * Raw file bytes are discarded after processing in the upload handler.
 * Nothing is written to the database or to disk.
 *
 * Memory controls:
 *   - Max 50 global entries (evicts oldest on overflow)
 *   - Max 200 MB total bytes across all active entries
 *   - Per-session limit enforced by session JWT (IMAGE_LIMIT_VALUE = 2)
 *   - TTL: 15 minutes (shorter than the document store's 30 min)
 *   - Cleanup interval: 5 minutes
 *
 * Cross-session isolation: getImage() returns null when the sessionId does
 * not match the stored entry — visitor A cannot access visitor B's imageRef.
 */

export const IMAGE_LIMIT_PER_SESSION = 2;
export const IMAGE_ANALYSIS_LIMIT_PER_SESSION = 2;

const TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_GLOBAL_ENTRIES = 50;
const MAX_GLOBAL_BYTES = 200 * 1024 * 1024;

export interface ImageEntry {
  sessionId: string;
  readonly productScope: "ora";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  base64: string;
  expiresAt: number;
}

const store = new Map<string, ImageEntry>();

function totalStoredBytes(): number {
  let total = 0;
  for (const entry of store.values()) {
    total += entry.sizeBytes;
  }
  return total;
}

function evictOldest(): void {
  let oldestRef: string | null = null;
  let oldestExpiry = Infinity;
  for (const [ref, entry] of store.entries()) {
    if (entry.expiresAt < oldestExpiry) {
      oldestExpiry = entry.expiresAt;
      oldestRef = ref;
    }
  }
  if (oldestRef) store.delete(oldestRef);
}

setInterval(() => {
  const now = Date.now();
  for (const [ref, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(ref);
  }
}, CLEANUP_INTERVAL_MS).unref();

export type StoreImageResult = { ok: true; imageRef: string } | { ok: false; error: string };

export function storeImage(
  entry: Omit<ImageEntry, "expiresAt" | "productScope">,
): StoreImageResult {
  const now = Date.now();

  // Evict expired entries first before checking limits
  for (const [ref, e] of store.entries()) {
    if (e.expiresAt <= now) store.delete(ref);
  }

  // Evict oldest to stay within global entry cap
  while (store.size >= MAX_GLOBAL_ENTRIES) {
    evictOldest();
  }

  // Evict oldest to stay within global byte cap
  while (store.size > 0 && totalStoredBytes() + entry.sizeBytes > MAX_GLOBAL_BYTES) {
    evictOldest();
  }

  if (store.size >= MAX_GLOBAL_ENTRIES) {
    return {
      ok: false,
      error:
        "Image analysis is temporarily at capacity. Please try again in a moment or describe your question in text instead.",
    };
  }

  const imageRef = crypto.randomUUID();
  store.set(imageRef, Object.freeze({ ...entry, productScope: "ora", expiresAt: now + TTL_MS }));
  return { ok: true, imageRef };
}

/**
 * Retrieve an image entry by ref, enforcing:
 * - Expiry (deleted and returns null if expired)
 * - Session isolation (returns null if sessionId does not match)
 */
export function getImage(imageRef: string, sessionId: string): ImageEntry | null {
  const entry = store.get(imageRef);
  if (!entry) return null;
  if (entry.productScope !== "ora") return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(imageRef);
    return null;
  }
  if (entry.sessionId !== sessionId) return null;
  return entry;
}

export function getTotalBytesForSession(sessionId: string): number {
  let total = 0;
  const now = Date.now();
  for (const entry of store.values()) {
    if (entry.sessionId === sessionId && entry.expiresAt > now) {
      total += entry.sizeBytes;
    }
  }
  return total;
}

export function imageStoreSize(): number {
  return store.size;
}
