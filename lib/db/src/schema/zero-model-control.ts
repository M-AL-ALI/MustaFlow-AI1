import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentTasksTable } from "./tasks";

/**
 * Versioned, operator-owned model bindings. A tier is the customer-facing
 * execution tier (lite | eco | power | pro); stage remains an independent
 * call attribute and can never be inferred from this table.
 */
export const zeroModelBindingVersionsTable = pgTable(
  "zero_model_binding_versions",
  {
    id: serial("id").primaryKey(),
    tier: text("tier").notNull(),
    version: integer("version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").notNull().default("candidate"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedBy: text("activated_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (table) => [
    unique("zero_model_binding_tier_version_uq").on(table.tier, table.version),
    uniqueIndex("zero_model_binding_one_active_per_tier_uq")
      .on(table.tier)
      .where(sql`${table.state} = 'active'`),
    index("zero_model_binding_tier_state_idx").on(table.tier, table.state, table.createdAt),
    check("zero_model_binding_tier_check", sql`${table.tier} IN ('lite','eco','power','pro')`),
    check(
      "zero_model_binding_provider_check",
      sql`${table.provider} IN ('openai','anthropic','gemini','deepseek','local')`,
    ),
    check(
      "zero_model_binding_state_check",
      sql`${table.state} IN ('candidate','active','previous','retired')`,
    ),
    check("zero_model_binding_version_check", sql`${table.version} > 0`),
  ],
);

/** Singleton operational settings; the parity floor is data, never code. */
export const zeroModelRegistrySettingsTable = pgTable(
  "zero_model_registry_settings",
  {
    registryKey: text("registry_key").primaryKey().default("global"),
    parityFloor: numeric("parity_floor", { precision: 8, scale: 4 }),
    resolverMode: text("resolver_mode").notNull().default("legacy"),
    updatedBy: text("updated_by").notNull().default("system"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("zero_model_registry_key_check", sql`${table.registryKey} = 'global'`),
    check("zero_model_registry_mode_check", sql`${table.resolverMode} IN ('legacy','registry')`),
    check(
      "zero_model_registry_parity_floor_check",
      sql`${table.parityFloor} IS NULL OR ${table.parityFloor} >= 0`,
    ),
  ],
);

/** One durable identity receipt per Zero provider call. */
export const zeroModelCallReceiptsTable = pgTable(
  "zero_model_call_receipts",
  {
    id: uuid("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    taskId: integer("task_id").references(() => agentTasksTable.id, { onDelete: "set null" }),
    tier: text("tier").notNull(),
    stage: text("stage").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    bindingVersionId: integer("binding_version_id").references(
      () => zeroModelBindingVersionsTable.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("started"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("zero_model_call_tier_finished_idx").on(table.tier, table.finishedAt),
    index("zero_model_call_operation_idx").on(table.operationId, table.startedAt),
    index("zero_model_call_task_idx").on(table.taskId, table.startedAt),
    check("zero_model_call_tier_check", sql`${table.tier} IN ('lite','eco','power','pro')`),
    check(
      "zero_model_call_stage_check",
      sql`${table.stage} IN ('build','refine','plan','architect','intent','converse')`,
    ),
    check(
      "zero_model_call_provider_check",
      sql`${table.provider} IN ('openai','anthropic','gemini','deepseek','local')`,
    ),
    check(
      "zero_model_call_status_check",
      sql`${table.status} IN ('started','completed','failed','interrupted')`,
    ),
  ],
);

export type ZeroModelBindingVersion = typeof zeroModelBindingVersionsTable.$inferSelect;
export type InsertZeroModelBindingVersion = typeof zeroModelBindingVersionsTable.$inferInsert;
export type ZeroModelRegistrySettings = typeof zeroModelRegistrySettingsTable.$inferSelect;
export type ZeroModelCallReceipt = typeof zeroModelCallReceiptsTable.$inferSelect;
export type InsertZeroModelCallReceipt = typeof zeroModelCallReceiptsTable.$inferInsert;
