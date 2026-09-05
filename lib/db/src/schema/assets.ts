import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectsTable } from "./projects";
import { projectArtifactsTable } from "./project-artifacts";

export const ASSET_KINDS = ["image", "file", "snapshot", "recording", "generated"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_SCOPES = ["account", "project", "thread"] as const;
export type AssetScope = (typeof ASSET_SCOPES)[number];

export type ProductScope = "nabuflow" | "ora";

export const ASSET_STATES = [
  "reserved",
  "uploading",
  "ready",
  "deleting",
  "rejected",
  "deleted",
] as const;
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
  altText?: string;
  suggestedAltText?: string;
  brandRole?: "none" | "logo" | "icon" | "palette" | "font" | "reference";
  derivativeOfAssetId?: number;
  derivativePreset?: string;
  visualEvidencePhase?: "before" | "after" | "evidence";
  visualEvidencePairId?: string | null;
};

export const assetsTable = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    productScope: text("product_scope").$type<ProductScope>(),
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
    uploadStartedAt: timestamp("upload_started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check("assets_product_scope_check", sql`${table.productScope} IN ('nabuflow', 'ora')`),
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
    artifactId: integer("artifact_id").references(() => projectArtifactsTable.id, {
      onDelete: "cascade",
    }),
    versionId: integer("version_id"),
    filePath: text("file_path"),
    consumer: text("consumer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Keep the type-level identity exactly aligned with the startup migration:
    // PostgreSQL NULL values are not equal under an ordinary unique index.
    uniqueIndex("asset_usage_identity_uq").on(
      table.assetId,
      sql`COALESCE(${table.projectId}, -1)`,
      sql`COALESCE(${table.artifactId}, -1)`,
      sql`COALESCE(${table.versionId}, -1)`,
      sql`COALESCE(${table.filePath}, '')`,
      table.consumer,
    ),
    index("asset_usage_asset_idx").on(table.assetId),
    index("asset_usage_project_idx").on(table.projectId),
  ],
);

/** @dormantExport Shared validation may consume this once storage-object APIs are exposed. */
export const ASSET_STORAGE_OBJECT_STATES = [
  "reserved",
  "uploading",
  "ready",
  "deleting",
  "deleted",
] as const;

/** Every physical object billed by the storage provider for one logical asset. */
export const assetStorageObjectsTable = pgTable(
  "asset_storage_objects",
  {
    id: serial("id").primaryKey(),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assetsTable.id, { onDelete: "cascade" }),
    storageBackend: text("storage_backend").notNull(),
    storageKey: text("storage_key").notNull(),
    role: text("role").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    /** Null only for adopted provider objects whose exact bytes still need observation. */
    sizeMeasuredAt: timestamp("size_measured_at", { withTimezone: true }),
    /** Immutable provider object generation observed before destructive cleanup. */
    providerGeneration: text("provider_generation"),
    /** Provider checksum associated with the observed generation. */
    providerChecksum: text("provider_checksum"),
    state: text("state").notNull().default("reserved"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("asset_storage_objects_key_uq").on(table.storageKey),
    uniqueIndex("asset_storage_objects_role_uq").on(table.assetId, table.role),
    index("asset_storage_objects_asset_idx").on(table.assetId, table.state),
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

export const assetAnalysisEventsTable = pgTable(
  "asset_analysis_events",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assetsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedProviderCostMicros: bigint("estimated_provider_cost_micros", { mode: "number" })
      .notNull()
      .default(0),
    customerCreditPrice: integer("customer_credit_price"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("asset_analysis_user_created_idx").on(table.userId, table.createdAt),
    index("asset_analysis_asset_idx").on(table.assetId),
  ],
);

export type Asset = typeof assetsTable.$inferSelect;
export type NewAsset = typeof assetsTable.$inferInsert;
