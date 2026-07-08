import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileDown,
  HeartPulse,
  Radio,
  ShieldCheck,
  Smartphone,
  UserCheck,
  XCircle,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { support } from "../lib/ipc";
import type { RelayState } from "../../shared/types";

type HealthLevel = "ok" | "warn" | "blocked";

interface HealthItem {
  label: string;
  level: HealthLevel;
  detail: string;
}

function healthColor(level: HealthLevel): string {
  if (level === "ok") return "#10b981";
  if (level === "warn") return "#f59e0b";
  return "#ef4444";
}

function HealthRow({ item }: { item: HealthItem }) {
  const Icon = item.level === "ok" ? CheckCircle2 : XCircle;
  return (
    <div
      className="card"
      style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px" }}
    >
      <Icon size={16} color={healthColor(item.level)} style={{ marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {item.label}
        </div>
        <div
          style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.5 }}
        >
          {item.detail}
        </div>
      </div>
    </div>
  );
}

export function HealthScreen() {
  const { session, hostState, pairingState, localProjects } = useApp();
  const [relayState, setRelayState] = useState<RelayState | null>(null);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.relay.getStatus().then(setRelayState);
    const remove = window.electronAPI.on.relayStatusChanged(setRelayState);
    return remove;
  }, []);

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
      },
      {
        label: "Host registration",
        level: hostRegistered ? "ok" : "blocked",
        detail: hostRegistered
          ? `Registered host ${hostState?.hostId}.`
          : "Register this computer as an Orax Desktop host.",
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
      },
      {
        label: "Pairing readiness",
        level: pairingReady ? "ok" : "warn",
        detail: pairingReady
          ? pairingState?.isActive
            ? "Pairing code is active for web or mobile."
            : "Ready to generate a pairing code."
          : "Pairing requires an online registered host.",
      },
      {
        label: "Release channel",
        level: "ok",
        detail:
          "Updates use the signed Orax Desktop release channel; silent background install is not enabled.",
      },
      {
        label: "Diagnostics export",
        level: "ok",
        detail:
          "Support diagnostics are available and validated before writing; tokens, env vars, and local paths are blocked.",
      },
    ];
  }, [hostState, pairingState?.isActive, relayState, session]);

  const summary = useMemo(() => {
    const blocked = healthItems.filter((item) => item.level === "blocked").length;
    const warnings = healthItems.filter((item) => item.level === "warn").length;
    if (blocked > 0) return { label: `${blocked} blocked`, level: "blocked" as const };
    if (warnings > 0)
      return { label: `${warnings} warning${warnings === 1 ? "" : "s"}`, level: "warn" as const };
    return { label: "All systems ready", level: "ok" as const };
  }, [healthItems]);

  async function handleExportDiagnostics() {
    setExportingDiagnostics(true);
    setDiagnosticsStatus(null);
    try {
      const result = await support.exportDiagnostics();
      setDiagnosticsStatus(
        result ? `Saved diagnostics to ${result.filePath}` : "Export cancelled.",
      );
    } catch (error) {
      setDiagnosticsStatus(
        error instanceof Error ? error.message : "Failed to export support diagnostics.",
      );
    } finally {
      setExportingDiagnostics(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
          Health Check
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          Check whether this desktop is ready for Orax web and mobile control.
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

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          Support action
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
          Export diagnostics when support needs proof of sign-in, heartbeat, relay, pairing, or
          release status. The export is validated before it is written.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn"
            onClick={() => void handleExportDiagnostics()}
            disabled={exportingDiagnostics}
          >
            <FileDown size={13} />
            {exportingDiagnostics ? "Exporting..." : "Export Support Diagnostics"}
          </button>
          {diagnosticsStatus && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{diagnosticsStatus}</span>
          )}
        </div>
      </div>
    </div>
  );
}
