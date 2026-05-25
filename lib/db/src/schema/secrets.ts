import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
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
  "analytics",
  "monitoring",
  "other",
] as const;
export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

export const SECRET_VERIFICATION_STATUSES = ["unverified", "verified", "invalid"] as const;
export type SecretVerificationStatus = (typeof SECRET_VERIFICATION_STATUSES)[number];

export const SECRET_MIN_ROLES = ["viewer", "member", "admin", "owner"] as const;
export type SecretMinRole = (typeof SECRET_MIN_ROLES)[number];

export const secretsTable = pgTable("project_secrets", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Encrypted with AES-256-GCM. See artifacts/api-server/src/lib/encryption.ts
  valueEncrypted: text("value_encrypted").notNull(),
  environment: text("environment").notNull().default("development"),
  category: text("category").notNull().default("other"),
  verificationStatus: text("verification_status").notNull().default("unverified"),
  // Minimum org role required to read the decrypted secret value.
  // 'viewer' (default) = all project members; 'owner' = org owner only.
  minRole: text("min_role").notNull().default("viewer"),
  // When true, this secret is safe to inject into the draft preview container.
  // Production secrets (API keys, payment keys) default to false so they are
  // never automatically exposed in the development preview environment.
  isPreviewSafe: boolean("is_preview_safe").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export type Secret = typeof secretsTable.$inferSelect;
export type InsertSecret = typeof secretsTable.$inferInsert;
