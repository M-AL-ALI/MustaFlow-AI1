import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export type FileSnapshotEntry = {
  path: string;
  content: string;
  mimeType: string;
};

export type AuditFinding = {
  category: "accessibility" | "seo" | "performance" | "security";
  severity: "error" | "warning" | "info";
  file: string;
  message: string;
  suggestion: string;
};

export type AuditScore = {
  category: "accessibility" | "seo" | "performance" | "security";
  label: string;
  pass: number;
  warnings: number;
  failures: number;
  score: number;
};

export type AuditReport = {
  findings: AuditFinding[];
  scores: AuditScore[];
  auditedAt: string;
  fileCount: number;
};

export const projectVersionsTable = pgTable("project_versions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  note: text("note"),
  filesSnapshot: jsonb("files_snapshot").$type<FileSnapshotEntry[]>(),
  planSnapshot: jsonb("plan_snapshot").$type<Record<string, unknown>>(),
  auditReport: jsonb("audit_report").$type<AuditReport>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectVersion = typeof projectVersionsTable.$inferSelect;
export type InsertProjectVersion = typeof projectVersionsTable.$inferInsert;
