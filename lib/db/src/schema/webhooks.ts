import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const WEBHOOK_EVENTS = [
  "domain.attached",
  "domain.verified",
  "domain.detached",
  "dns.changed",
  "cert.issued",
  "cert.expiring",
  "cert.expired",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const projectWebhooksTable = pgTable(
  "project_webhooks",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<WebhookEvent[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_project_webhooks_project").on(t.projectId)],
);

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "success", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookDeliveriesTable = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    webhookId: integer("webhook_id")
      .notNull()
      .references(() => projectWebhooksTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    attempt: integer("attempt").notNull().default(1),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_webhook_deliveries_webhook").on(t.webhookId),
    index("idx_webhook_deliveries_project").on(t.projectId),
  ],
);

export type ProjectWebhook = typeof projectWebhooksTable.$inferSelect;
export type InsertProjectWebhook = typeof projectWebhooksTable.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveriesTable.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveriesTable.$inferInsert;
