import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { agentTasksTable } from "./tasks";

export const SUGGESTION_CATEGORIES = ["feature", "fix", "improvement", "idea"] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

export const SUGGESTION_STATUSES = ["pending", "accepted", "dismissed", "saved"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const projectSuggestionsTable = pgTable(
  "project_suggestions",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => agentTasksTable.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull().default("feature"),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("project_suggestions_project_id_idx").on(table.projectId),
    index("project_suggestions_task_id_idx").on(table.taskId),
    index("project_suggestions_status_idx").on(table.status),
  ],
);

export type ProjectSuggestion = typeof projectSuggestionsTable.$inferSelect;
export type InsertProjectSuggestion =
  typeof projectSuggestionsTable.$inferInsert;
