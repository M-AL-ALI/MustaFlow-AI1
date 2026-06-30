/**
 * Durable rehydration layer on top of the in-memory Ora file-store.
 *
 * The in-memory `file-store.ts` is the fast path: session-scoped, ~2h TTL, and
 * wiped on restart. For SIGNED-IN users we ALSO mirror the extracted context
 * (document text or dataset summary) into the `ora_file_contexts` table at
 * upload time, so a follow-up question or "build a file from my upload" still
 * resolves the real data after the memory entry is gone (TTL/eviction/restart)
 * or the session JWT has rotated.
 *
 * Anonymous visitors stay memory-only — nothing is persisted or read from the
 * DB for them. Raw bytes are never stored here (only extracted text / dataset
 * summary needed to rebuild prompt context).
 */
import { db, oraFileContextsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "../logger";
import { getFile, type FileEntry } from "./file-store.js";
import type { DatasetSummary } from "./dataset-extract.js";

// Mirror the in-memory TTL on the FileEntry shape we synthesize from the DB.
// Nothing downstream re-checks this value (getFile already enforces expiry on
// the memory path), but keeping the field populated preserves the shape.
const REHYDRATE_TTL_MS = 2 * 60 * 60 * 1000;

export interface PersistFileContextInput {
  userId: string;
  fileRef: string;
  sessionId: string;
  assetId?: number | null;
  filename: string;
  mimeType: string;
  fileType: string;
  extractedText: string;
  charCount: number;
  datasetSummary?: DatasetSummary;
}

/**
 * Persist (upsert) the extracted context of a signed-in user's upload. Fully
 * best-effort and fire-and-forget: failures are logged and swallowed so an
 * upload never fails because the durable mirror is unavailable.
 */
export function persistFileContextBestEffort(input: PersistFileContextInput): void {
  void (async () => {
    try {
      await db
        .insert(oraFileContextsTable)
        .values({
          userId: input.userId,
          fileRef: input.fileRef,
          sessionId: input.sessionId,
          assetId: input.assetId ?? null,
          filename: input.filename,
          mimeType: input.mimeType,
          fileType: input.fileType,
          extractedText: input.extractedText,
          charCount: input.charCount,
          datasetSummary: input.datasetSummary ?? null,
        })
        .onConflictDoUpdate({
          target: [oraFileContextsTable.userId, oraFileContextsTable.fileRef],
          set: {
            sessionId: input.sessionId,
            assetId: input.assetId ?? null,
            filename: input.filename,
            mimeType: input.mimeType,
            fileType: input.fileType,
            extractedText: input.extractedText,
            charCount: input.charCount,
            datasetSummary: input.datasetSummary ?? null,
            updatedAt: new Date(),
            deletedAt: null,
          },
        });
    } catch (err) {
      logger.error({ component: "ora-file-context", err }, "Failed to persist Ora file context");
    }
  })();
}

/**
 * Read the durable context for a signed-in user's earlier upload, shaped as a
 * `FileEntry` so callers can treat it identically to the memory path. Ownership
 * is enforced by `user_id` (a stronger boundary than the anonymous sessionId
 * check), so a rotated session still resolves the user's own file.
 */
async function getDurableFileContext(fileRef: string, userId: string): Promise<FileEntry | null> {
  try {
    const [row] = await db
      .select()
      .from(oraFileContextsTable)
      .where(
        and(
          eq(oraFileContextsTable.fileRef, fileRef),
          eq(oraFileContextsTable.userId, userId),
          isNull(oraFileContextsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      filename: row.filename,
      mimeType: row.mimeType,
      extractedText: row.extractedText,
      charCount: row.charCount,
      expiresAt: Date.now() + REHYDRATE_TTL_MS,
      datasetSummary: (row.datasetSummary as DatasetSummary | null) ?? undefined,
    };
  } catch (err) {
    logger.error({ component: "ora-file-context", err }, "Failed to read Ora file context");
    return null;
  }
}

/**
 * Resolve an uploaded file's extracted context: memory first (works for both
 * anonymous and signed-in within the same live session), then — only for
 * signed-in users — the durable DB mirror by authenticated userId.
 */
export async function resolveFileEntry(
  fileRef: string,
  opts: { sessionId: string; userId?: string | null },
): Promise<FileEntry | null> {
  const memEntry = getFile(fileRef, opts.sessionId);
  if (memEntry) return memEntry;
  if (opts.userId) {
    return getDurableFileContext(fileRef, opts.userId);
  }
  return null;
}
