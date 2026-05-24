import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const AGENT_INBOX_CATEGORIES = ["bug", "design", "feature", "copy", "other"] as const;
export type AgentInboxCategory = (typeof AGENT_INBOX_CATEGORIES)[number];

export const AGENT_INBOX_SEVERITIES = ["low", "medium", "high"] as const;
export type AgentInboxSeverity = (typeof AGENT_INBOX_SEVERITIES)[number];

export const AGENT_INBOX_STATUSES = ["unread", "read", "resolved"] as const;
export type AgentInboxStatus = (typeof AGENT_INBOX_STATUSES)[number];

export const agentInboxTable = pgTable("agent_inbox", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  userId: text("user_id"),
  category: text("category").notNull().default("bug"),
  severity: text("severity").notNull().default("medium"),
  description: text("description").notNull(),
  screenshotUrl: text("screenshot_url"),
  status: text("status").notNull().default("unread"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export type AgentInboxItem = typeof agentInboxTable.$inferSelect;
export type InsertAgentInboxItem = typeof agentInboxTable.$inferInsert;
