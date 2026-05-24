import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  vector,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const PROJECT_EMBEDDING_DIM = 1536;
export const PROJECT_EMBEDDING_MODEL = "text-embedding-3-small";

export const projectEmbeddingsTable = pgTable(
  "project_embeddings",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull(),
    filePath: text("file_path").notNull(),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull().default(PROJECT_EMBEDDING_MODEL),
    embedding: vector("embedding", { dimensions: PROJECT_EMBEDDING_DIM }),
    snippet: text("snippet").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectFileUnique: uniqueIndex("project_embeddings_project_file_unique").on(
      t.projectId,
      t.filePath,
    ),
  }),
);

export type ProjectEmbedding = typeof projectEmbeddingsTable.$inferSelect;
export type InsertProjectEmbedding = typeof projectEmbeddingsTable.$inferInsert;
