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
import {
  getFile,
  putFileEntry,
  overwriteFileEntryBytesByRef,
  MAX_RAW_BYTES_PER_FILE,
  MAX_TEXT_CHARS_PER_FILE,
  type FileEntry,
} from "./file-store.js";
import type { DatasetSummary } from "./dataset-extract.js";

// Mirror the in-memory TTL on the FileEntry shape we synthesize from the DB.
// Nothing downstream re-checks this value (getFile already enforces expiry on
// the memory path), but keeping the field populated preserves the shape.
const REHYDRATE_TTL_MS = 2 * 60 * 60 * 1000;

export interface PersistFileContextInput {
  userId: string;
  /** Ora project this upload belongs to. Null/omitted = Personal space. */
  oraProjectId?: number | null;
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
export async function persistFileContext(input: PersistFileContextInput): Promise<void> {
  await db
    .insert(oraFileContextsTable)
    .values({
      userId: input.userId,
      oraProjectId: input.oraProjectId ?? null,
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
        // The original project binding is immutable across retries.
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
}

export function persistFileContextBestEffort(input: PersistFileContextInput): void {
  void (async () => {
    try {
      await persistFileContext(input);
    } catch (err) {
      logger.error({ component: "ora-file-context", err }, "Failed to persist Ora file context");
    }
  })();
}

/**
 * After a REAL in-place Office edit, repoint the durable mirror at the newly
 * persisted (edited) library asset so revisions after a restart or rotated
 * session compound on the edited bytes instead of silently reverting to the
 * original upload. Reads the freshly written-back memory entry (which carries
 * the re-extracted text). Best-effort and fire-and-forget, like the mirror
 * writes at upload time.
 */
export function relinkDurableFileContextBestEffort(opts: {
  fileRef: string;
  sessionId: string;
  userId: string;
  assetId: number;
}): void {
  const entry = getFile(opts.fileRef, opts.sessionId);
  // Only Office entries with raw bytes participate in durable raw-byte
  // rehydration; skip anything else rather than corrupt the row's fileType.
  if (!entry?.rawFileType) return;
  persistFileContextBestEffort({
    userId: opts.userId,
    fileRef: opts.fileRef,
    sessionId: opts.sessionId,
    assetId: opts.assetId,
    filename: entry.filename,
    mimeType: entry.mimeType,
    fileType: entry.rawFileType,
    extractedText: entry.extractedText,
    charCount: entry.charCount,
    datasetSummary: entry.datasetSummary,
  });
}

/**
 * AWAITED relink after a version restore. Unlike
 * `relinkDurableFileContextBestEffort` (fire-and-forget, and a no-op when the
 * in-memory entry is gone), this must complete before the restore response:
 *
 *   1. Repoints `ora_file_contexts.assetId` for (userId, fileRef) at the newly
 *      persisted restored asset — unconditionally, no memory entry required —
 *      so post-restart/rotated-session edits compound on the restored bytes.
 *   2. Re-extracts text from the restored bytes for docx/pptx (best-effort) so
 *      analysis prompts reflect the restored content, not the pre-restore edit.
 *   3. Overwrites any LIVE in-memory entry's raw bytes so follow-up edits in
 *      the current chat session compound on the restored version too.
 *
 * Returns true when the durable row was repointed. Never throws — failures are
 * logged and reported via the return value so the route can surface them.
 */
export async function relinkFileContextAfterRestore(opts: {
  userId: string;
  fileRef: string;
  assetId: number;
  bytes: Buffer;
}): Promise<boolean> {
  try {
    const [row] = await db
      .select({
        fileType: oraFileContextsTable.fileType,
      })
      .from(oraFileContextsTable)
      .where(
        and(
          eq(oraFileContextsTable.userId, opts.userId),
          eq(oraFileContextsTable.fileRef, opts.fileRef),
          isNull(oraFileContextsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return false;

    // Re-extract text from the restored bytes (docx/pptx only — xlsx context
    // lives in datasetSummary and text extraction does not apply).
    let extractedText: string | undefined;
    if (row.fileType === "docx" || row.fileType === "pptx") {
      try {
        const { extractText } = await import("./file-extract.js");
        const text = await extractText(opts.bytes, row.fileType);
        if (text.trim()) extractedText = text.slice(0, MAX_TEXT_CHARS_PER_FILE);
      } catch (err) {
        logger.warn(
          { component: "ora-file-context", err, fileType: row.fileType },
          "Failed to re-extract text after restore — keeping prior text",
        );
      }
    }

    await db
      .update(oraFileContextsTable)
      .set({
        assetId: opts.assetId,
        updatedAt: new Date(),
        ...(extractedText !== undefined ? { extractedText, charCount: extractedText.length } : {}),
      })
      .where(
        and(
          eq(oraFileContextsTable.userId, opts.userId),
          eq(oraFileContextsTable.fileRef, opts.fileRef),
          isNull(oraFileContextsTable.deletedAt),
        ),
      );

    // Live-session write-back so in-flight conversations compound on the
    // restored bytes. Ownership was proven against the durable row above.
    if (
      (row.fileType === "docx" || row.fileType === "pptx" || row.fileType === "xlsx") &&
      opts.bytes.length > 0 &&
      opts.bytes.length <= MAX_RAW_BYTES_PER_FILE
    ) {
      overwriteFileEntryBytesByRef(opts.fileRef, {
        rawBase64: opts.bytes.toString("base64"),
        rawSizeBytes: opts.bytes.length,
        ...(extractedText !== undefined ? { extractedText } : {}),
      });
    }
    return true;
  } catch (err) {
    logger.error(
      { component: "ora-file-context", err, fileRef: opts.fileRef },
      "Failed to relink durable file context after restore",
    );
    return false;
  }
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

    const entry: FileEntry = {
      sessionId: row.sessionId,
      filename: row.filename,
      mimeType: row.mimeType,
      extractedText: row.extractedText,
      charCount: row.charCount,
      expiresAt: Date.now() + REHYDRATE_TTL_MS,
      datasetSummary: (row.datasetSummary as DatasetSummary | null) ?? undefined,
    };

    // Raw-byte rehydration for Office files: the upload also went to the
    // durable asset library (asset id recorded on this row), so pull the
    // original bytes back and reattach them. This is what keeps
    // layout-preserving DOCX/PPTX/XLSX edits working after the in-memory entry
    // expired, the server restarted, or the session JWT rotated — without it
    // those requests silently fall through to full regeneration. Best-effort:
    // on any failure the text-only entry still works for analysis.
    if (
      row.assetId != null &&
      (row.fileType === "docx" || row.fileType === "pptx" || row.fileType === "xlsx")
    ) {
      try {
        const { getOraAssetBytes } = await import("../ora-assets");
        const bytes = await getOraAssetBytes(row.assetId, userId);
        if (bytes && bytes.length > 0 && bytes.length <= MAX_RAW_BYTES_PER_FILE) {
          entry.rawBase64 = bytes.toString("base64");
          entry.rawSizeBytes = bytes.length;
          entry.rawFileType = row.fileType;
        }
      } catch (err) {
        logger.warn(
          { component: "ora-file-context", err, assetId: row.assetId },
          "Failed to rehydrate raw Office bytes for durable file context",
        );
      }
    }

    return entry;
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
    const durable = await getDurableFileContext(fileRef, opts.userId);
    if (durable) {
      // Re-seed the in-memory store under the SAME fileRef but the CURRENT
      // sessionId so follow-up turns in this session are served from memory
      // (including any rehydrated raw bytes) and edit write-backs compound.
      const { expiresAt: _expiresAt, ...rest } = durable;
      putFileEntry(fileRef, { ...rest, sessionId: opts.sessionId });
      return { ...durable, sessionId: opts.sessionId };
    }
    return null;
  }
  return null;
}
