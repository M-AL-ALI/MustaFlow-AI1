/**
 * In-memory ephemeral file store for Ora Phase 2 (documents) + Phase 3 (datasets).
 *
 * Only extracted plain text (documents) or DatasetSummary (CSV/XLSX) is stored
 * — raw file bytes are discarded immediately after extraction. Nothing is written
 * to the database or to disk.
 *
 * Entries expire after 30 minutes (matching the session JWT TTL) and are evicted
 * by a cleanup interval and on every access attempt.
 */

import type { DatasetSummary } from "./dataset-extract.js";

export const MAX_TEXT_CHARS_PER_FILE = 25_000;
export const MAX_TOTAL_CHARS_PER_SESSION = 75_000;
export const FILE_LIMIT_PER_SESSION = 3;

const TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_STORE_ENTRIES = 2_000;

export interface FileEntry {
  sessionId: string;
  filename: string;
  mimeType: string;
  extractedText: string;
  charCount: number;
  expiresAt: number;
  datasetSummary?: DatasetSummary;
}

const store = new Map<string, FileEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [ref, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(ref);
  }
}, CLEANUP_INTERVAL_MS).unref();

export function storeFile(entry: Omit<FileEntry, "expiresAt">): string {
  if (store.size >= MAX_STORE_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) store.delete(oldest[0]);
  }
  const fileRef = crypto.randomUUID();
  store.set(fileRef, { ...entry, expiresAt: Date.now() + TTL_MS });
  return fileRef;
}

export function getFile(fileRef: string, sessionId: string): FileEntry | null {
  const entry = store.get(fileRef);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(fileRef);
    return null;
  }
  if (entry.sessionId !== sessionId) return null;
  return entry;
}

export function getTotalCharsForSession(sessionId: string): number {
  let total = 0;
  for (const entry of store.values()) {
    if (entry.sessionId === sessionId && entry.expiresAt > Date.now()) {
      total += entry.charCount;
    }
  }
  return total;
}

export function storeSize(): number {
  return store.size;
}
