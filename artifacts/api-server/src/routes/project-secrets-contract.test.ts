import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { isValidProjectSecretName, MASKED_SECRET_VALUE } from "../lib/project-secret-policy";

const source = readFileSync(new URL("./secrets.ts", import.meta.url), "utf8");

describe("project secret CRUD contract", () => {
  it("enforces environment-variable names", () => {
    expect(isValidProjectSecretName("API_KEY")).toBe(true);
    expect(isValidProjectSecretName("_PRIVATE_2")).toBe(true);
    expect(isValidProjectSecretName("2INVALID")).toBe(false);
    expect(isValidProjectSecretName("NOT-VALID")).toBe(false);
  });

  it("keeps every CRUD route project-owner scoped", () => {
    expect(source).toMatch(/router\.get\([\s\S]*?requireProjectOwnership/);
    expect(source).toMatch(/router\.post\([\s\S]*?requireProjectOwnership/);
    expect(source).toMatch(/router\.patch\([\s\S]*?requireProjectOwnership/);
    expect(source).toMatch(/router\.delete\([\s\S]*?requireProjectOwnership/);
  });

  it("uses encryption for writes and a fixed write-only mask for responses", () => {
    expect(source).toContain("encryptionService.encrypt(parsed.data.value)");
    expect(source).toContain("masked: MASKED_SECRET_VALUE");
    expect(source).not.toMatch(/masked:\s*maskValue/);
    expect(MASKED_SECRET_VALUE).not.toContain("value");
  });

  it("never serializes the encrypted or plaintext value in the response entry", () => {
    const entryBody = source.match(/function toEntry[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(entryBody).not.toContain("valueEncrypted:");
    expect(entryBody).not.toContain("value:");
    expect(entryBody).not.toContain("decrypt(");
  });
});
