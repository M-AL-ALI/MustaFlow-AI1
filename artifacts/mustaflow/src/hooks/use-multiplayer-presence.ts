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
}

export interface MultiplayerPresenceState {
  enabled: boolean;
  status: "idle" | "connecting" | "open" | "closed";
  peers: PresencePeer[];
  self: PresencePeer | null;
}

export function useMultiplayerPresence(
  projectId: number,
  enabled: boolean,
  displayName?: string | null,
): MultiplayerPresenceState {
  const [status, setStatus] = useState<MultiplayerPresenceState["status"]>("idle");
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const [self, setSelf] = useState<PresencePeer | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled || !projectId || typeof window === "undefined") {
      setStatus("idle");
      setPeers([]);
      setSelf(null);
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = displayName ? `?name=${encodeURIComponent(displayName)}` : "";
    const url = `${proto}//${window.location.host}/api/projects/${projectId}/multiplayer${qs}`;
    let cancelled = false;
    setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setStatus("closed");
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) return;
      setStatus("open");
    };
    ws.onclose = () => {
      if (cancelled) return;
      setStatus("closed");
      setPeers([]);
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
        const p = { id: String(msg.id), name: String(msg.name ?? msg.id) };
        setPeers((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
        return;
      }
      if (msg.type === "leave") {
        setPeers((prev) => prev.filter((x) => x.id !== msg.id));
        return;
      }
    };

    const pingTimer = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      }
    }, 25_000);

    return () => {
      cancelled = true;
      window.clearInterval(pingTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [projectId, enabled, displayName]);

  return { enabled, status, peers, self };
}
