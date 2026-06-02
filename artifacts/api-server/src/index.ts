import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import app from "./app";
import { logger } from "./lib/logger";
import { createTerminalServer } from "./lib/terminal";
import { createMultiplayerServer } from "./lib/multiplayer";
import { createDebugServer } from "./routes/debug";
import { ensureFlyApp, runContainerSelfCheck } from "./lib/container";
import { warmSemgrepRuleCache } from "./lib/checks/semgrep";
import { startCveScheduler } from "./lib/cve-scheduler";
import { failStuckBackgroundTasksOnBoot } from "./lib/jobs";
import { resumeStuckProvisioningOnBoot } from "./lib/provisioning";
import { resumeContainerLogTailersOnBoot } from "./lib/container-logs";
import { startContainerLogRetentionScheduler } from "./lib/container-log-retention";
import { handleLivePreviewUpgrade, matchPreviewPath } from "./lib/livePreviewProxy";
import {
  validatePreviewWebSocketUpgrade,
  isPreviewSubdomainHost,
} from "./middlewares/previewSubdomainGateway";
import { runStartupMigrations } from "./lib/startup-migrations";
import { isOraSecretConfigured } from "./lib/public-ai/session";
import { auditImageProviderConfig } from "./lib/image-provider";

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

// Log Ora public-AI session secret status so missing config is visible at boot.
if (isOraSecretConfigured()) {
  logger.info("ORA_SESSION_SECRET loaded — Ora public-AI endpoints active");
} else {
  logger.warn(
    "ORA_SESSION_SECRET is not set — Ora public-AI endpoints will return 503. Set this secret to enable them.",
  );
}

// Log image provider configuration at startup (presence only — no values).
{
  const imgAudit = auditImageProviderConfig();
  if (imgAudit.activeProviderPath === "none") {
    logger.warn(
      imgAudit,
      "image-provider: no image provider configured — Ora image generation disabled. " +
        "Set OPENAI_IMAGE_API_KEY (preferred) or OPENAI_API_KEY to enable it.",
    );
  } else {
    logger.info(imgAudit, `image-provider: configured (path=${imgAudit.activeProviderPath})`);
  }
}

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
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    socket.destroy();
    return;
  }

  // Security: preview subdomain WebSocket upgrades must be validated with the
  // same host/cookie/HMAC/expiry/revocation checks as HTTP requests.
  // Production and public hosts must never accept preview WebSocket upgrades.
  const host = req.headers.host;
  if (isPreviewSubdomainHost(host)) {
    // Resume the socket immediately so the HTTP server does not reclaim it
    // while async session validation (DB queries) is in flight.
    netSocket.resume();
    void validatePreviewWebSocketUpgrade(host, req.headers.cookie)
      .then((result) => {
        if (!result) {
          // Invalid session, expired, revoked, wrong host, or missing cookie.
          logger.warn(
            { host, url: req.url },
            "Preview subdomain WS upgrade rejected — invalid session",
          );
          try {
            netSocket.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        // Valid session — proxy the WebSocket upgrade to the test container.
        // Use TLS-aware request: httpsRequest for https:// targets, httpRequest otherwise.
        const isSecure = result.containerUrl.startsWith("https://");
        const target = new URL(result.containerUrl.replace(/\/$/, "") + (req.url ?? "/"));
        const requestFn = isSecure ? httpsRequest : httpRequest;
        const proxyReq = requestFn({
          hostname: target.hostname,
          port: Number(target.port) || (isSecure ? 443 : 80),
          path: target.pathname + (target.search || ""),
          method: "GET",
          headers: {
            ...req.headers,
            host: target.host,
          },
        });
        proxyReq.on(
          "upgrade",
          (
            proxyRes: import("node:http").IncomingMessage,
            proxySocket: import("node:net").Socket,
            proxyHead: Buffer,
          ) => {
            // Forward the real upstream 101 handshake — including Sec-WebSocket-Accept,
            // Sec-WebSocket-Protocol, Sec-WebSocket-Extensions, etc.
            // Without these the browser rejects the handshake.
            const headerLines: string[] = [];
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              if (k.toLowerCase() === "transfer-encoding") continue;
              const vals = Array.isArray(v) ? v : [v];
              for (const val of vals) {
                headerLines.push(`${k}: ${val}`);
              }
            }
            netSocket.write(
              "HTTP/1.1 101 Switching Protocols\r\n" + headerLines.join("\r\n") + "\r\n\r\n",
            );
            proxySocket.pipe(netSocket);
            netSocket.pipe(proxySocket);
            if (proxyHead.length > 0) proxySocket.unshift(proxyHead);
            proxySocket.on("error", () => {
              try {
                netSocket.destroy();
              } catch {
                /* ignore */
              }
            });
            netSocket.on("error", () => {
              try {
                proxySocket.destroy();
              } catch {
                /* ignore */
              }
            });
          },
        );
        proxyReq.on("error", (err: Error) => {
          logger.warn({ err, host }, "Preview subdomain WS proxy error");
          try {
            netSocket.destroy();
          } catch {
            /* ignore */
          }
        });
        proxyReq.end();
      })
      .catch((err: unknown) => {
        logger.warn({ err, host }, "Preview subdomain WS validation error");
        try {
          netSocket.destroy();
        } catch {
          /* ignore */
        }
      });
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

// Task #859 — Run all outstanding schema migrations before accepting traffic.
// Each step is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so this
// is safe on every boot and is a no-op when the schema is already current.
// Task #1194 — After migrations, run the container subsystem self-check to
// verify Fly.io exec connectivity before the server starts accepting requests.
void runStartupMigrations()
  .catch((err) => {
    // Non-fatal: log and continue — a partial schema is better than no server.
    logger.error({ err }, "startup-migrations: unexpected error (continuing)");
  })
  .then(() =>
    runContainerSelfCheck().catch((err: unknown) => {
      // Non-fatal: log and continue — a degraded container subsystem is better
      // than no server. The health endpoint will reflect the error status.
      logger.warn({ err }, "container subsystem: self-check threw unexpectedly");
    }),
  )
  .finally(() => {
    server.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  });
