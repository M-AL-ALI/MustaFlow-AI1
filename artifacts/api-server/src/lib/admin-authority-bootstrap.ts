import { decoupleLegacyBillingAdminRows } from "./admin-authority-billing-decoupling";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export const ADMIN_AUTHORITY_SEMANTICS = "admin-authority-user-roles-v1" as const;
const SYSTEM_ACTOR = "system:admin-authority-v1";

export type LegacyAdminIdentity = {
  userId: string;
  source: "admin_user_ids";
};

type QueryResult<Row = Record<string, unknown>> = {
  rows: Row[];
  rowCount?: number | null;
};

export type AdminAuthorityClient = {
  query<Row = Record<string, unknown>>(
    statement: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

export type AdminAuthorityReconciliationReceipt = {
  semantics: typeof ADMIN_AUTHORITY_SEMANTICS;
  bootstrapOwnerCreated: boolean;
  migratedIdentities: number;
  ownerProofReceipts: number;
  ownerCount: number;
  unresolvedBillingPrivilegeEmails: readonly string[];
};

export function parseAdminBootstrapUserIds(raw = process.env.ADMIN_USER_IDS): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function dedupeIdentities(identities: readonly LegacyAdminIdentity[]): LegacyAdminIdentity[] {
  const seen = new Set<string>();
  return identities.filter(({ userId }) => {
    if (!userId || seen.has(userId)) return false;
    seen.add(userId);
    return true;
  });
}

/**
 * Consume explicit bootstrap authority exactly once into user_roles. Request-time
 * Admin authorization reads only the durable role ledger.
 */
export async function reconcileAdminAuthorityWithClient(
  client: AdminAuthorityClient,
  inputIdentities: readonly LegacyAdminIdentity[],
): Promise<Omit<AdminAuthorityReconciliationReceipt, "unresolvedBillingPrivilegeEmails">> {
  const identities = dedupeIdentities(inputIdentities);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('admin-authority-user-roles-v1'))");
    await decoupleLegacyBillingAdminRows(client);
    const initial = await client.query<{ user_id: string; role: string }>(
      "SELECT user_id, role FROM user_roles ORDER BY id ASC",
    );
    let bootstrapOwnerCreated = false;
    if (initial.rows.length === 0) {
      const first = identities[0];
      if (!first) throw new Error("admin_authority_bootstrap_owner_missing");
      await client.query(
        `INSERT INTO user_roles (user_id, role, granted_by, created_at, updated_at)
         VALUES ($1, 'owner', $2, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           role = 'owner', granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
        [first.userId, `${ADMIN_AUTHORITY_SEMANTICS}:${first.source}`],
      );
      bootstrapOwnerCreated = true;
    }

    let migratedIdentities = 0;
    for (const identity of identities) {
      const current = await client.query<{ role: string; granted_by: string | null }>(
        "SELECT role, granted_by FROM user_roles WHERE user_id = $1",
        [identity.userId],
      );
      const previousRole = current.rows[0]?.role ?? null;
      if (previousRole !== "owner") {
        await client.query(
          `INSERT INTO user_roles (user_id, role, granted_by, created_at, updated_at)
           VALUES ($1, 'owner', $2, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             role = 'owner', granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
          [identity.userId, `${ADMIN_AUTHORITY_SEMANTICS}:${identity.source}`],
        );
      }
      const receipt = await client.query(
        `INSERT INTO admin_access_receipts (
           actor_user_id, actor_role, kind, action, target_user_id,
           previous_role, next_role, outcome, request_method, request_path
         )
         SELECT $1, 'owner', 'role_change', 'legacy_admin_authority_migrated',
                $2, $3, 'owner', $4, NULL, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM admin_access_receipts
             WHERE action = 'legacy_admin_authority_migrated' AND target_user_id = $2
          )`,
        [SYSTEM_ACTOR, identity.userId, previousRole, identity.source],
      );
      migratedIdentities += receipt.rowCount ?? 0;
    }

    const proof = await client.query(
      `INSERT INTO admin_access_receipts (
         actor_user_id, actor_role, kind, action, target_user_id,
         previous_role, next_role, outcome, request_method, request_path
       )
       SELECT $1, 'owner', 'access', 'admin_owner_presence_verified',
              user_id, role, role, 'present_in_user_roles', NULL, NULL
         FROM user_roles roles
        WHERE role = 'owner'
          AND NOT EXISTS (
            SELECT 1 FROM admin_access_receipts receipts
             WHERE receipts.action = 'admin_owner_presence_verified'
               AND receipts.target_user_id = roles.user_id
          )`,
      [SYSTEM_ACTOR],
    );
    const finalOwners = await client.query<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM user_roles WHERE role = 'owner'",
    );
    const ownerCount = Number(finalOwners.rows[0]?.total ?? 0);
    if (!Number.isSafeInteger(ownerCount) || ownerCount < 1) {
      throw new Error("admin_authority_owner_invariant_failed");
    }
    await client.query("COMMIT");
    return {
      semantics: ADMIN_AUTHORITY_SEMANTICS,
      bootstrapOwnerCreated,
      migratedIdentities,
      ownerProofReceipts: proof.rowCount ?? 0,
      ownerCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function reconcileAdminAuthorityAtBoot(): Promise<AdminAuthorityReconciliationReceipt> {
  const envIdentities = parseAdminBootstrapUserIds().map(
    (userId): LegacyAdminIdentity => ({ userId, source: "admin_user_ids" }),
  );
  const unresolvedBillingPrivilegeEmails: readonly string[] = [];
  const client = await pool.connect();
  try {
    const receipt = await reconcileAdminAuthorityWithClient(client, envIdentities);
    const result = { ...receipt, unresolvedBillingPrivilegeEmails };
    logger.info(result, "Admin authority reconciled into user_roles");
    return result;
  } finally {
    client.release();
  }
}
