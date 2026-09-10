import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";

interface LiveHealthReceipt {
  status: "passed" | "failed" | "partial";
  rootStatus: number | null;
  routesChecked: number;
  routesFailed: number;
  failureSummary: string | null;
  createdAt: string;
}

interface PublishingHealthProps {
  projectId: number;
  onShowProdErrors?: () => void;
}

const STAGES = [
  { label: "Building", description: "The app is being prepared for deployment." },
  {
    label: "Deployed",
    description: "A deployment is recorded. Its address still needs a live check.",
  },
  {
    label: "Live verified",
    description: "A live check passed for the routes and time recorded below.",
  },
];

function readReceipt(body: unknown): LiveHealthReceipt | null {
  if (!body || typeof body !== "object" || !("latest" in body))
    throw new Error("Missing health result");
  const latest: unknown = body.latest;
  if (latest === null) return null;
  if (!latest || typeof latest !== "object") throw new Error("Invalid health result");
  const row = latest as Partial<LiveHealthReceipt>;
  if (
    !["passed", "failed", "partial"].includes(String(row.status)) ||
    !(
      row.rootStatus === null ||
      (Number.isInteger(row.rootStatus) &&
        Number(row.rootStatus) >= 100 &&
        Number(row.rootStatus) <= 599)
    ) ||
    !Number.isSafeInteger(row.routesChecked) ||
    Number(row.routesChecked) < 0 ||
    !Number.isSafeInteger(row.routesFailed) ||
    Number(row.routesFailed) < 0 ||
    Number(row.routesFailed) > Number(row.routesChecked) ||
    !(row.failureSummary === null || typeof row.failureSummary === "string") ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    throw new Error("Invalid health result");
  return row as LiveHealthReceipt;
}

export function PublishingHealthBanner(props: PublishingHealthProps) {
  return <ProjectHealthBanner key={props.projectId} {...props} />;
}

function ProjectHealthBanner({ projectId, onShowProdErrors }: PublishingHealthProps) {
  const [latest, setLatest] = useState<LiveHealthReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const loadSequence = useRef(0);
  const runInFlight = useRef(false);

  const load = useCallback(async () => {
    const visit = generation.current;
    const sequence = ++loadSequence.current;
    const current = () => generation.current === visit && loadSequence.current === sequence;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/health-checks`);
      if (!response.ok) throw new Error("Health status unavailable");
      const receipt = readReceipt(await response.json());
      if (current()) setLatest(receipt);
    } catch {
      if (current())
        setLoadError(
          "Live-health status could not be loaded. Retry to read the latest saved result.",
        );
    } finally {
      if (current()) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    generation.current += 1;
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const runNow = async () => {
    if (runInFlight.current) return;
    const visit = generation.current;
    runInFlight.current = true;
    setRunning(true);
    setRunError(null);
    setRunNotice(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/health-checks/run`, {
        method: "POST",
      });
      if (generation.current !== visit) return;
      if (!response.ok) throw new Error("Live check unavailable");
      setRunNotice("A live check was requested. Read the saved result and its timestamp below.");
      await load();
    } catch {
      if (generation.current === visit)
        setRunError("The live check could not be confirmed. Use Run live check to try again.");
    } finally {
      if (generation.current === visit) {
        runInFlight.current = false;
        setRunning(false);
      }
    }
  };

  return (
    <section
      aria-label="Publishing health"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border bg-gradient-to-br from-muted/50 to-background p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Publish status guide
            </p>
            <h2 className="mt-1 text-base font-semibold tracking-tight">
              Build, deployment and live checks
            </h2>
          </div>
          <span className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
            Project #{projectId}
          </span>
        </div>
        <dl aria-label="Publishing status definitions" className="mt-4 grid gap-3 sm:grid-cols-3">
          {STAGES.map((stage) => (
            <div key={stage.label} className="rounded-lg border border-border bg-background/70 p-3">
              <dt className="text-xs font-semibold">{stage.label}</dt>
              <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {stage.description}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Latest live-site observation</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={loading || running}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Refresh saved status
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runNow()}
              disabled={running || loading}
            >
              {running && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {running ? "Requesting check..." : "Run live check"}
            </Button>
          </div>
        </div>
        {loading && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {latest ? "Refreshing saved health status..." : "Loading saved health status..."}
          </p>
        )}
        {loadError && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs"
          >
            <p className="text-destructive">{loadError}</p>
            {latest && (
              <p className="text-muted-foreground">
                The previous observation is retained. Current health could not be refreshed.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void load()}
              disabled={loading || running}
            >
              Retry health status
            </Button>
          </div>
        )}
        {runError && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {runError}
          </p>
        )}
        {runNotice && (
          <p role="status" className="text-xs text-muted-foreground">
            {runNotice}
          </p>
        )}
        {!latest && !loading && !loadError && (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4">
            <h4 className="text-sm font-medium">No saved live check</h4>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Live health is unverified here. Run a live check to request an observation of the
              deployed app.
            </p>
          </div>
        )}
        {latest && (
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-start gap-2">
              {latest.status === "passed" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-foreground" aria-hidden="true" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-semibold">
                  {latest.status === "passed"
                    ? "Last live check passed"
                    : latest.status === "partial"
                      ? "Last live check was partial"
                      : "Last live check failed"}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  Observed{" "}
                  <time dateTime={latest.createdAt}>
                    {new Date(latest.createdAt).toLocaleString()}
                  </time>
                </p>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Root HTTP response</dt>
                <dd className="mt-1 font-medium">{latest.rootStatus ?? "Not reported"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Routes checked</dt>
                <dd className="mt-1 font-medium">
                  {latest.routesChecked} checked / {latest.routesFailed} failed
                </dd>
              </div>
            </dl>
            {latest.failureSummary && (
              <p className="mt-3 break-words text-xs leading-relaxed">{latest.failureSummary}</p>
            )}
            {latest.status !== "passed" && onShowProdErrors && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onShowProdErrors}
                className="mt-3"
              >
                View production errors
              </Button>
            )}
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          This observation is not tied to a deployment revision in the available health record. It
          does not establish domain ownership, DNS propagation, or the health of every custom
          domain.
        </p>
      </div>
    </section>
  );
}
