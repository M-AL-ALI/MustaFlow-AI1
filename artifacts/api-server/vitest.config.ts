import { defineConfig } from "vitest/config";
import { configureVitestDatabase } from "./vitest.database";

// Fail loudly instead of silently skipping database coverage when an existing
// caller supplies the old generic variable. Integration is enabled only by the
// dedicated, validated disposable-test target.
if (process.env.DATABASE_URL?.trim() && !process.env.NABUFLOW_VITEST_DATABASE_URL?.trim()) {
  throw new Error(
    "DATABASE_URL is not accepted by Vitest. Use NABUFLOW_VITEST_DATABASE_URL with a disposable loopback database, or unset DATABASE_URL for non-database tests.",
  );
}

configureVitestDatabase();

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
