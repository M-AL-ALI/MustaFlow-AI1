import { defineConfig, devices } from "@playwright/test";

/**
 * Task #753 — Stop-button cancellation: browser e2e configuration
 *
 * Runs the Stop-button Playwright spec against the locally-running app.
 *
 * Required env vars (on the API server, not the test runner):
 *   DEV_SLOW_BUILD_DELAY_MS — makes runBuildPipeline sleep instead of calling
 *                             OpenAI so the task stays "building" long enough
 *                             for the test to call POST /cancel.
 *
 * Optional env vars (test runner):
 *   E2E_BASE_URL — app origin (default: http://localhost:80)
 *
 * Run with:
 *   npx playwright test e2e/stop-button.spec.ts
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:80",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
