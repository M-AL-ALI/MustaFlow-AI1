import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const GALLERY_CATEGORIES = [
  "web",
  "mobile",
  "saas",
  "ecommerce",
  "portfolio",
  "landing",
  "internal-tools",
  "ai-app",
  "dashboard",
  "blog",
  "social",
  "other",
] as const;
export type GalleryCategory = (typeof GALLERY_CATEGORIES)[number];

export const GALLERY_STATUSES = ["draft", "pending", "published", "rejected"] as const;
export type GalleryStatus = (typeof GALLERY_STATUSES)[number];

export const galleryTemplatesTable = pgTable(
  "gallery_templates",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    readme: text("readme"),
    category: text("category").notNull().default("web"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    authorId: text("author_id"),
    authorName: text("author_name"),
    filesSnapshot: jsonb("files_snapshot").$type<Record<string, string>>(),
    previewUrl: text("preview_url"),
    thumbnailUrl: text("thumbnail_url"),
    platform: text("platform").notNull().default("web"),
    stack: text("stack").notNull().default("react-vite"),
    rating: real("rating").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    forkCount: integer("fork_count").notNull().default(0),
    useCount: integer("use_count").notNull().default(0),
    status: text("status").notNull().default("draft"),
    featured: boolean("featured").notNull().default(false),
    editorsPick: boolean("editors_pick").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false),
    forkedFromId: integer("forked_from_id"),
    sourceProjectId: integer("source_project_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("gallery_templates_status_idx").on(table.status),
    index("gallery_templates_category_idx").on(table.category),
    index("gallery_templates_featured_idx").on(table.featured),
    index("gallery_templates_rating_idx").on(table.rating),
    index("gallery_templates_author_idx").on(table.authorId),
  ],
);

export type GalleryTemplate = typeof galleryTemplatesTable.$inferSelect;
export type InsertGalleryTemplate = typeof galleryTemplatesTable.$inferInsert;

export const templateRatingsTable = pgTable(
  "template_ratings",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id").notNull(),
    userId: text("user_id").notNull(),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("template_ratings_template_idx").on(table.templateId),
    index("template_ratings_user_idx").on(table.userId),
    uniqueIndex("template_ratings_user_template_unique").on(table.templateId, table.userId),
  ],
);

export type TemplateRating = typeof templateRatingsTable.$inferSelect;
export type InsertTemplateRating = typeof templateRatingsTable.$inferInsert;
