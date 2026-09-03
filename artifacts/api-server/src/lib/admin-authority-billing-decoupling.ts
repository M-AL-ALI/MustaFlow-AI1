type AuthorityQueryResult<Row> = { rows: Row[]; rowCount?: number | null };
type AuthorityQueryClient = {
  query<Row = Record<string, unknown>>(
    statement: string,
    values?: unknown[],
  ): Promise<AuthorityQueryResult<Row>>;
};

const LEGACY_BILLING_AUTHORITY_MARKER = "admin-authority-user-roles-v1:billing_privilege";
const EXPLICIT_LEGACY_ALLOWLIST_MARKER =
  "admin-authority-user-roles-v2:founder-approved-legacy-allowlist";

export async function decoupleLegacyBillingAdminRows(
  client: AuthorityQueryClient,
): Promise<number> {
  const result = await client.query<{ user_id: string }>(
    "WITH relabeled AS (" +
      " UPDATE user_roles" +
      " SET granted_by = $1, updated_at = NOW()" +
      " WHERE granted_by = $2" +
      " RETURNING user_id, role" +
      " )" +
      " INSERT INTO admin_access_receipts (" +
      " actor_user_id, actor_role, kind, action, target_user_id," +
      " previous_role, next_role, outcome, request_method, request_path" +
      " )" +
      " SELECT $3, 'owner', 'role_change', 'legacy_billing_authority_decoupled'," +
      " user_id, role, role, 'preserved_as_explicit_legacy_allowlist', NULL, NULL" +
      " FROM relabeled" +
      " RETURNING target_user_id AS user_id",
    [
      EXPLICIT_LEGACY_ALLOWLIST_MARKER,
      LEGACY_BILLING_AUTHORITY_MARKER,
      "system:admin-authority-v2",
    ],
  );
  return result.rowCount ?? result.rows.length;
}
