/**
 * Task #540 — Multiplayer presence WebSocket bridge.
 *
 * Endpoint: WS /api/projects/:id/multiplayer
 *
 * Scope (v1): lightweight presence broadcast — cursor positions, active tab,
 *   typing intent, and free-text edit broadcasts. The server fans messages out
 *   to every other socket joined to the same project room. There is no CRDT /
 *   conflict resolution yet — that's a follow-up (Yjs binding to the editor
 *   needs an editor refactor, see followup task).
 *
 * Wire format (JSON text frames):
 *   Client → Server:
 *     { type: "presence", cursor?: {x,y}, tab?: string, file?: string }
 *     { type: "edit",     file: string,   op: "insert" | "delete" | "replace",
 *                          range?: {start: number, end: number}, text?: string }
 *     { type: "ping" }
 *   Server → Client:
 *     { type: "hello",    you: { id, name } }
 *     { type: "roster",   peers: Array<{ id, name }> }
 *     { type: "peer",     id, name, ...payload }   // forwarded peer message
 *     { type: "leave",    id }
 *     { type: "pong" }
 *     { type: "error",    message }
 *
 * Ownership: connecting socket must be the project owner (or a future
 *   collaborator — for v1 only the owner can join).
 */
import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { db, projectsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { logger } from "./logger";

interface Peer {
  id: string;
  name: string;
  ws: WebSocket;
}

const rooms = new Map<number, Set<Peer>>();

function roomFor(projectId: number): Set<Peer> {
  let room = rooms.get(projectId);
  if (!room) {
    room = new Set();
    rooms.set(projectId, room);
  }
  return room;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
}

function broadcast(room: Set<Peer>, except: Peer, payload: unknown): void {
  for (const peer of room) {
    if (peer === except) continue;
    send(peer.ws, payload);
  }
}

export interface MultiplayerServer {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => void;
}

export function createMultiplayerServer(): MultiplayerServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url ?? "";
    const match = url.match(/\/api\/projects\/(\d+)\/multiplayer/);
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
      userId = null;
    }
    if (!userId) {
      send(ws, { type: "error", message: "Unauthorized" });
      ws.close(4401, "Unauthorized");
      return;
    }

    const [project] = await db
      .select({
        ownerId: projectsTable.ownerId,
        multiplayerEnabled: projectsTable.multiplayerEnabled,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      send(ws, { type: "error", message: "Project not found" });
      ws.close(4004, "Project not found");
      return;
    }
    if (!project.multiplayerEnabled) {
      send(ws, { type: "error", message: "Multiplayer disabled for this project" });
      ws.close(4001, "Multiplayer disabled");
      return;
    }
    if (project.ownerId !== userId) {
      send(ws, { type: "error", message: "Forbidden" });
      ws.close(4003, "Forbidden");
      return;
    }

    const sp = new URL(`http://x${url}`).searchParams;
    const peer: Peer = {
      id: userId,
      name: sp.get("name") ?? userId.slice(0, 8),
      ws,
    };
    const room = roomFor(projectId);
    room.add(peer);

    send(ws, { type: "hello", you: { id: peer.id, name: peer.name } });
    const roster = Array.from(room).map((p) => ({ id: p.id, name: p.name }));
    send(ws, { type: "roster", peers: roster });
    broadcast(room, peer, { type: "join", id: peer.id, name: peer.name });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return; // ignore malformed frames
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }
      if (msg.type === "presence" || msg.type === "edit") {
        broadcast(room, peer, {
          type: "peer",
          subtype: msg.type,
          id: peer.id,
          name: peer.name,
          ...msg,
        });
      }
    });

    const cleanup = () => {
      room.delete(peer);
      if (room.size === 0) {
        rooms.delete(projectId);
      } else {
        broadcast(room, peer, { type: "leave", id: peer.id });
      }
    };
    ws.on("close", cleanup);
    ws.on("error", (err: Error) => {
      logger.warn({ err, projectId }, "multiplayer: socket error");
      cleanup();
    });
  });

  const handleUpgrade = (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = req.url ?? "";
    if (!url.match(/\/api\/projects\/\d+\/multiplayer/)) return;
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  };

  return { wss, handleUpgrade };
}
