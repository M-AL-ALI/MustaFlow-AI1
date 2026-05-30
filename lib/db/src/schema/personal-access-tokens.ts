import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const personalAccessTokensTable = pgTable(
  "personal_access_tokens",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPreview: text("token_preview").notNull(),
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["domains:read", "domains:write"]),
    active: boolean("active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_pat_user").on(t.userId)],
);

export type PersonalAccessToken = typeof personalAccessTokensTable.$inferSelect;
export type InsertPersonalAccessToken = typeof personalAccessTokensTable.$inferInsert;
