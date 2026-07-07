import { useState } from "react";
import { Shield, Check, FileDown } from "lucide-react";
import { useApp } from "../context/AppContext";
import { support } from "../lib/ipc";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, type PermissionMode } from "../../shared/types";

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  read_only: "Orax can only read files and status. No changes are made.",
  ask_everything: "Every action requires your explicit approval before running.",
  ask_risky:
    "Approval required for risky actions (file writes, git, shell). Safe reads are automatic.",
  trusted_project:
    "Actions are allowed within a trusted project scope without per-action approval.",
  full_access: "All actions run without approval. Use only in secure, isolated environments.",
  custom: "Custom permission rules (configured per action type).",
};

export function SettingsScreen() {
  const { hostState, updatePermissionMode } = useApp();
  const [selected, setSelected] = useState<PermissionMode>(
    (hostState?.permissionMode as PermissionMode) ?? "ask_risky",
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [diagnosticsPath, setDiagnosticsPath] = useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updatePermissionMode(selected);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save permission mode.");
    } finally {
      setSaving(false);
    }
  }

  async function handleExportDiagnostics() {
    setExportingDiagnostics(true);
    setDiagnosticsError(null);
    setDiagnosticsPath(null);
    try {
      const result = await support.exportDiagnostics();
      if (result) {
        setDiagnosticsPath(result.filePath);
      }
    } catch (err) {
      setDiagnosticsError(
        err instanceof Error ? err.message : "Failed to export support diagnostics.",
      );
    } finally {
      setExportingDiagnostics(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Settings</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          Configure how Orax operates on this computer.
        </p>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Shield size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
            Permission Mode
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {PERMISSION_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => setSelected(mode)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "12px 14px",
                borderRadius: "var(--radius)",
                border: `1px solid ${selected === mode ? "var(--accent)" : "var(--border)"}`,
                background: selected === mode ? "var(--accent-dim)" : "var(--bg-surface)",
                cursor: "pointer",
                textAlign: "left",
                width: "100%",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: `2px solid ${selected === mode ? "var(--accent)" : "var(--border)"}`,
                  background: selected === mode ? "var(--accent)" : "transparent",
                  flexShrink: 0,
                  marginTop: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {selected === mode && (
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />
                )}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                  {PERMISSION_MODE_LABELS[mode]}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    marginTop: 2,
                    lineHeight: 1.5,
                  }}
                >
                  {MODE_DESCRIPTIONS[mode]}
                </div>
              </div>
            </button>
          ))}
        </div>

        {error && (
          <div
            style={{
              background: "var(--danger-dim)",
              border: "1px solid var(--danger)",
              borderRadius: "var(--radius-sm)",
              padding: "10px 14px",
              fontSize: 13,
              color: "var(--danger)",
              marginTop: 12,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || selected === hostState?.permissionMode}
          >
            {saved ? (
              <>
                <Check size={13} /> Saved
              </>
            ) : saving ? (
              "Saving…"
            ) : (
              "Save Permission Mode"
            )}
          </button>
          {selected !== hostState?.permissionMode && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Unsaved changes</span>
          )}
        </div>
      </div>

      <div className="card" style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        Capabilities (shell, filesystem, git) are all disabled in Phase 2C regardless of permission
        mode. Modes apply to future phases when execution is enabled.
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <FileDown size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
            Support Diagnostics
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
          Export a small JSON file for MustaFlow support. It includes app version, host state, relay
          state, and project display names. It does not include session tokens, passwords,
          environment variables, or local project paths.
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
          {diagnosticsPath && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Saved to {diagnosticsPath}
            </span>
          )}
        </div>
        {diagnosticsError && (
          <div
            style={{
              background: "var(--danger-dim)",
              border: "1px solid var(--danger)",
              borderRadius: "var(--radius-sm)",
              padding: "10px 14px",
              fontSize: 13,
              color: "var(--danger)",
            }}
          >
            {diagnosticsError}
          </div>
        )}
      </div>
    </div>
  );
}
