import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Shared hour/day admission counters for the public brainstorm surface.
 * admissionKey is already a one-way digest; no caller identity is stored.
 */
export const brainstormAdmissionCountersTable = pgTable(
  "brainstorm_admission_counters",
  {
    admissionKey: text("admission_key").notNull(),
    bucketKind: text("bucket_kind").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "brainstorm_admission_counters_pk",
      columns: [t.admissionKey, t.bucketKind, t.bucketStart],
    }),
    check("brainstorm_admission_bucket_kind_check", sql`${t.bucketKind} IN ('hour', 'day')`),
    check("brainstorm_admission_count_nonnegative_check", sql`${t.count} >= 0`),
    index("brainstorm_admission_counters_reset_idx").on(t.resetAt),
  ],
);

export type BrainstormAdmissionCounter = typeof brainstormAdmissionCountersTable.$inferSelect;
