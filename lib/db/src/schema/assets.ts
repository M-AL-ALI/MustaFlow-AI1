import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const ASSET_KINDS = ["image", "file", "snapshot", "recording", "generated"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_SCOPES = ["account", "project", "thread"] as const;
export type AssetScope = (typeof ASSET_SCOPES)[number];

export const ASSET_STATES = ["reserved", "ready", "rejected", "deleted"] as const;
export type AssetState = (typeof ASSET_STATES)[number];

export const ASSET_SCAN_STATES = [
  "not-required",
  "not-scanned",
  "clean",
  "threat",
  "failed",
] as const;
export type AssetScanState = (typeof ASSET_SCAN_STATES)[number];

export type AssetContext = {
  route?: string;
  domPath?: string;
  viewport?: { width: number; height: number; deviceMode: string };
  consoleErrors?: string[];
  region?: { x: number; y: number; width: number; height: number };
  annotation?: { kind: "arrow" | "circle"; label: string };
  redactions?: Array<{ x: number; y: number; width: number; height: number }>;
  resized?: boolean;
};

export const assetsTable = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
    threadKey: text("thread_key"),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    storageBackend: text("storage_backend").notNull().default("r2"),
    storageKey: text("storage_key").notNull(),
    state: text("state").notNull().default("reserved"),
    scanState: text("scan_state").notNull().default("not-scanned"),
    rejectionCode: text("rejection_code"),
    textPreview: text("text_preview"),
    versionId: integer("version_id"),
    taskId: integer("task_id"),
    messageId: integer("message_id"),
    context: jsonb("context").$type<AssetContext>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("assets_storage_key_uq").on(table.storageKey),
    index("assets_owner_state_idx").on(table.ownerUserId, table.state),
    index("assets_project_created_idx").on(table.projectId, table.createdAt),
    index("assets_thread_created_idx").on(table.threadKey, table.createdAt),
  ],
);

export const assetUsageTable = pgTable(
  "asset_usage",
  {
    id: serial("id").primaryKey(),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assetsTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
    versionId: integer("version_id"),
    filePath: text("file_path"),
    consumer: text("consumer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("asset_usage_identity_uq").on(
      table.assetId,
      table.projectId,
      table.versionId,
      table.filePath,
      table.consumer,
    ),
    index("asset_usage_asset_idx").on(table.assetId),
    index("asset_usage_project_idx").on(table.projectId),
  ],
);

export const accountAssetQuotaTable = pgTable("account_asset_quota", {
  userId: text("user_id").primaryKey(),
  baseAllowanceBytes: bigint("base_allowance_bytes", { mode: "number" })
    .notNull()
    .default(524_288_000),
  purchasedAllowanceBytes: bigint("purchased_allowance_bytes", { mode: "number" })
    .notNull()
    .default(0),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storageAddonSubscriptionsTable = pgTable(
  "storage_addon_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    sku: text("sku").notNull(),
    allowanceBytes: bigint("allowance_bytes", { mode: "number" }).notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeItemId: text("stripe_item_id"),
    status: text("status").notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_addons_stripe_sub_uq").on(table.stripeSubscriptionId),
    index("storage_addons_user_status_idx").on(table.userId, table.status),
  ],
);

export type Asset = typeof assetsTable.$inferSelect;
export type NewAsset = typeof assetsTable.$inferInsert;
