/**
 * Deterministic, non-routable defaults for unit-test module imports.
 *
 * Several production modules intentionally fail closed at import time when a
 * required secret or service endpoint is absent. Individual tests also mutate
 * process.env, which can otherwise leak into the next file in a serial run.
 * Reapply inert values before every test file so the full suite is
 * order-independent and can never fall through to production infrastructure.
 */
const databaseUrlBaseline = process.env.NABUFLOW_VITEST_DATABASE_URL_BASELINE;
if (databaseUrlBaseline) process.env.DATABASE_URL = databaseUrlBaseline;
else delete process.env.DATABASE_URL;
process.env.NABUFLOW_VITEST_DATABASE_ENABLED = databaseUrlBaseline ? "true" : "false";

process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "vitest-inert-api-key";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.ORA_SESSION_SECRET = "vitest-ora-session-secret-at-least-32-bytes";
