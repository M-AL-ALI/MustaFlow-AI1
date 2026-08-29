import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const ZERO_PROMPT_QUEUE_STORED_STATES = ["queued", "promoted", "deleted"] as const;
export type ZeroPromptQueueStoredState = (typeof ZERO_PROMPT_QUEUE_STORED_STATES)[number];

export const zeroPromptQueueItemsTable = pgTable(
  "zero_prompt_queue_items",
  {
    id: text("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    currentText: text("current_text").notNull(),
    assetIds: jsonb("asset_ids").$type<number[]>().notNull().default([]),
    state: text("state").$type<ZeroPromptQueueStoredState>().notNull(),
    promotedTurnId: text("promoted_turn_id"),
    deletedBy: text("deleted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("zero_prompt_queue_items_project_position_unique").on(t.projectId, t.position),
    index("zero_prompt_queue_items_project_state_idx").on(t.projectId, t.state, t.position),
    check("zero_prompt_queue_items_position_check", sql`${t.position} > 0`),
    check(
      "zero_prompt_queue_items_text_check",
      sql`char_length(${t.currentText}) BETWEEN 1 AND 10000`,
    ),
    check(
      "zero_prompt_queue_items_state_check",
      sql`${t.state} IN ('queued', 'promoted', 'deleted')`,
    ),
    check(
      "zero_prompt_queue_items_terminal_check",
      sql`(${t.state} = 'queued' AND ${t.promotedTurnId} IS NULL AND ${t.deletedBy} IS NULL)
        OR (${t.state} = 'promoted' AND ${t.promotedTurnId} IS NOT NULL AND ${t.deletedBy} IS NULL)
        OR (${t.state} = 'deleted' AND ${t.promotedTurnId} IS NULL AND ${t.deletedBy} IS NOT NULL)`,
    ),
  ],
);

export type ZeroPromptQueueStoredItem = typeof zeroPromptQueueItemsTable.$inferSelect;
export type InsertZeroPromptQueueStoredItem = typeof zeroPromptQueueItemsTable.$inferInsert;
