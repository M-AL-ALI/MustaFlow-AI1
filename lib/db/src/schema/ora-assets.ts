import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { assetsTable } from "./assets";

/**
 * Durable store for assets generated inside Ora (the standalone chat assistant,
 * kept separate from the AI Builder). Both generated FILES (csv/xlsx/docx/pdf/
 * pptx) and generated IMAGES are persisted here at generation time, keyed to the
 * owning user, so they survive chat resets, reloads, and other devices.
 *
 * New bytes live once in the account-wide asset registry/R2 and this table
 * keeps Ora-specific metadata and version lineage through `assetId`. `data`
 * remains only as a compatibility reader for historical rows created before
 * unification; no new write falls back to Postgres blobs.
 */
export const ORA_ASSET_KINDS = ["file", "image"] as const;
export type OraAssetKind = (typeof ORA_ASSET_KINDS)[number];

export const oraAssetsTable = pgTable(
  "ora_assets",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    // Ora project this asset belongs to (ora_projects.id). Null = the user's
    // default "Personal" space (standalone chats / no project selected). No FK
    // by design, matching ora_conversations.projectId — archiving a project
    // never cascades into asset rows.
    oraProjectId: integer("ora_project_id"),
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
    // Canonical account-wide asset-registry row. New writes always use this
    // link; legacy rows are adopted idempotently by the unified-asset startup
    // migration while retaining their historical byte location for fallback.
    assetId: integer("asset_id").references(() => assetsTable.id, { onDelete: "set null" }),
    sizeBytes: integer("size_bytes").notNull().default(0),
    // ── File revision lineage (append-only) ─────────────────────────────────
    // A "version chain" groups every revision of one logical file. The chain is
    // identified by rootAssetId: null on legacy rows and v1 roots (treat as
    // COALESCE(root_asset_id, id)); later versions point at the v1 row's id.
    // parentAssetId is the immediately-previous version (null for v1).
    // versionNumber is 1-based within the chain. Restores are append-only: a
    // restore inserts a NEW head row copying the old version's bytes, never
    // mutating history.
    rootAssetId: integer("root_asset_id"),
    parentAssetId: integer("parent_asset_id"),
    versionNumber: integer("version_number").notNull().default(1),
    // The upload fileRef this chain originated from, when applicable (edited
    // uploads); null for purely generated files.
    sourceFileRef: text("source_file_ref"),
    // Short human-readable description of what this version changed (e.g.
    // "Edited: replaced pricing line", "Restored version 2"). Null for v1.
    editSummary: text("edit_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("ora_assets_storage_xor", sql`(${t.data} IS NOT NULL) <> (${t.storageKey} IS NOT NULL)`),
    uniqueIndex("ora_assets_asset_id_uq")
      .on(t.assetId)
      .where(sql`${t.assetId} IS NOT NULL`),
    index("ora_assets_user_id_idx").on(t.userId),
    index("ora_assets_root_asset_id_idx").on(t.rootAssetId),
    index("ora_assets_user_project_idx").on(t.userId, t.oraProjectId),
  ],
);

export type OraAsset = typeof oraAssetsTable.$inferSelect;
export type NewOraAsset = typeof oraAssetsTable.$inferInsert;
