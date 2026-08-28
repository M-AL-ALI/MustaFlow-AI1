import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: {} }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { applyProjectCollaborationMigration } from "./startup-migrations";

describe("project collaboration migration", () => {
  it("is additive, backfills owners, and is safe to run twice", async () => {
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/gu, " ").trim());
        return { rows: [] };
      },
    };

    await applyProjectCollaborationMigration(client as never);
    const firstRun = [...statements];
    await applyProjectCollaborationMigration(client as never);

    expect(statements.slice(firstRun.length)).toEqual(firstRun);
    expect(
      firstRun.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS project_collaborators")),
    ).toBe(true);
    expect(firstRun.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS project_invites"))).toBe(
      true,
    );
    expect(firstRun.some((sql) => sql.includes("project_invites_pending_email_uq"))).toBe(true);
    expect(firstRun.some((sql) => sql.includes("SELECT id, workspace_id, owner_id, 'owner'"))).toBe(
      true,
    );
    expect(
      firstRun.some((sql) => sql.includes("ON CONFLICT (project_id, user_id) DO UPDATE")),
    ).toBe(true);
    expect(firstRun.at(-1)).toBe("COMMIT");
  });
});
