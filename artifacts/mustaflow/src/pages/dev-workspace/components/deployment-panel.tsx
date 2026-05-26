import { useState, useCallback, useEffect, useRef } from "react";
import {
  X,
  Rocket,
  Globe,
  Zap,
  Server,
  Clock,
  Check,
  Copy,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  History,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

type DeploymentType = "static" | "autoscale" | "reserved_vm" | "scheduled";

interface Secret {
  id: number;
  name: string;
  masked?: string;
  syncToDeployment?: boolean;
}

interface DeploymentLog {
  id: number;
  createdAt: string;
  env: string;
  status: string;
  publicUrl?: string | null;
  publicSlug?: string | null;
  note?: string | null;
  filesCount?: number | null;
  snapshotVersionId?: number | null;
}

interface DeployResult {
  ok: boolean;
  publicUrl: string;
  publicSlug: string;
  deployedAt: string;
  filesDeployed?: number;
  containerDeployed?: boolean;
}

interface DomainStatus {
  verificationStatus?: string;
  sslStatus?: string;
}

const PLATFORM_DOMAIN = "mustaflow.app";

const MACHINE_SIZES = [
  { id: "shared-cpu-1x", label: "Shared CPU · 256 MB", price: "~$2/mo" },
  { id: "performance-1x", label: "1 vCPU · 2 GB", price: "~$10/mo" },
  { id: "performance-2x", label: "2 vCPU · 4 GB", price: "~$20/mo" },
  { id: "performance-4x", label: "4 vCPU · 8 GB", price: "~$40/mo" },
];

const REGIONS = [
  { id: "iad", label: "US East (Virginia)" },
  { id: "lhr", label: "Europe (London)" },
  { id: "fra", label: "Europe (Frankfurt)" },
  { id: "syd", label: "Asia Pacific (Sydney)" },
  { id: "nrt", label: "Asia Pacific (Tokyo)" },
  { id: "sin", label: "Asia Pacific (Singapore)" },
  { id: "sjc", label: "US West (San Jose)" },
];

// ── Small helpers ──────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function TypeCard({
  id: _id,
  label,
  description,
  price,
  icon: Icon,
  active,
  onClick,
  badge,
}: {
  id: DeploymentType;
  label: string;
  description: string;
  price: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative text-left rounded-xl border p-3 transition-all",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "border-border bg-card/60 hover:border-primary/40 hover:bg-card",
      )}
    >
      {active && (
        <div className="absolute top-2 right-2">
          <div className="h-4 w-4 rounded-full bg-primary flex items-center justify-center">
            <Check className="h-2.5 w-2.5 text-primary-foreground" />
          </div>
        </div>
      )}
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
            active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground">{label}</span>
            {badge && (
              <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                {badge}
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{description}</div>
          <div className="text-[10px] font-medium text-foreground/70 mt-1">{price}</div>
        </div>
      </div>
    </button>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DeploymentPanel({
  projectId,
  projectSlug,
  onClose,
}: {
  projectId: number;
  projectSlug: string | null | undefined;
  onClose: () => void;
}) {
  // ── Deployment type ─────────────────────────────────────────────────────────
  const [deployType, setDeployType] = useState<DeploymentType>("static");
  const [machineSize, setMachineSize] = useState("shared-cpu-1x");
  const [region, setRegion] = useState("iad");
  const [cronExpr, setCronExpr] = useState("0 * * * *");
  const [buildCmd, setBuildCmd] = useState("npm run build");
  const [runCmd, setRunCmd] = useState("node server.js");
  const [outputDir, setOutputDir] = useState("dist");

  // ── URL / domain ───────────────────────────────────────────────────────────
  const autoSlug = projectSlug ?? `project-${projectId}`;
  const [customSlug, setCustomSlug] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);

  // ── Custom domain ──────────────────────────────────────────────────────────
  const [customDomain, setCustomDomain] = useState("");
  const [domainInput, setDomainInput] = useState("");
  const [domainStatus, setDomainStatus] = useState<DomainStatus | null>(null);
  const [savingDomain, setSavingDomain] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  // ── Secrets ────────────────────────────────────────────────────────────────
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [secretsExpanded, setSecretsExpanded] = useState(false);

  // ── Deploy state ───────────────────────────────────────────────────────────
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // ── History ────────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<DeploymentLog[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // ── Config loading ─────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const [cfgRes, secRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/deployment-config`),
        fetch(`/api/projects/${projectId}/secrets`),
      ]);
      if (cfgRes.ok) {
        const cfg = (await cfgRes.json()) as {
          deploymentType?: string;
          region?: string;
        };
        if (cfg.deploymentType) setDeployType(cfg.deploymentType as DeploymentType);
        if (cfg.region) setRegion(cfg.region);
      }
      if (secRes.ok) {
        // GET /api/projects/:id/secrets returns a raw array (not { secrets: [...] })
        const secData = (await secRes.json()) as Secret[] | { secrets?: Secret[] };
        const arr = Array.isArray(secData) ? secData : (secData.secrets ?? []);
        setSecrets(arr.map((s) => ({ ...s, syncToDeployment: true })));
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/deployments`);
      if (res.ok) {
        const data = (await res.json()) as { deployments?: DeploymentLog[] };
        setHistory(data.deployments ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingHistory(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // Auto-scroll build log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [buildLog]);

  // ── Save custom domain ─────────────────────────────────────────────────────
  const handleSaveDomain = useCallback(async () => {
    const domain = domainInput
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (!domain) return;
    setSavingDomain(true);
    setDomainError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: domain }),
      });
      const data = (await res.json()) as {
        error?: string;
        verificationStatus?: string;
        sslStatus?: string;
      };
      if (!res.ok) {
        setDomainError(data.error ?? `HTTP ${res.status}`);
      } else {
        setCustomDomain(domain);
        setDomainStatus({ verificationStatus: data.verificationStatus, sslStatus: data.sslStatus });
      }
    } catch (err) {
      setDomainError(err instanceof Error ? err.message : "Failed to add domain");
    } finally {
      setSavingDomain(false);
    }
  }, [projectId, domainInput]);

  // ── Rollback a history entry ────────────────────────────────────────────────
  const [rollingBack, setRollingBack] = useState<number | null>(null);

  const handleRollback = useCallback(
    async (versionId: number) => {
      setRollingBack(versionId);
      try {
        const res = await fetch(`/api/projects/${projectId}/versions/${versionId}/rollback`, {
          method: "POST",
        });
        if (res.ok) {
          void loadHistory();
        }
      } catch {
        /* ignore */
      } finally {
        setRollingBack(null);
      }
    },
    [projectId, loadHistory],
  );

  // ── Deploy ─────────────────────────────────────────────────────────────────
  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    setDeployError(null);
    setDeployResult(null);
    setBuildLog(["Initiating deployment…"]);

    try {
      // 1. Persist deployment type + region config
      await fetch(`/api/projects/${projectId}/deployment-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentType: deployType, region }),
      });

      setBuildLog((l) => [
        ...l,
        `Deployment type: ${deployType}`,
        `Region: ${region}`,
        "Snapshotting project files…",
      ]);

      // 2. If user set a custom subdomain, persist it on the project before deploying
      const slugToApply = customSlug.trim();
      if (slugToApply) {
        setBuildLog((l) => [...l, `Setting subdomain: ${slugToApply}.${PLATFORM_DOMAIN}…`]);
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicSlug: slugToApply }),
        });
      }

      // 3. For Scheduled type, upsert a deployment schedule with the cron expression
      if (deployType === "scheduled" && cronExpr.trim()) {
        setBuildLog((l) => [...l, `Registering schedule: ${cronExpr}…`]);
        const schRes = await fetch(`/api/projects/${projectId}/schedules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cronExpr: cronExpr.trim(), kind: "task_run", enabled: true }),
        });
        if (!schRes.ok) {
          const schData = (await schRes.json()) as { error?: string };
          setDeployError(schData.error ?? "Failed to create schedule");
          setBuildLog((l) => [...l, `Schedule error: ${schData.error ?? "unknown"}`]);
          return;
        }
        setBuildLog((l) => [...l, "Schedule created."]);
      }

      // 4. Trigger the deploy — include selected secret IDs so the server
      //    filters which secrets are injected into the container env.
      const syncedSecretIds = secrets
        .filter((s) => s.syncToDeployment)
        .map((s) => s.id);

      setBuildLog((l) => [
        ...l,
        `Syncing ${syncedSecretIds.length} secret${syncedSecretIds.length !== 1 ? "s" : ""}…`,
      ]);

      const res = await fetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deploymentType: deployType,
          secretIds: syncedSecretIds,
        }),
      });

      const data = (await res.json()) as DeployResult & { error?: string };

      if (!res.ok) {
        setDeployError(data.error ?? `HTTP ${res.status}`);
        setBuildLog((l) => [...l, `Error: ${data.error ?? "Deploy failed"}`]);
        return;
      }

      setBuildLog((l) => [
        ...l,
        `Snapshot created — ${data.filesDeployed ?? 0} file${(data.filesDeployed ?? 0) !== 1 ? "s" : ""} snapshotted.`,
        data.containerDeployed
          ? "Container blue/green swap complete."
          : "Pushed to edge CDN.",
        `Deployment recorded: ${new Date(data.deployedAt).toLocaleTimeString()}`,
        `Live at: ${data.publicUrl}`,
        "Done.",
      ]);
      setDeployResult(data);
      void loadHistory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Deploy failed";
      setDeployError(msg);
      setBuildLog((l) => [...l, `Error: ${msg}`]);
    } finally {
      setDeploying(false);
    }
  }, [projectId, deployType, region, cronExpr, customSlug, secrets, loadHistory]);

  // ── Domain verification check ──────────────────────────────────────────────
  const checkDomainStatus = useCallback(async () => {
    if (!customDomain) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/deployments/domain-status?domain=${encodeURIComponent(customDomain)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as DomainStatus;
        setDomainStatus(data);
      }
    } catch {
      /* ignore */
    }
  }, [projectId, customDomain]);

  useEffect(() => {
    if (!customDomain) return;
    const t = setInterval(() => void checkDomainStatus(), 15_000);
    return () => clearInterval(t);
  }, [customDomain, checkDomainStatus]);

  // ── Toggle secrets ─────────────────────────────────────────────────────────
  const toggleSecret = (id: number) => {
    setSecrets((prev) =>
      prev.map((s) => (s.id === id ? { ...s, syncToDeployment: !s.syncToDeployment } : s)),
    );
  };

  const effectiveSlug = customSlug.trim() || autoSlug;
  const liveUrl = `https://${effectiveSlug}.${PLATFORM_DOMAIN}/`;

  const cnameTarget = `hosted.${PLATFORM_DOMAIN}`;

  const domainStatusColor =
    domainStatus?.verificationStatus === "verified"
      ? "text-green-400"
      : domainStatus?.verificationStatus === "pending"
        ? "text-yellow-400"
        : "text-muted-foreground";

  const domainStatusLabel =
    domainStatus?.verificationStatus === "verified"
      ? "Verified"
      : domainStatus?.verificationStatus === "pending"
        ? "Pending DNS"
        : domainStatus?.sslStatus === "active"
          ? "Active"
          : "Not configured";

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-[480px] h-full bg-zinc-950 border-l border-border flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Rocket className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Deploy</h2>
              <p className="text-[10px] text-muted-foreground">Configure and launch your project</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* ── Deployment Type ─────────────────────────────────────────────── */}
          <section>
            <SectionHeading>Deployment type</SectionHeading>
            <div className="grid grid-cols-2 gap-2">
              <TypeCard
                id="static"
                label="Static"
                description="HTML/CSS/JS served from the global edge CDN. Free."
                price="Free"
                icon={Globe}
                active={deployType === "static"}
                onClick={() => setDeployType("static")}
              />
              <TypeCard
                id="autoscale"
                label="Autoscale"
                description="Web apps with variable traffic. Scales to zero when idle."
                price="~$0.01/req"
                icon={Zap}
                active={deployType === "autoscale"}
                onClick={() => setDeployType("autoscale")}
                badge="Core"
              />
              <TypeCard
                id="reserved_vm"
                label="Reserved VM"
                description="Always-on. Best for WebSockets, APIs, background services."
                price="From $5/mo"
                icon={Server}
                active={deployType === "reserved_vm"}
                onClick={() => setDeployType("reserved_vm")}
              />
              <TypeCard
                id="scheduled"
                label="Scheduled"
                description="Runs on a cron schedule. Best for periodic tasks and jobs."
                price="Per execution"
                icon={Clock}
                active={deployType === "scheduled"}
                onClick={() => setDeployType("scheduled")}
              />
            </div>
          </section>

          {/* ── Per-type config ─────────────────────────────────────────────── */}
          {deployType === "static" && (
            <section className="space-y-3">
              <SectionHeading>Static configuration</SectionHeading>
              <Field label="Build command" hint="Leave blank if no build step is required.">
                <input
                  value={buildCmd}
                  onChange={(e) => setBuildCmd(e.target.value)}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </Field>
              <Field label="Output directory" hint="Relative path to the folder of built files.">
                <input
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </Field>
            </section>
          )}

          {(deployType === "autoscale" || deployType === "reserved_vm") && (
            <section className="space-y-3">
              <SectionHeading>
                {deployType === "autoscale"
                  ? "Autoscale configuration"
                  : "Reserved VM configuration"}
              </SectionHeading>
              <Field label="Run command">
                <input
                  value={runCmd}
                  onChange={(e) => setRunCmd(e.target.value)}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </Field>
              <Field label="Machine size">
                <div className="space-y-1.5">
                  {MACHINE_SIZES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setMachineSize(s.id)}
                      className={cn(
                        "w-full text-left flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-all",
                        machineSize === s.id
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border bg-muted/40 text-muted-foreground hover:border-primary/40",
                      )}
                    >
                      <span>{s.label}</span>
                      <span className="font-medium">{s.price}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Region">
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {REGIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
            </section>
          )}

          {deployType === "scheduled" && (
            <section className="space-y-3">
              <SectionHeading>Scheduled configuration</SectionHeading>
              <Field
                label="Cron expression"
                hint="Use standard cron syntax: minute hour day month weekday"
              >
                <input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="0 * * * *"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </Field>
              <div className="flex gap-2 text-[10px] text-muted-foreground flex-wrap">
                {[
                  ["Every hour", "0 * * * *"],
                  ["Daily at midnight", "0 0 * * *"],
                  ["Weekly (Mon)", "0 0 * * 1"],
                  ["Every 15 min", "*/15 * * * *"],
                ].map(([label, value]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setCronExpr(value)}
                    className={cn(
                      "px-2 py-0.5 rounded border text-[10px] transition-colors",
                      cronExpr === value
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-muted hover:border-primary/40",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Field label="Run command" hint="Command executed on each scheduled run.">
                <input
                  value={runCmd}
                  onChange={(e) => setRunCmd(e.target.value)}
                  className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </Field>
            </section>
          )}

          {/* ── URL / Domain ─────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <SectionHeading>URL &amp; domain</SectionHeading>

            {/* Auto-generated URL */}
            <div className="bg-muted/40 border border-border rounded-xl p-3 space-y-3">
              <div>
                <div className="text-[10px] text-muted-foreground mb-1">
                  Auto-generated subdomain
                </div>
                <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono text-foreground flex-1 truncate">
                    {liveUrl}
                  </span>
                  <CopyButton value={liveUrl} />
                </div>
              </div>

              {/* Subdomain customisation */}
              <div>
                <div className="text-[10px] text-muted-foreground mb-1">
                  Customize subdomain <span className="opacity-60">(optional)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    value={customSlug}
                    onChange={(e) =>
                      setCustomSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                    }
                    placeholder={autoSlug}
                    className="flex-1 bg-background border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    .{PLATFORM_DOMAIN}
                  </span>
                </div>
              </div>

              {/* Privacy toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isPrivate ? (
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {isPrivate ? "Password protected" : "Public"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsPrivate((v) => !v)}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                    isPrivate ? "bg-primary" : "bg-muted-foreground/30",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform shadow",
                      isPrivate ? "translate-x-[18px]" : "translate-x-[3px]",
                    )}
                  />
                </button>
              </div>
            </div>

            {/* Custom domain */}
            <div className="border border-border rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">Custom domain</span>
                {customDomain && (
                  <span className={cn("text-[10px] font-medium", domainStatusColor)}>
                    {domainStatusLabel}
                  </span>
                )}
              </div>

              {!customDomain ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      placeholder="yourdomain.com"
                      className="flex-1 bg-muted border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!domainInput.trim() || savingDomain}
                      onClick={() => void handleSaveDomain()}
                      className="shrink-0 h-7 text-xs"
                    >
                      {savingDomain ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                    </Button>
                  </div>
                  {domainError && (
                    <div className="flex items-center gap-1.5 text-[10px] text-destructive">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      {domainError}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Free SSL certificate via Let's Encrypt. Provisioned automatically after DNS
                    verification.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono text-foreground flex-1 truncate">
                      {customDomain}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomDomain("");
                        setDomainInput("");
                        setDomainStatus(null);
                      }}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Remove
                    </button>
                  </div>

                  {/* DNS records — apex domains (no subdomain) use A records;
                      subdomains use a single CNAME.
                      Apex detection: hostname with exactly 2 dot-separated labels
                      is an apex zone (e.g. "example.com"). */}
                  {(() => {
                    const isApex = customDomain.split(".").length <= 2;
                    const dnsRows: { type: string; name: string; value: string }[] = isApex
                      ? [
                          { type: "A", name: "@", value: "76.76.21.21" },
                          { type: "CNAME", name: "www", value: cnameTarget },
                        ]
                      : [{ type: "CNAME", name: customDomain, value: cnameTarget }];
                    return (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-medium text-muted-foreground">
                          Required DNS records
                        </div>
                        <div className="rounded-lg border border-border overflow-hidden text-[10px] font-mono">
                          <div className="grid grid-cols-3 bg-muted/50 px-2 py-1 text-[9px] font-sans font-semibold text-muted-foreground uppercase tracking-wide">
                            <span>Type</span>
                            <span>Name</span>
                            <span>Value</span>
                          </div>
                          {dnsRows.map((row, i) => (
                            <div
                              key={i}
                              className="grid grid-cols-3 border-t border-border px-2 py-1.5 bg-card/50"
                            >
                              <span className="text-blue-400">{row.type}</span>
                              <div className="flex items-center gap-1 min-w-0">
                                <span className="truncate">{row.name}</span>
                                <CopyButton value={row.name} />
                              </div>
                              <div className="flex items-center gap-1 min-w-0">
                                <span className="truncate">{row.value}</span>
                                <CopyButton value={row.value} />
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {isApex
                            ? "Apex domains require an A record. Add the CNAME for www to redirect www visitors to your apex domain."
                            : "DNS changes can take up to 48 hours to propagate."}
                        </p>
                      </div>
                    );
                  })()}

                  {/* SSL status */}
                  <div className="flex items-center gap-2 text-[10px]">
                    <ShieldCheck
                      className={cn(
                        "h-3.5 w-3.5",
                        domainStatus?.sslStatus === "active"
                          ? "text-green-400"
                          : "text-muted-foreground",
                      )}
                    />
                    <span className="text-muted-foreground">
                      SSL:{" "}
                      {domainStatus?.sslStatus === "active"
                        ? "Active (Let's Encrypt)"
                        : "Pending provisioning"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void checkDomainStatus()}
                      className="ml-auto text-muted-foreground hover:text-foreground"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── Secrets sync ─────────────────────────────────────────────────── */}
          {secrets.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setSecretsExpanded((v) => !v)}
                className="flex items-center justify-between w-full mb-2"
              >
                <SectionHeading>
                  Secrets sync{" "}
                  <span className="normal-case font-normal text-muted-foreground/60">
                    ({secrets.filter((s) => s.syncToDeployment).length}/{secrets.length} synced)
                  </span>
                </SectionHeading>
                {secretsExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>

              {secretsExpanded && (
                <div className="space-y-1.5">
                  {secrets.map((secret) => (
                    <div
                      key={secret.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border bg-card/60"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="text-xs font-mono text-foreground truncate">
                          {secret.name}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleSecret(secret.id)}
                        className={cn(
                          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                          secret.syncToDeployment ? "bg-primary" : "bg-muted-foreground/30",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-block h-3 w-3 rounded-full bg-white transition-transform shadow",
                            secret.syncToDeployment ? "translate-x-[14px]" : "translate-x-[2px]",
                          )}
                        />
                      </button>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Secrets are encrypted and injected into the deployment environment. Workspace
                    secrets sync automatically by default.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* ── Build log ─────────────────────────────────────────────────────── */}
          {buildLog.length > 0 && (
            <section>
              <SectionHeading>Build log</SectionHeading>
              <div className="bg-zinc-900 border border-border rounded-xl p-3 font-mono text-[10px] text-green-400 max-h-40 overflow-y-auto space-y-0.5">
                {buildLog.map((line, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-muted-foreground/50 shrink-0 select-none">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className={line.startsWith("Error:") ? "text-red-400" : undefined}>
                      {line}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </section>
          )}

          {/* ── Success state ──────────────────────────────────────────────────── */}
          {deployResult && (
            <section className="border border-green-500/20 bg-green-500/5 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-green-400 text-sm font-semibold">
                <CheckCircle2 className="h-4 w-4" />
                Deployed successfully
              </div>
              <div className="flex items-center gap-2 bg-background/60 rounded-lg px-3 py-2 min-w-0">
                <Globe className="h-3.5 w-3.5 text-green-400 shrink-0" />
                <a
                  href={deployResult.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono text-primary hover:underline flex-1 truncate"
                >
                  {deployResult.publicUrl}
                </a>
                <CopyButton value={deployResult.publicUrl} />
                <a
                  href={deployResult.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {deployResult.filesDeployed} file{deployResult.filesDeployed !== 1 ? "s" : ""}{" "}
                deployed · {new Date(deployResult.deployedAt).toLocaleString()}
              </div>
            </section>
          )}

          {/* ── Deployment history ─────────────────────────────────────────────── */}
          <section>
            <button
              type="button"
              onClick={() => {
                setHistoryExpanded((v) => !v);
                if (!historyExpanded && history.length === 0) void loadHistory();
              }}
              className="flex items-center justify-between w-full mb-2"
            >
              <SectionHeading>
                <span className="flex items-center gap-1.5">
                  <History className="h-3 w-3" />
                  Deployment history
                </span>
              </SectionHeading>
              {historyExpanded ? (
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>

            {historyExpanded && (
              <div className="space-y-1.5">
                {loadingHistory ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : history.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic text-center py-4">
                    No deployments yet.
                  </p>
                ) : (
                  history.slice(0, 10).map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-border bg-card/60"
                    >
                      <div
                        className={cn(
                          "h-2 w-2 rounded-full mt-1.5 shrink-0",
                          entry.status === "passed" || entry.status === "published"
                            ? "bg-green-400"
                            : entry.status === "failed"
                              ? "bg-red-400"
                              : "bg-muted-foreground/40",
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={cn(
                              "text-[10px] font-medium capitalize",
                              entry.status === "passed" || entry.status === "published"
                                ? "text-green-400"
                                : entry.status === "failed"
                                  ? "text-red-400"
                                  : "text-muted-foreground",
                            )}
                          >
                            {entry.status}
                          </span>
                          <span className="text-[10px] text-muted-foreground">·</span>
                          <span className="text-[10px] text-muted-foreground uppercase">
                            {entry.env}
                          </span>
                          {entry.filesCount != null && (
                            <>
                              <span className="text-[10px] text-muted-foreground">·</span>
                              <span className="text-[10px] text-muted-foreground">
                                {entry.filesCount} files
                              </span>
                            </>
                          )}
                        </div>
                        {entry.publicUrl && (
                          <a
                            href={entry.publicUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] text-primary hover:underline truncate flex items-center gap-1 mt-0.5"
                          >
                            <span className="truncate">{entry.publicUrl}</span>
                            <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                          </a>
                        )}
                        {entry.note && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                            {entry.note}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                          {new Date(entry.createdAt).toLocaleDateString()}
                        </span>
                        {entry.snapshotVersionId && (
                          <button
                            type="button"
                            title="Roll back to this deployment"
                            disabled={rollingBack === entry.snapshotVersionId}
                            onClick={() => void handleRollback(entry.snapshotVersionId!)}
                            className="ml-1 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          >
                            {rollingBack === entry.snapshotVersionId ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        </div>

        {/* ── Footer: Deploy button ──────────────────────────────────────────── */}
        {!deployResult && (
          <div className="shrink-0 border-t border-border p-4 space-y-2">
            {deployError && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{deployError}</span>
              </div>
            )}
            <Button
              className="w-full gap-2"
              onClick={() => void handleDeploy()}
              disabled={deploying}
            >
              {deploying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              {deploying
                ? "Deploying…"
                : `Deploy to ${deployType === "static" ? "CDN" : deployType === "autoscale" ? "Autoscale" : deployType === "reserved_vm" ? "Reserved VM" : "Schedule"}`}
            </Button>
          </div>
        )}

        {deployResult && (
          <div className="shrink-0 border-t border-border p-4 flex gap-2">
            <a href={deployResult.publicUrl} target="_blank" rel="noreferrer" className="flex-1">
              <Button variant="outline" className="w-full gap-2">
                <ExternalLink className="h-3.5 w-3.5" />
                Visit
              </Button>
            </a>
            <Button
              variant="ghost"
              onClick={() => {
                setDeployResult(null);
                setBuildLog([]);
                setDeployError(null);
              }}
              className="flex-1 gap-2"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Redeploy
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
