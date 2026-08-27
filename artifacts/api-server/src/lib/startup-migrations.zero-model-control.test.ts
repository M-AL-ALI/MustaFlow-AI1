import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: {} }));

import { applyZeroModelControlMigration } from "./startup-migrations";

function readyClient() {
  const statements: string[] = [];
  const query = vi.fn(async (text: string) => {
    statements.push(text);
    if (text.includes("AS bindings_ready")) {
      return {
        rows: [
          {
            bindings_ready: true,
            settings_ready: true,
            calls_ready: true,
            constraints_ready: true,
          },
        ],
      };
    }
    return { rows: [] };
  });
  return { client: { query }, statements };
}

describe("zero model control startup migration", () => {
  it("is additive and safe to run twice", async () => {
    const { client, statements } = readyClient();
    await applyZeroModelControlMigration(client as never);
    await applyZeroModelControlMigration(client as never);

    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(2);
    expect(statements.join("\n")).toContain("CREATE TABLE IF NOT EXISTS");
    expect(statements.join("\n")).toContain("CREATE INDEX IF NOT EXISTS");
    expect(statements.join("\n")).not.toMatch(/DROP\s+(TABLE|COLUMN)/iu);
  });

  it("rolls back and preserves a typed terminal when verification is incomplete", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("AS bindings_ready")) {
        return {
          rows: [
            {
              bindings_ready: true,
              settings_ready: false,
              calls_ready: true,
              constraints_ready: true,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(applyZeroModelControlMigration({ query } as never)).rejects.toThrow(
      "zero_model_control_schema_incomplete",
    );
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});
