import {
  pgTable,
  serial,
  date,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Durable Ora spend ledger — Wave 1C.
 *
 * One aggregated row per (date_key, ledger_key). Upserted atomically with
 * ON CONFLICT DO UPDATE so concurrent API processes never lose an increment.
 *
 * ledger_key encoding:
 *   "global"            — total units across all callers (UTC calendar day)
 *   "user:{userId}"     — units for one authenticated user
 *   "ip:{ipHash}"       — units for one anonymous IP (first 8 chars of raw IP)
 *   "feature:{kind}"    — units attributed to one OraFeatureKind
 *
 * On startup the API server reads today's rows and seeds its in-memory Maps
 * so caps survive restarts and deployments. Rows for past days are kept for
 * admin observability and may be pruned by a retention job after 30 days.
 */
export const oraSpendLedgerTable = pgTable(
  "ora_spend_ledger",
  {
    id: serial("id").primaryKey(),
    /** UTC calendar day — "YYYY-MM-DD" stored as SQL DATE. */
    dateKey: date("date_key").notNull(),
    /** Composite key encoding cap dimension (see above). */
    ledgerKey: text("ledger_key").notNull(),
    /** Accumulated units for this (date_key, ledger_key) pair. */
    units: integer("units").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ora_spend_ledger_date_key_unique").on(t.dateKey, t.ledgerKey),
    index("ora_spend_ledger_date_idx").on(t.dateKey),
  ],
);

export type OraSpendLedgerRow = typeof oraSpendLedgerTable.$inferSelect;
export type InsertOraSpendLedgerRow = typeof oraSpendLedgerTable.$inferInsert;
