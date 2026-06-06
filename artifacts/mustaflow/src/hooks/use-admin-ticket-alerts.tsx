import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { getListAdminSupportTicketsQueryKey } from "@workspace/api-client-react";

// ── Opt-out preference ────────────────────────────────────────────────────────
// Real-time alerts are ON by default. Admins who don't want them can disable
// them; the preference is stored locally so it persists per-browser. Changes are
// broadcast via a custom event so the live hook reacts immediately (same tab)
// and via the native `storage` event (other tabs).
const PREF_KEY = "mustaflow_support_alerts_disabled";
const PREF_EVENT = "mustaflow:support-alerts-pref-changed";

export function areSupportAlertsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "1";
  } catch {
    return true;
  }
}

export function setSupportAlertsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, "1");
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new Event(PREF_EVENT));
  } catch {
    /* ignore */
  }
}

/** React state mirror of the opt-out preference, kept in sync across tabs. */
export function useSupportAlertsPref(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(areSupportAlertsEnabled);
  useEffect(() => {
    const sync = () => setEnabled(areSupportAlertsEnabled());
    window.addEventListener(PREF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PREF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    setSupportAlertsEnabled(next);
    setEnabled(next);
  }, []);
  return [enabled, set];
}

/**
 * Request browser-notification permission. Must be called from a user gesture
 * (e.g. a button click) for reliable cross-browser behaviour. Returns the
 * resulting permission state, or "unsupported" when the API is unavailable.
 */
export async function requestSupportAlertNotifications(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

interface NewTicketPayload {
  id: number;
  subject: string;
  category: string;
  plan: string | null;
  createdAt: string;
}

interface AlertMessage {
  type: "connected" | "new-ticket";
  ticket?: NewTicketPayload;
}

/**
 * Live admin support-ticket alerts over WebSocket. When a new ticket arrives the
 * admin sees a non-intrusive toast (and a browser notification if they've
 * granted permission) linking to the Support Inbox, and the inbox badge refetch
 * is triggered immediately.
 *
 * Degrades gracefully: when `enabled` is false, the admin has opted out, or the
 * socket cannot be established, nothing here runs and the existing 60s polling in
 * the sidebar keeps the badge up to date.
 */
export function useAdminTicketAlerts(enabled: boolean): void {
  const [prefEnabled] = useSupportAlertsPref();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const setLocationRef = useRef(setLocation);
  setLocationRef.current = setLocation;

  const active = enabled && prefEnabled;

  useEffect(() => {
    if (!active) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false;

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      attempts += 1;
      // Exponential backoff capped at 30s. Polling remains the fallback meanwhile.
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const handleNewTicket = (ticket: NewTicketPayload) => {
      // Refresh the sidebar badge / inbox list right away.
      void queryClient.invalidateQueries({
        queryKey: getListAdminSupportTicketsQueryKey({ limit: 1 }),
      });
      void queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).includes("/admin/support-tickets"),
      });

      const subject = ticket.subject?.trim() || "New support ticket";

      toast({
        title: "New support ticket",
        description: subject,
        action: (
          <ToastAction
            altText="View ticket"
            onClick={() => setLocationRef.current("/admin/support")}
          >
            View
          </ToastAction>
        ),
      });

      // Native notification only when the admin has already granted permission;
      // we never prompt unsolicited here.
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const n = new Notification("New support ticket", {
            body: subject,
            tag: `support-ticket-${ticket.id}`,
          });
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            setLocationRef.current("/admin/support");
            n.close();
          };
        } catch {
          /* ignore */
        }
      }
    };

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/admin/support-alerts`;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempts = 0;
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: AlertMessage;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as AlertMessage;
        } catch {
          return;
        }
        if (msg.type === "new-ticket" && msg.ticket) handleNewTicket(msg.ticket);
      };

      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [active, queryClient]);
}
