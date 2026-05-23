/**
 * Playwright end-to-end runner for the agentic builder loop.
 *
 * Targets a live preview URL (the project's container proxy URL) and runs a
 * sequence of scenarios — each loads the page, interacts, and reports
 * pass/fail along with console errors, network failures, and a thumbnail
 * screenshot on failure.
 *
 * Budgets are enforced here so a runaway run cannot blow up a task:
 *   - 60s total wall-clock for the whole run
 *   - 10 scenarios max
 *   - 5 MB total screenshot bytes (further scenarios get no screenshot)
 *
 * Graceful degradation:
 *   - No preview URL          → skipped run, returns a summary with skippedReason
 *   - Playwright not installed → skipped run
 *   - Chromium launch fails    → skipped run
 */

import { logger } from "../logger";
import type { E2eRunSummary, E2eScenarioResult } from "@workspace/db";

export type E2eScenario = {
  name: string;
  source?: "smoke" | "user";
  /**
   * Steps run after the page loads. Selectors are CSS or text= form.
   * Kept intentionally small — the loop generates these dynamically.
   */
  steps: Array<
    | { action: "click"; selector: string; optional?: boolean }
    | { action: "fill"; selector: string; value: string; optional?: boolean }
    | { action: "expectVisible"; selector: string; optional?: boolean }
    | { action: "expectText"; selector: string; value: string }
    | { action: "waitFor"; selector: string; timeoutMs?: number }
    | { action: "noConsoleErrors" }
    /** Click every matching element (capped at `max`, default 5). Missing matches => skip. */
    | { action: "clickEach"; selector: string; max?: number }
    /**
     * For every <form>, fill each input with a heuristically-valid value
     * (email→`smoke@example.com`, number→`1`, others→`smoke`) and submit it.
     * Skips if no forms found.
     */
    | { action: "submitEachForm"; max?: number }
  >;
};

export type E2eRunOptions = {
  /** Live target URL. When null, the run is skipped with a reason. */
  targetUrl: string | null;
  scenarios: E2eScenario[];
  /** Optional: HTML to inject via setContent when targetUrl can't be reached
   *  (used as a fallback so static-html projects can still be validated). */
  fallbackHtml?: string | null;
  /** Total wall-clock budget for the whole run (ms). Default 60_000. */
  totalBudgetMs?: number;
  /** Max scenarios. Default 10. */
  maxScenarios?: number;
  /** Max combined screenshot bytes. Default 5 MB. */
  maxScreenshotBytes?: number;
  signal?: AbortSignal;
};

const DEFAULT_TOTAL_BUDGET_MS = 60_000;
const DEFAULT_MAX_SCENARIOS = 10;
const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const PER_SCENARIO_TIMEOUT_MS = 10_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const SCREENSHOT_PER_FAILURE_BUDGET = 200 * 1024;

function emptySummary(skippedReason: string, targetUrl: string | null): E2eRunSummary {
  return {
    targetUrl,
    ranAt: new Date().toISOString(),
    totalDurationMs: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    skippedReason,
    budgetExceeded: false,
    scenarios: [],
    autoFixAttempted: false,
  };
}

async function resolveChromiumPath(): Promise<string | undefined> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const { existsSync } = await import("node:fs");
  const candidates = [
    "/nix/var/nix/profiles/default/bin/chromium",
    "/run/current-system/sw/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function runE2eScenarios(opts: E2eRunOptions): Promise<E2eRunSummary> {
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const maxScenarios = opts.maxScenarios ?? DEFAULT_MAX_SCENARIOS;
  const maxScreenshotBytes = opts.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;

  if (!opts.targetUrl && !opts.fallbackHtml) {
    return emptySummary("no preview URL available (container not running)", null);
  }

  let chromium: typeof import("playwright").chromium;
  try {
    const playwright = await import("playwright");
    chromium = playwright.chromium;
  } catch (err) {
    logger.warn({ err }, "Playwright not installed — skipping E2E run");
    return emptySummary("Playwright not installed in API server", opts.targetUrl);
  }

  const executablePath = await resolveChromiumPath();

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    logger.warn({ err }, "Chromium launch failed — skipping E2E run");
    return emptySummary("Chromium not available on this host", opts.targetUrl);
  }

  const scenariosToRun = opts.scenarios.slice(0, maxScenarios);
  const budgetExceededTrim = opts.scenarios.length > maxScenarios;
  const results: E2eScenarioResult[] = [];
  let totalScreenshotBytes = 0;
  let budgetExceeded = budgetExceededTrim;
  const runStart = Date.now();

  try {
    for (const scenario of scenariosToRun) {
      if (opts.signal?.aborted) {
        results.push({
          name: scenario.name,
          source: scenario.source ?? "smoke",
          passed: false,
          durationMs: 0,
          message: "aborted by user",
          consoleErrors: [],
          networkFailures: [],
          screenshotBase64: null,
        });
        continue;
      }
      const elapsed = Date.now() - runStart;
      if (elapsed >= totalBudgetMs) {
        budgetExceeded = true;
        results.push({
          name: scenario.name,
          source: scenario.source ?? "smoke",
          passed: false,
          durationMs: 0,
          message: `skipped: total E2E budget of ${totalBudgetMs}ms exceeded`,
          consoleErrors: [],
          networkFailures: [],
          screenshotBase64: null,
        });
        continue;
      }

      const scenarioStart = Date.now();
      const consoleErrors: string[] = [];
      const networkFailures: E2eScenarioResult["networkFailures"] = [];
      let passed = false;
      let message = "";
      let screenshotBase64: string | null = null;

      const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 400));
      });
      page.on("pageerror", (err) => {
        consoleErrors.push(`pageerror: ${err.message}`.slice(0, 400));
      });
      page.on("requestfailed", (req) => {
        networkFailures.push({
          url: req.url().slice(0, 300),
          status: null,
          message: (req.failure()?.errorText ?? "request failed").slice(0, 200),
        });
      });
      page.on("response", (resp) => {
        const status = resp.status();
        if (status >= 400) {
          networkFailures.push({
            url: resp.url().slice(0, 300),
            status,
            message: `HTTP ${status}`,
          });
        }
      });

      try {
        if (opts.targetUrl) {
          await page.goto(opts.targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: PAGE_LOAD_TIMEOUT_MS,
          });
        } else if (opts.fallbackHtml) {
          await page.setContent(opts.fallbackHtml, {
            waitUntil: "domcontentloaded",
            timeout: PAGE_LOAD_TIMEOUT_MS,
          });
        }

        let stepFailed = false;
        for (const step of scenario.steps) {
          try {
            switch (step.action) {
              case "click": {
                const loc = page.locator(step.selector).first();
                const count = await loc.count();
                if (count === 0) {
                  if (step.optional) break;
                  throw new Error(`no element matches ${step.selector}`);
                }
                await loc.click({ timeout: PER_SCENARIO_TIMEOUT_MS });
                break;
              }
              case "fill": {
                const loc = page.locator(step.selector).first();
                const count = await loc.count();
                if (count === 0) {
                  if (step.optional) break;
                  throw new Error(`no element matches ${step.selector}`);
                }
                await loc.fill(step.value, { timeout: PER_SCENARIO_TIMEOUT_MS });
                break;
              }
              case "expectVisible": {
                const loc = page.locator(step.selector).first();
                const count = await loc.count();
                if (count === 0) {
                  if (step.optional) break;
                  throw new Error(`${step.selector} not visible`);
                }
                const visible = await loc.isVisible();
                if (!visible) {
                  if (step.optional) break;
                  throw new Error(`${step.selector} not visible`);
                }
                break;
              }
              case "clickEach": {
                const limit = Math.min(step.max ?? 5, 10);
                const all = page.locator(step.selector);
                const count = Math.min(await all.count(), limit);
                if (count === 0) break;
                for (let i = 0; i < count; i++) {
                  try {
                    await all.nth(i).click({ timeout: PER_SCENARIO_TIMEOUT_MS, trial: false });
                  } catch {
                    /* per-item click is best-effort */
                  }
                }
                break;
              }
              case "submitEachForm": {
                const limit = Math.min(step.max ?? 3, 10);
                const formCount = Math.min(await page.locator("form").count(), limit);
                if (formCount === 0) break;
                for (let i = 0; i < formCount; i++) {
                  const form = page.locator("form").nth(i);
                  const inputs = form.locator(
                    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled])",
                  );
                  const inputCount = Math.min(await inputs.count(), 10);
                  for (let j = 0; j < inputCount; j++) {
                    const input = inputs.nth(j);
                    let value = "smoke";
                    try {
                      const type = (await input.getAttribute("type")) ?? "";
                      if (type === "email") value = "smoke@example.com";
                      else if (type === "number") value = "1";
                      else if (type === "tel") value = "5550100";
                      else if (type === "url") value = "https://example.com";
                      else if (type === "password") value = "Smoke!Pw1";
                    } catch {
                      /* default value */
                    }
                    try {
                      await input.fill(value, { timeout: PER_SCENARIO_TIMEOUT_MS });
                    } catch {
                      /* per-input fill is best-effort */
                    }
                  }
                  const submit = form
                    .locator("button[type=submit], [type=submit], button:not([type])")
                    .first();
                  if ((await submit.count()) > 0) {
                    try {
                      await submit.click({ timeout: PER_SCENARIO_TIMEOUT_MS });
                    } catch {
                      /* submit click is best-effort */
                    }
                  }
                }
                break;
              }
              case "expectText": {
                const el = page.locator(step.selector).first();
                await el.waitFor({ state: "attached", timeout: PER_SCENARIO_TIMEOUT_MS });
                const text = ((await el.textContent()) ?? "").trim().toLowerCase();
                if (!text.includes(step.value.toLowerCase())) {
                  throw new Error(
                    `expected "${step.value}" in ${step.selector}, got "${text.slice(0, 80)}"`,
                  );
                }
                break;
              }
              case "waitFor": {
                await page
                  .locator(step.selector)
                  .first()
                  .waitFor({
                    state: "visible",
                    timeout: step.timeoutMs ?? PER_SCENARIO_TIMEOUT_MS,
                  });
                break;
              }
              case "noConsoleErrors": {
                if (consoleErrors.length > 0) {
                  throw new Error(`${consoleErrors.length} console error(s) on page`);
                }
                break;
              }
            }
          } catch (err) {
            stepFailed = true;
            message = err instanceof Error ? err.message : String(err);
            break;
          }
        }

        if (!stepFailed) {
          passed = true;
          message = "ok";
        }
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      if (!passed && totalScreenshotBytes < maxScreenshotBytes) {
        try {
          const buf = await page.screenshot({ type: "png", fullPage: false });
          if (buf.byteLength <= SCREENSHOT_PER_FAILURE_BUDGET) {
            screenshotBase64 = buf.toString("base64");
            totalScreenshotBytes += buf.byteLength;
          } else {
            screenshotBase64 = null;
            budgetExceeded = true;
          }
        } catch {
          // screenshot failure is non-fatal
        }
      } else if (!passed) {
        budgetExceeded = true;
      }

      results.push({
        name: scenario.name,
        source: scenario.source ?? "smoke",
        passed,
        durationMs: Date.now() - scenarioStart,
        message: message.slice(0, 400),
        consoleErrors: consoleErrors.slice(0, 10),
        networkFailures: networkFailures.slice(0, 10),
        screenshotBase64: passed ? null : screenshotBase64,
      });

      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  return {
    targetUrl: opts.targetUrl,
    ranAt: new Date(runStart).toISOString(),
    totalDurationMs: Date.now() - runStart,
    passed: passedCount,
    failed: failedCount,
    skipped: 0,
    skippedReason: null,
    budgetExceeded,
    scenarios: results,
    autoFixAttempted: false,
  };
}

/**
 * The default smoke scenarios. Designed to work on any web app:
 *  - page loads without throwing
 *  - no console errors after settle
 *  - first visible button is clickable (optional — only if present)
 *  - first visible form submit doesn't blow up (optional)
 */
export function defaultSmokeScenarios(): E2eScenario[] {
  return [
    {
      name: "Page loads",
      source: "smoke",
      steps: [{ action: "expectVisible", selector: "body" }],
    },
    {
      name: "No console errors on load",
      source: "smoke",
      steps: [{ action: "noConsoleErrors" }],
    },
    {
      name: "All primary buttons are clickable",
      source: "smoke",
      steps: [
        {
          action: "clickEach",
          selector: "button:not([type=submit]), [role=button], a.btn",
          max: 5,
        },
        { action: "noConsoleErrors" },
      ],
    },
    {
      name: "Every form accepts valid input and submits",
      source: "smoke",
      steps: [{ action: "submitEachForm", max: 3 }, { action: "noConsoleErrors" }],
    },
  ];
}

/**
 * Discover user-authored Playwright specs from the project's file map.
 * Returns the matched file entries; execution is handled separately by
 * `runUserSpecs` so the agent loop can run them with @playwright/test
 * against the live preview, not as synthetic in-process scenarios.
 */
export function discoverUserSpecs(
  files: Array<{ path: string; content?: string }>,
): Array<{ path: string; content: string }> {
  return files
    .filter((f) => /^tests\/e2e\/.+\.spec\.tsx?$/.test(f.path) && typeof f.content === "string")
    .map((f) => ({ path: f.path, content: f.content as string }));
}

export type UserSpecRunOptions = {
  specs: Array<{ path: string; content: string }>;
  baseUrl: string;
  /**
   * Numeric project id, used by writeFileToContainer / execInContainer for
   * audit logging (`container_logs` rows).
   */
  projectId: number;
  /**
   * Active Fly.io machine ID. When null, user spec execution is skipped
   * with reason "requires project container" — running untrusted user code
   * on the API server host would be a sandbox-escape class issue, so the
   * project's own container is the only supported execution boundary.
   */
  containerId: string | null;
  /**
   * Wall-clock budget (ms) for this user-spec phase. When called from the
   * agent loop's auto-smoke, the caller should pass the **remaining** time
   * after the smoke run so the combined cap stays at 60s.
   * Default 60_000.
   */
  totalBudgetMs?: number;
  /**
   * Max number of user specs to actually execute. When called from the
   * auto-smoke path, the caller should pass `10 - smokeScenariosRun` so
   * the combined scenario cap is honoured. Specs beyond the cap are
   * reported as `skipped: budget`.
   * Default 10.
   */
  maxSpecs?: number;
  signal?: AbortSignal;
};

/**
 * Execute user-authored Playwright spec files (`tests/e2e/*.spec.ts`) against
 * the live preview, **inside the project's own Fly.io container**.
 *
 * Trust boundary: user spec files are arbitrary user code, so they MUST NOT
 * execute on the API server. The project container is the same sandbox the
 * user's own app code runs in, so running specs there matches the existing
 * security model. When no container is attached, the run is skipped with a
 * clear reason rather than falling back to host execution.
 *
 * Returns one `E2eScenarioResult` per spec (one entry per file, not per
 * individual `test(...)` block — the JSON reporter's nested suite/test tree
 * is flattened into a single pass/fail per spec for the chat card).
 */
export async function runUserSpecs(opts: UserSpecRunOptions): Promise<E2eScenarioResult[]> {
  if (opts.specs.length === 0) return [];
  const budget = Math.max(opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS, 0);
  const maxSpecs = Math.max(opts.maxSpecs ?? DEFAULT_MAX_SCENARIOS, 0);
  const skippedReason = (msg: string): E2eScenarioResult[] =>
    opts.specs.map((s) => ({
      name: `Custom: ${s.path.replace(/^tests\/e2e\//, "")}`,
      source: "user" as const,
      passed: false,
      durationMs: 0,
      message: msg,
      consoleErrors: [],
      networkFailures: [],
      screenshotBase64: null,
    }));
  if (budget < 2000 || maxSpecs === 0) {
    return skippedReason("skipped: combined E2E budget exhausted by smoke run");
  }
  if (!opts.containerId) {
    return skippedReason(
      "skipped: user spec execution requires the project container (sandboxing) — start the container and re-run",
    );
  }
  const specsToRun = opts.specs.slice(0, maxSpecs);
  const specsSkipped = opts.specs.slice(maxSpecs);

  const { writeFileToContainer, execInContainer } = await import("../container");
  const results: E2eScenarioResult[] = [];
  const remoteWorkDir = `/tmp/mf-e2e-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;

  try {
    // Write each spec into the container workdir under a flattened filename.
    const writtenSpecs: Array<{ rel: string; origPath: string }> = [];
    for (const spec of specsToRun) {
      const fname = spec.path.replace(/^tests\/e2e\//, "").replace(/[\\/]/g, "_");
      const remote = `${remoteWorkDir}/tests/${fname}`;
      const ok = await writeFileToContainer(opts.containerId, remote, spec.content, opts.projectId);
      if (!ok) {
        results.push({
          name: `Custom: ${spec.path.replace(/^tests\/e2e\//, "")}`,
          source: "user",
          passed: false,
          durationMs: 0,
          message: "skipped: failed to upload spec to container",
          consoleErrors: [],
          networkFailures: [],
          screenshotBase64: null,
        });
        continue;
      }
      writtenSpecs.push({ rel: `tests/${fname}`, origPath: spec.path });
    }

    if (writtenSpecs.length === 0) {
      for (const s of specsSkipped) {
        results.push({
          name: `Custom: ${s.path.replace(/^tests\/e2e\//, "")}`,
          source: "user",
          passed: false,
          durationMs: 0,
          message: `skipped: combined E2E scenario cap (${DEFAULT_MAX_SCENARIOS}) reached`,
          consoleErrors: [],
          networkFailures: [],
          screenshotBase64: null,
        });
      }
      return results;
    }

    // Minimal playwright.config + package.json so `npx --yes playwright test`
    // bootstraps cleanly even on a fresh container with no project deps.
    const configBody =
      `import { defineConfig } from "@playwright/test";\n` +
      `export default defineConfig({\n` +
      `  testDir: "./tests",\n` +
      `  fullyParallel: false,\n` +
      `  workers: 1,\n` +
      `  retries: 0,\n` +
      `  timeout: 15000,\n` +
      `  reporter: [["json", { outputFile: "results.json" }]],\n` +
      `  use: { baseURL: ${JSON.stringify(opts.baseUrl)}, headless: true,\n` +
      `    launchOptions: { args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] },\n` +
      `  },\n` +
      `});\n`;
    const pkgBody = JSON.stringify(
      {
        name: "mf-e2e",
        private: true,
        type: "module",
        devDependencies: { "@playwright/test": "^1.60.0" },
      },
      null,
      2,
    );
    const wroteConfig = await writeFileToContainer(
      opts.containerId,
      `${remoteWorkDir}/playwright.config.ts`,
      configBody,
      opts.projectId,
    );
    const wrotePkg = await writeFileToContainer(
      opts.containerId,
      `${remoteWorkDir}/package.json`,
      pkgBody,
      opts.projectId,
    );
    if (!wroteConfig || !wrotePkg) {
      return skippedReason("skipped: failed to write playwright config into container");
    }

    if (opts.signal?.aborted) return skippedReason("skipped: aborted by user");

    // Execute. The container runs `npx --yes @playwright/test test ...`.
    // npx will install on first use and cache thereafter. Wall-clock budget
    // is enforced by racing against the AbortSignal + a timer.
    const cmd = [
      "/bin/sh",
      "-lc",
      `cd ${remoteWorkDir} && timeout ${Math.floor(budget / 1000)}s npx --yes -p @playwright/test@1.60.0 playwright test --reporter=json --config=playwright.config.ts; echo "---RESULTS---"; cat results.json 2>/dev/null || echo '{}'`,
    ];
    const runStart = Date.now();
    const exec = await Promise.race([
      execInContainer(opts.containerId, cmd, opts.projectId, "/tmp"),
      new Promise<{ ok: false; output: string }>((resolve) => {
        const t = setTimeout(
          () => resolve({ ok: false, output: "ERROR: e2e wall-clock budget exceeded" }),
          budget + 5000,
        );
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve({ ok: false, output: "ERROR: aborted by user" });
          },
          { once: true },
        );
      }),
    ]);
    logger.info(
      { ms: Date.now() - runStart, specs: writtenSpecs.length },
      "user-specs: container exec finished",
    );

    // Split exec output: anything after the ---RESULTS--- marker is the
    // results.json payload from the playwright json reporter.
    const marker = "---RESULTS---";
    const idx = exec.output.lastIndexOf(marker);
    const jsonRaw = idx >= 0 ? exec.output.slice(idx + marker.length).trim() : "";

    type PwSpec = {
      title: string;
      ok: boolean;
      tests?: Array<{
        results?: Array<{
          status?: string;
          error?: { message?: string };
          duration?: number;
        }>;
      }>;
    };
    type PwSuite = {
      title?: string;
      file?: string;
      specs?: PwSpec[];
      suites?: PwSuite[];
    };
    type PwReport = { suites?: PwSuite[] };
    let parsed: PwReport | null = null;
    try {
      parsed = JSON.parse(jsonRaw) as PwReport;
    } catch {
      parsed = null;
    }
    const flat: Array<{ file: string; specs: PwSpec[] }> = [];
    const flatten = (suites: PwSuite[]): void => {
      for (const s of suites) {
        if (s.specs?.length) flat.push({ file: s.file ?? s.title ?? "", specs: s.specs });
        if (Array.isArray(s.suites)) flatten(s.suites);
      }
    };
    if (parsed?.suites) flatten(parsed.suites);

    for (const written of writtenSpecs) {
      const baseName = written.rel.split("/").pop() ?? written.rel;
      const matched = flat.find((f) => f.file.endsWith(baseName));
      const friendlyName = `Custom: ${written.origPath.replace(/^tests\/e2e\//, "")}`;
      if (!matched || !matched.specs || matched.specs.length === 0) {
        results.push({
          name: friendlyName,
          source: "user",
          passed: false,
          durationMs: 0,
          message: parsed
            ? "spec produced no test results"
            : `playwright test did not produce results.json (timeout, install failure, or runtime error). Exec stderr: ${exec.output.slice(0, 200)}`,
          consoleErrors: [],
          networkFailures: [],
          screenshotBase64: null,
        });
        continue;
      }
      const allOk = matched.specs.every((sp) => sp.ok);
      const failed = matched.specs.filter((sp) => !sp.ok);
      const firstErr = failed
        .flatMap((sp) => sp.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .find((r) => r.error?.message)?.error?.message;
      const totalDur = matched.specs
        .flatMap((sp) => sp.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .reduce((acc, r) => acc + (r.duration ?? 0), 0);
      results.push({
        name: friendlyName,
        source: "user",
        passed: allOk,
        durationMs: Math.round(totalDur),
        message: allOk ? "ok" : (firstErr ?? "one or more tests failed").slice(0, 400),
        consoleErrors: [],
        networkFailures: [],
        screenshotBase64: null,
      });
    }
  } finally {
    // Best-effort cleanup of the remote workdir.
    await execInContainer(
      opts.containerId,
      ["/bin/sh", "-lc", `rm -rf ${remoteWorkDir}`],
      opts.projectId,
      "/tmp",
    ).catch(() => {});
  }

  for (const s of specsSkipped) {
    results.push({
      name: `Custom: ${s.path.replace(/^tests\/e2e\//, "")}`,
      source: "user",
      passed: false,
      durationMs: 0,
      message: `skipped: combined E2E scenario cap (${DEFAULT_MAX_SCENARIOS}) reached`,
      consoleErrors: [],
      networkFailures: [],
      screenshotBase64: null,
    });
  }

  return results;
}
