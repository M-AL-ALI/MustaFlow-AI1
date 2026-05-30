import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const VAULT_CATEGORIES = [
  "REPORT",
  "INVESTIGATION",
  "CORRECTIVE_ACTION",
  "LESSON_LEARNED",
  "BEST_PRACTICE",
  "PROJECT",
  "SOP",
  "STANDARD",
  "AUDIT",
  "KPI",
  "RISK",
  "OTHER",
] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

export const VAULT_SOURCE_TYPES = [
  "ORA_REPORT",
  "DATASET_ANALYSIS",
  "DOCUMENT_ANALYSIS",
  "IMAGE_ANALYSIS",
  "VOICE_TRANSCRIPT",
  "USER_CREATED",
  "MANUAL_ENTRY",
  "IMPORT",
  "OTHER",
] as const;
export type VaultSourceType = (typeof VAULT_SOURCE_TYPES)[number];

export const VAULT_STATUSES = ["draft", "approved", "archived"] as const;
export type VaultStatus = (typeof VAULT_STATUSES)[number];

export const vaultEntriesTable = pgTable(
  "vault_entries",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull().default("OTHER"),
    subcategory: text("subcategory"),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    department: text("department"),
    sourceType: text("source_type").notNull().default("USER_CREATED"),
    sourceReference: text("source_reference"),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    confidenceScore: integer("confidence_score"),
    approved: boolean("approved").notNull().default(false),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("vault_entries_search_idx").using(
      "gin",
      sql`to_tsvector('pg_catalog.english'::regconfig, coalesce(${t.title}, '') || ' ' || coalesce(${t.summary}, ''))`,
    ),
    index("vault_entries_tags_idx").using("gin", t.tags),
    index("vault_entries_updated_idx").on(t.userId, t.updatedAt.desc()),
    index("vault_entries_dept_idx").on(t.userId, t.department),
    index("vault_entries_archived_idx")
      .on(t.userId, t.archivedAt)
      .where(sql`archived_at IS NOT NULL`),
    index("vault_entries_user_idx").on(t.userId, t.createdAt),
    index("vault_entries_category_idx").on(t.userId, t.category),
    index("vault_entries_status_idx").on(t.userId, t.status),
  ],
);

export type VaultEntry = typeof vaultEntriesTable.$inferSelect;
export type InsertVaultEntry = typeof vaultEntriesTable.$inferInsert;

export const vaultVersionsTable = pgTable(
  "vault_versions",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    department: text("department"),
    editedBy: text("edited_by").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
    changeSummary: text("change_summary"),
  },
  (t) => [index("vault_versions_entry_idx").on(t.entryId, t.version)],
);

export type VaultVersion = typeof vaultVersionsTable.$inferSelect;
export type InsertVaultVersion = typeof vaultVersionsTable.$inferInsert;
