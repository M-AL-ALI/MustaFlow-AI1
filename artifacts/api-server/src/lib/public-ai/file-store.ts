/**
 * In-memory ephemeral file store for Ora Phase 2 (documents) + Phase 3 (datasets).
 *
 * Extracted plain text (documents) or DatasetSummary (CSV/XLSX) is always stored.
 * Small Office files may also keep raw bytes in memory only, so Ora can perform
 * layout-preserving edits during the same live session. Nothing is written to
 * the database or to disk.
 *
 * Entries expire after 2 hours and are evicted by a cleanup interval and on
 * every access attempt. The window is intentionally longer than the 30-minute
 * session JWT TTL (the sessionId itself is stable across token refresh) so an
 * active, longer conversation does not lose its uploaded files mid-session and
 * force the user to re-upload.
 */

import type { DatasetSummary } from "./dataset-extract.js";

export const MAX_TEXT_CHARS_PER_FILE = 25_000;
export const MAX_TOTAL_CHARS_PER_SESSION = 75_000;
export const FILE_LIMIT_PER_SESSION = 3;
export const MAX_RAW_BYTES_PER_FILE = 20 * 1024 * 1024;

const TTL_MS = 2 * 60 * 60 * 1000;
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
  rawBase64?: string;
  rawSizeBytes?: number;
  rawFileType?: "docx" | "pptx" | "xlsx";
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

/**
 * Insert or overwrite an entry under a KNOWN fileRef with a fresh TTL. Used by
 * (1) the durable rehydration path, so an entry rebuilt from the DB is served
 * from memory (with raw bytes) on subsequent turns of the current session, and
 * (2) the layout-preserving edit write-back, so consecutive edits compound on
 * the latest bytes instead of silently starting over from the original upload.
 */
export function putFileEntry(fileRef: string, entry: Omit<FileEntry, "expiresAt">): void {
  if (!store.has(fileRef) && store.size >= MAX_STORE_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) store.delete(oldest[0]);
  }
  store.set(fileRef, { ...entry, expiresAt: Date.now() + TTL_MS });
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
