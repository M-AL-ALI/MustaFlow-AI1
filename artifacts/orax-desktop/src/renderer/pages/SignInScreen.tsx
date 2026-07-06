import { useState } from "react";
import { Monitor } from "lucide-react";
import { useApp } from "../context/AppContext";

export function SignInScreen() {
  const { signIn } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
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
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Monitor size={24} color="#fff" />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 20, color: "var(--text-primary)" }}>
            Orax Desktop
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Connect your computer to MustaFlow
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          Sign in with your MustaFlow account to register this computer as an Orax host. Clicking
          the button opens your browser so you can approve this desktop and return here
          automatically.
        </p>

        {error && (
          <div
            style={{
              background: "var(--danger-dim)",
              border: "1px solid var(--danger)",
              borderRadius: "var(--radius-sm)",
              padding: "8px 12px",
              fontSize: 13,
              color: "var(--danger)",
            }}
          >
            {error}
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "10px 14px" }}
          onClick={() => void handleSignIn()}
          disabled={busy}
        >
          {busy ? "Waiting for browser approval..." : "Sign in with MustaFlow"}
        </button>

        <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
          Sign-in opens in your default browser. No password is entered here.
        </p>
      </div>
    </div>
  );
}
