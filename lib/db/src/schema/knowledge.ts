import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  vector,
} from "drizzle-orm/pg-core";
import { chatMessagesTable } from "./messages";
import { agentTasksTable } from "./tasks";
import { projectVersionsTable } from "./versions";

/** Dimension of the OpenAI text-embedding-3-small vector. */
export const KNOWLEDGE_EMBEDDING_DIM = 1536;

export const KNOWLEDGE_TYPES = [
  "build",
  "refine",
  "rollback",
  "publish",
  "publish_failed",
  "duplicate",
  "secret_warning",
  "secret_change",
  "integration_needed",
  "test_report",
  "manual_edit",
  "note",
  "conversation_summary",
  "style_memory",
  "decision",
  "rejection",
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const KNOWLEDGE_SEVERITIES = ["info", "warning", "error"] as const;
export type KnowledgeSeverity = (typeof KNOWLEDGE_SEVERITIES)[number];

export const KNOWLEDGE_SCOPES = ["user", "project", "org", "global"] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

/**
 * Where an entry originated. Used to keep Ora Memory and the AI Builder
 * Knowledge Vault separate: only `origin = "ora"` entries are ever surfaced or
 * injected by Ora. Builder-generated knowledge is tagged "builder"; auto-promoted
 * cross-user knowledge is "system"; rows that predate this column are backfilled
 * to "builder" and stay hidden from Ora.
 */
export const KNOWLEDGE_ORIGINS = ["ora", "builder", "system", "legacy"] as const;
export type KnowledgeOrigin = (typeof KNOWLEDGE_ORIGINS)[number];

/**
 * Lightweight category for Ora memories (origin = "ora"). Stored in the shared
 * `category` column, which is isolated from the AI Builder Knowledge Vault by
 * the `origin` filter — Builder rows use their own category values and are never
 * read by Ora. Assigned automatically on save (heuristic classifier) and
 * user-overridable from the Memory Center.
 *
 *  - preference : how the user likes things (style, tone, defaults, do/don't)
 *  - personal   : durable personal facts (name, role, location, contact)
 *  - project    : project / product / work context
 *  - other      : the default when nothing else fits
 */
export const ORA_MEMORY_CATEGORIES = [
  "preference",
  "personal",
  "project",
  "document",
  "other",
] as const;
export type OraMemoryCategory = (typeof ORA_MEMORY_CATEGORIES)[number];
export const DEFAULT_ORA_MEMORY_CATEGORY: OraMemoryCategory = "other";

export function isOraMemoryCategory(v: unknown): v is OraMemoryCategory {
  return typeof v === "string" && (ORA_MEMORY_CATEGORIES as readonly string[]).includes(v);
}

export interface DiffSummary {
  filesAdded: string[];
  filesModified: string[];
  filesRemoved: string[];
  linesAdded?: number;
  linesRemoved?: number;
}

export const knowledgeEntriesTable = pgTable("knowledge_entries", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull().default("note"),
  content: text("content").notNull(),
  // Project-scoped context (null = global / cross-project lesson).
  // BUILDER ONLY — never set for Ora memories.
  projectId: integer("project_id"),
  // Ora project anchor (origin="ora" only). When set, this memory belongs to a
  // specific Ora project (ora_projects.id) and persists across every
  // conversation in that project. Deliberately SEPARATE from Builder's
  // `projectId` so the Builder Knowledge Vault read paths never touch it.
  oraProjectId: integer("ora_project_id"),
  // Actor who triggered the event
  userId: text("user_id"),
  // Machine-readable type for filtering and display
  type: text("type").notNull().default("note"),
  // Scope: user (personal preference), project (project-level), org (team), global (cross-user approved)
  scope: text("scope").notNull().default("project"),
  // Links to the task or version that produced this entry
  relatedTaskId: integer("related_task_id").references(() => agentTasksTable.id, {
    onDelete: "set null",
  }),
  relatedVersionId: integer("related_version_id").references(() => projectVersionsTable.id, {
    onDelete: "set null",
  }),
  // Exact inclusive message range summarized into a conversation_summary row.
  // Null on legacy rows and on knowledge types that are not conversation summaries.
  sourceMessageStartId: integer("source_message_start_id").references(() => chatMessagesTable.id, {
    onDelete: "set null",
  }),
  sourceMessageEndId: integer("source_message_end_id").references(() => chatMessagesTable.id, {
    onDelete: "set null",
  }),
  // Comma-separated tags, e.g. "towing,landing-page,map"
  tags: text("tags"),
  // How important is this entry?
  severity: text("severity").notNull().default("info"),
  // Has a human approved this for reuse across projects?
  approvedForReuse: boolean("approved_for_reuse").notNull().default(false),
  // Compact file diff summary stored as JSONB
  diffSummary: jsonb("diff_summary").$type<DiffSummary>(),
  // User-written annotation / note on this entry
  annotation: text("annotation"),
  // Explicit quality signals from the user (👍/👎)
  thumbsUp: integer("thumbs_up").notNull().default(0),
  thumbsDown: integer("thumbs_down").notNull().default(0),
  // How many times this lesson was applied in a build
  usageCount: integer("usage_count").notNull().default(0),
  // How many times a near-duplicate was merged into this entry instead of inserting a new row
  reinforcedCount: integer("reinforced_count").notNull().default(0),
  // Opt-in: share anonymized lesson to the public community pool
  isPublic: boolean("is_public").notNull().default(false),
  // AI-generated embedding vector for semantic similarity ranking.
  // pgvector column (1536 dims = OpenAI text-embedding-3-small).
  // Null when not yet computed — loadKnowledgeContext falls back to TF-IDF.
  embedding: vector("embedding", { dimensions: KNOWLEDGE_EMBEDDING_DIM }),
  // Ora Memory Center: when false, the memory is kept but excluded from Ora's
  // context injection (user "paused" it). User-scope memories only.
  enabled: boolean("enabled").notNull().default(true),
  // Ora Memory Center: the Ora conversation a memory was captured from (if any).
  sourceConversationId: integer("source_conversation_id"),
  // Ora Memory consolidation: when a NEWER Ora memory supersedes this one
  // (the user saved an updated fact that overlaps an earlier memory), this
  // points to the newer entry's id. Superseded entries are disabled (excluded
  // from Ora's context) but kept visible in the Memory Center with a
  // "Superseded" badge, so the change is non-destructive and reversible.
  // Null = active / never superseded. Ora (origin="ora") rows only.
  supersededBy: integer("superseded_by"),
  // Provenance marker. "ora" = user-approved Ora memory (the only origin Ora
  // shows/injects); "builder"/"system" = AI Builder Knowledge Vault (hidden from
  // Ora). Null on legacy rows until the backfill migration runs.
  origin: text("origin").$type<KnowledgeOrigin>(),
  // Soft-delete: when set, the entry is archived and hidden by default
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // When set, this entry's contributor has already been rewarded for crossing
  // the public-library net-thumbs-up threshold (prevents double-rewards).
  contributorRewardedAt: timestamp("contributor_rewarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnowledgeEntry = typeof knowledgeEntriesTable.$inferSelect;
export type InsertKnowledgeEntry = typeof knowledgeEntriesTable.$inferInsert;
