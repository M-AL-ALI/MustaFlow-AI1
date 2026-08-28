import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const adminSource = readFileSync(resolve(sourceRoot, "pages/admin.tsx"), "utf8");
const developerPageSource = readFileSync(
  resolve(sourceRoot, "pages/admin-developer-tools.tsx"),
  "utf8",
);
const appSource = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");
const adminPageBody = adminSource.slice(
  adminSource.indexOf("export default function AdminPage"),
  adminSource.indexOf("export function AdminDeveloperTools"),
);
const developerToolsBody = adminSource.slice(
  adminSource.indexOf("export function AdminDeveloperTools"),
  adminSource.indexOf("const ACTION_COLORS"),
);

describe("Admin panel declarations and developer-tool exile", () => {
  it("gives every retained panel family one visible purpose, action, and freshness contract", () => {
    expect(adminSource).toContain("data-admin-panel-declaration");
    expect(adminSource).toContain(">Purpose<");
    expect(adminSource).toContain(">Operator action<");
    expect(adminSource).toContain(">Freshness<");

    for (const component of [
      "ProdErrorsTile",
      "JobQueueTile",
      "InboxRecentUnreadTile",
      "SupportTicketsTile",
      "StatCard",
      "AdminSection",
    ]) {
      const start = adminSource.indexOf(`function ${component}`);
      expect(start, component).toBeGreaterThan(0);
      const nextFunction = adminSource.indexOf("\nfunction ", start + 10);
      const body = adminSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
      expect(body, component).toContain("<PanelDeclaration");
    }
  });

  it("removes all five developer panels from the operator page and keeps them together", () => {
    for (const panel of [
      "<EvalResultsTile",
      "<OraRoutingDiagnosticsPanel",
      "Architect Review",
      "<TopSkillsPanel",
      "<SkillsPanel",
    ]) {
      expect(adminPageBody, panel).not.toContain(panel);
      expect(developerToolsBody, panel).toContain(panel);
    }
    expect(adminSource).toContain("Top skills used (last {topSkills.windowDays} days)");
    expect(adminPageBody).toContain('href="/admin/developer-tools"');
  });

  it("makes the developer surface owner-only and keeps a complete navigation path", () => {
    expect(appSource).toContain('path="/admin/developer-tools"');
    expect(appSource).toContain('meQuery.data?.role !== "owner"');
    expect(appSource).toContain("<OwnerAdminGuard>");
    expect(developerPageSource).toContain("<AdminBreadcrumbs");
    expect(developerPageSource).toContain('{ label: "Admin Page", href: "/admin" }');
    expect(developerPageSource).toContain("Back to Admin Page");
    expect(developerPageSource).toContain("<AdminDeveloperTools />");
  });
});
