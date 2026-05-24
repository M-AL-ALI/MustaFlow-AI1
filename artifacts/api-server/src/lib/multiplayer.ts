/**
 * Task #540 — Multiplayer collaboration WebSocket bridge.
 *
 * Endpoint: WS /api/projects/:id/multiplayer
 *
 * Two transport modes are multiplexed on the same connection:
 *   1. Binary frames → Yjs y-protocols (sync + awareness) for CRDT-based
 *      conflict-free document collaboration. Per-project Y.Doc lives in
 *      memory; awareness keeps cursor/selection state. This is the
 *      "real" multiplayer path used by a Y.Text-bound editor (e.g.
 *      Monaco / CodeMirror via y-monaco / y-codemirror).
 *   2. Text JSON frames → lightweight presence broadcast for clients
 *      that don't speak Yjs yet (cursor pings, active-tab updates,
 *      typing intents). Kept for parity with the previous v0 client.
 *
 * Ownership: the project must have `multiplayerEnabled=true`, the
 *   socket must be authenticated (Clerk session cookie), and the user
 *   must be the project owner. (A collaborator ACL model is a future
 *   milestone — see followup #595.)
 */
import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { db, projectsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { logger } from "./logger";

// y-protocols message tags (from y-websocket reference impl).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Peer {
  id: string;
  name: string;
  ws: WebSocket;
  /**
   * Awareness clientIDs that originated from this connection. We track
   * them so disconnect cleanup can remove the *peer's* awareness state,
   * not the server doc's clientID (which would leave ghost cursors).
   */
  controlledIds: Set<number>;
}

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  peers: Set<Peer>;
}

const rooms = new Map<number, Room>();

function roomFor(projectId: number): Room {
  let room = rooms.get(projectId);
  if (!room) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    room = { doc, awareness, peers: new Set() };
    rooms.set(projectId, room);
  }
  return room;
}

function sendBinary(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }
}

function broadcastBinary(room: Room, except: Peer, data: Uint8Array): void {
  for (const peer of room.peers) {
    if (peer === except) continue;
    sendBinary(peer.ws, data);
  }
}

function broadcastJson(room: Room, except: Peer, payload: unknown): void {
  for (const peer of room.peers) {
    if (peer === except) continue;
    sendJson(peer.ws, payload);
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
      sendJson(ws, { type: "error", message: "Unauthorized" });
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
      sendJson(ws, { type: "error", message: "Project not found" });
      ws.close(4004, "Project not found");
      return;
    }
    if (!project.multiplayerEnabled) {
      sendJson(ws, { type: "error", message: "Multiplayer disabled for this project" });
      ws.close(4001, "Multiplayer disabled");
      return;
    }
    if (project.ownerId !== userId) {
      sendJson(ws, { type: "error", message: "Forbidden" });
      ws.close(4003, "Forbidden");
      return;
    }

    const sp = new URL(`http://x${url}`).searchParams;
    const peer: Peer = {
      id: userId,
      name: sp.get("name") ?? userId.slice(0, 8),
      ws,
      controlledIds: new Set<number>(),
    };
    const room = roomFor(projectId);
    room.peers.add(peer);

    // ── Yjs sync handshake ──────────────────────────────────────────────────
    // 1) Send sync step1 (our state vector) so the client can compute the
    //    update we're missing.
    {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, room.doc);
      sendBinary(ws, encoding.toUint8Array(enc));
    }
    // 2) Send current awareness state of all peers to the new peer.
    {
      const states = room.awareness.getStates();
      if (states.size > 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())),
        );
        sendBinary(ws, encoding.toUint8Array(enc));
      }
    }

    // Lightweight JSON greeting for non-Yjs clients (cursor-only mode).
    sendJson(ws, { type: "hello", you: { id: peer.id, name: peer.name } });
    const roster = Array.from(room.peers).map((p) => ({ id: p.id, name: p.name }));
    sendJson(ws, { type: "roster", peers: roster });
    broadcastJson(room, peer, { type: "join", id: peer.id, name: peer.name });

    // Fan-out any local Y.Doc updates to every other peer.
    const docUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === peer) return; // already broadcast below
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      sendBinary(ws, encoding.toUint8Array(enc));
    };
    room.doc.on("update", docUpdateHandler);

    const awarenessChangeHandler = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      // Track which awareness clientIDs originated from this connection
      // (matches the y-websocket reference impl). On disconnect we remove
      // exactly these IDs so ghost cursors don't linger.
      if (origin === peer) {
        for (const id of added) peer.controlledIds.add(id);
        for (const id of removed) peer.controlledIds.delete(id);
        return;
      }
      const changed = added.concat(updated).concat(removed);
      if (changed.length === 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed),
      );
      sendBinary(ws, encoding.toUint8Array(enc));
    };
    room.awareness.on("change", awarenessChangeHandler);

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary?: boolean) => {
      // Binary frames → Yjs protocol.
      const binary = isBinary ?? (raw instanceof Buffer && raw.length > 0 && raw[0]! < 16);
      if (binary && Buffer.isBuffer(raw)) {
        try {
          const dec = decoding.createDecoder(new Uint8Array(raw));
          const messageType = decoding.readVarUint(dec);
          const enc = encoding.createEncoder();
          if (messageType === MESSAGE_SYNC) {
            encoding.writeVarUint(enc, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(dec, enc, room.doc, peer);
            if (encoding.length(enc) > 1) {
              sendBinary(ws, encoding.toUint8Array(enc));
            }
            // Re-broadcast the original update (other peers will receive it
            // via docUpdateHandler since this triggered a doc.update).
          } else if (messageType === MESSAGE_AWARENESS) {
            awarenessProtocol.applyAwarenessUpdate(
              room.awareness,
              decoding.readVarUint8Array(dec),
              peer,
            );
          }
        } catch (err) {
          logger.warn({ err, projectId }, "multiplayer: failed to handle binary frame");
        }
        return;
      }

      // Text frames → lightweight JSON presence.
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "ping") {
        sendJson(ws, { type: "pong" });
        return;
      }
      if (msg.type === "presence" || msg.type === "edit") {
        broadcastJson(room, peer, {
          type: "peer",
          subtype: msg.type,
          id: peer.id,
          name: peer.name,
          ...msg,
        });
      }
    });

    const cleanup = () => {
      room.doc.off("update", docUpdateHandler);
      room.awareness.off("change", awarenessChangeHandler);
      if (peer.controlledIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(
          room.awareness,
          Array.from(peer.controlledIds),
          peer,
        );
        peer.controlledIds.clear();
      }
      room.peers.delete(peer);
      if (room.peers.size === 0) {
        room.doc.destroy();
        rooms.delete(projectId);
      } else {
        broadcastJson(room, peer, { type: "leave", id: peer.id });
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
