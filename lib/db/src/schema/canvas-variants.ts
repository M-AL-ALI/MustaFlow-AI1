/**
 * Task #541 — Live mockup sandbox on Canvas.
 *
 * Stores variant mockups generated from a single "Explore designs" prompt.
 * Each variant holds its own immutable snapshot of files (separate from the
 * main project_files table) so the user can preview multiple alternatives
 * side-by-side and graduate the chosen one into the main app.
 *
 * Variants are ephemeral: rows whose `lastViewedAt` is older than 24h are
 * pruned by a background sweep (see canvas.ts → pruneStaleVariants).
 */
import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Touched on every iframe view; used by the 24h idle sweep.
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CanvasVariant = typeof canvasVariantsTable.$inferSelect;
export type InsertCanvasVariant = typeof canvasVariantsTable.$inferInsert;
