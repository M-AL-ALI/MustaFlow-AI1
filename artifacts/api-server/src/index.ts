import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { createTerminalServer } from "./lib/terminal";
import { ensureFlyApp } from "./lib/container";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Ensure the Fly.io app exists for container infrastructure (best-effort)
void ensureFlyApp();

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
