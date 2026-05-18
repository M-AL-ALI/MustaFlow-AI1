import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const SECRET_ENVIRONMENTS = ["development", "testing", "staging", "production"] as const;
export type SecretEnvironment = (typeof SECRET_ENVIRONMENTS)[number];

export const SECRET_CATEGORIES = [
  "auth",
  "payment",
  "maps",
  "ai",
  "database",
  "storage",
  "email",
  "sms",
  "deployment",
  "other",
] as const;
export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

export const SECRET_VERIFICATION_STATUSES = ["unverified", "verified", "invalid"] as const;
export type SecretVerificationStatus = (typeof SECRET_VERIFICATION_STATUSES)[number];

export const secretsTable = pgTable("project_secrets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // DEV ONLY: stored as plaintext. Replace with real encryption before production.
  // See artifacts/api-server/src/lib/encryption.ts for the encryption service interface.
  valueEncrypted: text("value_encrypted").notNull(),
  environment: text("environment").notNull().default("development"),
  category: text("category").notNull().default("other"),
  verificationStatus: text("verification_status").notNull().default("unverified"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export type Secret = typeof secretsTable.$inferSelect;
export type InsertSecret = typeof secretsTable.$inferInsert;
