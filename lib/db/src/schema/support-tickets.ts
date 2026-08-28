import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Support tickets — created when Ora Support Mode escalates an unresolved issue
 * to a human. The ticket is the durable record: it is persisted BEFORE any email
 * attempt so a mail failure can never lose the user's request.
 *
 * `transcript` is a JSONB array of the support conversation (role/content), so
 * the human reader has full context. `attachments` is a JSONB array of validated
 * safe link/metadata objects ({ fileName, mimeType, size, url }) — never raw or
 * executable file bytes. `supportEmailUsed` records the address the ticket was
 * actually sent to for auditability. `emailStatus` records delivery outcome.
 */
// Triage lifecycle: a freshly escalated ticket starts as "new" (untouched),
// support staff move it to "open" (being worked) and finally "resolved".
// "closed" is accepted as a legacy alias for "resolved" so pre-existing rows
// keep loading; new transitions only ever write new/open/resolved.
export const SUPPORT_TICKET_STATUSES = [
  "new",
  "open",
  "waiting_on_user",
  "blocked_on_third_party",
  "resolved",
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];

export const SUPPORT_EMAIL_STATUSES = ["sent", "skipped", "failed"] as const;
export type SupportEmailStatus = (typeof SUPPORT_EMAIL_STATUSES)[number];

export const supportTicketsTable = pgTable(
  "support_tickets",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email"),
    plan: text("plan").notNull().default("free"),
    category: text("category").notNull().default("other"),
    status: text("status").notNull().default("new"),
    priority: text("priority").notNull().default("normal"),
    assignedToUserId: text("assigned_to_user_id"),
    resolutionClass: text("resolution_class"),
    thirdPartyBlocker: text("third_party_blocker"),
    resolutionEvidence: jsonb("resolution_evidence"),
    subject: text("subject").notNull(),
    transcript: jsonb("transcript").notNull().default([]),
    projectId: integer("project_id"),
    attachments: jsonb("attachments").notNull().default([]),
    deviceInfo: jsonb("device_info"),
    supportEmailUsed: text("support_email_used"),
    emailStatus: text("email_status").notNull().default("skipped"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByRole: text("resolved_by_role"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_tickets_user_id_idx").on(t.userId, t.createdAt),
    index("support_tickets_status_idx").on(t.status, t.createdAt),
    index("support_tickets_assignee_status_idx").on(t.assignedToUserId, t.status, t.updatedAt),
    index("support_tickets_priority_status_idx").on(t.priority, t.status, t.updatedAt),
    index("support_tickets_resolution_class_idx").on(t.resolutionClass, t.createdAt),
  ],
);

export type SupportTicket = typeof supportTicketsTable.$inferSelect;
export type InsertSupportTicket = typeof supportTicketsTable.$inferInsert;
