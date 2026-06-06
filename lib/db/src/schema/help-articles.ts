import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Help articles — the content that powers BOTH the public Help Center page and
 * Ora Support Mode retrieval. A single source of truth so the assistant
 * troubleshoots using the same material users can browse.
 *
 * `isFaq` flags short question/answer entries surfaced in the Help Center FAQ
 * section. `tags` is a JSONB array of lowercase keyword strings used for simple
 * relevance matching during Support Mode retrieval.
 */
export const HELP_ARTICLE_CATEGORIES = [
  "getting-started",
  "builder",
  "billing",
  "account",
  "publishing",
  "troubleshooting",
  "faq",
] as const;
export type HelpArticleCategory = (typeof HELP_ARTICLE_CATEGORIES)[number];

export const helpArticlesTable = pgTable(
  "help_articles",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    category: text("category").notNull().default("getting-started"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: jsonb("tags").notNull().default([]),
    isFaq: boolean("is_faq").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("help_articles_category_idx").on(t.category, t.sortOrder),
    index("help_articles_is_faq_idx").on(t.isFaq),
  ],
);

export type HelpArticle = typeof helpArticlesTable.$inferSelect;
export type InsertHelpArticle = typeof helpArticlesTable.$inferInsert;
