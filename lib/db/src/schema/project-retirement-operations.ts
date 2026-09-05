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
  /** Closed semantics identity; older/malformed receipts never authorize restore. */
  semantics: "project-retirement-v2";
  /**
   * Minimal replay receipt written atomically with clearing the project tombstone.
   * It intentionally carries no user content, provider response, hostname, or secret.
   */
  restore?: {
    state: "restored";
    restoredAt: string;
  };
  reconciliation?: {
    generation: number;
    parentOperationId: string;
    requestedBy: string;
    reason: "retryable_terminal" | "legacy_admin_reconciliation" | "configuration_recovery";
    configurationRecoveryUsed?: boolean;
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
  access: {
    state: "pending" | "revoked";
    shareLinksRevoked: number;
    previewSessionsRevoked: number;
    supportGrantsRevoked: number;
    supportSessionsInterrupted: number;
    canvasShareTokensCleared: number;
    canvasAbTestsEnded: number;
  };
  /** Legacy CDN objects under the numeric project prefix; keys never enter the receipt. */
  legacyR2: {
    state: "pending" | "deleting" | "not_configured" | "verified_absent" | "failed";
    discoveredCount: number;
    deletedCount: number;
    failureCode: string | null;
  };
  /**
   * Managed add-ons in the current implementation are project-scoped bindings
   * to shared services.  Retirement clears those bindings and their injected
   * secrets, then proves the project has no live binding left.  Provider-owned
   * resources must use a future explicitly registered release handler instead
   * of being mistaken for a binding-only add-on.
   */
  managedAddons: {
    state: "pending" | "detaching" | "verified_detached" | "failed";
    discoveredCount: number;
    detachedCount: number;
    secretsRemoved: number;
    bindingsRemaining: number;
    failureCode: string | null;
  };
  /** Recovery evidence earned before a SQLite-bearing runtime is destroyed. */
  sqliteRecovery: {
    state: "pending" | "not_applicable" | "not_present" | "preserved" | "failed";
    snapshotId: number | null;
    sizeBytes: number;
    storage: "inline" | "object" | null;
    failureCode: string | null;
  };
  domains: Array<{
    domainId: number | null;
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
    domainId: number | null;
    hostname: string;
    kind: "ruleset_rule" | "firewall_rule" | "firewall_filter" | "rate_limit" | "mtls_certificate";
    providerId: string;
    rulesetId: string | null;
    ref: string;
    state: "pending" | "releasing" | "verified_absent" | "failed";
    failureCode: string | null;
  }>;
  /** Purchased-domain ownership and recoverable project assignment both survive Trash. */
  purchasedDomains?: Array<{
    purchasedDomainId: number;
    projectDomainId: number | null;
    hostname: string;
    state: "pending" | "retained";
  }>;
  retainedLegacyRuntimePointers: Array<{
    pointer: "containerId" | "prodContainerId" | "testContainerId";
    identity: string;
    reason:
      | "runtime_identity_malformed"
      | "runtime_namespace_mismatch"
      | "runtime_project_mismatch"
      | "runtime_role_slot_mismatch"
      | "legacy_runtime_provider";
  }>;
  /** Sanitized Fly reconciliation evidence; raw machine identities remain internal. */
  legacyRuntimeResolutions?: Array<
    | {
        pointer: "containerId" | "prodContainerId" | "testContainerId";
        state: "verified_absent";
        proof: "initial_get_404" | "delete_then_get_404";
      }
    | {
        pointer: "containerId" | "prodContainerId" | "testContainerId";
        state: "retained";
        reason:
          | "legacy_pointer_malformed"
          | "provider_observation_unavailable"
          | "provider_response_invalid"
          | "machine_identity_mismatch"
          | "project_identity_mismatch"
          | "contradictory_identity_marker"
          | "storage_ownership_ambiguous"
          | "provider_delete_unavailable"
          | "absence_unverified";
        retryable: boolean;
      }
  >;
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
