import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Database, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

export const PRODUCTION_DATABASE_ADMISSION_CONFIRMATION = "ACTIVATE DATABASE ADMISSION";

type AdmissionStatus = {
  configuredEpoch: string | null;
  phase: "unconfigured" | "missing" | "prepared" | "active" | "closed";
  activeEpoch: string | null;
  workerDeploymentVersion: string | null;
  evidenceSha256: string | null;
  observedAt: string | null;
  readyAt: string | null;
  activatedAt: string | null;
  projectIdFloor: number | null;
  canActivate: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatus(value: unknown): AdmissionStatus | null {
  if (!isRecord(value)) return null;
  const phase = value.phase;
  if (!new Set(["unconfigured", "missing", "prepared", "active", "closed"]).has(String(phase))) {
    return null;
  }
  if (
    !(value.configuredEpoch === null || typeof value.configuredEpoch === "string") ||
    !(value.activeEpoch === null || typeof value.activeEpoch === "string") ||
    !(
      value.workerDeploymentVersion === null || typeof value.workerDeploymentVersion === "string"
    ) ||
    !(value.evidenceSha256 === null || typeof value.evidenceSha256 === "string") ||
    !(value.observedAt === null || typeof value.observedAt === "string") ||
    !(value.readyAt === null || typeof value.readyAt === "string") ||
    !(value.activatedAt === null || typeof value.activatedAt === "string") ||
    !(value.projectIdFloor === null || Number.isSafeInteger(value.projectIdFloor)) ||
    typeof value.canActivate !== "boolean"
  ) {
    return null;
  }
  return value as AdmissionStatus;
}

function phaseSummary(status: AdmissionStatus): string {
  if (status.phase === "active") {
    return "Active. Every future production database allocation requires a durable project-birth receipt.";
  }
  if (status.phase === "prepared") {
    return status.canActivate
      ? "Prepared and drained. The boundary is ready for owner activation."
      : "Prepared. The mandatory six-minute safety drain is still running.";
  }
  if (status.phase === "missing") {
    return "Configured but not prepared in the production database.";
  }
  if (status.phase === "closed") {
    return "This epoch is closed. A new coordinated release epoch is required.";
  }
  return "Replit and Cloudflare do not have a valid shared admission epoch.";
}

export function ProductionDatabaseAdmissionPanel() {
  const [status, setStatus] = useState<AdmissionStatus | null>(null);
  const [busy, setBusy] = useState<"refresh" | "prepare" | "activate" | null>("refresh");
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const mounted = useRef(true);

  async function requestStatus(action?: "prepare" | "activate") {
    const operation = action ?? "refresh";
    setBusy(operation);
    setFailure(null);
    try {
      const response = await authFetch(
        action
          ? `/api/admin/production-database-admission/${action}`
          : "/api/admin/production-database-admission",
        action ? { method: "POST" } : undefined,
      );
      const parsed = parseStatus(await response.json());
      if (!response.ok || !parsed) throw new Error("unreadable_admission_status");
      if (mounted.current) {
        setStatus(parsed);
        if (action === "activate") setConfirmation("");
      }
    } catch {
      if (mounted.current) {
        setFailure(
          "The admission boundary could not be verified. No project or database was changed.",
        );
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void requestStatus();
    const timer = window.setInterval(() => void requestStatus(), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  const activationConfirmed = confirmation === PRODUCTION_DATABASE_ADMISSION_CONFIRMATION;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Database className="h-3.5 w-3.5" /> Production database admission
        </h3>
        <button
          type="button"
          onClick={() => void requestStatus()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy === "refresh" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <p>
            <strong className="text-foreground">Purpose:</strong> Bind every future Neon allocation
            to an immutable project-birth receipt.
          </p>
          <p>
            <strong className="text-foreground">Safety:</strong> Preparation waits six minutes;
            activation briefly excludes project inserts while reserving the sequence floor.
          </p>
          <p>
            <strong className="text-foreground">Scope:</strong> This control never deletes, moves,
            or edits an existing project.
          </p>
        </div>

        {status && (
          <div
            className={`rounded-lg border p-3 ${status.phase === "active" ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}
            data-testid="production-database-admission-status"
            aria-live="polite"
          >
            <p className="flex items-center gap-2 text-sm font-semibold">
              {status.phase === "active" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-700" />
              ) : (
                <ShieldCheck className="h-4 w-4 text-amber-700" />
              )}
              {phaseSummary(status)}
            </p>
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <p className="break-all">
                Configured epoch: <code>{status.configuredEpoch ?? "unavailable"}</code>
              </p>
              <p className="break-all">
                Active epoch: <code>{status.activeEpoch ?? "none"}</code>
              </p>
              {status.readyAt && (
                <p>Activation ready: {new Date(status.readyAt).toLocaleString()}</p>
              )}
              {status.projectIdFloor !== null && (
                <p>Protected sequence floor: {status.projectIdFloor}</p>
              )}
              {status.workerDeploymentVersion && (
                <p className="break-all">
                  Observed worker: <code>{status.workerDeploymentVersion}</code>
                </p>
              )}
              {status.evidenceSha256 && (
                <p className="break-all">
                  Evidence: <code>{status.evidenceSha256}</code>
                </p>
              )}
            </div>
          </div>
        )}

        {status && status.phase !== "active" && status.phase !== "closed" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void requestStatus("prepare")}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === "prepare" && <Loader2 className="h-4 w-4 animate-spin" />}
              {status.phase === "prepared"
                ? "Revalidate preparation"
                : "Prepare admission boundary"}
            </button>

            {status.phase === "prepared" && (
              <div className="space-y-2 border-t border-border pt-3">
                <label
                  htmlFor="production-database-admission-confirmation"
                  className="block text-sm font-medium"
                >
                  Type{" "}
                  <code className="rounded bg-muted px-1 py-0.5">
                    {PRODUCTION_DATABASE_ADMISSION_CONFIRMATION}
                  </code>{" "}
                  to activate
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id="production-database-admission-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-72 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => void requestStatus("activate")}
                    disabled={busy !== null || !status.canActivate || !activationConfirmed}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {busy === "activate" && <Loader2 className="h-4 w-4 animate-spin" />}
                    Activate admission boundary
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {failure && (
          <p className="text-sm text-destructive" role="alert">
            {failure}
          </p>
        )}
      </div>
    </section>
  );
}
