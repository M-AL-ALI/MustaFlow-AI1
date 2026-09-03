import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decoupleLegacyBillingAdminRows } from "./admin-authority-billing-decoupling";

describe("Admin authority billing decoupling", () => {
  it("durably relabels and receipts historical billing-derived grants", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ user_id: "user_existing_staff" }],
      rowCount: 1,
    });
    const changed = await decoupleLegacyBillingAdminRows({ query });
    expect(changed).toBe(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("legacy_billing_authority_decoupled"),
      [
        "admin-authority-user-roles-v2:founder-approved-legacy-allowlist",
        "admin-authority-user-roles-v1:billing_privilege",
        "system:admin-authority-v2",
      ],
    );
  });

  it("keeps billing privilege configuration out of bootstrap authority", () => {
    const source = readFileSync(resolve(__dirname, "admin-authority-bootstrap.ts"), "utf8");
    expect(source).not.toContain("billing-privileges");
    expect(source).not.toContain("resolveBillingPrivilegeIdentities");
    expect(source).not.toContain("billingPrivilegeEmails");
    expect(source).toContain("decoupleLegacyBillingAdminRows(client)");
  });
});
