import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrations = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");

describe("queued prompt attachment migration", () => {
  it("adds a durable JSON attachment identity column idempotently", () => {
    expect(migrations).toContain("asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(migrations).toContain(
      "ADD COLUMN IF NOT EXISTS asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb",
    );
  });
});
