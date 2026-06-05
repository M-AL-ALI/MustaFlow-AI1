import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Durable store for assets generated inside Ora (the standalone chat assistant,
 * kept separate from the AI Builder). Both generated FILES (csv/xlsx/docx/pdf/
 * pptx) and generated IMAGES are persisted here at generation time, keyed to the
 * owning user, so they survive chat resets, reloads, and other devices.
 *
 * Bytes are stored as base64 in `data` (no `data:` prefix) — this keeps the
 * library durable in both dev and prod without depending on external object
 * storage (R2/GCS), matching the existing "files served from the DB" pattern.
 */
export const ORA_ASSET_KINDS = ["file", "image"] as const;
export type OraAssetKind = (typeof ORA_ASSET_KINDS)[number];

export const oraAssetsTable = pgTable(
  "ora_assets",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    format: text("format"),
    prompt: text("prompt"),
    data: text("data").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("ora_assets_user_id_idx").on(t.userId)],
);

export type OraAsset = typeof oraAssetsTable.$inferSelect;
export type NewOraAsset = typeof oraAssetsTable.$inferInsert;
