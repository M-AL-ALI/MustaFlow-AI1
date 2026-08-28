import type { PoolClient } from "pg";

export const DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID = "deployment_runtime_schema_v2" as const;

export const DEPLOYMENT_RUNTIME_SCHEMA_VIOLATIONS = [
  "admin_authority_missing",
  "workspace_membership_missing",
  "support_delivery_missing",
  "support_delivery_constraints_missing",
  "support_delivery_indexes_missing",
  "prompt_queue_missing",
  "project_collaboration_missing",
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
      ) AS "projectCollaborationReady"
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
