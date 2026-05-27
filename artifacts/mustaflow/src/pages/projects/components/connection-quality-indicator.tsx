import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Wifi, WifiOff, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ConnectionState = "connected" | "reconnecting" | "error";

interface ConnectionQualityIndicatorProps {
  reconnectAttempt: number;
  hasError: boolean;
  maxAttempts?: number;
}

const STATE_CONFIG: Record<
  ConnectionState,
  {
    label: string;
    dotClass: string;
    pingClass: string;
    iconClass: string;
    Icon: React.ElementType;
    heading: string;
    description: string;
  }
> = {
  connected: {
    label: "Connected",
    dotClass: "bg-emerald-500",
    pingClass: "bg-emerald-400",
    iconClass: "text-emerald-500",
    Icon: Wifi,
    heading: "Connection is healthy",
    description: "Your AI chat stream is connected and responses will arrive in real time.",
  },
  reconnecting: {
    label: "Reconnecting",
    dotClass: "bg-amber-500",
    pingClass: "bg-amber-400",
    iconClass: "text-amber-500",
    Icon: RefreshCw,
    heading: "Reconnecting…",
    description:
      "The chat stream dropped and is being retried automatically. If your internet connection is unstable you may see delays.",
  },
  error: {
    label: "Disconnected",
    dotClass: "bg-red-500",
    pingClass: "bg-red-400",
    iconClass: "text-red-500",
    Icon: WifiOff,
    heading: "Connection lost",
    description:
      'All reconnect attempts failed. Check your internet connection, then use the "Try again" button in the chat to resend your last message.',
  },
};

export function ConnectionQualityIndicator({
  reconnectAttempt,
  hasError,
  maxAttempts = 3,
}: ConnectionQualityIndicatorProps) {
  const state: ConnectionState = hasError
    ? "error"
    : reconnectAttempt > 0
      ? "reconnecting"
      : "connected";

  const cfg = STATE_CONFIG[state];
  const Icon = cfg.Icon;

  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open) return;

    function reposition() {
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      const panelW = 260;
      let left = r.left + r.width / 2 - panelW / 2;
      left = Math.max(8, Math.min(window.innerWidth - panelW - 8, left));
      setPanelStyle({
        top: r.bottom + 6,
        left,
        width: panelW,
      });
    }

    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const isReconnecting = state === "reconnecting";

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Connection status: ${cfg.label}`}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-medium transition-colors",
          state === "error"
            ? "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/15"
            : state === "reconnecting"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          {(state === "error" || state === "reconnecting") && (
            <span
              className={cn(
                "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                cfg.pingClass,
              )}
            />
          )}
          <span className={cn("relative inline-flex rounded-full h-2 w-2", cfg.dotClass)} />
        </span>
        <Icon className={cn("h-3 w-3 shrink-0", cfg.iconClass, isReconnecting && "animate-spin")} />
        <span className="hidden sm:inline">{cfg.label}</span>
        {isReconnecting && (
          <span className="hidden sm:inline text-[10px] text-amber-400/70">
            ({reconnectAttempt}/{maxAttempts})
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            className="fixed z-50 rounded-xl border border-border bg-card shadow-xl p-4 space-y-2.5 animate-in fade-in duration-100"
            style={panelStyle}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    state === "error"
                      ? "bg-red-500/10"
                      : state === "reconnecting"
                        ? "bg-amber-500/10"
                        : "bg-emerald-500/10",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", cfg.iconClass)} />
                </div>
                <p className="text-sm font-semibold leading-snug">{cfg.heading}</p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{cfg.description}</p>
            {isReconnecting && (
              <div className="flex items-center gap-2 pt-0.5">
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-300"
                    style={{ width: `${(reconnectAttempt / maxAttempts) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-amber-400 font-medium tabular-nums">
                  {reconnectAttempt}/{maxAttempts}
                </span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
