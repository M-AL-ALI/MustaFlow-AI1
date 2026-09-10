/**
 * Task #540 — Minimal multiplayer presence client.
 *
 * Opens a WebSocket to `/api/projects/:id/multiplayer` (handled by the
 * Yjs + JSON-presence bridge in `artifacts/api-server/src/lib/multiplayer.ts`)
 * and exposes the current peer roster + connection status. The same socket
 * carries Yjs binary frames; a Y.Doc-bound editor (Monaco/CodeMirror via
 * y-monaco/y-codemirror) can attach to it later by sharing this hook's
 * `socket` ref. For now this enables the "you're collaborating live" UX
 * piece end-to-end without requiring a CRDT-bound editor.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface PresencePeer {
  id: string;
  name: string;
  imageUrl: string;
  kind: "owner" | "teammate" | "staff";
  location: string;
  grantId: number | null;
  grantExpiresAt: string | null;
}

export interface MultiplayerPresenceState {
  enabled: boolean;
  status: "idle" | "connecting" | "open" | "closed";
  peers: PresencePeer[];
  self: PresencePeer | null;
  message: string | null;
  /** Explicit recovery after credentials or project access have changed. */
  reconnect?: () => void;
}

export const MULTIPLAYER_MAX_RECONNECT_ATTEMPTS = 5;
const PERMANENT_CLOSE_CODES = new Set([4401, 4403, 4003, 4409]);

function isPermanentPresenceDenial(msg: { type?: string; [key: string]: unknown }): boolean {
  return (
    msg.type === "grant_closed" ||
    msg.type === "access_removed" ||
    (msg.type === "error" &&
      (msg.message === "Unauthorized" ||
        msg.message === "Forbidden" ||
        msg.code === "unauthenticated" ||
        msg.code === "forbidden" ||
        msg.code === "presence_identity_required"))
  );
}

export function useMultiplayerPresence(
  projectId: number,
  enabled: boolean,
  location = "Project workspace",
): MultiplayerPresenceState {
  const [status, setStatus] = useState<MultiplayerPresenceState["status"]>("idle");
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const [self, setSelf] = useState<PresencePeer | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const reconnect = useCallback(() => setReconnectGeneration((value) => value + 1), []);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setPeers([]);
    setSelf(null);
    setMessage(null);
    if (!enabled || !projectId || typeof window === "undefined") {
      setStatus("idle");
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = `?location=${encodeURIComponent(location)}`;
    const url = `${proto}//${window.location.host}/api/projects/${projectId}/multiplayer${qs}`;
    let cancelled = false;
    let permanentDenial = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let pingTimer: number | null = null;
    const isCurrent = (ws: WebSocket) => !cancelled && wsRef.current === ws;
    const clearPing = () => {
      if (pingTimer !== null) window.clearInterval(pingTimer);
      pingTimer = null;
    };
    const clearReconnect = () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const scheduleReconnect = () => {
      if (cancelled || permanentDenial || reconnectTimer !== null) return;
      reconnectAttempt += 1;
      if (reconnectAttempt > MULTIPLAYER_MAX_RECONNECT_ATTEMPTS) {
        setMessage((current) => current ?? "Connection interrupted. Reconnect to try again.");
        return;
      }
      const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled || permanentDenial) return;
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("closed");
        scheduleReconnect();
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        if (!isCurrent(ws)) return;
        // A transport opening is not proof of authentication or project access.
        ws.send(JSON.stringify({ type: "presence", location }));
      };
      ws.onclose = (event) => {
        if (!isCurrent(ws)) return;
        wsRef.current = null;
        clearPing();
        setStatus("closed");
        setPeers([]);
        setSelf(null);
        if (PERMANENT_CLOSE_CODES.has(event.code)) {
          permanentDenial = true;
          setMessage(
            (current) =>
              current ??
              (event.code === 4401
                ? "Unauthorized"
                : event.code === 4003
                  ? "Forbidden"
                  : event.code === 4409
                    ? "Add your name and picture before joining this project."
                    : "Your access to this project has ended."),
          );
        }
        if (permanentDenial) {
          clearReconnect();
          return;
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        if (!isCurrent(ws)) return;
        // Browsers hide HTTP upgrade failures. Do not invent an auth denial from this event.
        setStatus("closed");
      };
      ws.onmessage = (ev) => {
        if (!isCurrent(ws) || permanentDenial || typeof ev.data !== "string") return;
        let msg: { type?: string; [key: string]: unknown };
        try {
          msg = JSON.parse(ev.data) as typeof msg;
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
        if (msg.type === "error" || msg.type === "grant_closed" || msg.type === "access_removed") {
          setMessage(typeof msg.message === "string" ? msg.message : "Presence is unavailable.");
          if (isPermanentPresenceDenial(msg)) {
            permanentDenial = true;
            clearReconnect();
            clearPing();
            setStatus("closed");
            setPeers([]);
            setSelf(null);
            try {
              ws.close();
            } catch {
              /* already closed */
            }
          }
          return;
        }
        if (msg.type === "hello") {
          const you = msg.you as PresencePeer | undefined;
          if (!you || typeof you.id !== "string") return;
          setSelf(you);
          setStatus("open");
          setMessage(null);
          // Only the server's authenticated greeting resets the failure budget.
          reconnectAttempt = 0;
          clearPing();
          pingTimer = window.setInterval(() => {
            if (isCurrent(ws) && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: "ping" }));
              } catch {
                /* transport closing */
              }
            }
          }, 4_000);
          return;
        }
        if (msg.type === "roster") {
          setPeers((msg.peers as PresencePeer[] | undefined) ?? []);
          return;
        }
        if (msg.type === "join") {
          const peer = msg.peer as PresencePeer | undefined;
          if (!peer) return;
          setPeers((current) =>
            current.some((item) => item.id === peer.id) ? current : [...current, peer],
          );
          return;
        }
        if (msg.type === "peer") {
          const peer = msg.peer as PresencePeer | undefined;
          if (!peer) return;
          setPeers((current) => [...current.filter((item) => item.id !== peer.id), peer]);
          return;
        }
        if (msg.type === "leave") {
          setPeers((current) => current.filter((peer) => peer.id !== msg.id));
        }
      };
    };
    const recoverNetwork = () => {
      if (cancelled || permanentDenial) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.CONNECTING ||
          wsRef.current.readyState === WebSocket.OPEN)
      )
        return;
      // Online may expedite a reserved retry, but must not create a fresh budget.
      if (reconnectTimer === null || reconnectAttempt > MULTIPLAYER_MAX_RECONNECT_ATTEMPTS) return;
      clearReconnect();
      connect();
    };
    window.addEventListener("online", recoverNetwork);
    connect();
    return () => {
      cancelled = true;
      window.removeEventListener("online", recoverNetwork);
      clearReconnect();
      clearPing();
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
  }, [projectId, enabled, location, reconnectGeneration]);

  return { enabled, status, peers, self, message, reconnect };
}
