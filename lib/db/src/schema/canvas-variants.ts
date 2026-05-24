/**
 * Task #541 — Live mockup sandbox on Canvas.
 * Task #634 — Canvas Variants Leadership (8 variants, diff, A/B, lineage, library).
 *
 * Stores variant mockups generated from a single "Explore designs" prompt.
 * Each variant holds its own immutable snapshot of files (separate from the
 * main project_files table) so the user can preview multiple alternatives
 * side-by-side and graduate the chosen one into the main app.
 *
 * Variants are ephemeral: rows whose `lastViewedAt` is older than 24h are
 * pruned by a background sweep (see canvas.ts → pruneStaleVariants).
 */
import { pgTable, serial, integer, text, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import type { FileSnapshotEntry } from "./versions";

export type CanvasVariantStatus = "pending" | "generating" | "ready" | "failed";

export const canvasVariantsTable = pgTable("canvas_variants", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  // explorationId: groups multiple variants produced from the same prompt
  // so the UI can render them as one row of comparison tiles.
  explorationId: text("exploration_id").notNull(),
  label: text("label").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").$type<CanvasVariantStatus>().notNull().default("pending"),
  // Snapshot of generated files (same shape as project_versions.filesSnapshot).
  files: jsonb("files").$type<FileSnapshotEntry[]>(),
  assistantSummary: text("assistant_summary"),
  errorMessage: text("error_message"),
  // Variant rank in its exploration (1..N) — drives the order shown on canvas.
  rank: integer("rank").notNull().default(1),
  // Source mode — "explore" = AI-generated variant; "extract" = pulled from main app.
  source: text("source").notNull().default("explore"),
  // Task #634: lineage — points to the parent variant this was forked from.
  variantParentId: integer("variant_parent_id"),
  // Task #634: signed share token (opaque UUID, set on first share request).
  shareToken: text("share_token"),
  // Task #634: saved to cross-project library flag.
  savedToLibrary: boolean("saved_to_library").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Touched on every iframe view; used by the 24h idle sweep.
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CanvasVariant = typeof canvasVariantsTable.$inferSelect;
export type InsertCanvasVariant = typeof canvasVariantsTable.$inferInsert;

/**
 * Task #634 — Cross-project Variant Library.
 * User-scoped saved variants that can be imported into any project.
 */
export const canvasVariantLibraryTable = pgTable("canvas_variant_library", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  files: jsonb("files").$type<FileSnapshotEntry[]>().notNull(),
  sourceProjectId: integer("source_project_id").references(() => projectsTable.id, {
    onDelete: "set null",
  }),
  sourceVariantId: integer("source_variant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CanvasVariantLibraryItem = typeof canvasVariantLibraryTable.$inferSelect;

/**
 * Task #634 — Canvas A/B Tests.
 * Traffic-split between two ready variants; tracks views and conversions
 * so a winner can be identified by statistical significance.
 */
export const canvasAbTestsTable = pgTable("canvas_ab_tests", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  variantAId: integer("variant_a_id").notNull(),
  variantBId: integer("variant_b_id").notNull(),
  // Percentage of visitors routed to variant A (rest go to B).
  trafficSplitPct: integer("traffic_split_pct").notNull().default(50),
  // Metric to optimise for: "clicks" | "time_on_page" | "conversions"
  metric: text("metric").notNull().default("clicks"),
  status: text("status").$type<"running" | "paused" | "ended">().notNull().default("running"),
  winnerId: integer("winner_id"),
  viewsA: integer("views_a").notNull().default(0),
  viewsB: integer("views_b").notNull().default(0),
  conversionsA: integer("conversions_a").notNull().default(0),
  conversionsB: integer("conversions_b").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export type CanvasAbTest = typeof canvasAbTestsTable.$inferSelect;
