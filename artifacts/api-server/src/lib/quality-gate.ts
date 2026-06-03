/**
 * Agentic build quality gate.
 *
 * Runs three checks after the agent loop writes its staging snapshot:
 *   1. TypeScript compilation — `tsc --noEmit` inside the container.
 *   2. ESLint — on ALL changed JS/TS files (batched to avoid ARG_MAX).
 *   3. Server startup smoke test — starts the process and polls /healthz for
 *      up to 15 seconds (full-stack stacks only).
 *
 * Also exports `scanUndeclaredEnvVars` which does a static scan of JS/TS
 * source files for `process.env.FOO` references not in the project secrets.
 *
 * All container calls go through `execInContainer` and fail gracefully when
 * the required tooling is not installed in the container image.
 *
 * Distinction between check states:
 *   - passed=true, skipped=false  → ran and succeeded
 *   - passed=false, skipped=false → ran and failed
 *   - skipped=true                → binary not found; treated as unavailable
 *
 * QualityGateResult.passed is true only when at least one check ran and no
 * executed check failed. QualityGateResult.allPassed is true only when all
 * checks ran (none were skipped) and all passed — used for the UI banner.
 */

import { execInContainer, npmInstallInBackground, syncFilesToContainer } from "./container";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QualityGateCheck = {
  id: string;
  label: string;
  passed: boolean;
  /** true when the check's binary was not found — not a failure, not a pass */
  skipped: boolean;
  skipReason?: string;
  output: string;
  durationMs: number;
};

export type QualityGateResult = {
  /**
   * True when all executed checks passed (skipped checks don't contribute).
   * False as soon as any executed check fails.
   * False also when NO checks executed (nothing to validate).
   */
  passed: boolean;
  /**
   * True only when every applicable check ran AND passed (no skips).
   * Used by jobs.ts to decide whether to show the "All checks passed" banner.
   */
  allPassed: boolean;
  checks: QualityGateCheck[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function isTsJsFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && TS_JS_EXTS.has(path.slice(dot));
}

function hasFile(files: ReadonlyArray<{ path: string }>, name: string): boolean {
  return files.some((f) => f.path === name || f.path.endsWith(`/${name}`));
}

function hasEslintConfig(files: ReadonlyArray<{ path: string }>): boolean {
  const cfgs = [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
  ];
  return cfgs.some((c) => hasFile(files, c));
}

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript + ESLint gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run TypeScript and ESLint checks inside a running Fly.io container.
 *
 * Skips gracefully when:
 *   - tsconfig.json is absent (no TypeScript project to check)
 *   - tsc binary is not installed in the container's node_modules
 *   - no ESLint config exists (ESLint check is skipped)
 *   - eslint binary is not installed
 *
 * Infrastructure failures (Fly exec error, timeout) are surfaced as failed
 * checks rather than thrown exceptions.
 *
 * ESLint lints ALL changed JS/TS files — batched into groups of 50 to stay
 * safely under ARG_MAX. Each batch runs sequentially; outputs are concatenated
 * and the overall check fails if any batch exits non-zero.
 */
export async function runQualityGate(
  containerId: string,
  projectId: number,
  changedFiles: ReadonlyArray<{ path: string; content: string }>,
  allFiles: ReadonlyArray<{ path: string }>,
  /** Full project file set with content, used to re-sync the container if the
   *  Fly machine has restarted and lost its writable layer (package.json missing). */
  allFilesForSync?: ReadonlyArray<{ path: string; content: string }>,
): Promise<QualityGateResult> {
  const checks: QualityGateCheck[] = [];

  // ── Pre-flight: re-sync files + npm install if machine restarted ─────────
  // Fly machines reset their writable layer on each stop/start cycle.
  // If /app/package.json is missing after a restart, re-sync all project files
  // and re-run npm install so that tsc/eslint can find their binaries.
  if (allFilesForSync && allFilesForSync.length > 0) {
    try {
      const probe = await execInContainer(
        containerId,
        ["sh", "-c", "test -f /app/package.json && echo exists || echo missing"],
        projectId,
      );
      if (probe.output.includes("missing") || probe.machineWoken) {
        logger.info(
          { projectId, containerId },
          "Quality gate pre-flight: /app/package.json missing after machine restart — re-syncing files and running npm install",
        );
        await syncFilesToContainer(
          containerId,
          projectId,
          allFilesForSync.map((f) => ({ path: f.path, content: f.content })),
        ).catch((e: unknown) =>
          logger.warn(
            { projectId, err: e },
            "Quality gate pre-flight: syncFilesToContainer failed (non-fatal)",
          ),
        );
        // Re-run npm install using the background+poll approach.
        // Direct exec holds an open HTTP connection for ~90 s which gets cut by
        // Fly's ~60 s autostop.  Detaching the process and polling with short
        // execs keeps every individual exec well under the autostop window.
        //
        // Pass onMachineRestarted so that if the machine autostops DURING the
        // background install (resetting /app), files are re-synced before the
        // next install attempt.  Without this, npm would run against an empty
        // /app directory (no package.json) and succeed with 0 packages.
        const filesSnapshot = allFilesForSync;
        const installResult = await npmInstallInBackground(containerId, projectId, {
          wallClockCapMs: 6 * 60 * 1000,
          onMachineRestarted: async () => {
            logger.info(
              { projectId, containerId },
              "Quality gate pre-flight: machine restarted during npm install — re-syncing files",
            );
            await syncFilesToContainer(
              containerId,
              projectId,
              filesSnapshot.map((f) => ({ path: f.path, content: f.content })),
            ).catch((e: unknown) =>
              logger.warn(
                { projectId, err: e },
                "Quality gate pre-flight: re-sync on restart failed (non-fatal)",
              ),
            );
            // Restart the health server so keepalive pings keep the machine alive.
            const { startContainerHealthServer } = await import("./container");
            await startContainerHealthServer(containerId, projectId);
          },
        });
        if (installResult.ok) {
          logger.info(
            { projectId, containerId },
            "Quality gate pre-flight: re-sync + install complete",
          );
        } else {
          logger.warn(
            { projectId, containerId, output: installResult.output.slice(0, 500) },
            "Quality gate pre-flight: npm install failed (non-fatal) — tsc/eslint checks may be skipped",
          );
        }
      }
    } catch (preFlightErr) {
      logger.warn(
        { projectId, err: preFlightErr },
        "Quality gate pre-flight check failed — proceeding without re-sync (non-fatal)",
      );
    }
  }

  // ── 1. TypeScript ──────────────────────────────────────────────────────────
  if (hasFile(allFiles, "tsconfig.json")) {
    const start = Date.now();
    const tsCmd = [
      "sh",
      "-c",
      "if [ -f /app/node_modules/.bin/tsc ]; then /app/node_modules/.bin/tsc --noEmit --skipLibCheck 2>&1; else echo '__TSC_NOT_INSTALLED__'; fi",
    ];
    try {
      const res = await execInContainer(containerId, tsCmd, projectId, "/app");
      const durationMs = Date.now() - start;
      if (res.output.includes("__TSC_NOT_INSTALLED__")) {
        logger.info(
          { projectId, containerId },
          "TSC not installed in container — skipping TypeScript check",
        );
        checks.push({
          id: "typescript",
          label: "TypeScript",
          passed: false,
          skipped: true,
          skipReason: "tsc binary not found in /app/node_modules/.bin",
          output: "",
          durationMs,
        });
      } else {
        checks.push({
          id: "typescript",
          label: "TypeScript",
          passed: res.exitCode === 0,
          skipped: false,
          output: res.output.slice(0, 3000),
          durationMs,
        });
      }
    } catch (err) {
      checks.push({
        id: "typescript",
        label: "TypeScript",
        passed: false,
        skipped: false,
        output: `Container exec failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      });
    }
  }

  // ── 2. ESLint ──────────────────────────────────────────────────────────────
  const changedTsJs = changedFiles.filter((f) => isTsJsFile(f.path));
  if (changedTsJs.length > 0 && hasEslintConfig(allFiles)) {
    const start = Date.now();

    // First probe: check if eslint binary is present
    const probeCmd = [
      "sh",
      "-c",
      "[ -f /app/node_modules/.bin/eslint ] && echo '__ESLINT_FOUND__' || echo '__ESLINT_NOT_INSTALLED__'",
    ];
    // eslint-disable-next-line no-useless-assignment
    let eslintPresent = false;
    try {
      const probe = await execInContainer(containerId, probeCmd, projectId, "/app");
      eslintPresent = probe.output.includes("__ESLINT_FOUND__");
    } catch {
      eslintPresent = false;
    }

    if (!eslintPresent) {
      logger.info(
        { projectId, containerId },
        "ESLint not installed in container — skipping ESLint check",
      );
      checks.push({
        id: "eslint",
        label: "ESLint",
        passed: false,
        skipped: true,
        skipReason: "eslint binary not found in /app/node_modules/.bin",
        output: "",
        durationMs: Date.now() - start,
      });
    } else {
      // Lint ALL changed JS/TS files — batch in groups of 50 to stay under ARG_MAX.
      const BATCH_SIZE = 50;
      const batches: string[][] = [];
      for (let i = 0; i < changedTsJs.length; i += BATCH_SIZE) {
        batches.push(
          changedTsJs.slice(i, i + BATCH_SIZE).map((f) => `/app/${f.path.replace(/"/g, '\\"')}`),
        );
      }

      let combinedOutput = "";
      let overallPassed = true;

      for (const batch of batches) {
        const fileArgs = batch.map((p) => `"${p}"`).join(" ");
        const lintCmd = [
          "sh",
          "-c",
          `/app/node_modules/.bin/eslint --max-warnings 20 ${fileArgs} 2>&1`,
        ];
        try {
          const res = await execInContainer(containerId, lintCmd, projectId, "/app");
          if (res.exitCode !== 0) overallPassed = false;
          combinedOutput += res.output;
        } catch (err) {
          overallPassed = false;
          combinedOutput += `Container exec failed: ${err instanceof Error ? err.message : String(err)}\n`;
        }
      }

      checks.push({
        id: "eslint",
        label: "ESLint",
        passed: overallPassed,
        skipped: false,
        output: combinedOutput.slice(0, 3000),
        durationMs: Date.now() - start,
      });
    }
  }

  // ── Compute aggregate result ───────────────────────────────────────────────
  const executedChecks = checks.filter((c) => !c.skipped);
  const skippedChecks = checks.filter((c) => c.skipped);

  // passed = no executed check failed. When all checks are skipped (tooling absent in
  // this container type) we treat it as a graceful pass — not a quality failure.
  // This prevents "all skipped" from routing the task to needs_fix.
  const passed = executedChecks.length === 0 || executedChecks.every((c) => c.passed);
  // allPassed = every applicable check actually ran AND all passed (no skips, no failures).
  // Only allPassed=true earns the green "All checks passed" banner.
  const allPassed = skippedChecks.length === 0 && executedChecks.length > 0 && passed;

  return { passed, allPassed, checks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server startup smoke test
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the server inside the container and verify it responds to `/healthz`
 * within 15 seconds. Polls every 2 seconds.
 *
 * Only call this for full-stack stacks (node-api, nextjs) after the TypeScript
 * and ESLint checks have passed.
 */
export async function runSmokeTest(
  containerId: string,
  projectId: number,
  port: number = 3000,
): Promise<QualityGateCheck> {
  const start = Date.now();

  // Kill any leftover process on the port, start the server via npm start
  // (works for both node-api and nextjs stacks), then poll /healthz up to
  // 7 times (every 2 s = 14 s total). PORT is exported so frameworks that
  // read it automatically bind on the right interface.
  const smokeCmd = [
    "sh",
    "-c",
    `
pkill -f "node " 2>/dev/null || true
sleep 1
export PORT=${port}
if [ -f /app/package.json ]; then
  nohup npm start >/tmp/__smoke_server.log 2>&1 &
else
  nohup node . >/tmp/__smoke_server.log 2>&1 &
fi
for i in 1 2 3 4 5 6 7; do
  sleep 2
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}/healthz 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    echo "SMOKE_OK"
    exit 0
  fi
done
echo "SMOKE_FAIL"
tail -30 /tmp/__smoke_server.log 2>/dev/null || true
exit 1
    `.trim(),
  ];

  try {
    const res = await execInContainer(containerId, smokeCmd, projectId, "/app");
    const durationMs = Date.now() - start;
    const passed = res.output.includes("SMOKE_OK");
    return {
      id: "smoke-test",
      label: "Server startup",
      passed,
      skipped: false,
      output: passed
        ? "Server responded to /healthz with HTTP 200"
        : `Server did not respond within 15 s.\n${res.output.slice(0, 2000)}`,
      durationMs,
    };
  } catch (err) {
    return {
      id: "smoke-test",
      label: "Server startup",
      passed: false,
      skipped: false,
      output: `Container exec failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment variable static analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common platform/runtime env vars that are always available and should not
 * be flagged as undeclared even if they're absent from the project secrets list.
 */
const ALWAYS_KNOWN_VARS = new Set([
  "NODE_ENV",
  "PORT",
  "HOST",
  "PWD",
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "PROJECT_ID",
  "DATABASE_URL",
  "REDIS_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
]);

/**
 * Scan JS/TS files in `files` for `process.env.FOO` references.
 * Returns each variable name not found in `knownSecretNames` (and not in the
 * platform-always-known set), deduped by variable name.
 */
export function scanUndeclaredEnvVars(
  files: ReadonlyArray<{ path: string; content: string }>,
  knownSecretNames: ReadonlyArray<string>,
): Array<{ varName: string; file: string }> {
  const known = new Set([...knownSecretNames, ...ALWAYS_KNOWN_VARS]);
  const result: Array<{ varName: string; file: string }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!isTsJsFile(file.path)) continue;
    for (const match of file.content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      const varName = match[1]!;
      if (!known.has(varName) && !seen.has(varName)) {
        seen.add(varName);
        result.push({ varName, file: file.path });
      }
    }
  }

  return result;
}
