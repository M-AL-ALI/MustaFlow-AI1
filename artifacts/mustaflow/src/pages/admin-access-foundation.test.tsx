import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceRoot = resolve(process.cwd(), "src");
const pageSource = readFileSync(resolve(sourceRoot, "pages/admin.tsx"), "utf8");
const appSource = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");
const sidebarSource = readFileSync(resolve(sourceRoot, "components/layout/sidebar.tsx"), "utf8");
const drawerSource = readFileSync(
  resolve(sourceRoot, "components/layout/slide-out-nav.tsx"),
  "utf8",
);
const gateSource = readFileSync(resolve(sourceRoot, "hooks/use-admin-access.ts"), "utf8");
const trustSource = readFileSync(resolve(sourceRoot, "pages/trust.tsx"), "utf8");

describe("Admin Page shell", () => {
  it("names the operator console and shows the four-role allowlist only to Owners", () => {
    expect(pageSource).toContain(">Admin Page</h1>");
    expect(pageSource).toContain("Operational health, support, access controls");
    expect(pageSource).not.toContain("The operator console for provider control");
    expect(pageSource).toContain("{isOwner && (");
    for (const role of ["owner", "operator", "support", "analyst"]) {
      expect(pageSource).toContain(`<option value="${role}"`);
    }
    expect(pageSource).toContain("Allowlist change history");
  });

  it("keeps both the navigation entry and route guard bound to the server gate", () => {
    expect(gateSource).toContain('authFetch("/api/admin/me",');
    expect(gateSource).toContain("data?.isAdmin === true");
    expect(gateSource).toContain("evidence?.userId === userId");
    for (const navigation of [sidebarSource, drawerSource]) {
      expect(navigation).toContain("useAdminAccess()");
    }

    expect(sidebarSource).toContain("if (!isAdmin) return null");
    // The active responsive shell passes the same server-gated value to one
    // shared renderer. Behavior tests also cover denial, grant and revocation.
    expect(drawerSource).toContain("const { isAdmin } = useAdminAccess();");
    expect(drawerSource).toContain("isAdmin={isAdmin}");
    expect(drawerSource).toContain("{isAdmin && (");
    expect(sidebarSource).toContain("canViewSupport");
    expect(sidebarSource).toContain("Admin Page");
    expect(appSource).toContain("useGetAdminMe()");
    expect(appSource).toContain("meQuery.error.status === 404");
  });

  it("names the same user_roles authority on the Admin and Trust surfaces", () => {
    expect(pageSource).toContain("Authority is read from the Admin");
    expect(pageSource).not.toContain("granted via ADMIN_USER_IDS");
    expect(trustSource).toContain("server-side user_roles ledger");
    expect(trustSource).not.toContain("ADMIN_USER_IDS");
  });
});
