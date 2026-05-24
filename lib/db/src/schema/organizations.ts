import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  // type: personal = auto-created per-user org; team = explicitly created org
  type: text("type").notNull().default("team"),
  // avatarUrl: logo / avatar for the org
  avatarUrl: text("avatar_url"),
  // billingEmail: where invoices go
  billingEmail: text("billing_email"),
  // stripeCustomerId: Stripe customer for org-level billing (future)
  stripeCustomerId: text("stripe_customer_id"),
  // createdByUserId: Clerk user ID of the org creator
  createdByUserId: text("created_by_user_id").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizationsTable.$inferSelect;
export type InsertOrganization = typeof organizationsTable.$inferInsert;
