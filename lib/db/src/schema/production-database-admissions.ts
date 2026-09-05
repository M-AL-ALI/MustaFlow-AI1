import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const productionDatabaseAdmissionEpochsTable = pgTable(
  "production_database_admission_epochs",
  {
    epoch: uuid("epoch").primaryKey(),
    namespace: text("namespace").notNull().default("production"),
    state: text("state").notNull().default("prepared"),
    workerDeploymentVersion: text("worker_deployment_version").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    projectIdFloor: integer("project_id_floor").notNull(),
  },
  (table) => [
    check(
      "production_database_admission_epoch_namespace_check",
      sql`${table.namespace} = 'production'`,
    ),
    check(
      "production_database_admission_epoch_state_check",
      sql`${table.state} IN ('prepared','active','closed')`,
    ),
    check(
      "production_database_admission_epoch_evidence_check",
      sql`${table.evidenceSha256} ~ '^[0-9a-f]{64}$' AND length(${table.workerDeploymentVersion}) BETWEEN 1 AND 200 AND ${table.projectIdFloor} >= 0`,
    ),
    check(
      "production_database_admission_epoch_drain_check",
      sql`${table.state} <> 'active' OR (${table.activatedAt} IS NOT NULL AND ${table.activatedAt} >= ${table.observedAt} + interval '6 minutes')`,
    ),
    uniqueIndex("production_database_admission_epoch_active_uq")
      .on(table.namespace)
      .where(sql`state = 'active'`),
  ],
);

/** No project FK: this minimal terminal authorization evidence survives project removal. */
export const productionDatabaseAdmissionReceiptsTable = pgTable(
  "production_database_admission_receipts",
  {
    projectId: integer("project_id").primaryKey(),
    registrationEpoch: uuid("registration_epoch")
      .notNull()
      .references(() => productionDatabaseAdmissionEpochsTable.epoch),
    birthToken: uuid("birth_token").notNull(),
    birthRegistered: boolean("birth_registered").notNull(),
    allocationIdentity: text("allocation_identity"),
    state: text("state").notNull(),
    authorizationId: uuid("authorization_id"),
    sealId: uuid("seal_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("production_database_admission_receipt_project_check", sql`${table.projectId} > 0`),
    check(
      "production_database_admission_receipt_identity_check",
      sql`${table.allocationIdentity} IS NULL OR ${table.allocationIdentity} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "production_database_admission_receipt_state_check",
      sql`(${table.state} = 'fresh' AND ${table.birthRegistered} AND ${table.authorizationId} IS NULL AND ${table.sealId} IS NULL) OR (${table.state} = 'authorized' AND ${table.allocationIdentity} IS NOT NULL AND ${table.authorizationId} IS NOT NULL AND ${table.sealId} IS NULL) OR (${table.state} = 'sealed' AND ${table.allocationIdentity} IS NOT NULL AND ${table.sealId} IS NOT NULL)`,
    ),
  ],
);
