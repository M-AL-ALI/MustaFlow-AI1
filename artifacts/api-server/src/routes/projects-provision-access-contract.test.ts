import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./projects.ts", import.meta.url), "utf8");

describe("project provision status access contract", () => {
  it("invokes the project access guard for viewer access", () => {
    expect(source).toMatch(
      /"\/projects\/:id\/provision\/status"\s*,\s*requireProjectAccess\("viewer"\)/,
    );
    expect(source).not.toMatch(
      /"\/projects\/:id\/provision\/status"\s*,\s*requireProjectAccess\s*,/,
    );
  });
});
