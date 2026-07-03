import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

/**
 * orax_hosts — registered Orax Desktop installations.
 *
 * One row per physical machine registration. A single user can have multiple
 * hosts (work laptop + home desktop). installId is a stable UUID written to
 * the OS credential store on first install and survives app updates.
 */
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

/**
 * orax_pairing_codes — short-lived, single-use codes for QR / manual pairing.
 *
 * Created by the desktop on demand. Expires in 10 minutes. Account-bound:
 * the redeeming session's userId must match the code's userId.
 */
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

/**
 * orax_paired_devices — mobile / browser sessions paired to a desktop host.
 *
 * One row per (host, mobile device) pair. A phone can appear in multiple rows
 * when paired to multiple desktops. A desktop can appear in multiple rows when
 * multiple phones are paired to it.
 */
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
    index("orax_paired_devices_host_id_idx").on(t.hostId),
    index("orax_paired_devices_user_id_idx").on(t.userId),
    index("orax_paired_devices_mobile_idx").on(t.mobileDeviceId),
  ],
);

export type OraxHost = typeof oraxHostsTable.$inferSelect;
export type InsertOraxHost = typeof oraxHostsTable.$inferInsert;
export type OraxPairingCode = typeof oraxPairingCodesTable.$inferSelect;
export type InsertOraxPairingCode = typeof oraxPairingCodesTable.$inferInsert;
export type OraxPairedDevice = typeof oraxPairedDevicesTable.$inferSelect;
export type InsertOraxPairedDevice = typeof oraxPairedDevicesTable.$inferInsert;
