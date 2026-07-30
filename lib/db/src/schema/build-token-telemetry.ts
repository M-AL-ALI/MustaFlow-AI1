import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  numeric,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { agentTasksTable } from "./tasks";

/**
 * Per-build token telemetry — NabuFlow R2 Phase D.
 *
 * One row per completed build (upserted on task_id). Captures the aggregate
 * token economics for the build so the 7-day calibration report can compare
 * actual loaded cost against the credit charge basis and flag modes where the
 * ratio drops below 1.15×.
 *
 * `computed_usd_cost` is derived from static per-model pricing constants and
 * is for internal calibration only — it is NOT used for billing or invoicing.
 */
export const buildTokenTelemetryTable = pgTable(
  "build_token_telemetry",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => agentTasksTable.id, { onDelete: "cascade" }),
    /** Agent mode frozen at build time (lite | eco | power | pro). */
    mode: text("mode").notNull(),
    /** AI provider used for the dominant build call (openai | anthropic | gemini | deepseek). */
    provider: text("provider").notNull(),
    /** Canonical model identifier as sent to the provider SDK. */
    model: text("model").notNull(),
    /** Total prompt/input tokens across all model calls in this build. */
    inputTokens: integer("input_tokens").notNull().default(0),
    /** Total completion/output tokens across all model calls in this build. */
    outputTokens: integer("output_tokens").notNull().default(0),
    /**
     * Estimated USD cost derived from static per-model pricing constants.
     * For calibration reporting only — never read for billing.
     */
    computedUsdCost: numeric("computed_usd_cost", { precision: 12, scale: 8 })
      .notNull()
      .default("0"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("build_token_telemetry_task_id_unique").on(t.taskId),
    index("build_token_telemetry_task_id_idx").on(t.taskId),
    index("build_token_telemetry_mode_recorded_idx").on(t.mode, t.recordedAt),
    index("build_token_telemetry_recorded_at_idx").on(t.recordedAt),
  ],
);

export type BuildTokenTelemetry = typeof buildTokenTelemetryTable.$inferSelect;
export type InsertBuildTokenTelemetry = typeof buildTokenTelemetryTable.$inferInsert;
