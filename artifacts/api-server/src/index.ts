import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import app from "./app";
import { logger } from "./lib/logger";
import { createTerminalServer } from "./lib/terminal";
import { createMultiplayerServer } from "./lib/multiplayer";
import { createDebugServer } from "./routes/debug";
import { ensureFlyApp } from "./lib/container";
import { warmSemgrepRuleCache } from "./lib/checks/semgrep";
import { startCveScheduler } from "./lib/cve-scheduler";
import { failStuckBackgroundTasksOnBoot } from "./lib/jobs";
import { resumeStuckProvisioningOnBoot } from "./lib/provisioning";
import { resumeContainerLogTailersOnBoot } from "./lib/container-logs";
import { startContainerLogRetentionScheduler } from "./lib/container-log-retention";
import { handleLivePreviewUpgrade, matchPreviewPath } from "./lib/livePreviewProxy";

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
// Task #738 — resume any agentic provisioning jobs that were mid-flight when
// the server crashed. The provisioning pipeline is idempotent so this just
// re-runs the steps that didn't get to persist.
void resumeStuckProvisioningOnBoot();
// Task #746 — resume Fly machine log tailers for every agentic project that
// already has a containerId, so the workspace Logs tab gets a live feed
// across server restarts.
void resumeContainerLogTailersOnBoot();
// Task #750 — periodically trim `container_logs` so long-lived agentic
// projects don't grow the table without bound. Caps by age (default 14 days)
// and by per-project row count (default 10k).
startContainerLogRetentionScheduler();

// Create an HTTP server so we can attach WebSocket upgrade handlers alongside Express.
const server = createServer(app);

// Attach the terminal WebSocket server (handles /api/projects/:id/terminal upgrades)
const terminalServer = createTerminalServer();
const multiplayerServer = createMultiplayerServer();
const debugServer = createDebugServer();
const MULTIPLAYER_PATH = /^\/api\/projects\/\d+\/multiplayer$/;
const TERMINAL_PATH = /^\/api\/projects\/\d+\/terminal$/;
const DEBUG_PATH = /^\/api\/projects\/\d+\/debug$/;
server.on("upgrade", (req, socket, head) => {
  const netSocket = socket as unknown as import("node:net").Socket;
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (MULTIPLAYER_PATH.test(pathname)) {
    multiplayerServer.handleUpgrade(req, netSocket, head);
  } else if (TERMINAL_PATH.test(pathname)) {
    terminalServer.handleUpgrade(req, netSocket, head);
  } else if (DEBUG_PATH.test(pathname)) {
    debugServer.handleUpgrade(req, netSocket, head);
  } else {
    // Task #740: forward WebSocket upgrades on /api/projects/:id/preview/...
    // to the project's live container so Vite HMR works inside the iframe.
    const previewMatch = matchPreviewPath(pathname);
    if (previewMatch) {
      void handleLivePreviewUpgrade(previewMatch.projectId, req, netSocket, head).catch(
        (err: unknown) => {
          logger.warn({ err, projectId: previewMatch.projectId }, "Preview WS upgrade failed");
          try {
            netSocket.destroy();
          } catch {
            /* ignore */
          }
        },
      );
      return;
    }
    socket.destroy();
  }
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
