import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import app from "./app";
import { logger } from "./lib/logger";
import { createTerminalServer } from "./lib/terminal";
import { ensureFlyApp } from "./lib/container";
import { warmSemgrepRuleCache } from "./lib/checks/semgrep";
import { startCveScheduler } from "./lib/cve-scheduler";
import { failStuckBackgroundTasksOnBoot } from "./lib/jobs";

const execFileAsync = promisify(execFile);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Verify semgrep is available and pre-warm the rule pack cache so the first
// real scan doesn't pay the network round-trip cost.
void execFileAsync("semgrep", ["--version"], { timeout: 5000 })
  .then(({ stdout }) => {
    logger.info({ version: stdout.trim().split("\n")[0] }, "semgrep available for SAST scanning");
    void warmSemgrepRuleCache();
  })
  .catch(() => {
    logger.warn(
      "semgrep not found in PATH — semgrep-sast check will be skipped. Install semgrep to enable AST-aware security scanning.",
    );
  });

// Ensure the Fly.io app exists for container infrastructure (best-effort)
void ensureFlyApp();

// Start the daily CVE audit scheduler (fires 30 s after startup, then every 24 h)
startCveScheduler();

// Task #509: Mark any background tasks that were mid-flight when the process died
// as failed and refund their reserved credits. Best-effort — non-fatal on errors.
void failStuckBackgroundTasksOnBoot();

// Create an HTTP server so we can attach WebSocket upgrade handlers alongside Express.
const server = createServer(app);

// Attach the terminal WebSocket server (handles /api/projects/:id/terminal upgrades)
const terminalServer = createTerminalServer();
server.on("upgrade", terminalServer.handleUpgrade);

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
