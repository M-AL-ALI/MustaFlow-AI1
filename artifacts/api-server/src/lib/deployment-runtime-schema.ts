import type { PoolClient } from "pg";

export const DEPLOYMENT_RUNTIME_SCHEMA_CONTRACT_ID = "deployment_runtime_schema_v10" as const;

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
  "project_purge_operations_missing",
  "project_purge_operations_columns_missing",
  "project_purge_operations_constraints_missing",
  "project_purge_operations_indexes_missing",
  "project_purge_notification_index_missing",
  "asset_usage_attachment_guard_missing",
  "durable_asset_reference_guards_missing",
  "preview_database_allocation_missing",
  "production_database_admission_tables_missing",
  "production_database_admission_columns_missing",
  "production_database_admission_constraints_missing",
  "production_database_admission_indexes_missing",
  "production_database_admission_triggers_missing",
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
  projectPurgeOperationsReady: boolean;
  projectPurgeOperationsColumnsReady: boolean;
  projectPurgeOperationsConstraintsReady: boolean;
  projectPurgeOperationsIndexesReady: boolean;
  projectPurgeNotificationIndexReady: boolean;
  assetUsageAttachmentGuardReady: boolean;
  durableAssetReferenceGuardsReady: boolean;
  previewDatabaseAllocationReady: boolean;
  productionDatabaseAdmissionTablesReady: boolean;
  productionDatabaseAdmissionColumnsReady: boolean;
  productionDatabaseAdmissionConstraintsReady: boolean;
  productionDatabaseAdmissionIndexesReady: boolean;
  productionDatabaseAdmissionTriggersReady: boolean;
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
        SELECT COUNT(*) = 16
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
      ) AS "projectRetirementOperationsIndexesReady",
      to_regclass('public.project_purge_operations') IS NOT NULL
        AS "projectPurgeOperationsReady",
      (
        SELECT COUNT(*) = 21
          FROM information_schema.columns column_row
         WHERE column_row.table_schema = 'public'
           AND column_row.table_name = 'project_purge_operations'
           AND (column_row.column_name, column_row.data_type, column_row.is_nullable) IN (
             ('id', 'text', 'NO'), ('project_id', 'integer', 'NO'),
             ('retirement_operation_id_hash', 'text', 'NO'),
             ('trigger', 'text', 'NO'), ('state', 'text', 'NO'),
             ('stage', 'text', 'NO'), ('idempotency_key_hash', 'text', 'NO'),
             ('requested_by_hash', 'text', 'YES'), ('attempt_count', 'integer', 'NO'),
             ('lease_version', 'integer', 'NO'),
             ('lease_expires_at', 'timestamp with time zone', 'YES'),
             ('due_at', 'timestamp with time zone', 'NO'),
              ('next_attempt_at', 'timestamp with time zone', 'YES'),
              ('failure_code', 'text', 'YES'), ('failure_retryable', 'boolean', 'YES'),
              ('resource_progress', 'jsonb', 'NO'),
              ('terminal_evidence', 'jsonb', 'YES'),
             ('created_at', 'timestamp with time zone', 'NO'),
             ('updated_at', 'timestamp with time zone', 'NO'),
             ('started_at', 'timestamp with time zone', 'YES'),
             ('terminal_at', 'timestamp with time zone', 'YES')
           )
      ) AS "projectPurgeOperationsColumnsReady",
      (
        SELECT COUNT(*) = 10
           AND bool_and(
             CASE constraint_row.conname
               WHEN 'project_purge_operations_pkey' THEN
                 constraint_row.contype = 'p'
                 AND pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (id)'
               WHEN 'project_purge_operations_trigger_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%trigger%manual%expiry%'
               WHEN 'project_purge_operations_state_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%state%scheduled%accepted%running%failed%completed%canceled%'
               WHEN 'project_purge_operations_stage_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%stage%verify%inventory%assets%snapshots%database%addons%runtime%relational%absence%'
               WHEN 'project_purge_operations_failure_code_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%failure_code%project_purge_absence_unverified%project_purge_operation_unavailable%'
               WHEN 'project_purge_operations_attempt_count_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%attempt_count%>= 0%'
               WHEN 'project_purge_operations_lease_version_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%lease_version%>= 0%'
               WHEN 'project_purge_operations_hashes_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%retirement_operation_id_hash%idempotency_key_hash%requested_by_hash%'
               WHEN 'project_purge_operations_requester_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%trigger%expiry%requested_by_hash%IS NOT NULL%'
               WHEN 'project_purge_operations_terminal_check' THEN
                 constraint_row.contype = 'c'
                 AND pg_get_constraintdef(constraint_row.oid) LIKE '%terminal_evidence%terminal_at%'
               ELSE FALSE
             END
           )
          FROM pg_catalog.pg_constraint constraint_row
          JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'project_purge_operations'
           AND constraint_row.conname = ANY(ARRAY[
             'project_purge_operations_pkey',
             'project_purge_operations_trigger_check',
             'project_purge_operations_state_check',
             'project_purge_operations_stage_check',
             'project_purge_operations_failure_code_check',
             'project_purge_operations_attempt_count_check',
             'project_purge_operations_lease_version_check',
             'project_purge_operations_hashes_check',
             'project_purge_operations_requester_check',
             'project_purge_operations_terminal_check'
           ])
           AND constraint_row.convalidated
           AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_constraint foreign_key
              WHERE foreign_key.conrelid = relation.oid
                AND foreign_key.contype = 'f'
           )
      ) AS "projectPurgeOperationsConstraintsReady",
      (
        SELECT COUNT(*) = 6
           AND bool_and(index_row.indisvalid AND index_row.indisready)
           AND bool_and(
             CASE index_relation.relname
               WHEN 'project_purge_operations_pkey' THEN index_row.indisunique
               WHEN 'project_purge_operations_project_idx' THEN
                 pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id, created_at)%'
               WHEN 'project_purge_operations_due_idx' THEN
                 pg_get_indexdef(index_row.indexrelid) LIKE '%(state, due_at, next_attempt_at)%'
               WHEN 'project_purge_operations_idempotency_uq' THEN
                 index_row.indisunique
                 AND pg_get_indexdef(index_row.indexrelid) LIKE '%(idempotency_key_hash)%'
               WHEN 'project_purge_operations_retirement_uq' THEN
                 index_row.indisunique
                 AND pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id, retirement_operation_id_hash)%'
               WHEN 'project_purge_operations_active_project_uq' THEN
                 index_row.indisunique
                 AND pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id)%'
                 AND pg_get_expr(index_row.indpred, index_row.indrelid) LIKE '%scheduled%accepted%running%failed%'
               ELSE FALSE
             END
           )
          FROM pg_catalog.pg_index index_row
          JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
          JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND table_relation.relname = 'project_purge_operations'
           AND index_relation.relname = ANY(ARRAY[
             'project_purge_operations_pkey',
             'project_purge_operations_project_idx',
             'project_purge_operations_due_idx',
             'project_purge_operations_idempotency_uq',
             'project_purge_operations_retirement_uq',
             'project_purge_operations_active_project_uq'
           ])
      ) AS "projectPurgeOperationsIndexesReady",
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_index index_row
          JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
          JOIN pg_catalog.pg_class table_relation ON table_relation.oid=index_row.indrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid=table_relation.relnamespace
         WHERE namespace.nspname='public'
           AND table_relation.relname='notifications'
           AND index_relation.relname='notifications_project_purge_milestone_uq'
           AND index_row.indisunique AND index_row.indisvalid AND index_row.indisready
           AND pg_get_indexdef(index_row.indexrelid)
                 LIKE '%(resource_type, resource_id, recipient_id)%'
           AND pg_get_expr(index_row.indpred, index_row.indrelid)
                 LIKE '%resource_type%project_purge%'
      ) AS "projectPurgeNotificationIndexReady",
      EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger trigger_row
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'asset_usage'
           AND trigger_row.tgname = 'asset_usage_requires_ready_asset'
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgenabled = ANY(ARRAY['O', 'A']::"char"[])
           AND regexp_replace(
                 lower(pg_get_triggerdef(trigger_row.oid)),
                 '[[:space:]]+',
                 ' ',
                 'g'
               ) LIKE '%before insert or update of asset_id, project_id on public.asset_usage%'
           AND regexp_replace(
                 lower(pg_get_functiondef(procedure_row.oid)),
                 '[[:space:]]+',
                 ' ',
                 'g'
               ) LIKE '%current_state is distinct from ''ready''%'
           AND regexp_replace(
                 lower(pg_get_functiondef(procedure_row.oid)),
                 '[[:space:]]+',
                 ' ',
                 'g'
               ) LIKE '%for share%'
      ) AS "assetUsageAttachmentGuardReady",
      (
        SELECT COUNT(*) = 15
           AND bool_and(NOT trigger_row.tgisinternal)
           AND bool_and(trigger_row.tgenabled = ANY(ARRAY['O', 'A']::"char"[]))
           AND bool_and(trigger_row.tgtype = 23)
           AND bool_and(trigger_row.tgqual IS NULL)
           AND bool_and(
             trigger_row.tgfoid =
               to_regprocedure('public.require_attachable_assets_in_durable_reference()')
           )
           AND bool_and(
             (SELECT string_agg(attribute.attname, ', ' ORDER BY trigger_column.ordinality)
                FROM unnest(trigger_row.tgattr::smallint[]) WITH ORDINALITY
                     AS trigger_column(attnum, ordinality)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid=relation.oid
                 AND attribute.attnum=trigger_column.attnum) = expected.column_list
           )
           AND bool_and(
             regexp_replace(lower(pg_get_functiondef(procedure_row.oid)), '[[:space:]]+', ' ', 'g')
               LIKE '%if current_state is distinct from ''ready'' then%'
           )
           AND bool_and(
             regexp_replace(lower(pg_get_functiondef(procedure_row.oid)), '[[:space:]]+', ' ', 'g')
               LIKE '%for share%'
           )
           AND bool_and(
             regexp_replace(lower(pg_get_functiondef(procedure_row.oid)), '[[:space:]]+', ' ', 'g')
               LIKE '%legacy_object_reference_unavailable%'
           )
           AND bool_and(
             regexp_replace(lower(pg_get_functiondef(procedure_row.oid)), '[[:space:]]+', ' ', 'g')
               LIKE '%public.resolve_durable_asset_ids(row_json)%'
           )
           AND bool_and(
             regexp_replace(lower(pg_get_functiondef(procedure_row.oid)), '[[:space:]]+', ' ', 'g')
               LIKE '%asset_reference_forbidden%'
           )
           AND bool_and(
             regexp_replace(lower(pg_get_functiondef(procedure_row.oid)), '[[:space:]]+', ' ', 'g')
               LIKE '%from public.asset_usage%'
           )
           AND bool_and(
             EXISTS (
               SELECT 1 FROM unnest(COALESCE(procedure_row.proconfig, ARRAY[]::text[])) setting
                WHERE regexp_replace(lower(setting), '[[:space:]]+', '', 'g') =
                      'search_path=pg_catalog,public'
             )
           )
          FROM (VALUES
            ('chat_messages', 'project_id, attachments'),
            ('agent_tasks', 'project_id, attachments, report, staging_snapshot'),
            ('agent_tool_calls', 'project_id, stdout_preview, args_summary'),
            ('zero_prompt_queue_items', 'project_id, asset_ids, current_text'),
            ('knowledge_entries', 'project_id, annotation'),
            ('project_files', 'project_id, content'),
            ('project_versions', 'project_id, files_snapshot'),
            ('canvas_variants', 'project_id, files'),
            ('canvas_variant_library', 'source_project_id, files'),
            ('gallery_templates', 'source_project_id, files_snapshot'),
            ('agent_inbox', 'project_id, screenshot_url'),
            ('task_events', 'task_id, message, data'),
            ('project_activity', 'project_id, metadata'),
            ('visual_edit_changes', 'project_id, before_content, after_content'),
            ('generated_images', 'project_id, user_id, asset_id, storage_key, file_url, thumbnail_url, deleted_at, status'),
            ('support_tickets', 'user_id, project_id, transcript, attachments')
          ) AS expected(table_name, column_list)
          JOIN pg_catalog.pg_class relation ON relation.relname = expected.table_name
          JOIN pg_catalog.pg_trigger trigger_row ON trigger_row.tgrelid = relation.oid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
         WHERE namespace.nspname = 'public'
           AND relation.relname = ANY(ARRAY[
             'chat_messages', 'agent_tasks', 'agent_tool_calls',
             'zero_prompt_queue_items', 'knowledge_entries', 'project_files',
             'project_versions', 'canvas_variants', 'canvas_variant_library',
              'gallery_templates', 'agent_inbox', 'task_events',
              'project_activity', 'visual_edit_changes', 'generated_images',
              'support_tickets'
           ])
           AND trigger_row.tgname = 'durable_asset_reference_guard_' || relation.relname
           AND trigger_row.tgfoid =
               to_regprocedure('public.require_attachable_assets_in_durable_reference()')
           AND to_regprocedure('public.extract_durable_asset_ids(jsonb)') IS NOT NULL
           AND to_regclass('public.durable_asset_deletion_claims') IS NOT NULL
           AND to_regprocedure('public.resolve_durable_storage_keys(jsonb)') IS NOT NULL
           AND regexp_replace(
                 lower(pg_get_functiondef(procedure_row.oid)),
                 '[[:space:]]+', ' ', 'g'
               ) LIKE '%pg_advisory_xact_lock_shared%'
           AND regexp_replace(
                 lower(pg_get_functiondef(procedure_row.oid)),
                 '[[:space:]]+', ' ', 'g'
               ) LIKE '%from public.durable_asset_deletion_claims%'
           AND regexp_replace(
                 lower(pg_get_functiondef(
                   to_regprocedure('public.extract_durable_asset_ids(jsonb)')
                 )),
                 '[[:space:]]+', ' ', 'g'
               ) LIKE '%/api/assets/([1-9][0-9]{0,9})/content%'
           AND EXISTS (
             SELECT 1
              WHERE to_regprocedure('public.resolve_durable_asset_ids(jsonb)') IS NOT NULL
                AND regexp_replace(
                      lower(pg_get_functiondef(
                        to_regprocedure('public.resolve_durable_asset_ids(jsonb)')
                      )),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%/api/images/([1-9][0-9]{0,9})/file%'
                 AND regexp_replace(
                       lower(pg_get_functiondef(
                         to_regprocedure('public.resolve_durable_asset_ids(jsonb)')
                       )),
                       '[[:space:]]+', ' ', 'g'
                     ) LIKE '%/api/projects/([1-9][0-9]{0,9})/uploads/([1-9][0-9]{0,9})/content%'
                 AND regexp_replace(
                       lower(pg_get_functiondef(
                         to_regprocedure('public.resolve_durable_asset_ids(jsonb)')
                       )),
                       '[[:space:]]+', ' ', 'g'
                     ) LIKE '%join public.asset_storage_objects storage_row on storage_row.storage_key = matched.storage_match[1]%'
                 AND pg_get_functiondef(
                       to_regprocedure('public.resolve_durable_asset_ids(jsonb)')
                     ) LIKE '%?#<>(){},;%'
                 AND pg_get_functiondef(
                       to_regprocedure('public.resolve_durable_storage_keys(jsonb)')
                     ) LIKE '%?#<>(){},;%'
                 AND EXISTS (
                  SELECT 1
                    FROM unnest(COALESCE(
                      (SELECT proconfig FROM pg_catalog.pg_proc
                        WHERE oid=to_regprocedure('public.resolve_durable_asset_ids(jsonb)')),
                      ARRAY[]::text[]
                    )) setting
                   WHERE regexp_replace(lower(setting), '[[:space:]]+', '', 'g') =
                         'search_path=pg_catalog,public'
                )
           )
           AND EXISTS (
             SELECT 1
              WHERE to_regprocedure(
                      'public.durable_asset_reference_exists(integer,integer,integer)'
                    ) IS NOT NULL
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.durable_asset_reference_exists(integer,integer,integer)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%from public.canvas_variant_library%'
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.durable_asset_reference_exists(integer,integer,integer)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%from public.gallery_templates%'
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.durable_asset_reference_exists(integer,integer,integer)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%select tool_call.project_id, null::integer, to_jsonb(tool_call)%'
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.durable_asset_reference_exists(integer,integer,integer)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%select image.project_id, image.id, to_jsonb(image)%'
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.durable_asset_reference_exists(integer,integer,integer)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%from public.asset_storage_objects storage_row%'
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.durable_asset_reference_exists(integer,integer,integer)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%project-purge-preserved-direct:%'
                AND regexp_replace(
                      lower(pg_get_functiondef(to_regprocedure(
                        'public.resolve_durable_asset_ids(jsonb)'
                      ))),
                      '[[:space:]]+', ' ', 'g'
                    ) LIKE '%and image.deleted_at is null%'
                AND EXISTS (
                  SELECT 1
                    FROM unnest(COALESCE(
                      (SELECT proconfig FROM pg_catalog.pg_proc
                        WHERE oid=to_regprocedure(
                          'public.durable_asset_reference_exists(integer,integer,integer)'
                        )),
                      ARRAY[]::text[]
                    )) setting
                   WHERE regexp_replace(lower(setting), '[[:space:]]+', '', 'g') =
                         'search_path=pg_catalog,public'
                 )
           )
           AND to_regprocedure('public.require_live_owned_ora_asset_reference()') IS NOT NULL
            AND (SELECT COUNT(*) = 2
                   AND bool_and(NOT trigger_row.tgisinternal)
                   AND bool_and(trigger_row.tgenabled = ANY(ARRAY['O', 'A']::"char"[]))
                   AND bool_and(trigger_row.tgtype = 23)
                   AND bool_and(trigger_row.tgqual IS NULL)
                   AND bool_and(trigger_row.tgnargs = expected.argument_count)
                   AND bool_and(
                     encode(trigger_row.tgargs, 'escape') = expected.argument_bytes
                   )
                   AND bool_and(
                    trigger_row.tgfoid =
                      to_regprocedure('public.require_live_owned_ora_asset_reference()')
                  )
                  AND bool_and(
                    (SELECT string_agg(attribute.attname, ', ' ORDER BY trigger_column.ordinality)
                       FROM unnest(trigger_row.tgattr::smallint[]) WITH ORDINALITY
                            AS trigger_column(attnum, ordinality)
                       JOIN pg_catalog.pg_attribute attribute
                         ON attribute.attrelid=relation.oid
                        AND attribute.attnum=trigger_column.attnum) = expected.column_list
                  )
                  FROM (VALUES
                   ('ora_file_contexts', 'ora_asset_reference_guard_ora_file_contexts', 'user_id, asset_id, deleted_at', 2, 'asset_id\\000deleted_at\\000'),
                   ('brand_kits', 'ora_asset_reference_guard_brand_kits', 'user_id, logo_asset_id', 1, 'logo_asset_id\\000')
                 ) AS expected(table_name, trigger_name, column_list, argument_count, argument_bytes)
                 JOIN pg_catalog.pg_class relation ON relation.relname=expected.table_name
                 JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
                 JOIN pg_catalog.pg_trigger trigger_row ON trigger_row.tgrelid=relation.oid
                WHERE namespace.nspname='public'
                  AND trigger_row.tgname=expected.trigger_name)
           AND (SELECT NOT procedure_row.prosecdef
                  FROM pg_catalog.pg_proc procedure_row
                 WHERE procedure_row.oid=
                   to_regprocedure('public.require_live_owned_ora_asset_reference()'))
           AND regexp_replace(
                 lower(pg_get_functiondef(
                   to_regprocedure('public.require_live_owned_ora_asset_reference()')
                 )), '[[:space:]]+', ' ', 'g'
               ) LIKE '%from public.ora_assets ora%ora.user_id = row_json ->> ''user_id''%ora.deleted_at is null%for share%'
           AND regexp_replace(
                 lower(pg_get_functiondef(
                   to_regprocedure('public.require_live_owned_ora_asset_reference()')
                 )), '[[:space:]]+', ' ', 'g'
               ) LIKE '%candidate_ora_asset_id := nullif(row_json ->> tg_argv[0],%'
           AND regexp_replace(
                 lower(pg_get_functiondef(
                   to_regprocedure('public.require_live_owned_ora_asset_reference()')
                 )), '[[:space:]]+', ' ', 'g'
               ) LIKE '%ora.id = candidate_ora_asset_id%'
           AND regexp_replace(
                 lower(pg_get_functiondef(
                   to_regprocedure('public.require_live_owned_ora_asset_reference()')
                 )), '[[:space:]]+', ' ', 'g'
               ) LIKE '%ora_asset_reference_unavailable%errcode = ''55000''%'
           AND EXISTS (
             SELECT 1
               FROM unnest(COALESCE(
                 (SELECT proconfig FROM pg_catalog.pg_proc
                   WHERE oid=to_regprocedure('public.require_live_owned_ora_asset_reference()')),
                 ARRAY[]::text[]
               )) setting
               WHERE regexp_replace(lower(setting), '[[:space:]]+', '', 'g') =
                     'search_path=pg_catalog,public'
            )
       ) AS "durableAssetReferenceGuardsReady",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='projects'
          AND column_name='preview_db_allocation' AND data_type='jsonb' AND is_nullable='YES'
      ) AS "previewDatabaseAllocationReady",
      (
        to_regclass('public.production_database_admission_epochs') IS NOT NULL
        AND to_regclass('public.production_database_admission_receipts') IS NOT NULL
      ) AS "productionDatabaseAdmissionTablesReady",
      (
        SELECT COUNT(*) = 18
        FROM (VALUES
          ('production_database_admission_epochs', 'epoch', 'uuid', 'NO'),
          ('production_database_admission_epochs', 'namespace', 'text', 'NO'),
          ('production_database_admission_epochs', 'state', 'text', 'NO'),
          ('production_database_admission_epochs', 'worker_deployment_version', 'text', 'NO'),
          ('production_database_admission_epochs', 'evidence_sha256', 'text', 'NO'),
          ('production_database_admission_epochs', 'observed_at', 'timestamp with time zone', 'NO'),
          ('production_database_admission_epochs', 'activated_at', 'timestamp with time zone', 'YES'),
          ('production_database_admission_epochs', 'project_id_floor', 'integer', 'NO'),
          ('production_database_admission_receipts', 'project_id', 'integer', 'NO'),
          ('production_database_admission_receipts', 'registration_epoch', 'uuid', 'NO'),
          ('production_database_admission_receipts', 'birth_token', 'uuid', 'NO'),
          ('production_database_admission_receipts', 'birth_registered', 'boolean', 'NO'),
          ('production_database_admission_receipts', 'allocation_identity', 'text', 'YES'),
          ('production_database_admission_receipts', 'state', 'text', 'NO'),
          ('production_database_admission_receipts', 'authorization_id', 'uuid', 'YES'),
          ('production_database_admission_receipts', 'seal_id', 'uuid', 'YES'),
          ('production_database_admission_receipts', 'created_at', 'timestamp with time zone', 'NO'),
          ('production_database_admission_receipts', 'updated_at', 'timestamp with time zone', 'NO')
        ) AS required(table_name, column_name, data_type, is_nullable)
        JOIN information_schema.columns column_row
          ON column_row.table_schema = 'public'
         AND column_row.table_name = required.table_name
         AND column_row.column_name = required.column_name
         AND column_row.data_type = required.data_type
         AND column_row.is_nullable = required.is_nullable
      ) AS "productionDatabaseAdmissionColumnsReady",
      (
        (
          SELECT COUNT(*) = 7
          FROM (VALUES
            ('production_database_admission_epochs', 'production_database_admission_epoch_namespace_check'),
            ('production_database_admission_epochs', 'production_database_admission_epoch_state_check'),
            ('production_database_admission_epochs', 'production_database_admission_epoch_evidence_check'),
            ('production_database_admission_epochs', 'production_database_admission_epoch_drain_check'),
            ('production_database_admission_receipts', 'production_database_admission_receipt_project_check'),
            ('production_database_admission_receipts', 'production_database_admission_receipt_identity_check'),
            ('production_database_admission_receipts', 'production_database_admission_receipt_state_check')
          ) AS required(table_name, constraint_name)
          JOIN pg_constraint constraint_row
            ON constraint_row.conrelid = to_regclass('public.' || required.table_name)
           AND constraint_row.conname = required.constraint_name
           AND constraint_row.contype = 'c'
           AND constraint_row.convalidated
        )
        AND (
          SELECT COUNT(*) = 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.production_database_admission_receipts')
            AND contype = 'f'
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint constraint_row
          JOIN pg_attribute receipt_column
            ON receipt_column.attrelid = constraint_row.conrelid
           AND receipt_column.attname = 'registration_epoch' AND NOT receipt_column.attisdropped
          JOIN pg_attribute epoch_column
            ON epoch_column.attrelid = constraint_row.confrelid
           AND epoch_column.attname = 'epoch' AND NOT epoch_column.attisdropped
          WHERE constraint_row.conrelid = to_regclass('public.production_database_admission_receipts')
            AND constraint_row.confrelid = to_regclass('public.production_database_admission_epochs')
            AND constraint_row.contype = 'f' AND constraint_row.convalidated
            AND constraint_row.conkey = ARRAY[receipt_column.attnum]::smallint[]
            AND constraint_row.confkey = ARRAY[epoch_column.attnum]::smallint[]
            AND constraint_row.confdeltype = 'a' AND constraint_row.confupdtype = 'a'
            AND NOT constraint_row.condeferrable
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.production_database_admission_epochs')
            AND contype = 'f'
        )
      ) AS "productionDatabaseAdmissionConstraintsReady",
      (
        SELECT COUNT(*) = 3
        FROM (VALUES
          ('production_database_admission_epochs', 'production_database_admission_epochs_pkey', 'epoch', false),
          ('production_database_admission_receipts', 'production_database_admission_receipts_pkey', 'project_id', false),
          ('production_database_admission_epochs', 'production_database_admission_epoch_active_uq', 'namespace', true)
        ) AS required(table_name, index_name, column_name, partial)
        JOIN pg_class table_row ON table_row.oid = to_regclass('public.' || required.table_name)
        JOIN pg_class index_relation ON index_relation.relname = required.index_name
          AND index_relation.relnamespace = table_row.relnamespace
        JOIN pg_index index_row ON index_row.indexrelid = index_relation.oid
          AND index_row.indrelid = table_row.oid
        JOIN pg_attribute column_row ON column_row.attrelid = table_row.oid
          AND column_row.attname = required.column_name AND NOT column_row.attisdropped
        WHERE index_row.indisunique AND index_row.indisvalid AND index_row.indisready
          AND index_row.indnatts = 1 AND index_row.indnkeyatts = 1
          AND index_row.indkey[0] = column_row.attnum AND index_row.indexprs IS NULL
          AND CASE WHEN required.partial THEN
            regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid),
              '[[:space:]()]', '', 'g') = 'state=''active''::text'
          ELSE index_row.indisprimary AND index_row.indpred IS NULL END
      ) AS "productionDatabaseAdmissionIndexesReady",
      (
        SELECT COUNT(*) = 2
        FROM (VALUES
          ('projects', 'production_database_project_birth', 'register_production_database_project_birth', 7),
          ('production_database_admission_receipts', 'production_database_admission_receipt_guard',
            'guard_production_database_admission_receipt', 27)
        ) AS required(table_name, trigger_name, function_name, trigger_type)
        JOIN pg_trigger trigger_row
          ON trigger_row.tgrelid = to_regclass('public.' || required.table_name)
         AND trigger_row.tgname = required.trigger_name
        JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
          AND function_row.proname = required.function_name
        JOIN pg_namespace function_namespace ON function_namespace.oid = function_row.pronamespace
          AND function_namespace.nspname = 'public'
        JOIN pg_language function_language ON function_language.oid = function_row.prolang
          AND function_language.lanname = 'plpgsql'
        WHERE NOT trigger_row.tgisinternal AND trigger_row.tgenabled IN ('O', 'A')
          AND trigger_row.tgtype = required.trigger_type
          AND trigger_row.tgnargs = 0 AND trigger_row.tgqual IS NULL
          AND cardinality(trigger_row.tgattr::smallint[]) = 0
          AND NOT trigger_row.tgdeferrable
          AND function_row.prorettype = 'pg_catalog.trigger'::regtype
          AND NOT function_row.prosecdef
          AND function_row.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
          AND CASE WHEN required.trigger_name = 'production_database_project_birth' THEN
            lower(function_row.prosrc) LIKE '%production_database_project_identity_reused%'
            AND lower(function_row.prosrc) LIKE '%production_database_birth_identity_untrusted%'
            AND lower(function_row.prosrc) LIKE '%currval(sequence_name::regclass)%'
            AND lower(function_row.prosrc) LIKE '%for share%'
            AND lower(function_row.prosrc) LIKE '%insert into public.production_database_admission_receipts%'
          ELSE
            lower(function_row.prosrc) LIKE '%production_database_admission_receipt_retained%'
            AND lower(function_row.prosrc) LIKE '%production_database_admission_receipt_immutable%'
            AND lower(function_row.prosrc) LIKE '%new.registration_epoch%'
            AND lower(function_row.prosrc) LIKE '%old.authorization_id%'
            AND lower(function_row.prosrc) LIKE '%old.state = ''sealed''%'
          END
      ) AS "productionDatabaseAdmissionTriggersReady"
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
  if (observation?.projectPurgeOperationsReady !== true)
    violations.push("project_purge_operations_missing");
  if (observation?.projectPurgeOperationsColumnsReady !== true)
    violations.push("project_purge_operations_columns_missing");
  if (observation?.projectPurgeOperationsConstraintsReady !== true)
    violations.push("project_purge_operations_constraints_missing");
  if (observation?.projectPurgeOperationsIndexesReady !== true)
    violations.push("project_purge_operations_indexes_missing");
  if (observation?.projectPurgeNotificationIndexReady !== true)
    violations.push("project_purge_notification_index_missing");
  if (observation?.assetUsageAttachmentGuardReady !== true)
    violations.push("asset_usage_attachment_guard_missing");
  if (observation?.durableAssetReferenceGuardsReady !== true)
    violations.push("durable_asset_reference_guards_missing");
  if (observation?.previewDatabaseAllocationReady !== true)
    violations.push("preview_database_allocation_missing");
  if (observation?.productionDatabaseAdmissionTablesReady !== true)
    violations.push("production_database_admission_tables_missing");
  if (observation?.productionDatabaseAdmissionColumnsReady !== true)
    violations.push("production_database_admission_columns_missing");
  if (observation?.productionDatabaseAdmissionConstraintsReady !== true)
    violations.push("production_database_admission_constraints_missing");
  if (observation?.productionDatabaseAdmissionIndexesReady !== true)
    violations.push("production_database_admission_indexes_missing");
  if (observation?.productionDatabaseAdmissionTriggersReady !== true)
    violations.push("production_database_admission_triggers_missing");

  // Static catalog evidence proves that future writes are guarded. Only after
  // that evidence is complete is it safe to reference these tables directly
  // and certify that no historical active pointer bypassed the guards.
  if (violations.length === 0 && observation?.durableAssetReferenceGuardsReady === true) {
    const referenceRows = await client.query<{ oraAssetReferenceRowsReady: boolean }>(`
      SELECT (
        NOT EXISTS (
          SELECT 1
            FROM public.ora_file_contexts context_row
            LEFT JOIN public.ora_assets ora
              ON ora.id = context_row.asset_id
             AND ora.user_id = context_row.user_id
             AND ora.deleted_at IS NULL
           WHERE context_row.asset_id IS NOT NULL
             AND context_row.deleted_at IS NULL
             AND ora.id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.brand_kits kit
            LEFT JOIN public.ora_assets ora
              ON ora.id = kit.logo_asset_id
             AND ora.user_id = kit.user_id
             AND ora.deleted_at IS NULL
           WHERE kit.logo_asset_id IS NOT NULL
             AND ora.id IS NULL
        )
      ) AS "oraAssetReferenceRowsReady"
    `);
    if (referenceRows.rows[0]?.oraAssetReferenceRowsReady !== true) {
      violations.push("durable_asset_reference_guards_missing");
    }
  }

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
