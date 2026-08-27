import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceRoot = resolve(process.cwd(), "src");
const pageSource = readFileSync(resolve(sourceRoot, "pages/admin.tsx"), "utf8");
const appSource = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");
const sidebarSource = readFileSync(resolve(sourceRoot, "components/layout/sidebar.tsx"), "utf8");

describe("Admin Page shell", () => {
  it("names the operator console and shows the four-role allowlist only to Owners", () => {
    expect(pageSource).toContain(">Admin Page</h1>");
    expect(pageSource).toContain("The operator console for provider control");
    expect(pageSource).toContain("{isOwner && (");
    for (const role of ["owner", "operator", "support", "analyst"]) {
      expect(pageSource).toContain(`<option value="${role}"`);
    }
    expect(pageSource).toContain("Allowlist change history");
  });

  it("keeps both the navigation entry and route guard bound to the server gate", () => {
    expect(sidebarSource).toContain('authFetch("/api/admin/me")');
    expect(sidebarSource).toContain("if (!staffRole) return null");
    expect(sidebarSource).toContain("canViewSupport");
    expect(sidebarSource).toContain("Admin Page");
    expect(appSource).toContain("useGetAdminMe()");
    expect(appSource).toContain("meQuery.error.status === 404");
  });
});
