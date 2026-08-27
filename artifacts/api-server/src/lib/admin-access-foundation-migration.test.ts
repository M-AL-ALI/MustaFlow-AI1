import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: {} }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { applyAdminAccessFoundationMigration } from "./startup-migrations";

describe("Admin Page access migration", () => {
  it("is additive, converts the old broad role, and is safe to run twice", async () => {
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        return { rows: [] };
      },
    };

    await applyAdminAccessFoundationMigration(client as never);
    const firstRun = [...statements];
    await applyAdminAccessFoundationMigration(client as never);
    expect(statements.slice(firstRun.length)).toEqual(firstRun);
    expect(firstRun.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS user_roles"))).toBe(
      true,
    );
    expect(firstRun).toContain("UPDATE user_roles SET role = 'operator' WHERE role = 'admin'");
    expect(
      firstRun.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS admin_access_receipts")),
    ).toBe(true);
    expect(firstRun.some((sql) => sql.includes("user_roles_role_check"))).toBe(true);
    expect(firstRun.at(-1)).toBe("COMMIT");
  });
});
