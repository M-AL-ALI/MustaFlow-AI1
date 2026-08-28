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
import { useEffect, useRef, useState } from "react";

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
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled || !projectId || typeof window === "undefined") {
      setStatus("idle");
      setPeers([]);
      setSelf(null);
      setMessage(null);
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = `?location=${encodeURIComponent(location)}`;
    const url = `${proto}//${window.location.host}/api/projects/${projectId}/multiplayer${qs}`;
    let cancelled = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let pingTimer: number | null = null;

    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("closed");
        reconnectTimer = window.setTimeout(connect, 1_000);
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectAttempt = 0;
        setStatus("open");
        setMessage(null);
        ws.send(JSON.stringify({ type: "presence", location }));
      };
      ws.onclose = () => {
        if (cancelled) return;
        setStatus("closed");
        setPeers([]);
        setSelf(null);
        reconnectAttempt += 1;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
        reconnectTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        if (cancelled) return;
        setStatus("closed");
      };
      ws.onmessage = (ev) => {
        // Ignore Yjs binary frames here — a Y.Doc-bound editor consumes those.
        if (typeof ev.data !== "string") return;
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data) as typeof msg;
        } catch {
          return;
        }
        if (!msg.type) return;
        if (msg.type === "error" || msg.type === "grant_closed" || msg.type === "access_removed") {
          setMessage(typeof msg.message === "string" ? msg.message : "Presence is unavailable.");
          if (msg.type === "access_removed") {
            setPeers([]);
            setSelf(null);
          }
          return;
        }
        if (msg.type === "hello") {
          const you = msg.you as PresencePeer | undefined;
          if (you) setSelf(you);
          return;
        }
        if (msg.type === "roster") {
          setPeers((msg.peers as PresencePeer[] | undefined) ?? []);
          return;
        }
        if (msg.type === "join") {
          const p = msg.peer as PresencePeer | undefined;
          if (!p) return;
          setPeers((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
          return;
        }
        if (msg.type === "peer") {
          const p = msg.peer as PresencePeer | undefined;
          if (!p) return;
          setPeers((prev) => [...prev.filter((x) => x.id !== p.id), p]);
          return;
        }
        if (msg.type === "leave") {
          setPeers((prev) => prev.filter((x) => x.id !== msg.id));
          return;
        }
      };

      if (pingTimer !== null) window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* ignore */
          }
        }
      }, 4_000);
    };
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [projectId, enabled, location]);

  return { enabled, status, peers, self, message };
}
