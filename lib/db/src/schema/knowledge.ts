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
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const KNOWLEDGE_SEVERITIES = ["info", "warning", "error"] as const;
export type KnowledgeSeverity = (typeof KNOWLEDGE_SEVERITIES)[number];

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
  // Project-scoped context (null = global / cross-project lesson)
  projectId: integer("project_id"),
  // Actor who triggered the event
  userId: text("user_id"),
  // Machine-readable type for filtering and display
  type: text("type").notNull().default("note"),
  // Links to the task or version that produced this entry
  relatedTaskId: integer("related_task_id"),
  relatedVersionId: integer("related_version_id"),
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
  // AI-generated embedding vector for semantic similarity ranking.
  // pgvector column (1536 dims = OpenAI text-embedding-3-small).
  // Null when not yet computed — loadKnowledgeContext falls back to TF-IDF.
  embedding: vector("embedding", { dimensions: KNOWLEDGE_EMBEDDING_DIM }),
  // Soft-delete: when set, the entry is archived and hidden by default
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnowledgeEntry = typeof knowledgeEntriesTable.$inferSelect;
export type InsertKnowledgeEntry = typeof knowledgeEntriesTable.$inferInsert;
