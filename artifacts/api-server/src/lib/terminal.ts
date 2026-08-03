/**
 * Terminal WebSocket bridge — connects a browser xterm.js session to a
 * Fly.io machine's shell via the Fly exec API (streaming PTY).
 *
 * Protocol:
 *   Client → Server: UTF-8 text frames (keystrokes)
 *   Server → Client: UTF-8 text frames (terminal output)
 *   Server → Client: JSON frame starting with "\x00" prefix for control messages
 *     e.g. "\x00{\"type\":\"status\",\"status\":\"connecting\"}"
 *
 * The server authenticates the Clerk session before upgrading the connection.
 */

import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { db, projectsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { execInContainer } from "./container";
import { logger } from "./logger";

export interface TerminalServer {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void;
}

function sendControl(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send("\x00" + JSON.stringify(msg));
  }
}

function sendText(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(text);
  }
}

/**
 * Create the WebSocket server for terminal sessions.
 * Mount with: server.on("upgrade", terminalServer.handleUpgrade)
 *
 * Path: /api/projects/:id/terminal
 */
export function createTerminalServer(): TerminalServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    // Extract projectId from URL path
    const url = req.url ?? "";
    const match = url.match(/\/api\/projects\/(\d+)\/terminal/);
    if (!match) {
      ws.close(4000, "Invalid path");
      return;
    }
    const projectId = parseInt(match[1]!, 10);

    // Auth check — Clerk session must be present
    let userId: string | null = null;
    try {
      const auth = getAuth(req as unknown as Parameters<typeof getAuth>[0]);
      userId = auth?.userId ?? null;
    } catch {
      // safety net — getAuth() should not throw, but guard against SDK misconfiguration
    }

    // Require authentication — unauthenticated connections are never allowed,
    // even in development. The catch above is only a safety net for a throwing SDK.
    if (!userId) {
      sendControl(ws, { type: "error", message: "Unauthorized" });
      ws.close(4001, "Unauthorized");
      return;
    }

    sendControl(ws, { type: "status", status: "connecting" });

    // Load project and verify ownership
    const [project] = await db
      .select({
        ownerId: projectsTable.ownerId,
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      sendControl(ws, { type: "error", message: "Project not found" });
      ws.close(4004, "Project not found");
      return;
    }

    if (project.ownerId !== userId) {
      sendControl(ws, { type: "error", message: "Forbidden" });
      ws.close(4003, "Forbidden");
      return;
    }

    if (!project.containerId || project.containerStatus !== "running") {
      sendControl(ws, {
        type: "error",
        message: "Container is not running. Start it from the Preview tab first.",
      });
      ws.close(4002, "Container not running");
      return;
    }

    const machineId = project.containerId;
    sendControl(ws, { type: "status", status: "connected" });
    sendText(ws, "\r\n\x1b[32mConnected to project container\x1b[0m\r\n$ ");

    // Input buffer — accumulate keystrokes into a command line
    let lineBuffer = "";

    ws.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
      const input = data.toString("utf8");

      // Handle special characters
      if (input === "\r" || input === "\n") {
        const cmd = lineBuffer.trim();
        lineBuffer = "";
        sendText(ws, "\r\n");

        if (cmd === "") {
          sendText(ws, "$ ");
          return;
        }

        // Execute via Fly exec API
        sendControl(ws, { type: "status", status: "running", command: cmd });
        try {
          const result = await execInContainer(machineId, ["/bin/sh", "-c", cmd], projectId);
          if (result.output) {
            sendText(ws, result.output.replace(/\n/g, "\r\n"));
          }
          sendText(
            ws,
            result.ok ? "\r\n\x1b[32m[exit 0]\x1b[0m\r\n$ " : "\r\n\x1b[31m[exit 1]\x1b[0m\r\n$ ",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendText(ws, `\r\n\x1b[31mError: ${msg}\x1b[0m\r\n$ `);
        }
      } else if (input === "\x7f" || input === "\b") {
        // Backspace
        if (lineBuffer.length > 0) {
          lineBuffer = lineBuffer.slice(0, -1);
          sendText(ws, "\b \b");
        }
      } else if (input === "\x03") {
        // Ctrl+C
        lineBuffer = "";
        sendText(ws, "^C\r\n$ ");
      } else {
        // Regular character — echo and buffer
        lineBuffer += input;
        sendText(ws, input);
      }
    });

    ws.on("close", () => {
      logger.info({ projectId, machineId }, "Terminal session closed");
    });

    ws.on("error", (err: Error) => {
      logger.warn({ err, projectId }, "Terminal WebSocket error");
    });
  });

  const handleUpgrade = (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = req.url ?? "";
    if (!url.match(/\/api\/projects\/\d+\/terminal/)) return;
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  };

  return { wss, handleUpgrade };
}
