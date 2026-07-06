import { useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle2, Loader2, Monitor, ShieldCheck, XCircle } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

type ApprovalState = "idle" | "approving" | "approved" | "denied" | "error";

export default function OraxDesktopAuthApprovePage() {
  const { getToken } = useAuth();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const challengeId = params.get("challengeId") ?? "";
  const userCode = params.get("userCode") ?? "";
  const [state, setState] = useState<ApprovalState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function complete(decision: "approve" | "deny") {
    if (!challengeId || !userCode) {
      setState("error");
      setError("This Orax Desktop sign-in link is missing its challenge code.");
      return;
    }
    setState("approving");
    setError(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch("/api/orax/desktop-auth/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ challengeId, userCode, decision }),
      });
      if (!res.ok) throw new Error(`Approval failed (${res.status})`);
      setState(decision === "approve" ? "approved" : "denied");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Could not complete Orax Desktop sign-in.");
    }
  }

  const busy = state === "approving";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <Link
            href="/orax/devices"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Back to Orax devices"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm font-semibold">Orax Desktop Sign-In</span>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-xl items-center px-4 py-10">
        <section className="w-full space-y-6 rounded-3xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <Monitor className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">Approve Orax Desktop</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Confirm this code matches the Orax Desktop window before connecting this computer to
                your MustaFlow AI account.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-dashed border-border bg-background p-5 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Desktop code
            </div>
            <div className="mt-2 font-mono text-4xl font-black tracking-[0.35em]">
              {userCode || "------"}
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              This creates an Orax Desktop session token for coding-agent routes only. It does not
              expose your password, and it does not grant access to Ora chat routes.
            </p>
          </div>

          {state === "approved" ? (
            <StatusMessage
              icon={<CheckCircle2 className="h-5 w-5" />}
              title="Desktop approved"
              body="Return to Orax Desktop. It should finish sign-in automatically."
            />
          ) : null}
          {state === "denied" ? (
            <StatusMessage
              icon={<XCircle className="h-5 w-5" />}
              title="Desktop sign-in denied"
              body="The desktop app will stay signed out."
            />
          ) : null}
          {state === "error" ? (
            <StatusMessage
              icon={<XCircle className="h-5 w-5" />}
              title="Could not approve desktop"
              body={error ?? "Try starting sign-in again from Orax Desktop."}
              danger
            />
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || state === "approved"}
              onClick={() => void complete("approve")}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Approve desktop
            </button>
            <button
              type="button"
              className="inline-flex h-11 flex-1 items-center justify-center rounded-full border border-border bg-background px-5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || state === "approved"}
              onClick={() => void complete("deny")}
            >
              Deny
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function StatusMessage({
  icon,
  title,
  body,
  danger = false,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  danger?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border p-4 ${
        danger
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-background text-foreground"
      }`}
    >
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
