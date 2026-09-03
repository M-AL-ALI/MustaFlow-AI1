import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const adminPage = readFileSync(resolve(sourceRoot, "pages/admin.tsx"), "utf8");
const panel = readFileSync(
  resolve(sourceRoot, "components/admin/account-access-panel.tsx"),
  "utf8",
);
const supportInbox = readFileSync(resolve(sourceRoot, "pages/support-inbox.tsx"), "utf8");

describe("Admin account and ticket identity controls", () => {
  it("renders the reversible account control only on the Owner surface", () => {
    expect(adminPage).toContain("isOwner && me && <AdminAccountAccessPanel");
    expect(panel).toContain("Find account");
    expect(panel).toContain("Suspend access");
    expect(panel).toContain("Restore access");
    expect(panel).toContain("You cannot suspend your own account.");
    expect(panel).toContain("Owner accounts must transfer or remove the Owner role first.");
  });

  it("requires an audit reason and uses generated authenticated transport hooks", () => {
    expect(panel).toContain('placeholder="Required audit reason (8–500 characters)"');
    expect(panel).toContain("useLookupAdminAccount(");
    expect(panel).toContain("useSuspendAdminAccount()");
    expect(panel).toContain("useRestoreAdminAccount()");
    expect(panel).not.toContain("authFetch(");
    expect(panel).not.toContain("window.fetch(");
  });

  it("keeps the ticket number in both the list and selected-ticket header", () => {
    expect(supportInbox.match(/\{ticket\.ticketNumber\}/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(supportInbox).toContain("<SupportOperationConsole");
    expect(supportInbox).toContain("ticketId={ticketId}");
    expect(supportInbox).toContain("ticketNumber={ticket.ticketNumber}");
  });
  it("grants staff allowlist access by exact account email", () => {
    expect(adminPage).toContain('placeholder="Staff member email address"');
    expect(adminPage).toContain('type="email"');
    expect(adminPage).toContain("email: roleEmail.trim().toLowerCase()");
    expect(adminPage).not.toContain('placeholder="Clerk user ID');
    expect(adminPage).not.toContain("userId: roleEmail");
  });
});
