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
 * Access and identity: the socket must be authenticated, the caller must have
 *   live project access or a live user-approved support grant, and the person's
 *   shared account profile must provide both a display name and picture. The
 *   same mechanism renders teammates and staff; CRDT frames remain disabled
 *   when the project's multiplayer switch is off.
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
import { checkProjectAccess } from "./auth";
import { getSharedAccountProfile } from "./clerk-users";
import { findLiveSupportGrant } from "./support-access";
import { formatSupportTicketNumber } from "./support-ticket-workflow";

// y-protocols message tags (from y-websocket reference impl).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Peer {
  id: string;
  userId: string;
  name: string;
  imageUrl: string;
  kind: "owner" | "teammate" | "staff";
  location: string;
  grantId: number | null;
  grantExpiresAt: string | null;
  multiplayerEnabled: boolean;
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

const PRESENCE_LOCATIONS = new Set([
  "Project workspace",
  "Canvas",
  "Code",
  "Preview",
  "Checks",
  "History",
  "Settings",
  "Support session",
]);

export function parsePresenceLocation(value: unknown): string {
  if (typeof value !== "string") return "Project workspace";
  if (PRESENCE_LOCATIONS.has(value)) return value;
  // Staff support sessions name only the bounded ticket number; arbitrary
  // client text never becomes another user's presence label.
  return /^Support ticket NF-\d{6,}$/u.test(value) ? value : "Project workspace";
}

function publicPeer(peer: Peer) {
  return {
    id: peer.id,
    name: peer.name,
    imageUrl: peer.imageUrl,
    kind: peer.kind,
    location: peer.location,
    grantId: peer.grantId,
    grantExpiresAt: peer.grantExpiresAt,
  };
}

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

function _broadcastBinary(room: Room, except: Peer, data: Uint8Array): void {
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

    // eslint-disable-next-line no-useless-assignment
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
    const [access, supportGrant, identity] = await Promise.all([
      checkProjectAccess(userId, projectId, "viewer"),
      findLiveSupportGrant({ projectId, staffUserId: userId }),
      getSharedAccountProfile(userId),
    ]);
    if (access !== "granted" && !supportGrant) {
      sendJson(ws, { type: "error", message: "Forbidden" });
      ws.close(4003, "Forbidden");
      return;
    }
    if (!identity?.displayName || !identity.imageUrl) {
      sendJson(ws, {
        type: "error",
        code: "presence_identity_required",
        message: "Add your name and picture before joining this project.",
      });
      ws.close(4409, "Identity required");
      return;
    }

    const sp = new URL(`http://x${url}`).searchParams;
    const peer: Peer = {
      id: `${userId}:${crypto.randomUUID()}`,
      userId,
      name: identity.displayName,
      imageUrl: identity.imageUrl,
      kind: supportGrant ? "staff" : project.ownerId === userId ? "owner" : "teammate",
      location: supportGrant
        ? `Support ticket ${formatSupportTicketNumber(supportGrant.ticketId)}`
        : parsePresenceLocation(sp.get("location")),
      grantId: supportGrant?.id ?? null,
      grantExpiresAt: supportGrant?.expiresAt?.toISOString() ?? null,
      multiplayerEnabled: project.multiplayerEnabled,
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
    sendJson(ws, { type: "hello", you: publicPeer(peer) });
    const roster = Array.from(room.peers).map(publicPeer);
    sendJson(ws, { type: "roster", peers: roster });
    broadcastJson(room, peer, { type: "join", peer: publicPeer(peer) });

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

    let lastSeenAt = Date.now();
    ws.on("pong", () => {
      lastSeenAt = Date.now();
    });
    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary?: boolean) => {
      lastSeenAt = Date.now();
      // Binary frames → Yjs protocol.
      const binary = isBinary ?? (raw instanceof Buffer && raw.length > 0 && raw[0]! < 16);
      if (binary && Buffer.isBuffer(raw)) {
        if (peer.kind === "staff") {
          sendJson(ws, {
            type: "error",
            code: "support_presence_read_only",
            message: "Support can inspect this project, but cannot edit without your approval.",
          });
          return;
        }
        if (!peer.multiplayerEnabled) {
          sendJson(ws, {
            type: "error",
            code: "multiplayer_editing_disabled",
            message: "Live editing is turned off for this project.",
          });
          return;
        }
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
      if (msg.type === "presence") {
        if (peer.kind !== "staff") peer.location = parsePresenceLocation(msg.location);
        broadcastJson(room, peer, {
          type: "peer",
          subtype: "presence",
          peer: publicPeer(peer),
        });
        return;
      }
      if (msg.type === "edit" && peer.kind === "staff") {
        sendJson(ws, {
          type: "error",
          code: "support_presence_read_only",
          message: "Support can inspect this project, but cannot edit without your approval.",
        });
        return;
      }
      if (msg.type === "edit" && peer.multiplayerEnabled) {
        broadcastJson(room, peer, { type: "peer", subtype: "edit", peer: publicPeer(peer) });
      }
    });

    const grantWatch =
      peer.kind === "staff"
        ? setInterval(() => {
            void findLiveSupportGrant({ projectId, staffUserId: peer.userId })
              .then((current) => {
                if (!current || current.id !== peer.grantId) {
                  sendJson(ws, {
                    type: "grant_closed",
                    message: "The user's support access has ended.",
                  });
                  ws.close(4403, "Support access ended");
                }
              })
              .catch(() => ws.close(4413, "Support access could not be verified"));
          }, 2_000)
        : null;
    grantWatch?.unref?.();
    const collaboratorWatch =
      peer.kind !== "staff"
        ? setInterval(() => {
            void checkProjectAccess(peer.userId, projectId, "viewer")
              .then((decision) => {
                if (decision !== "granted") {
                  sendJson(ws, {
                    type: "access_removed",
                    message: "Your access to this project has ended.",
                  });
                  ws.close(4403, "Project access ended");
                }
              })
              .catch(() => ws.close(4413, "Project access could not be verified"));
          }, 2_000)
        : null;
    collaboratorWatch?.unref?.();
    const livenessWatch = setInterval(() => {
      if (Date.now() - lastSeenAt > 12_000) {
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 4_000);
    livenessWatch.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (grantWatch) clearInterval(grantWatch);
      if (collaboratorWatch) clearInterval(collaboratorWatch);
      clearInterval(livenessWatch);
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
