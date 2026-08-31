import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export type ProjectRetirementTargetProgress = {
  role: "preview" | "production";
  slot: "primary" | "blue" | "green";
  state: "pending" | "destroying" | "verified_absent" | "failed";
  attempts: number;
  failureCode: string | null;
};

export type ProjectRetirementProgress = {
  reconciliation?: {
    generation: number;
    parentOperationId: string;
    requestedBy: string;
    reason: "retryable_terminal" | "legacy_admin_reconciliation";
  };
  route: {
    state: "pending" | "deactivating" | "verified_absent" | "failed";
    failureCode: string | null;
    /** Legacy Snapshot-Worker hostname KV is optional; current routes use the runtime registry. */
    legacyHostnameKv?: {
      state: "not_configured" | "verified_absent" | "failed";
      failureCode: string | null;
    };
    hostnames: Array<{
      hostname: string;
      state: "absent" | "present" | "unavailable";
      stage: "delete" | "read" | null;
    }>;
    runtimeRoutes?: Array<{
      hostname: string;
      manifestRevision: string;
      sandboxIdentity: string;
      state: "releasing" | "verified_absent" | "present" | "unavailable";
    }>;
    cache: { state: "pending" | "purged" | "failed" };
  };
  tasks: {
    state: "pending" | "canceled";
    count: number;
    terminalized: number;
    creditsRefunded: number;
    telemetryFlushed: number;
  };
  domains: Array<{
    domainId: number;
    hostname: string;
    state: "pending" | "releasing" | "verified_absent" | "failed";
    failureCode: string | null;
  }>;
  /**
   * One receipt per unique provider hostname id. A legacy projects pointer and
   * any matching project_domains pointers share the same absence proof.
   */
  hostnameCertificates?: Array<{
    cfHostnameId: string;
    hostnames: string[];
    projectDomainIds: number[];
    legacyProjectPointer: boolean;
    state: "pending" | "releasing" | "verified_absent" | "failed";
    failureCode: string | null;
  }>;
  /** Exact zone security resources removed before a domain pointer is lost. */
  securityResources?: Array<{
    domainId: number;
    hostname: string;
    kind: "ruleset_rule" | "firewall_rule" | "firewall_filter" | "rate_limit" | "mtls_certificate";
    providerId: string;
    rulesetId: string | null;
    ref: string;
    state: "pending" | "releasing" | "verified_absent" | "failed";
    failureCode: string | null;
  }>;
  /** Purchased-domain ownership survives; only its project assignment is retired. */
  purchasedDomains?: Array<{
    purchasedDomainId: number;
    projectDomainId: number | null;
    hostname: string;
    state: "pending" | "detached";
  }>;
  retainedLegacyRuntimePointers: Array<{
    pointer: "containerId" | "prodContainerId";
    identity: string;
    reason:
      | "runtime_identity_malformed"
      | "runtime_namespace_mismatch"
      | "runtime_project_mismatch"
      | "runtime_role_slot_mismatch";
  }>;
  runtimes: ProjectRetirementTargetProgress[];
};

export const projectRetirementOperationsTable = pgTable(
  "project_retirement_operations",
  {
    id: text("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").notNull(),
    state: text("state").notNull().default("accepted"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseVersion: integer("lease_version").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    progress: jsonb("progress").$type<ProjectRetirementProgress>().notNull(),
    failureCode: text("failure_code"),
    failureTarget: jsonb("failure_target").$type<{
      role: "preview" | "production";
      slot: "primary" | "blue" | "green";
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("project_retirement_operations_project_idx").on(table.projectId, table.createdAt),
    index("project_retirement_operations_state_idx").on(table.state, table.updatedAt),
    uniqueIndex("project_retirement_operations_active_project_uq")
      .on(table.projectId)
      .where(sql`state IN ('accepted', 'running') OR (state = 'failed' AND completed_at IS NULL)`),
  ],
);

export type ProjectRetirementOperation = typeof projectRetirementOperationsTable.$inferSelect;
export type InsertProjectRetirementOperation = typeof projectRetirementOperationsTable.$inferInsert;
