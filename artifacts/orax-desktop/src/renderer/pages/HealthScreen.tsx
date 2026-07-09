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
import type { RelayState, SupportDiagnosticsHealthTimelineEntry } from "../../shared/types";

type HealthLevel = "ok" | "warn" | "blocked";
type ActionStatus = "idle" | "running" | "success" | "failed";
type ActionResultMessage = string | void;
type SmokeChecklistStatus = "ready" | "needs-action" | "manual";
type ManualChecklistConfirmationKey = "pairing" | "diagnosticsExport" | "diagnosticsResultCopy";

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
const INITIAL_MANUAL_CHECKLIST_CONFIRMATIONS: Record<ManualChecklistConfirmationKey, boolean> = {
  pairing: false,
  diagnosticsExport: false,
  diagnosticsResultCopy: false,
};

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

function smokeStatusColor(status: SmokeChecklistStatus): string {
  if (status === "ready") return "#10b981";
  if (status === "needs-action") return "#ef4444";
  return "#f59e0b";
}

function smokeStatusLabel(status: SmokeChecklistStatus): string {
  if (status === "ready") return "Ready";
  if (status === "needs-action") return "Needs action";
  return "Manual";
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

interface SmokeChecklistItem {
  label: string;
  status: SmokeChecklistStatus;
  detail: string;
  action?: {
    label: string;
    state: ActionState;
    onClick: () => void;
  };
  manualConfirmation?: {
    label: string;
    confirmed: boolean;
    onClick: () => void;
  };
}

interface SmokeChecklistSummary {
  ready: number;
  needsAction: number;
  manual: number;
  total: number;
  complete: boolean;
}

function getSmokeChecklistSummary(items: SmokeChecklistItem[]): SmokeChecklistSummary {
  const ready = items.filter((item) => item.status === "ready").length;
  const needsAction = items.filter((item) => item.status === "needs-action").length;
  const manual = items.filter((item) => item.status === "manual").length;
  const total = items.length;
  return { ready, needsAction, manual, total, complete: ready === total };
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
          {state.status === "success"
            ? (state.message ?? "Done.")
            : (state.message ?? "Action failed.")}
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
          No timeline entries to include yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
            Included in diagnostics export from Health.
          </p>
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

function HealthSmokeChecklist({ items }: { items: SmokeChecklistItem[] }) {
  const summary = getSmokeChecklistSummary(items);

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ShieldCheck size={14} color="var(--text-secondary)" />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          Health smoke checklist
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
        Use this checklist on Windows after install or update. Derived items update from live Health
        state; manual items require the user to click through and confirm the result.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "8px 10px",
            background: "rgba(16,185,129,0.08)",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Ready</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
            {summary.complete
              ? "Windows smoke checklist complete"
              : `${summary.ready} of ${summary.total} checks ready`}
          </div>
        </div>
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "8px 10px",
            background: "rgba(239,68,68,0.06)",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Action</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
            {summary.needsAction} need action
          </div>
        </div>
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "8px 10px",
            background: "rgba(245,158,11,0.08)",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Manual</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>
            {summary.manual} manual
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((item) => {
          const Icon =
            item.status === "ready" ? CheckCircle2 : item.status === "manual" ? Activity : XCircle;
          return (
            <div
              key={item.label}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "8px 10px",
                background: "rgba(255,255,255,0.55)",
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
              }}
            >
              <Icon
                size={14}
                color={smokeStatusColor(item.status)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                    {item.label}
                  </span>
                  <span style={{ fontSize: 11, color: smokeStatusColor(item.status) }}>
                    {smokeStatusLabel(item.status)}
                  </span>
                </div>
                <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-secondary)" }}>
                  {item.detail}
                </div>
                {item.action && item.status !== "ready" && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="btn"
                      style={{ fontSize: 12, padding: "4px 10px", gap: 6 }}
                      onClick={item.action.onClick}
                      disabled={item.action.state.status === "running"}
                    >
                      {item.action.state.status === "running" ? (
                        <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                      {item.action.state.status === "running" ? "Working..." : item.action.label}
                    </button>
                    {(item.action.state.status === "success" ||
                      item.action.state.status === "failed") && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 11,
                          color: actionStateColor(item.action.state.status),
                          lineHeight: 1.4,
                        }}
                      >
                        {item.action.state.status === "success"
                          ? (item.action.state.message ?? "Done.")
                          : (item.action.state.message ?? "Action failed.")}
                      </div>
                    )}
                  </div>
                )}
                {item.manualConfirmation &&
                  !item.manualConfirmation.confirmed &&
                  item.status === "manual" && (
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="btn"
                        style={{ fontSize: 12, padding: "4px 10px", gap: 6 }}
                        onClick={item.manualConfirmation.onClick}
                      >
                        <CheckCircle2 size={11} />
                        {item.manualConfirmation.label}
                      </button>
                    </div>
                  )}
              </div>
            </div>
          );
        })}
      </div>
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
  const [manualChecklistConfirmations, setManualChecklistConfirmations] = useState(
    INITIAL_MANUAL_CHECKLIST_CONFIRMATIONS,
  );

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

  const markManualChecklistConfirmation = useCallback((key: ManualChecklistConfirmationKey) => {
    setManualChecklistConfirmations((prev) => ({ ...prev, [key]: true }));
  }, []);

  const runAction = useCallback(
    async (key: ActionKey, fn: () => Promise<ActionResultMessage>) => {
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
        const resultMessage = (await fn()) ?? "Done.";
        setActionStates((prev) => ({
          ...prev,
          [key]: {
            status: "success",
            message: resultMessage,
            lastAttempted: prev[key].lastAttempted,
          },
        }));
        updateActionEvent(eventId, { status: "success", message: resultMessage });
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
        const healthTimeline: SupportDiagnosticsHealthTimelineEntry[] = actionHistory.map(
          (entry) => ({
            id: entry.id,
            actionKey: entry.key,
            label: entry.label,
            status: entry.status,
            message: entry.message,
            createdAt: entry.createdAt,
          }),
        );
        const result = await support.exportDiagnostics({ healthTimeline });
        if (!result) return "Diagnostics export cancelled.";
        return "Diagnostics exported. Health timeline included.";
      }),
    [actionHistory, runAction],
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

  const smokeChecklistItems = useMemo<SmokeChecklistItem[]>(() => {
    const signedIn = Boolean(session);
    const hostRegistered = Boolean(hostState?.hostId);
    const hostOnline = hostState?.status === "online";
    const relayPolling = relayState?.status === "polling";
    const pairingReady = hostRegistered && hostOnline;
    const pairingOpened =
      actionStates.openPairing.status === "success" || manualChecklistConfirmations.pairing;
    const diagnosticsMessage = actionStates.exportDiagnostics.message ?? "";
    const diagnosticsResultConfirmed =
      manualChecklistConfirmations.diagnosticsResultCopy ||
      (actionStates.exportDiagnostics.status === "success" &&
        (diagnosticsMessage.includes("Diagnostics exported. Health timeline included.") ||
          diagnosticsMessage.includes("Diagnostics export cancelled.")));
    const diagnosticsExportConfirmed =
      actionStates.exportDiagnostics.status === "success" ||
      manualChecklistConfirmations.diagnosticsExport;

    return [
      {
        label: "Sign in with MustaFlow AI",
        status: signedIn ? "ready" : "needs-action",
        detail: signedIn ? "Signed-in session is active." : "Use Sign in again before continuing.",
        action: {
          label: "Sign in again",
          state: actionStates.signIn,
          onClick: handleSignIn,
        },
      },
      {
        label: "Register host",
        status: hostRegistered ? "ready" : "needs-action",
        detail: hostRegistered ? "This computer has a host id." : "Use Reconnect host.",
        action: {
          label: "Reconnect host",
          state: actionStates.reconnectHost,
          onClick: handleReconnectHost,
        },
      },
      {
        label: "Confirm heartbeat",
        status: hostOnline ? "ready" : "needs-action",
        detail: hostOnline ? "Desktop heartbeat is online." : "Host must be online.",
      },
      {
        label: "Confirm relay polling",
        status: relayPolling ? "ready" : "needs-action",
        detail: relayPolling ? "Relay is polling for actions." : "Use Restart relay.",
        action: {
          label: "Restart relay",
          state: actionStates.restartRelay,
          onClick: handleRestartRelay,
        },
      },
      {
        label: "Open pairing",
        status: pairingOpened ? "ready" : pairingReady ? "manual" : "needs-action",
        detail: pairingOpened
          ? "Pairing page was opened in this session."
          : pairingReady
            ? "Open Pairing and confirm the code screen."
            : "Pairing requires an online registered host.",
        action: {
          label: "Open pairing",
          state: actionStates.openPairing,
          onClick: handleOpenPairing,
        },
        manualConfirmation: pairingReady
          ? {
              label: "Mark pairing checked",
              confirmed: pairingOpened,
              onClick: () => markManualChecklistConfirmation("pairing"),
            }
          : undefined,
      },
      {
        label: "Export support diagnostics",
        status: diagnosticsExportConfirmed ? "ready" : "manual",
        detail: diagnosticsExportConfirmed
          ? "Diagnostics export flow returned a safe result message."
          : "Click Export Support Diagnostics and choose save or cancel.",
        action: {
          label: "Export Support Diagnostics",
          state: actionStates.exportDiagnostics,
          onClick: handleExportDiagnostics,
        },
        manualConfirmation: {
          label: "Mark diagnostics checked",
          confirmed: diagnosticsExportConfirmed,
          onClick: () => markManualChecklistConfirmation("diagnosticsExport"),
        },
      },
      {
        label: "Confirm diagnostics success/cancel messages",
        status: diagnosticsResultConfirmed ? "ready" : "manual",
        detail: diagnosticsResultConfirmed
          ? "Health shows a safe result message without the saved file path."
          : "Confirm success or cancel copy appears and no local path is shown.",
        manualConfirmation: {
          label: "Mark result copy checked",
          confirmed: diagnosticsResultConfirmed,
          onClick: () => markManualChecklistConfirmation("diagnosticsResultCopy"),
        },
      },
    ];
  }, [
    actionStates,
    handleExportDiagnostics,
    handleOpenPairing,
    handleReconnectHost,
    handleRestartRelay,
    handleSignIn,
    hostState?.hostId,
    hostState?.status,
    manualChecklistConfirmations,
    markManualChecklistConfirmation,
    relayState?.status,
    session,
  ]);

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

      <HealthSmokeChecklist items={smokeChecklistItems} />

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
