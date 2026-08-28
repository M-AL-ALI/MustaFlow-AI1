import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "src");
const authSource = readFileSync(resolve(root, "lib/adminAuth.ts"), "utf8");
const routeSource = readFileSync(resolve(root, "routes/admin.ts"), "utf8");

describe("Admin authority single-source law", () => {
  it("keeps request-time authority in user_roles only", () => {
    expect(authSource).toContain('source: "user_roles"');
    expect(authSource).not.toContain("ADMIN_USER_IDS");
    expect(authSource).not.toContain("billing-privileges");
    expect(authSource).not.toContain("isBillingPrivileged");
  });

  it("makes launch readiness and /admin/me report the same authority", () => {
    expect(routeSource).toContain("authoritySource: principal.source");
    expect(routeSource).toContain("Admin RBAC is active with");
    expect(routeSource).not.toContain("hasEnvAdmins");
    expect(routeSource).not.toContain("Set ADMIN_USER_IDS env var");
  });
});
