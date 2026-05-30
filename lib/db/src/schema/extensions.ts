import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const EXTENSION_SCOPES = [
  "read_files",
  "write_files",
  "call_ai",
  "access_env",
  "access_secrets",
  "trigger_build",
  "read_logs",
] as const;
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

export const EXTENSION_STATUSES = ["draft", "pending", "published", "suspended"] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

export interface ExtensionManifest {
  name: string;
  slug: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  scopes: ExtensionScope[];
  entrypoint: string;
  icon?: string;
  webhooks?: Array<{ event: string; url: string }>;
  settings?: Array<{
    key: string;
    label: string;
    type: "string" | "boolean" | "select";
    required?: boolean;
    options?: string[];
    default?: string | boolean;
  }>;
}

export const extensionsTable = pgTable(
  "extensions",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    longDescription: text("long_description"),
    version: text("version").notNull().default("1.0.0"),
    authorId: text("author_id"),
    authorName: text("author_name"),
    manifestUrl: text("manifest_url"),
    manifest: jsonb("manifest").$type<ExtensionManifest>(),
    scopes: jsonb("scopes").$type<ExtensionScope[]>().notNull().default([]),
    iconUrl: text("icon_url"),
    homepageUrl: text("homepage_url"),
    repositoryUrl: text("repository_url"),
    category: text("category").notNull().default("productivity"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    installCount: integer("install_count").notNull().default(0),
    status: text("status").notNull().default("draft"),
    vetted: boolean("vetted").notNull().default(false),
    featured: boolean("featured").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false),
    vettingNotes: text("vetting_notes"),
    vettedAt: timestamp("vetted_at", { withTimezone: true }),
    vettedBy: text("vetted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("extensions_status_idx").on(table.status),
    index("extensions_category_idx").on(table.category),
    index("extensions_featured_idx").on(table.featured),
    index("extensions_author_idx").on(table.authorId),
  ],
);

export type Extension = typeof extensionsTable.$inferSelect;
export type InsertExtension = typeof extensionsTable.$inferInsert;

export const projectExtensionsTable = pgTable(
  "project_extensions",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull(),
    extensionId: integer("extension_id").notNull(),
    extensionSlug: text("extension_slug").notNull(),
    installedBy: text("installed_by"),
    config: jsonb("config").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("project_extensions_project_idx").on(table.projectId),
    index("project_extensions_extension_idx").on(table.extensionId),
    uniqueIndex("project_extensions_unique").on(table.projectId, table.extensionId),
  ],
);

export type ProjectExtension = typeof projectExtensionsTable.$inferSelect;
export type InsertProjectExtension = typeof projectExtensionsTable.$inferInsert;
