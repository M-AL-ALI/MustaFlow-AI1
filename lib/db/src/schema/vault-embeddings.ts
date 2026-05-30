import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  vector,
} from "drizzle-orm/pg-core";

/** Dimension of text-embedding-3-small (1536). Matches KNOWLEDGE_EMBEDDING_DIM. */
export const VAULT_EMBEDDING_DIM = 1536;
export const VAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** Hard caps enforced at the service layer. */
export const VAULT_MAX_ENTRY_CHARS = 12_000;
export const VAULT_MAX_CHUNKS_PER_ENTRY = 20;
export const VAULT_CHUNK_TARGET_CHARS = 4_000; // ≈ 1 000 tokens @ 4 chars/token

export const vaultEmbeddingsTable = pgTable(
  "vault_embeddings",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id").notNull(),
    userId: text("user_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    chunkText: text("chunk_text").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    embedding: vector("embedding", { dimensions: VAULT_EMBEDDING_DIM }),
    embeddingModel: text("embedding_model").notNull().default(VAULT_EMBEDDING_MODEL),
    sourceVersion: integer("source_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vault_embeddings_entry_chunk_unique").on(t.entryId, t.chunkIndex),
    index("vault_embeddings_entry_idx").on(t.entryId),
    index("vault_embeddings_user_idx").on(t.userId, t.entryId),
  ],
);

export type VaultEmbedding = typeof vaultEmbeddingsTable.$inferSelect;
export type InsertVaultEmbedding = typeof vaultEmbeddingsTable.$inferInsert;
