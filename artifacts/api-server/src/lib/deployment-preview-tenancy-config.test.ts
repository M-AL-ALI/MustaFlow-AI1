import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const replitConfig = readFileSync(
  fileURLToPath(new URL("../../../../.replit", import.meta.url)),
  "utf8",
);

function userenvSection(name: string): string {
  const section = replitConfig.match(
    new RegExp(`\\[userenv\\.${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`, "u"),
  );
  return section?.[1] ?? "";
}

describe("deployment-preview workspace tenancy configuration", () => {
  it("does not place an environment-specific adoption owner in shared configuration", () => {
    expect(userenvSection("shared")).not.toMatch(/^LEGACY_ADOPTION_OWNER_ID\s*=/mu);
  });

  it("keeps development and production owner choices explicit", () => {
    expect(userenvSection("development")).toMatch(
      /^LEGACY_ADOPTION_OWNER_ID = "user_[A-Za-z0-9]+"$/mu,
    );
    expect(userenvSection("production")).toMatch(
      /^LEGACY_ADOPTION_OWNER_ID = "user_[A-Za-z0-9]+"$/mu,
    );
  });
});
