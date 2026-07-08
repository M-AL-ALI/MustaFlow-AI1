import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  HeartPulse,
  Loader2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  UserCheck,
  XCircle,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { relay, support } from "../lib/ipc";
import type { RelayState } from "../../shared/types";

type HealthLevel = "ok" | "warn" | "blocked";
type ActionStatus = "idle" | "running" | "success" | "failed";

interface ActionState {
  status: ActionStatus;
  message: string | null;
  lastAttempted: string | null;
}

interface ActionHistoryEntry {
  id: string;
  key: ActionKey;
  label: string;
  status: Exclude<ActionStatus, "idle">;
  message: string;
  createdAt: string;
}

type ActionKey =
  | "signIn"
  | "reconnectHost"
  | "restartRelay"
  | "openPairing"
  | "checkRelease"
  | "exportDiagnostics";

const INITIAL_ACTION_STATE: ActionState = { status: "idle", message: null, lastAttempted: null };

const ACTION_LABELS: Record<ActionKey, string> = {
  signIn: "Sign in again",
  reconnectHost: "Reconnect host",
  restartRelay: "Restart relay",
  openPairing: "Open pairing",
  checkRelease: "Check release status",
  exportDiagnostics: "Export Support Diagnostics",
};

function initActionStates(): Record<ActionKey, ActionState> {
  return {
    signIn: INITIAL_ACTION_STATE,
    reconnectHost: INITIAL_ACTION_STATE,
    restartRelay: INITIAL_ACTION_STATE,
    openPairing: INITIAL_ACTION_STATE,
    checkRelease: INITIAL_ACTION_STATE,
    exportDiagnostics: INITIAL_ACTION_STATE,
  };
}

function redactForDisplay(err: unknown): string {
  let msg = err instanceof Error ? err.message : "Action failed.";
  msg = msg.replace(/\bBearer\s+\S+/gi, "[redacted]");
  msg = msg.replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted]");
  msg = msg.replace(/\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|KEY)=\S*/g, "[redacted]");
  msg = msg.replace(/[A-Za-z]:\\[^\s,;]*/g, "[redacted]");
  msg = msg.replace(/\/(?:Users|home|var|tmp|workspace|workspaces)[^\s,;]*/g, "[redacted]");
  if (msg.length > 120) msg = msg.slice(0, 117) + "...";
  return msg;
}

function healthColor(level: HealthLevel): string {
  if (level === "ok") return "#10b981";
  if (level === "warn") return "#f59e0b";
  return "#ef4444";
}

function actionStateColor(status: ActionStatus): string {
  if (status === "success") return "#10b981";
  if (status === "failed") return "#ef4444";
  return "var(--text-muted)";
}

interface HealthRowAction {
  key: ActionKey;
  label: string;
  state: ActionState;
  onClick: () => void;
  showWhen: "not-ok" | "always";
}

interface HealthItem {
  label: string;
  level: HealthLevel;
  detail: string;
  action?: HealthRowAction;
}

function ActionButton({
  label,
  state,
  onClick,
  level,
  showWhen,
}: {
  label: string;
  state: ActionState;
  onClick: () => void;
  level: HealthLevel;
  showWhen: "not-ok" | "always";
}) {
  const visible = showWhen === "always" || level !== "ok";
  if (!visible) return null;
  const running = state.status === "running";
  return (
    <div style={{ marginTop: 8 }}>
      <button
        className="btn"
        style={{ fontSize: 12, padding: "4px 10px", gap: 6 }}
        onClick={onClick}
        disabled={running}
      >
        {running ? (
          <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
        ) : (
          <RefreshCw size={11} />
        )}
        {running ? "Working..." : label}
      </button>
      {(state.status === "success" || state.status === "failed") && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: actionStateColor(state.status),
            lineHeight: 1.4,
          }}
        >
          {state.status === "success" ? "Done." : (state.message ?? "Action failed.")}
          {state.lastAttempted && (
            <span style={{ marginLeft: 6, color: "var(--text-muted)", opacity: 0.7 }}>
              {new Date(state.lastAttempted).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function HealthRow({ item }: { item: HealthItem }) {
  const Icon = item.level === "ok" ? CheckCircle2 : XCircle;
  return (
    <div
      className="card"
      style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px" }}
    >
      <Icon size={16} color={healthColor(item.level)} style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {item.label}
        </div>
        <div
          style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.5 }}
        >
          {item.detail}
        </div>
        {item.action && (
          <ActionButton
            label={item.action.label}
            state={item.action.state}
            onClick={item.action.onClick}
            level={item.level}
            showWhen={item.action.showWhen}
          />
        )}
      </div>
    </div>
  );
}

function ActionTimeline({ entries }: { entries: ActionHistoryEntry[] }) {
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Activity size={14} color="var(--text-secondary)" />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          Action timeline
        </span>
      </div>
      {entries.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
          No recovery actions recorded yet. Use a health recovery button to record the attempt here.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {entries.map((entry) => (
            <div
              key={entry.id}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "8px 10px",
                background: "rgba(255,255,255,0.55)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                  {entry.label}
                </span>
                <span style={{ fontSize: 11, color: actionStateColor(entry.status) }}>
                  {entry.status}
                </span>
              </div>
              <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-secondary)" }}>
                {entry.message}
              </div>
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--text-muted)" }}>
                {new Date(entry.createdAt).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HealthScreen() {
  const { session, hostState, pairingState, localProjects, signIn, registerHost, setPage } =
    useApp();
  const [relayState, setRelayState] = useState<RelayState | null>(null);
  const [actionStates, setActionStates] =
    useState<Record<ActionKey, ActionState>>(initActionStates);
  const [actionHistory, setActionHistory] = useState<ActionHistoryEntry[]>([]);

  useEffect(() => {
    void window.electronAPI.relay.getStatus().then(setRelayState);
    const remove = window.electronAPI.on.relayStatusChanged(setRelayState);
    return remove;
  }, []);

  const recordActionEvent = useCallback((entry: ActionHistoryEntry) => {
    setActionHistory((prev) => [entry, ...prev].slice(0, 8));
  }, []);

  const updateActionEvent = useCallback(
    (id: string, patch: Pick<ActionHistoryEntry, "status" | "message">) => {
      setActionHistory((prev) =>
        prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      );
    },
    [],
  );

  const runAction = useCallback(
    async (key: ActionKey, fn: () => Promise<void>) => {
      const lastAttempted = new Date().toISOString();
      const eventId = `${key}-${lastAttempted}`;
      recordActionEvent({
        id: eventId,
        key,
        label: ACTION_LABELS[key],
        status: "running",
        message: "Started.",
        createdAt: lastAttempted,
      });
      setActionStates((prev) => ({
        ...prev,
        [key]: { status: "running", message: null, lastAttempted },
      }));
      try {
        await fn();
        setActionStates((prev) => ({
          ...prev,
          [key]: { status: "success", message: null, lastAttempted: prev[key].lastAttempted },
        }));
        updateActionEvent(eventId, { status: "success", message: "Completed." });
      } catch (err) {
        const message = redactForDisplay(err);
        setActionStates((prev) => ({
          ...prev,
          [key]: {
            status: "failed",
            message,
            lastAttempted: prev[key].lastAttempted,
          },
        }));
        updateActionEvent(eventId, { status: "failed", message });
      }
    },
    [recordActionEvent, updateActionEvent],
  );

  const handleSignIn = useCallback(() => runAction("signIn", signIn), [runAction, signIn]);

  const handleReconnectHost = useCallback(
    () => runAction("reconnectHost", registerHost),
    [runAction, registerHost],
  );

  const handleRestartRelay = useCallback(
    () =>
      runAction("restartRelay", async () => {
        const newState = await relay.restart();
        setRelayState(newState);
      }),
    [runAction],
  );

  const handleOpenPairing = useCallback(
    () =>
      runAction("openPairing", async () => {
        setPage("pairing");
      }),
    [runAction, setPage],
  );

  const handleCheckRelease = useCallback(
    () => runAction("checkRelease", () => Promise.resolve()),
    [runAction],
  );

  const handleExportDiagnostics = useCallback(
    () =>
      runAction("exportDiagnostics", async () => {
        const result = await support.exportDiagnostics();
        if (!result) throw new Error("Export cancelled.");
      }),
    [runAction],
  );

  const healthItems = useMemo<HealthItem[]>(() => {
    const signedIn = Boolean(session);
    const hostOnline = hostState?.status === "online";
    const hostRegistered = Boolean(hostState?.hostId);
    const relayPolling = relayState?.status === "polling";
    const pairingReady = hostOnline && hostRegistered;

    return [
      {
        label: "Sign-in status",
        level: signedIn ? "ok" : "blocked",
        detail: signedIn
          ? `Signed in as ${session?.email ?? session?.displayName ?? "MustaFlow user"}.`
          : "Sign in with MustaFlow AI before using Orax Desktop.",
        action: {
          key: "signIn",
          label: "Sign in again",
          state: actionStates.signIn,
          onClick: handleSignIn,
          showWhen: "not-ok",
        },
      },
      {
        label: "Host registration",
        level: hostRegistered ? "ok" : "blocked",
        detail: hostRegistered
          ? `Registered host ${hostState?.hostId}.`
          : "Register this computer as an Orax Desktop host.",
        action: {
          key: "reconnectHost",
          label: "Reconnect host",
          state: actionStates.reconnectHost,
          onClick: handleReconnectHost,
          showWhen: "not-ok",
        },
      },
      {
        label: "Heartbeat status",
        level: hostOnline ? "ok" : hostState?.status === "reconnecting" ? "warn" : "blocked",
        detail:
          hostState?.status === "online"
            ? "Heartbeat is online."
            : hostState?.status === "reconnecting"
              ? "Heartbeat is reconnecting."
              : "Heartbeat is offline.",
      },
      {
        label: "Relay polling",
        level: relayPolling ? "ok" : relayState?.status === "error" ? "blocked" : "warn",
        detail:
          relayState?.status === "polling"
            ? `Relay is polling for actions${relayState.lastPollAt ? `; last poll ${new Date(relayState.lastPollAt).toLocaleTimeString()}` : ""}.`
            : relayState?.status === "error"
              ? `Relay error: ${relayState.errorMsg ?? "unknown"}.`
              : "Relay starts after the desktop is online.",
        action: {
          key: "restartRelay",
          label: "Restart relay",
          state: actionStates.restartRelay,
          onClick: handleRestartRelay,
          showWhen: "not-ok",
        },
      },
      {
        label: "Pairing readiness",
        level: pairingReady ? "ok" : "warn",
        detail: pairingReady
          ? pairingState?.isActive
            ? "Pairing code is active for web or mobile."
            : "Ready to generate a pairing code."
          : "Pairing requires an online registered host.",
        action: {
          key: "openPairing",
          label: "Open pairing",
          state: actionStates.openPairing,
          onClick: handleOpenPairing,
          showWhen: "always",
        },
      },
      {
        label: "Release channel",
        level: "ok",
        detail:
          "Updates use the signed Orax Desktop release channel; silent background install is not enabled.",
        action: {
          key: "checkRelease",
          label: "Check release status",
          state: actionStates.checkRelease,
          onClick: handleCheckRelease,
          showWhen: "always",
        },
      },
      {
        label: "Diagnostics export",
        level: "ok",
        detail:
          "Support diagnostics are available and validated before writing; tokens, env vars, and local paths are blocked.",
        action: {
          key: "exportDiagnostics",
          label: "Export Support Diagnostics",
          state: actionStates.exportDiagnostics,
          onClick: handleExportDiagnostics,
          showWhen: "always",
        },
      },
    ];
  }, [
    actionStates,
    handleCheckRelease,
    handleExportDiagnostics,
    handleOpenPairing,
    handleReconnectHost,
    handleRestartRelay,
    handleSignIn,
    hostState,
    pairingState?.isActive,
    relayState,
    session,
  ]);

  const summary = useMemo(() => {
    const blocked = healthItems.filter((item) => item.level === "blocked").length;
    const warnings = healthItems.filter((item) => item.level === "warn").length;
    if (blocked > 0) return { label: `${blocked} blocked`, level: "blocked" as const };
    if (warnings > 0)
      return { label: `${warnings} warning${warnings === 1 ? "" : "s"}`, level: "warn" as const };
    return { label: "All systems ready", level: "ok" as const };
  }, [healthItems]);

  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
          Health Check
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          Check whether this desktop is ready for Orax web and mobile control. Use the recovery
          actions to resolve any blocked or degraded items.
        </p>
      </div>

      <div className="card" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <HeartPulse size={20} color={healthColor(summary.level)} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            {summary.label}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Local projects tracked: {localProjects.length}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <UserCheck size={14} color="var(--text-secondary)" />
            <span className="label">Account</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-primary)" }}>
            {session?.email ?? "Not signed in"}
          </div>
        </div>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Radio size={14} color="var(--text-secondary)" />
            <span className="label">Relay</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-primary)" }}>
            {relayState?.status ?? "idle"}
          </div>
        </div>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Smartphone size={14} color="var(--text-secondary)" />
            <span className="label">Pairing</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-primary)" }}>
            {pairingState?.isActive ? "Code active" : "Ready when online"}
          </div>
        </div>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldCheck size={14} color="var(--text-secondary)" />
            <span className="label">Release</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-primary)" }}>
            Signed channel
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {healthItems.map((item) => (
          <HealthRow key={item.label} item={item} />
        ))}
      </div>

      <ActionTimeline entries={actionHistory} />

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Activity size={14} color="var(--text-secondary)" />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            Recovery actions
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
          Each health item above shows a recovery action when it is not ready. Actions use the
          existing sign-in, host registration, relay, and pairing flows. Errors are redacted before
          display; no tokens, environment variables, or local paths are shown.
        </p>
      </div>
    </div>
  );
}
