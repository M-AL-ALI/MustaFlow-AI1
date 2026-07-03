import { Monitor, Cpu, Shield } from "lucide-react";
import { useApp } from "../context/AppContext";
import { PERMISSION_MODE_LABELS } from "../../shared/types";

export function HomeScreen() {
  const { hostState } = useApp();

  if (!hostState) return null;

  const statusLabel = {
    online: "Online",
    offline: "Offline",
    reconnecting: "Reconnecting…",
    unregistered: "Not registered",
  }[hostState.status];

  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Orax Desktop</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          This computer is registered as a trusted Orax host.
        </p>
      </div>

      <div className="card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span className={`status-dot ${hostState.status}`} style={{ width: 12, height: 12 }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text-primary)" }}>{statusLabel}</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Heartbeat every 30 seconds
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="card">
          <div className="label">Device</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <Monitor size={14} color="var(--text-secondary)" />
            <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{hostState.deviceName}</span>
          </div>
        </div>

        <div className="card">
          <div className="label">Platform</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <Cpu size={14} color="var(--text-secondary)" />
            <span style={{ fontSize: 13, color: "var(--text-primary)", textTransform: "capitalize" }}>
              {hostState.platform}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="label">Permission Mode</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <Shield size={14} color="var(--text-secondary)" />
            <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
              {PERMISSION_MODE_LABELS[hostState.permissionMode as keyof typeof PERMISSION_MODE_LABELS] ?? hostState.permissionMode}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="label">App Version</div>
          <div style={{ fontSize: 13, color: "var(--text-primary)", marginTop: 4 }}>
            v{hostState.appVersion}
          </div>
        </div>
      </div>

      {hostState.hostId && (
        <div className="card">
          <div className="label">Host ID</div>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-secondary)", marginTop: 4, wordBreak: "break-all" }}>
            {hostState.hostId}
          </div>
        </div>
      )}

      <div className="card" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent)" }}>
        <div style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>
          Phase 2C — Skeleton Only
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Capabilities are disabled. Shell, filesystem, git, and browser access will be
          enabled in future phases after explicit permission setup.
        </div>
      </div>
    </div>
  );
}
