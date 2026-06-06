/**
 * Support alerts WebSocket bridge — pushes new support-ticket notifications to
 * connected admins in real time so staff can respond faster than the existing
 * 60s polling.
 *
 * Path: /api/admin/support-alerts
 *
 * Protocol (server → client, JSON text frames):
 *   { "type": "connected" }
 *   { "type": "new-ticket", "ticket": { id, subject, category, plan, createdAt } }
 *
 * Auth: the Clerk session is read from the upgrade request cookie and the user
 * must pass the same admin RBAC check (`isAdminUser`) used by the HTTP routes.
 * Non-admins (or anonymous callers) are rejected at the handshake.
 *
 * This channel is purely additive: if the WebSocket cannot be established the
 * frontend keeps using its existing 60s polling, so alerts degrade gracefully.
 */

import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { getAuth } from "@clerk/express";
import { isAdminUser } from "./adminAuth";
import { logger } from "./logger";

export interface NewTicketAlert {
  id: number;
  subject: string;
  category: string;
  plan: string | null;
  createdAt: string;
}

export interface SupportAlertsServer {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void;
}

// Connected admin sockets. A single admin may have multiple tabs open.
const clients = new Set<WebSocket>();

/**
 * Broadcast a "new ticket" alert to every connected admin. Best-effort and
 * exception-safe: a failed send to one socket never blocks the others and never
 * throws into the caller (ticket creation must not fail because of alerting).
 */
export function broadcastNewTicket(ticket: NewTicketAlert): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: "new-ticket", ticket });
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(payload);
    } catch (err) {
      logger.warn({ component: "support-alerts", err }, "Failed to push ticket alert");
    }
  }
}

/**
 * Create the WebSocket server for admin support alerts.
 * Mount with: server.on("upgrade", supportAlertsServer.handleUpgrade)
 */
export function createSupportAlertsServer(): SupportAlertsServer {
  const wss = new WebSocketServer({ noServer: true });

  // Heartbeat — terminate sockets that stop responding to pings so dead
  // connections do not accumulate in the `clients` set.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      const tagged = ws as WebSocket & { isAlive?: boolean };
      if (tagged.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        clients.delete(ws);
        continue;
      }
      tagged.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  wss.on("connection", (ws: WebSocket) => {
    const tagged = ws as WebSocket & { isAlive?: boolean };
    tagged.isAlive = true;
    clients.add(ws);

    ws.on("pong", () => {
      tagged.isAlive = true;
    });
    ws.on("close", () => {
      clients.delete(ws);
    });
    ws.on("error", () => {
      clients.delete(ws);
    });

    try {
      ws.send(JSON.stringify({ type: "connected" }));
    } catch {
      /* ignore */
    }
  });

  const handleUpgrade = (
    req: IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void => {
    // Resume the socket immediately so the HTTP server does not reclaim it while
    // the async admin check is in flight (see ws-upgrade-socket-resume memory).
    socket.resume();

    let userId: string | null;
    try {
      const auth = getAuth(req as unknown as Parameters<typeof getAuth>[0]);
      userId = auth?.userId ?? null;
    } catch {
      userId = null;
    }

    if (!userId) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }

    void isAdminUser(userId)
      .then((admin) => {
        if (!admin) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          wss.emit("connection", ws, req);
        });
      })
      .catch((err: unknown) => {
        logger.warn({ component: "support-alerts", err }, "Support alerts upgrade check failed");
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
  };

  return { wss, handleUpgrade };
}
