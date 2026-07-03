import { pgTable, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const ORAX_HOST_STATUSES = ["online", "offline", "revoked"] as const;
export type OraxHostStatus = (typeof ORAX_HOST_STATUSES)[number];

export const ORAX_HOST_PLATFORMS = ["windows", "mac", "linux"] as const;
export type OraxHostPlatform = (typeof ORAX_HOST_PLATFORMS)[number];

export const ORAX_HOST_PERMISSION_MODES = [
  "read_only",
  "ask_everything",
  "ask_risky",
  "trusted_project",
  "full_access",
  "custom",
] as const;
export type OraxHostPermissionMode = (typeof ORAX_HOST_PERMISSION_MODES)[number];

export const ORAX_THREAD_STATUSES = ["idle", "active", "paused", "completed", "failed"] as const;
export type OraxThreadStatus = (typeof ORAX_THREAD_STATUSES)[number];

export const ORAX_DESKTOP_APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type OraxDesktopApprovalStatus = (typeof ORAX_DESKTOP_APPROVAL_STATUSES)[number];

export const ORAX_USAGE_EVENT_STATUSES = ["success", "failure", "cancelled"] as const;
export type OraxUsageEventStatus = (typeof ORAX_USAGE_EVENT_STATUSES)[number];

export const ORAX_ACTION_TYPES = [
  "model_call",
  "screenshot_analysis",
  "file_analysis",
  "repository_analysis",
  "command_execution",
  "approval_event",
  "relay_event",
  "git_commit",
  "git_push",
  "github_pr_created",
  "typecheck_run",
  "test_run",
  "build_run",
] as const;
export type OraxActionType = (typeof ORAX_ACTION_TYPES)[number];

// ── orax_hosts ─────────────────────────────────────────────────────────────────
// One row per physical machine registration. installId is stable across
// app updates (stored in OS credential store on first install).

export const oraxHostsTable = pgTable(
  "orax_hosts",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    deviceName: text("device_name").notNull(),
    platform: text("platform").notNull().default("windows"),
    osVersion: text("os_version"),
    appVersion: text("app_version").notNull().default("0.0.0"),
    installId: text("install_id").notNull().unique(),
    publicKey: text("public_key").notNull().default(""),
    status: text("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    pairedAt: timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    capabilities: jsonb("capabilities").notNull().default({}),
    permissionMode: text("permission_mode").notNull().default("ask_risky"),
    trustedProjectIds: jsonb("trusted_project_ids").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_hosts_user_id_idx").on(t.userId),
    index("orax_hosts_status_idx").on(t.userId, t.status),
  ],
);

// ── orax_pairing_codes ─────────────────────────────────────────────────────────
// Short-lived (10 min), single-use. Account-bound: the redeeming session's
// userId must match the code's userId. A new code invalidates all previous
// unredeemed codes for the same host (enforced at the API layer).

export const oraxPairingCodesTable = pgTable(
  "orax_pairing_codes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: text("host_id").notNull(),
    userId: text("user_id").notNull(),
    code: text("code").notNull().unique(),
    qrPayload: text("qr_payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedBy: text("redeemed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_pairing_codes_host_id_idx").on(t.hostId),
    index("orax_pairing_codes_user_id_idx").on(t.userId),
  ],
);

// ── orax_paired_devices ────────────────────────────────────────────────────────
// One row per (host, mobile device) pair. Unique constraint prevents duplicate
// pairing rows; re-pairing upserts via ON CONFLICT DO UPDATE.

export const oraxPairedDevicesTable = pgTable(
  "orax_paired_devices",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: text("host_id").notNull(),
    userId: text("user_id").notNull(),
    mobileDeviceId: text("mobile_device_id").notNull(),
    displayName: text("display_name"),
    platform: text("platform"),
    pairedAt: timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("orax_paired_devices_host_mobile_uidx").on(t.hostId, t.mobileDeviceId),
    index("orax_paired_devices_user_id_idx").on(t.userId),
  ],
);

// ── orax_projects ──────────────────────────────────────────────────────────────
// Local project folders registered on a desktop host. Survives host reconnects.
// On a new device, local_path may be absent — the UI shows "Reconnect folder".

export const oraxProjectsTable = pgTable(
  "orax_projects",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    hostId: text("host_id").notNull(),
    userId: text("user_id").notNull(),
    localPath: text("local_path").notNull(),
    displayName: text("display_name").notNull(),
    gitRemoteUrl: text("git_remote_url"),
    currentBranch: text("current_branch"),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    permissionModeOverride: text("permission_mode_override"),
    setupScripts: jsonb("setup_scripts"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_projects_host_id_idx").on(t.hostId),
    index("orax_projects_user_id_idx").on(t.userId),
  ],
);

// ── orax_threads ───────────────────────────────────────────────────────────────
// Task/conversation threads. A thread belongs to a host (for desktop-executed
// work) and optionally to a project. Cloud-only threads have hostId = null.

export const oraxThreadsTable = pgTable(
  "orax_threads",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    hostId: text("host_id"),
    projectId: text("project_id"),
    title: text("title"),
    status: text("status").notNull().default("idle"),
    lastEvent: jsonb("last_event"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_threads_user_id_idx").on(t.userId),
    index("orax_threads_host_id_idx").on(t.hostId),
    index("orax_threads_project_id_idx").on(t.projectId),
    index("orax_threads_status_idx").on(t.userId, t.status),
  ],
);

// ── orax_thread_messages ───────────────────────────────────────────────────────
// All messages within a thread: user prompts, assistant replies,
// system events (progress, stdout chunks, diffs), and approval records.

export const oraxThreadMessagesTable = pgTable(
  "orax_thread_messages",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text("thread_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    eventType: text("event_type"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_thread_messages_thread_id_idx").on(t.threadId),
    index("orax_thread_messages_created_at_idx").on(t.threadId, t.createdAt),
  ],
);

// ── orax_pending_approvals ─────────────────────────────────────────────────────
// Approval requests initiated by web/mobile (Phase 2F command approvals) or
// the desktop (future phases). Resolved from web, mobile, or the desktop UI.
// Phase 2F columns: userId, cwd, reason, riskLevel, expiresAt.
// threadId is nullable — command approvals may exist outside a thread.

// Desktop-specific name: desktop command approvals are always account-scoped
// (userId is required). SQL table name stays orax_pending_approvals for
// migration compatibility.
export const oraxDesktopPendingApprovalsTable = pgTable(
  "orax_pending_approvals",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    hostId: text("host_id").notNull(),
    threadId: text("thread_id"),
    description: text("description").notNull(),
    command: text("command"),
    filePath: text("file_path"),
    diff: text("diff"),
    cwd: text("cwd"),
    reason: text("reason"),
    riskLevel: text("risk_level").notNull().default("low"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_pending_approvals_thread_id_idx").on(t.threadId),
    index("orax_pending_approvals_host_id_idx").on(t.hostId),
    index("orax_pending_approvals_status_idx").on(t.hostId, t.status),
    index("orax_pending_approvals_user_id_idx").on(t.userId),
  ],
);

// Backward-compat alias so any existing code referencing the old name still works.
export const oraxPendingApprovalsTable = oraxDesktopPendingApprovalsTable;

// ── orax_usage_events ──────────────────────────────────────────────────────────
// Append-only usage event log. Written by the cloud on confirmation from the
// desktop (not self-reported by the client, to prevent spoofing).

export const oraxUsageEventsTable = pgTable(
  "orax_usage_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    hostId: text("host_id").notNull(),
    projectId: text("project_id"),
    threadId: text("thread_id"),
    actionType: text("action_type").notNull(),
    modelUsed: text("model_used"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    computeMs: integer("compute_ms"),
    status: text("status").notNull().default("success"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_usage_events_user_id_idx").on(t.userId),
    index("orax_usage_events_host_id_idx").on(t.hostId),
    index("orax_usage_events_thread_id_idx").on(t.threadId),
    index("orax_usage_events_created_at_idx").on(t.userId, t.createdAt),
  ],
);

// ── orax_audit_log ─────────────────────────────────────────────────────────────
// Security audit log. Records every sensitive action regardless of permission
// mode. Denormalized (no FK constraints) so it survives host/thread deletion.

export const oraxAuditLogTable = pgTable(
  "orax_audit_log",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    hostId: text("host_id").notNull(),
    projectId: text("project_id"),
    threadId: text("thread_id"),
    action: text("action").notNull(),
    command: text("command"),
    filePath: text("file_path"),
    outcome: text("outcome").notNull(),
    errorMsg: text("error_msg"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orax_audit_log_user_id_idx").on(t.userId),
    index("orax_audit_log_host_id_idx").on(t.hostId),
    index("orax_audit_log_thread_id_idx").on(t.threadId),
    index("orax_audit_log_created_at_idx").on(t.userId, t.createdAt),
  ],
);

// ── Inferred types ─────────────────────────────────────────────────────────────

export type OraxHost = typeof oraxHostsTable.$inferSelect;
export type InsertOraxHost = typeof oraxHostsTable.$inferInsert;
export type OraxPairingCode = typeof oraxPairingCodesTable.$inferSelect;
export type InsertOraxPairingCode = typeof oraxPairingCodesTable.$inferInsert;
export type OraxPairedDevice = typeof oraxPairedDevicesTable.$inferSelect;
export type InsertOraxPairedDevice = typeof oraxPairedDevicesTable.$inferInsert;
export type OraxProject = typeof oraxProjectsTable.$inferSelect;
export type InsertOraxProject = typeof oraxProjectsTable.$inferInsert;
export type OraxThread = typeof oraxThreadsTable.$inferSelect;
export type InsertOraxThread = typeof oraxThreadsTable.$inferInsert;
export type OraxThreadMessage = typeof oraxThreadMessagesTable.$inferSelect;
export type InsertOraxThreadMessage = typeof oraxThreadMessagesTable.$inferInsert;
export type OraxDesktopPendingApproval = typeof oraxDesktopPendingApprovalsTable.$inferSelect;
export type InsertOraxDesktopPendingApproval = typeof oraxDesktopPendingApprovalsTable.$inferInsert;
// Backward-compat type aliases
export type OraxPendingApproval = OraxDesktopPendingApproval;
export type InsertOraxPendingApproval = InsertOraxDesktopPendingApproval;
export type OraxUsageEvent = typeof oraxUsageEventsTable.$inferSelect;
export type InsertOraxUsageEvent = typeof oraxUsageEventsTable.$inferInsert;
export type OraxAuditLog = typeof oraxAuditLogTable.$inferSelect;
export type InsertOraxAuditLog = typeof oraxAuditLogTable.$inferInsert;

// ── Phase 2E: relay message envelope ───────────────────────────────────────
// Typed envelope for all messages passed through the Orax relay layer.
// Used by both WS (future) and HTTP-polling (Phase 2E MVP) transports.

export const ORAX_RELAY_MESSAGE_TYPES = [
  "host_connected",
  "host_disconnected",
  "action_requested",
  "action_acknowledged",
  "action_progress",
  "action_completed",
  "action_failed",
  "approval_requested",
  "approval_resolved",
  "ping",
  "pong",
] as const;
export type OraxRelayMessageType = (typeof ORAX_RELAY_MESSAGE_TYPES)[number];

export interface OraxRelayMessage {
  id: string;
  type: OraxRelayMessageType;
  userId: string;
  hostId: string;
  threadId?: string;
  actionId?: string;
  sequenceNum: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Phase 2E safe action types (no shell / file / git) ─────────────────────

export const ORAX_PHASE2E_ACTION_TYPES = [
  "ping_desktop",
  "get_desktop_status",
  "list_local_projects",
] as const;
export type OraxPhase2EActionType = (typeof ORAX_PHASE2E_ACTION_TYPES)[number];

export const ORAX_DESKTOP_ACTION_STATUSES = [
  "queued",
  "sent",
  "acknowledged",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type OraxDesktopActionStatus = (typeof ORAX_DESKTOP_ACTION_STATUSES)[number];

// ── orax_desktop_actions ────────────────────────────────────────────────────
// One row per action dispatched from web/mobile to a desktop host.
// Status lifecycle: queued → sent → acknowledged → running → completed/failed.
// idempotency_key is caller-supplied or server-generated; unique constraint
// allows safe retries without double-execution.

export const oraxDesktopActionsTable = pgTable(
  "orax_desktop_actions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    hostId: text("host_id").notNull(),
    threadId: text("thread_id"),
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("orax_desktop_actions_user_id_idx").on(t.userId),
    index("orax_desktop_actions_host_id_idx").on(t.hostId),
    index("orax_desktop_actions_status_idx").on(t.hostId, t.status),
    index("orax_desktop_actions_thread_id_idx").on(t.threadId),
  ],
);

export type OraxDesktopAction = typeof oraxDesktopActionsTable.$inferSelect;
export type InsertOraxDesktopAction = typeof oraxDesktopActionsTable.$inferInsert;
