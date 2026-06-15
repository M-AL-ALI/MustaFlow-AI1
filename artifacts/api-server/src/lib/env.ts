/**
 * Centralized runtime environment checks.
 *
 * Keep production/test decisions here so security-sensitive bypasses do not
 * drift across modules.
 */

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1";
}

export function isE2ETestRuntime(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.E2E_TEST_ENABLED === "true" &&
    process.env.REPLIT_DEPLOYMENT !== "1"
  );
}
