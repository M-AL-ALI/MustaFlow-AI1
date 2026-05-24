import {
  pgTable,
  serial,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export type PlanTemplateData = {
  summary?: string;
  goal?: string;
  approach?: string;
  sitemap?: Array<{ name: string; route: string; purpose: string }>;
  pages?: string[];
  backend?: string[];
  database?: string[];
  dataModel?: Array<{ table: string; fields: string[] }>;
  apiEndpoints?: Array<{ method: string; path: string; purpose: string }>;
  integrations?: string[];
  keysNeeded?: string[];
  filesAffected?: string[];
  uxNotes?: Record<string, string>;
  accessibilityNotes?: string;
  complexityScore?: number;
  recommendedMode?: string;
  estimatedBuildSeconds?: number;
  risks?: string[];
  testPlan?: string[];
};

export const planTemplatesTable = pgTable(
  "plan_templates",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    category: text("category").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    platform: text("platform").notNull().default("web"),
    plan: jsonb("plan").$type<PlanTemplateData>().notNull(),
    isSystem: boolean("is_system").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("plan_templates_category_idx").on(table.category),
    index("plan_templates_sort_order_idx").on(table.sortOrder),
  ],
);

export type PlanTemplate = typeof planTemplatesTable.$inferSelect;
export type InsertPlanTemplate = typeof planTemplatesTable.$inferInsert;
