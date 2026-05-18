import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const secretsTable = pgTable("project_secrets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  valueEncrypted: text("value_encrypted").notNull(),
  environment: text("environment").notNull().default("test"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Secret = typeof secretsTable.$inferSelect;
export type InsertSecret = typeof secretsTable.$inferInsert;
