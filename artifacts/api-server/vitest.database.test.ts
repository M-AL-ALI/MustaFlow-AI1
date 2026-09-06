import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  configureVitestDatabase,
  resolveVitestDatabaseUrl,
  VITEST_DATABASE_BASELINE_ENV,
  VITEST_DATABASE_ENABLED_ENV,
  VITEST_DATABASE_URL_ENV,
} from "./vitest.database";

const SAFE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/ora_gate_disposable_0123456789abcdef";
const imageEditTestSource = readFileSync(
  new URL("./src/routes/__tests__/ora-image-edit.test.ts", import.meta.url),
  "utf8",
);

describe("Vitest disposable database boundary", () => {
  it("removes an ambient generic DATABASE_URL when no dedicated target is supplied", () => {
    const environment = {
      DATABASE_URL: "postgresql://production.example.com/nabuflow",
    } as NodeJS.ProcessEnv;

    configureVitestDatabase(environment);

    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment[VITEST_DATABASE_ENABLED_ENV]).toBe("false");
    expect(environment[VITEST_DATABASE_BASELINE_ENV]).toBe("");
  });

  it("accepts and activates an explicitly named loopback disposable database", () => {
    const environment = { [VITEST_DATABASE_URL_ENV]: SAFE_URL } as NodeJS.ProcessEnv;

    configureVitestDatabase(environment);

    expect(environment.DATABASE_URL).toBe(SAFE_URL);
    expect(environment[VITEST_DATABASE_ENABLED_ENV]).toBe("true");
    expect(environment[VITEST_DATABASE_BASELINE_ENV]).toBe(SAFE_URL);
  });

  it.each([
    "postgresql://postgres:postgres@db.example.com:5432/ora_gate_disposable_0123456789abcdef",
    "postgresql://postgres:postgres@127.0.0.1:5432/production",
    "postgresql://postgres:postgres@127.0.0.1:5432/ora_gate_disposable_0123456789abcdef?sslmode=require",
    "https://127.0.0.1/ora_gate_disposable_0123456789abcdef",
  ])("rejects an unsafe dedicated target without exposing it in the error: %s", (value) => {
    const environment = { [VITEST_DATABASE_URL_ENV]: value } as NodeJS.ProcessEnv;

    expect(() => resolveVitestDatabaseUrl(environment)).toThrow(
      `${VITEST_DATABASE_URL_ENV} must target 127.0.0.1 and an ora_gate_disposable_<16 hex> database`,
    );
  });

  it("restores image-provider test state before any database cleanup guard", () => {
    const providerRestore = imageEditTestSource.indexOf(
      "if (ORIGINAL_OPENAI_IMAGE_API_KEY === undefined)",
    );
    const databaseCleanupGuard = imageEditTestSource.indexOf(
      'if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;',
    );

    expect(providerRestore).toBeGreaterThan(-1);
    expect(databaseCleanupGuard).toBeGreaterThan(providerRestore);
  });
});
