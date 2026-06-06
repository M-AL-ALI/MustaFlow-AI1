import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Durable store for assets generated inside Ora (the standalone chat assistant,
 * kept separate from the AI Builder). Both generated FILES (csv/xlsx/docx/pdf/
 * pptx) and generated IMAGES are persisted here at generation time, keyed to the
 * owning user, so they survive chat resets, reloads, and other devices.
 *
 * Bytes are stored as base64 in `data` (no `data:` prefix) by default — this
 * keeps the library durable in both dev and prod without depending on external
 * object storage, matching the existing "files served from the DB" pattern.
 *
 * When R2 offload is enabled (ORA_ASSETS_R2_ENABLED=true and CF R2 credentials
 * present), bytes are instead uploaded to R2 and the object key is recorded in
 * `storageKey`; in that case `data` is null. The download path resolves either
 * source, so the two storage modes coexist and R2 is a strict superset.
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
    // Base64 bytes (DB storage mode). Null when bytes are offloaded to R2 — see
    // `storageKey`. Exactly one of `data` / `storageKey` carries the payload.
    data: text("data"),
    // R2 object key when bytes are offloaded to object storage; null in DB mode.
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("ora_assets_user_id_idx").on(t.userId)],
);

export type OraAsset = typeof oraAssetsTable.$inferSelect;
export type NewOraAsset = typeof oraAssetsTable.$inferInsert;
