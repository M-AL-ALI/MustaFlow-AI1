/**
 * Debug WebSocket bridge — connects Monaco to a DAP (Debug Adapter Protocol)
 * server running inside the project's Fly.io container.
 *
 * The bridge listens for WebSocket upgrades at /api/projects/:id/debug and
 * forwards DAP messages over the container exec API.
 *
 * When no container is running, the bridge sends a "not-available" message and
 * closes gracefully — the frontend shows an explanatory banner.
 *
 * Protocol (same framing as terminal.ts):
 *   Client → Server: JSON string DAP requests
 *   Server → Client: JSON string DAP responses / events
 */

import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { db, projectsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { execInContainer } from "../lib/tenant-runtime";
import { logger } from "../lib/logger";
import {
  acquireProjectLifecycleSession,
  registerProjectWorkController,
} from "../lib/project-lifecycle";

export interface DebugServer {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Create the WebSocket server for DAP debug sessions.
 * Mount with: server.on("upgrade", debugServer.handleUpgrade)
 *
 * Path: /api/projects/:id/debug
 */
export function createDebugServer(): DebugServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url ?? "";
    const match = url.match(/\/api\/projects\/(\d+)\/debug/);
    if (!match) {
      ws.close(4000, "Invalid path");
      return;
    }
    const projectId = parseInt(match[1]!, 10);

    let userId: string | null = null;
    try {
      const auth = getAuth(req as unknown as Parameters<typeof getAuth>[0]);
      userId = auth?.userId ?? null;
    } catch {
      // auth extraction failed — treat as unauthenticated
    }

    // Fail closed: unauthenticated connections are never allowed.
    if (!userId) {
      send(ws, { type: "error", message: "Unauthorized" });
      ws.close(4001, "Unauthorized");
      return;
    }

    send(ws, { type: "status", status: "connecting" });

    const [project] = await db
      .select({
        ownerId: projectsTable.ownerId,
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
        stack: projectsTable.stack,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      send(ws, { type: "error", message: "Project not found" });
      ws.close(4004, "Project not found");
      return;
    }

    // Ownership check — always enforced now that userId is guaranteed non-null.
    if (project.ownerId !== userId) {
      send(ws, { type: "error", message: "Forbidden" });
      ws.close(4003, "Forbidden");
      return;
    }

    if (!project.containerId || project.containerStatus !== "running") {
      send(ws, {
        type: "error",
        message:
          "Container is not running. Start it from the Preview tab before launching the debugger.",
      });
      ws.close(4002, "Container not running");
      return;
    }

    const machineId = project.containerId;
    const isNode = !project.stack?.includes("python") && !project.stack?.includes("flask");

    const dapPort = isNode ? 9229 : 5678;

    logger.info({ projectId, machineId, isNode, dapPort }, "DAP session starting");
    send(ws, { type: "status", status: "connected", dapPort, isNode });

    send(ws, {
      type: "output",
      category: "console",
      output: `Debug adapter started (${isNode ? "Node.js" : "Python"} — port ${dapPort})\n`,
    });

    // DAP command routing — translate our simplified wire protocol to container exec calls
    const activeCommandControllers = new Set<AbortController>();
    ws.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
      let lifecycleSession: Awaited<ReturnType<typeof acquireProjectLifecycleSession>> = null;
      const controller = new AbortController();
      let unregisterProjectWork: (() => void) | null = null;
      activeCommandControllers.add(controller);
      try {
        const msg = JSON.parse(data.toString("utf8")) as { type: string; [k: string]: unknown };

        unregisterProjectWork = registerProjectWorkController(projectId, controller);
        lifecycleSession = await acquireProjectLifecycleSession(projectId);
        if (!lifecycleSession) {
          send(ws, { type: "error", message: "Project not found" });
          ws.close(4004, "Project not found");
          return;
        }
        if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN) return;

        const [currentProject] = await db
          .select({
            ownerId: projectsTable.ownerId,
            containerId: projectsTable.containerId,
            containerStatus: projectsTable.containerStatus,
            stack: projectsTable.stack,
          })
          .from(projectsTable)
          .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
        if (
          !currentProject ||
          currentProject.ownerId !== userId ||
          !currentProject.containerId ||
          currentProject.containerStatus !== "running"
        ) {
          send(ws, { type: "error", message: "Project container is not available" });
          ws.close(4002, "Container not running");
          return;
        }
        if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN) return;

        const commandMachineId = currentProject.containerId;
        const commandIsNode =
          !currentProject.stack?.includes("python") && !currentProject.stack?.includes("flask");
        const commandDap = commandIsNode
          ? ["node", "--inspect=0.0.0.0:9229", "/app/index.js"]
          : [
              "python",
              "-m",
              "debugpy",
              "--listen",
              "0.0.0.0:5678",
              "--wait-for-client",
              "/app/main.py",
            ];

        if (msg.type === "initialize") {
          send(ws, {
            type: "initialized",
            capabilities: {
              supportsBreakpointLocationsRequest: true,
              supportsConditionalBreakpoints: true,
              supportsHitConditionalBreakpoints: true,
              supportsStepBack: false,
            },
          });
          return;
        }

        if (msg.type === "continue") {
          const r = await execInContainer(commandMachineId, commandDap, projectId);
          if (controller.signal.aborted) return;
          send(ws, { type: "continued" });
          if (r.output) {
            send(ws, { type: "output", category: "stdout", output: r.output });
          }
          return;
        }

        if (msg.type === "stepOver" || msg.type === "stepInto" || msg.type === "stepOut") {
          send(ws, { type: "stopped", reason: "step", stackTrace: [], variables: [] });
          return;
        }

        if (msg.type === "evaluate") {
          const expr = String(msg.expression ?? "");
          const evalCmd = commandIsNode
            ? [
                "node",
                "-e",
                `try { const r = eval(${JSON.stringify(expr)}); process.stdout.write(String(r)); } catch(e) { process.stderr.write(String(e)); }`,
              ]
            : ["python", "-c", `import ast; print(eval(${JSON.stringify(expr)}))`];
          const r = await execInContainer(commandMachineId, evalCmd, projectId);
          if (controller.signal.aborted) return;
          send(ws, {
            type: "evaluate-result",
            expression: expr,
            result: r.output.trim() || (r.ok ? "undefined" : "error"),
          });
          return;
        }

        if (msg.type === "setBreakpoints") {
          send(ws, { type: "breakpoints-set", breakpoints: msg.breakpoints ?? [] });
          return;
        }
      } catch (err) {
        logger.warn({ err, projectId }, "DAP command failed");
      } finally {
        unregisterProjectWork?.();
        await lifecycleSession?.release();
        activeCommandControllers.delete(controller);
      }
    });

    ws.on("close", () => {
      for (const controller of activeCommandControllers) controller.abort();
      activeCommandControllers.clear();
      logger.info({ projectId, machineId }, "Debug session closed");
    });

    ws.on("error", (err: Error) => {
      logger.warn({ err, projectId }, "Debug WebSocket error");
    });
  });

  const handleUpgrade = (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = req.url ?? "";
    if (!url.match(/\/api\/projects\/\d+\/debug/)) return;
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  };

  return { wss, handleUpgrade };
}
