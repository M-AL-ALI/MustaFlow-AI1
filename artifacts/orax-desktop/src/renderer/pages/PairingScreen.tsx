import { useState, useEffect, useRef } from "react";
import { RefreshCw, X, Unplug } from "lucide-react";
import { useApp } from "../context/AppContext";
import { pairing } from "../lib/ipc";

function formatCountdown(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const secs = Math.ceil(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PairingScreen() {
  const { hostState, pairingState } = useApp();
  const [countdown, setCountdown] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!pairingState?.expiresAt) {
      setCountdown("");
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    const tick = () => setCountdown(formatCountdown(pairingState.expiresAt!));
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [pairingState?.expiresAt]);

  const isExpired = pairingState?.expiresAt
    ? new Date(pairingState.expiresAt).getTime() <= Date.now()
    : false;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      await pairing.create();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pairing code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    try {
      await pairing.cancel();
    } finally {
      setBusy(false);
    }
  }

  if (!hostState?.hostId) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Host not registered. Complete setup first.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Pair a Device</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          Generate a code to pair your phone or browser with this computer.
        </p>
      </div>

      {error && (
        <div style={{ background: "var(--danger-dim)", border: "1px solid var(--danger)", borderRadius: "var(--radius-sm)", padding: "10px 14px", fontSize: 13, color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {pairingState?.isActive && !isExpired ? (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div className="label">Pairing Code</div>
            <div style={{
              fontFamily: "monospace",
              fontSize: 40,
              fontWeight: 700,
              color: "var(--accent)",
              letterSpacing: "0.25em",
              marginTop: 8,
            }}>
              {pairingState.code}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8 }}>
              Expires in <strong style={{ color: "var(--text-primary)" }}>{countdown}</strong>
            </div>
          </div>

          {pairingState.qrPayload && (
            <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", padding: 16 }}>
              <div className="label">QR Payload</div>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)", wordBreak: "break-all", marginTop: 6, lineHeight: 1.5 }}>
                {pairingState.qrPayload}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                Scan this QR payload with your phone or enter the code manually on mobile or the website.
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => void handleCreate()} disabled={busy} style={{ flex: 1, justifyContent: "center" }}>
              <RefreshCw size={13} /> Refresh
            </button>
            <button className="btn btn-danger" onClick={() => void handleCancel()} disabled={busy} style={{ flex: 1, justifyContent: "center" }}>
              <X size={13} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center", textAlign: "center" }}>
          <Unplug size={32} color="var(--text-muted)" />
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {isExpired ? "Code Expired" : "No Active Pairing Code"}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
              {isExpired
                ? "Generate a new code to pair a device."
                : "Generate a code to pair your phone or browser with this computer."}
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => void handleCreate()}
            disabled={busy}
            style={{ justifyContent: "center" }}
          >
            {busy ? "Generating…" : "Generate Pairing Code"}
          </button>
        </div>
      )}

      <div className="card" style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        Pairing codes expire after 10 minutes. They are account-bound and single-use.
        Revoke trusted devices at any time from the website or desktop app.
      </div>
    </div>
  );
}
