import { pgTable, serial, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Durable, text-only mirror of an uploaded Ora file's extracted context.
 *
 * Uploads normally live only in the ephemeral, in-memory file-store (see
 * `file-store.ts`), which is session-scoped and expires after a couple of hours
 * — and is wiped entirely on server restart/redeploy. For SIGNED-IN users we
 * additionally persist the EXTRACTED CONTEXT here (document text or dataset
 * summary), keyed by `(user_id, file_ref)`, so a follow-up question or a
 * "build a file from my upload" request still resolves the real data after the
 * memory entry has been evicted, the session JWT has rotated, or the request
 * lands on a different server instance.
 *
 * Anonymous visitors are intentionally NOT persisted here — they keep the
 * memory-only fast path. Raw file BYTES are never stored in this table (those,
 * for signed-in users, go to `ora_assets`); only extracted text / dataset
 * summary metadata needed to re-hydrate prompt context.
 */
export const oraFileContextsTable = pgTable(
  "ora_file_contexts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    // The opaque UUID returned by the in-memory storeFile() at upload time. The
    // client re-sends this ref on follow-up turns; we resolve memory first, then
    // fall back to this table by (user_id, file_ref).
    fileRef: text("file_ref").notNull(),
    sessionId: text("session_id").notNull(),
    // Optional link to the durable ora_assets row holding the raw bytes, when one
    // was persisted for this upload. Not required to re-hydrate prompt context.
    assetId: integer("asset_id"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    fileType: text("file_type").notNull(),
    // Extracted plain text for documents; empty string for datasets (which carry
    // their content in datasetSummary instead).
    extractedText: text("extracted_text").notNull().default(""),
    charCount: integer("char_count").notNull().default(0),
    // DatasetSummary JSON for CSV/XLSX uploads; null for documents.
    datasetSummary: jsonb("dataset_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ora_file_contexts_user_ref_unique").on(t.userId, t.fileRef),
    index("ora_file_contexts_user_id_idx").on(t.userId),
  ],
);

export type OraFileContext = typeof oraFileContextsTable.$inferSelect;
export type NewOraFileContext = typeof oraFileContextsTable.$inferInsert;
