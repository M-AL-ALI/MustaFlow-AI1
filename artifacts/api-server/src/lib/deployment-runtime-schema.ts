import type { PoolClient } from "pg";

export const DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID = "deployment_runtime_schema_v3" as const;

export const DEPLOYMENT_RUNTIME_SCHEMA_VIOLATIONS = [
  "admin_authority_missing",
  "workspace_membership_missing",
  "support_delivery_missing",
  "support_delivery_constraints_missing",
  "support_delivery_indexes_missing",
  "prompt_queue_missing",
  "project_collaboration_missing",
  "project_retirement_operations_missing",
  "project_retirement_operations_columns_missing",
  "project_retirement_operations_constraints_missing",
  "project_retirement_operations_indexes_missing",
] as const;

export type DeploymentRuntimeSchemaViolation =
  (typeof DEPLOYMENT_RUNTIME_SCHEMA_VIOLATIONS)[number];

export type DeploymentRuntimeSchemaAssessment =
  | {
      contractId: typeof DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID;
      mode: "mutable";
      violations: readonly [];
    }
  | {
      contractId: typeof DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID;
      mode: "read-only-ready";
      violations: readonly [];
    }
  | {
      contractId: typeof DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID;
      mode: "read-only-incomplete";
      violations: readonly DeploymentRuntimeSchemaViolation[];
    };

type RuntimeSchemaObservation = {
  canCreateSchemaObjects: boolean;
  canMutateExistingObjects: boolean;
  adminAuthorityReady: boolean;
  workspaceMembershipReady: boolean;
  supportDeliveryReady: boolean;
  supportDeliveryConstraintsReady: boolean;
  supportDeliveryIndexesReady: boolean;
  promptQueueReady: boolean;
  projectCollaborationReady: boolean;
  projectRetirementOperationsReady: boolean;
  projectRetirementOperationsColumnsReady: boolean;
  projectRetirementOperationsConstraintsReady: boolean;
  projectRetirementOperationsIndexesReady: boolean;
};

/**
 * Deployment runtimes may intentionally receive a database role that cannot
 * perform DDL after Replit's migration phase has completed. Detect that
 * boundary with catalog reads only. A non-mutable runtime is accepted only
 * when the schema objects required by the current release are already present.
 */
export async function assessDeploymentRuntimeSchema(
  client: Pick<PoolClient, "query">,
): Promise<DeploymentRuntimeSchemaAssessment> {
  const result = await client.query<RuntimeSchemaObservation>(`
    SELECT
      has_schema_privilege(current_user, current_schema(), 'CREATE')
        AS "canCreateSchemaObjects",
      NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND relation.relkind = ANY(ARRAY['r', 'p', 'S', 'v', 'm']::"char"[])
           AND NOT pg_has_role(current_user, relation.relowner, 'USAGE')
      ) AS "canMutateExistingObjects",
      to_regclass('public.user_roles') IS NOT NULL
        AS "adminAuthorityReady",
      to_regclass('public.workspace_members') IS NOT NULL
        AS "workspaceMembershipReady",
      to_regclass('public.support_user_deliveries') IS NOT NULL
        AS "supportDeliveryReady",
      (
        SELECT COUNT(*) = 2
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'support_user_deliveries'
           AND constraint_row.conname = ANY(ARRAY[
             'support_user_deliveries_kind_check',
             'support_user_deliveries_email_status_check'
           ])
           AND constraint_row.convalidated
      ) AS "supportDeliveryConstraintsReady",
      (
        SELECT COUNT(*) = 2
          FROM pg_catalog.pg_index index_row
          JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
          JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND table_relation.relname = 'support_user_deliveries'
           AND index_relation.relname = ANY(ARRAY[
             'support_user_deliveries_ticket_created_idx',
             'support_user_deliveries_recipient_created_idx'
           ])
           AND index_row.indisvalid
           AND index_row.indisready
      ) AS "supportDeliveryIndexesReady",
      to_regclass('public.zero_prompt_queue_items') IS NOT NULL
        AS "promptQueueReady",
      (
        to_regclass('public.project_collaborators') IS NOT NULL
        AND to_regclass('public.project_invites') IS NOT NULL
      ) AS "projectCollaborationReady",
      to_regclass('public.project_retirement_operations') IS NOT NULL
        AS "projectRetirementOperationsReady",
      (
        SELECT COUNT(*) = 14
          FROM information_schema.columns column_row
         WHERE column_row.table_schema = 'public'
           AND column_row.table_name = 'project_retirement_operations'
           AND (column_row.column_name, column_row.data_type, column_row.is_nullable) IN (
             ('id', 'text', 'NO'), ('project_id', 'integer', 'NO'),
             ('requested_by', 'text', 'NO'), ('state', 'text', 'NO'),
             ('attempt_count', 'integer', 'NO'), ('lease_version', 'integer', 'NO'),
             ('lease_expires_at', 'timestamp with time zone', 'YES'),
             ('progress', 'jsonb', 'NO'), ('failure_code', 'text', 'YES'),
             ('failure_target', 'jsonb', 'YES'),
             ('created_at', 'timestamp with time zone', 'NO'),
             ('started_at', 'timestamp with time zone', 'YES'),
             ('completed_at', 'timestamp with time zone', 'YES'),
             ('updated_at', 'timestamp with time zone', 'NO')
           )
      ) AS "projectRetirementOperationsColumnsReady",
      (
        SELECT COUNT(*) = 5
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'project_retirement_operations'
           AND constraint_row.conname = ANY(ARRAY[
             'project_retirement_operations_pkey',
             'project_retirement_operations_state_check',
             'project_retirement_operations_attempt_count_check',
             'project_retirement_operations_lease_version_check',
             'project_retirement_operations_project_id_fkey'
           ])
           AND constraint_row.convalidated
           AND (
             (constraint_row.conname = 'project_retirement_operations_pkey'
               AND constraint_row.contype = 'p'
               AND pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (id)')
             OR (constraint_row.conname = 'project_retirement_operations_state_check'
               AND constraint_row.contype = 'c'
               AND pg_get_constraintdef(constraint_row.oid) LIKE '%state%accepted%running%failed%completed%canceled%')
             OR (constraint_row.conname = 'project_retirement_operations_attempt_count_check'
               AND constraint_row.contype = 'c'
               AND pg_get_constraintdef(constraint_row.oid) LIKE '%attempt_count%>= 0%')
             OR (constraint_row.conname = 'project_retirement_operations_lease_version_check'
               AND constraint_row.contype = 'c'
               AND pg_get_constraintdef(constraint_row.oid) LIKE '%lease_version%>= 0%')
             OR (constraint_row.conname = 'project_retirement_operations_project_id_fkey'
               AND constraint_row.contype = 'f'
               AND constraint_row.confdeltype = 'c'
               AND pg_get_constraintdef(constraint_row.oid)
                 = 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE')
           )
      ) AS "projectRetirementOperationsConstraintsReady",
      (
        SELECT COUNT(*) = 3
          FROM pg_catalog.pg_index index_row
          JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
          JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND table_relation.relname = 'project_retirement_operations'
           AND index_relation.relname = ANY(ARRAY[
             'project_retirement_operations_project_idx',
             'project_retirement_operations_state_idx',
             'project_retirement_operations_active_project_uq'
           ])
           AND index_row.indisvalid AND index_row.indisready
           AND (
             (index_relation.relname = 'project_retirement_operations_project_idx'
               AND pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id, created_at)%')
             OR (index_relation.relname = 'project_retirement_operations_state_idx'
               AND pg_get_indexdef(index_row.indexrelid) LIKE '%(state, updated_at)%')
             OR (index_relation.relname = 'project_retirement_operations_active_project_uq'
               AND index_row.indisunique
               AND pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id)%'
               AND pg_get_expr(index_row.indpred, index_row.indrelid) LIKE '%accepted%running%failed%completed_at%')
           )
      ) AS "projectRetirementOperationsIndexesReady"
  `);

  const observation = result.rows[0];
  if (
    observation?.canCreateSchemaObjects === true &&
    observation.canMutateExistingObjects === true
  ) {
    return {
      contractId: DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID,
      mode: "mutable",
      violations: [],
    };
  }

  const violations: DeploymentRuntimeSchemaViolation[] = [];
  if (observation?.adminAuthorityReady !== true) violations.push("admin_authority_missing");
  if (observation?.workspaceMembershipReady !== true)
    violations.push("workspace_membership_missing");
  if (observation?.supportDeliveryReady !== true) violations.push("support_delivery_missing");
  if (observation?.supportDeliveryConstraintsReady !== true)
    violations.push("support_delivery_constraints_missing");
  if (observation?.supportDeliveryIndexesReady !== true)
    violations.push("support_delivery_indexes_missing");
  if (observation?.promptQueueReady !== true) violations.push("prompt_queue_missing");
  if (observation?.projectCollaborationReady !== true)
    violations.push("project_collaboration_missing");
  if (observation?.projectRetirementOperationsReady !== true)
    violations.push("project_retirement_operations_missing");
  if (observation?.projectRetirementOperationsColumnsReady !== true)
    violations.push("project_retirement_operations_columns_missing");
  if (observation?.projectRetirementOperationsConstraintsReady !== true)
    violations.push("project_retirement_operations_constraints_missing");
  if (observation?.projectRetirementOperationsIndexesReady !== true)
    violations.push("project_retirement_operations_indexes_missing");

  return violations.length === 0
    ? {
        contractId: DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID,
        mode: "read-only-ready",
        violations: [],
      }
    : {
        contractId: DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID,
        mode: "read-only-incomplete",
        violations,
      };
}
