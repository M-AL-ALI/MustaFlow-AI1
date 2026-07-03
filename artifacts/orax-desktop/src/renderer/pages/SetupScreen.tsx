import { useState } from "react";
import { ServerCog, CheckCircle } from "lucide-react";
import { useApp } from "../context/AppContext";

export function SetupScreen() {
  const { session, registerHost } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRegister() {
    setBusy(true);
    setError(null);
    try {
      await registerHost();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 24,
        background: "var(--bg-base)",
        padding: 32,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ServerCog size={24} color="#fff" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 20, color: "var(--text-primary)" }}>Set Up This Computer</div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Register as an Orax host</div>
        </div>
      </div>

      <div className="card" style={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 }}>
        {session && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--accent-dim)", borderRadius: "var(--radius-sm)", border: "1px solid var(--accent)" }}>
            <CheckCircle size={14} color="var(--accent)" />
            <span style={{ fontSize: 13, color: "var(--accent)" }}>
              Signed in as <strong>{session.displayName}</strong>
            </span>
          </div>
        )}

        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Registering this computer lets you pair it with your phone or browser to receive
          and approve actions remotely. You control what Orax can do through permission modes.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            "Device name and platform are sent to MustaFlow",
            "All capabilities are disabled by default",
            "You approve actions before they run",
          ].map((item) => (
            <div key={item} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
              <CheckCircle size={14} color="var(--success)" style={{ marginTop: 2, flexShrink: 0 }} />
              {item}
            </div>
          ))}
        </div>

        {error && (
          <div style={{ background: "var(--danger-dim)", border: "1px solid var(--danger)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13, color: "var(--danger)" }}>
            {error}
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "10px 14px" }}
          onClick={() => void handleRegister()}
          disabled={busy}
        >
          {busy ? "Registering…" : "Register This Computer"}
        </button>
      </div>
    </div>
  );
}
