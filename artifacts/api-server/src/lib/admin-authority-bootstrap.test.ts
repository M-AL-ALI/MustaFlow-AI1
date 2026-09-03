import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: {} }));
vi.mock("./billing-privileges", () => ({
  billingPrivilegeEmails: vi.fn(() => []),
  resolveBillingPrivilegeIdentities: vi.fn(async () => []),
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));
import {
  parseAdminBootstrapUserIds,
  reconcileAdminAuthorityWithClient,
  type AdminAuthorityClient,
} from "./admin-authority-bootstrap";

function fakeAuthorityStore(seed: Array<{ userId: string; role: string }> = []) {
  const roles = new Map(seed.map(({ userId, role }) => [userId, role]));
  const receipts = new Set<string>();
  const statements: string[] = [];
  const client: AdminAuthorityClient = {
    async query<Row>(statement: string, values: unknown[] = []) {
      const compact = statement.replace(/\s+/gu, " ").trim();
      statements.push(compact);
      if (compact.startsWith("SELECT user_id, role FROM user_roles")) {
        return {
          rows: [...roles].map(([user_id, role]) => ({ user_id, role })) as Row[],
        };
      }
      if (compact.startsWith("SELECT role, granted_by FROM user_roles")) {
        const role = roles.get(String(values[0]));
        return { rows: role ? ([{ role, granted_by: null }] as Row[]) : [] };
      }
      if (compact.startsWith("INSERT INTO user_roles")) {
        roles.set(String(values[0]), "owner");
        return { rows: [] };
      }
      if (compact.includes("'legacy_admin_authority_migrated'")) {
        const key = `migration:${String(values[1])}`;
        const inserted = receipts.has(key) ? 0 : 1;
        receipts.add(key);
        return { rows: [], rowCount: inserted };
      }
      if (compact.includes("'admin_owner_presence_verified'")) {
        let inserted = 0;
        for (const [userId, role] of roles) {
          const key = `proof:${userId}`;
          if (role === "owner" && !receipts.has(key)) {
            receipts.add(key);
            inserted += 1;
          }
        }
        return { rows: [], rowCount: inserted };
      }
      if (compact.startsWith("SELECT COUNT(*)::text AS total")) {
        const total = [...roles.values()].filter((role) => role === "owner").length;
        return { rows: [{ total: String(total) }] as Row[] };
      }
      return { rows: [] };
    },
  };
  return { client, roles, receipts, statements };
}

describe("single-source Admin authority bootstrap", () => {
  it("uses ADMIN_USER_IDS only as a deterministic, idempotent empty-table bootstrap", async () => {
    expect(parseAdminBootstrapUserIds(" founder , founder,operator ")).toEqual([
      "founder",
      "operator",
    ]);
    const store = fakeAuthorityStore();
    const identities = [
      { userId: "founder", source: "admin_user_ids" as const },
      { userId: "operator", source: "admin_user_ids" as const },
    ];
    const first = await reconcileAdminAuthorityWithClient(store.client, identities);
    const second = await reconcileAdminAuthorityWithClient(store.client, identities);

    expect(first).toMatchObject({
      bootstrapOwnerCreated: true,
      migratedIdentities: 2,
      ownerProofReceipts: 2,
      ownerCount: 2,
    });
    expect(second).toMatchObject({
      bootstrapOwnerCreated: false,
      migratedIdentities: 0,
      ownerProofReceipts: 0,
      ownerCount: 2,
    });
    expect(store.roles).toEqual(
      new Map([
        ["founder", "owner"],
        ["operator", "owner"],
      ]),
    );
  });

  it("fails closed when an empty role ledger has no bootstrap identity", async () => {
    const store = fakeAuthorityStore();
    await expect(reconcileAdminAuthorityWithClient(store.client, [])).rejects.toThrow(
      "admin_authority_bootstrap_owner_missing",
    );
    expect(store.statements.at(-1)).toBe("ROLLBACK");
  });
});
