import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  Globe,
  Smartphone,
  PlaySquare,
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  Server,
  ToggleLeft,
  ToggleRight,
  Lock,
  FileText,
  Image,
  Camera,
  UserCheck,
  Loader2,
  Copy,
  Check,
  XCircle,
  Info,
  Save,
  Key,
  KeyRound,
  ExternalLink,
  Terminal,
  AlertCircle,
  QrCode,
  Package,
  Link2,
  Github,
  Rocket,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEventSource } from "@/lib/use-event-source";
import {
  getGetProjectQueryKey,
  useListVersions,
  getListVersionsQueryKey,
  useApproveVersionForTesting,
  useProvisionPreviewDatabase,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { DnsRecordsPanel, RegistrarGuideSection } from "./dns-records-panel";
import { EmailSetupWizard } from "./email-setup-wizard";
import { WebhooksPanel } from "./webhooks-panel";
import { DomainAnalyticsCard } from "./domain-analytics-card";
import { DomainPurchaseWidget } from "./domain-purchase-widget";
import { useWorkspace } from "@/contexts/workspace-context";
import type { InlineSurfaceActivityUpdate } from "./inline-activity-stream";
import { SupportReportLink } from "@/components/support-report-link";

// ─── Post-publish health banner (Task #511) ─────────────────────────────────
function HealthCheckBanner({
  projectId,
  onShowProdErrors,
}: {
  projectId: number;
  onShowProdErrors?: () => void;
}) {
  const [latest, setLatest] = useState<{
    status: "passed" | "failed" | "partial";
    rootStatus: number | null;
    routesChecked: number;
    routesFailed: number;
    failureSummary: string | null;
    createdAt: string;
  } | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await authFetch(`/api/projects/${projectId}/health-checks`);
      if (r.ok) {
        const data = (await r.json()) as { latest: typeof latest };
        setLatest(data.latest ?? null);
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const r = await authFetch(`/api/projects/${projectId}/health-checks/run`, { method: "POST" });
      if (r.ok) await load();
    } catch {
      /* ignore */
    } finally {
      setRunning(false);
    }
  }, [projectId, load]);

  if (!latest) return null;

  const tone =
    latest.status === "passed"
      ? "bg-green-500/5 border-green-500/30 text-green-400"
      : latest.status === "partial"
        ? "bg-amber-500/5 border-amber-500/30 text-amber-400"
        : "bg-destructive/5 border-destructive/30 text-destructive";

  const Icon =
    latest.status === "passed"
      ? CheckCircle2
      : latest.status === "partial"
        ? AlertTriangle
        : XCircle;

  return (
    <div className={cn("border rounded-xl p-4 flex items-start gap-3", tone)}>
      <Icon className="h-5 w-5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold capitalize">Health check {latest.status}</span>
          <span className="text-[11px] opacity-80">
            · root {latest.rootStatus ?? "—"} · {latest.routesFailed}/{latest.routesChecked} routes
            failed
          </span>
          <div className="ml-auto flex items-center gap-3">
            {latest.status !== "passed" && onShowProdErrors && (
              <button
                type="button"
                onClick={onShowProdErrors}
                className="text-[11px] underline opacity-80 hover:opacity-100"
              >
                Show me prod errors
              </button>
            )}
            <button
              type="button"
              onClick={() => void runNow()}
              disabled={running}
              className="text-[11px] underline opacity-80 hover:opacity-100 disabled:opacity-50"
            >
              {running ? "Running…" : "Re-check"}
            </button>
          </div>
        </div>
        {latest.failureSummary && (
          <div className="text-[12px] opacity-90 mt-1">{latest.failureSummary}</div>
        )}
        <div className="text-[10px] opacity-60 mt-1">
          Last run: {new Date(latest.createdAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      title="Copy URL"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function DnsTable({ rows }: { rows: { type: string; name: string; value: string }[] }) {
  return (
    <div className="rounded-md bg-background border border-border overflow-hidden text-xs font-mono">
      <div className="grid grid-cols-3 gap-px bg-border">
        {["Type", "Name", "Value"].map((h) => (
          <div key={h} className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">
            {h}
          </div>
        ))}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-3 gap-px bg-border">
          <div className="bg-card px-2 py-1.5">{row.type}</div>
          <div className="bg-card px-2 py-1.5 flex items-center gap-1 min-w-0">
            <span className="truncate">{row.name}</span>
            <CopyUrlButton url={row.name} />
          </div>
          <div className="bg-card px-2 py-1.5 flex items-center gap-1 min-w-0">
            <span className="truncate">{row.value}</span>
            <CopyUrlButton url={row.value} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EasCredVerifyButton({
  secretId,
  projectId,
  initialStatus,
  onVerified,
}: {
  secretId: number;
  projectId: number;
  initialStatus: string;
  onVerified?: (status: string) => void;
}) {
  const [status, setStatus] = useState(initialStatus ?? "unverified");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const verify = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/secrets/${secretId}/verify`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as { status: string; message?: string };
        setStatus(data.status);
        setMessage(data.message ?? null);
        onVerified?.(data.status);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId, secretId, onVerified]);

  const statusIcon =
    status === "verified" ? (
      <CheckCircle2 className="h-3 w-3 text-green-500" />
    ) : status === "verification_failed" ? (
      <XCircle className="h-3 w-3 text-destructive" />
    ) : (
      <AlertCircle className="h-3 w-3 text-muted-foreground" />
    );

  return (
    <div className="shrink-0 flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1">
        {statusIcon}
        <button
          onClick={() => void verify()}
          disabled={loading}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 whitespace-nowrap"
          title={message ?? undefined}
        >
          {loading ? "Checking…" : status === "verified" ? "Re-verify" : "Verify"}
        </button>
      </div>
      {message && (
        <span
          className={cn(
            "text-[9px] max-w-[120px] text-right leading-tight",
            status === "verified"
              ? "text-green-500"
              : status === "verification_failed"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          {message}
        </span>
      )}
    </div>
  );
}

type ChecklistItem = {
  id: string;
  label: string;
  description?: string;
  icon?: React.ElementType;
  required: boolean;
};

type ChecklistSection = {
  title: string;
  items: ChecklistItem[];
};

const WEB_TESTING_CHECKLIST: ChecklistSection[] = [
  {
    title: "Build & Preview",
    items: [
      { id: "w-build", label: "App builds without errors", required: true },
      { id: "w-preview", label: "Preview renders correctly in all device sizes", required: true },
      { id: "w-console", label: "No console errors in preview", required: true },
    ],
  },
  {
    title: "Content & Links",
    items: [
      {
        id: "w-content",
        label: "All placeholder content replaced with real content",
        required: true,
      },
      { id: "w-links", label: "All navigation links work", required: true },
      { id: "w-forms", label: "Contact / signup forms submit correctly", required: false },
    ],
  },
];

const WEB_PRODUCTION_CHECKLIST: ChecklistSection[] = [
  {
    title: "Pre-publish Gates",
    items: [
      {
        id: "wp-secrets",
        label: "Production secrets configured (not test keys)",
        icon: Lock,
        required: true,
      },
      {
        id: "wp-rollback",
        label: "Rollback point saved (latest version snapshot)",
        icon: RefreshCw,
        required: true,
      },
      {
        id: "wp-env",
        label: "Environment validated — no dev / test keys in production",
        icon: ShieldCheck,
        required: true,
      },
      {
        id: "wp-report",
        label: "Test report reviewed and approved",
        icon: FileText,
        required: true,
      },
    ],
  },
  {
    title: "Performance & Security",
    items: [
      { id: "wp-perf", label: "Lighthouse score checked (target 90+)", required: false },
      { id: "wp-privacy", label: "Privacy policy linked", icon: UserCheck, required: false },
      { id: "wp-https", label: "HTTPS enforced on custom domain", required: true },
    ],
  },
];

const IOS_CHECKLIST: ChecklistSection[] = [
  {
    title: "Apple Developer Requirements",
    items: [
      {
        id: "ios-account",
        label: "Apple Developer account active ($99 / yr)",
        icon: UserCheck,
        required: true,
      },
      { id: "ios-bundleid", label: "Bundle ID registered (com.yourco.appname)", required: true },
      {
        id: "ios-certs",
        label: "Distribution certificate and provisioning profile created",
        required: true,
      },
    ],
  },
  {
    title: "App Assets",
    items: [
      {
        id: "ios-icon",
        label: "App icon set (1024×1024 PNG, no alpha, no rounded corners)",
        icon: Image,
        required: true,
      },
      { id: "ios-splash", label: "Launch screen / splash configured", required: true },
      {
        id: "ios-screenshots",
        label: 'App Store screenshots (6.7", 6.1", iPad 12.9")',
        icon: Camera,
        required: true,
      },
    ],
  },
  {
    title: "TestFlight",
    items: [
      { id: "ios-expo", label: "Expo build configured (eas build --platform ios)", required: true },
      { id: "ios-tf-upload", label: "IPA uploaded to App Store Connect", required: true },
      {
        id: "ios-tf-testers",
        label: "TestFlight testers invited and build distributed",
        required: true,
      },
      {
        id: "ios-tf-feedback",
        label: "TestFlight feedback collected and addressed",
        required: true,
      },
    ],
  },
  {
    title: "App Store Submission",
    items: [
      { id: "ios-privacy", label: "Privacy policy URL added", icon: UserCheck, required: true },
      { id: "ios-desc", label: "App Store description and keywords written", required: true },
      { id: "ios-category", label: "Category and age rating selected", required: true },
      { id: "ios-review", label: "App submitted for Apple review (1–3 days)", required: true },
    ],
  },
];

const ANDROID_CHECKLIST: ChecklistSection[] = [
  {
    title: "Google Play Requirements",
    items: [
      {
        id: "and-account",
        label: "Google Play Developer account active ($25 one-time)",
        icon: UserCheck,
        required: true,
      },
      { id: "and-pkg", label: "Package name registered (com.yourco.appname)", required: true },
      {
        id: "and-keystore",
        label: "Upload keystore generated and stored securely",
        required: true,
      },
    ],
  },
  {
    title: "App Assets",
    items: [
      {
        id: "and-icon",
        label: "App icon (512×512 PNG) and adaptive icon configured",
        icon: Image,
        required: true,
      },
      { id: "and-feature", label: "Feature graphic (1024×500 PNG)", required: true },
      {
        id: "and-screenshots",
        label: 'Play Store screenshots (phone + 7" tablet)',
        icon: Camera,
        required: true,
      },
    ],
  },
  {
    title: "Build & Upload",
    items: [
      {
        id: "and-expo",
        label: "Expo build configured (eas build --platform android)",
        required: true,
      },
      { id: "and-aab", label: "Android App Bundle (.aab) built and uploaded", required: true },
      { id: "and-track", label: "Internal / closed testing track configured", required: true },
      { id: "and-feedback", label: "Testing feedback collected and addressed", required: true },
    ],
  },
  {
    title: "Play Store Submission",
    items: [
      { id: "and-privacy", label: "Privacy policy URL added", icon: UserCheck, required: true },
      { id: "and-desc", label: "Store listing description (short + full) written", required: true },
      { id: "and-content", label: "Content rating questionnaire completed", required: true },
      { id: "and-review", label: "App submitted for Google review (1–7 days)", required: true },
    ],
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({
  sections,
  checked,
}: {
  sections: ChecklistSection[];
  checked: Set<string>;
}) {
  const required = sections.flatMap((s) => s.items).filter((i) => i.required);
  const done = required.filter((i) => checked.has(i.id));
  const pct = required.length === 0 ? 0 : Math.round((done.length / required.length) * 100);
  return (
    <div className="flex items-center gap-3 min-w-[160px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct === 100 ? "bg-green-500" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {done.length}/{required.length} required
      </span>
    </div>
  );
}

function ChecklistGroup({
  sections,
  checked,
  onToggle,
}: {
  sections: ChecklistSection[];
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.title} className="border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-muted/50 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">{section.title}</span>
            <span className="text-xs text-muted-foreground">
              {section.items.filter((i) => checked.has(i.id)).length}/{section.items.length}
            </span>
          </div>
          <div className="divide-y divide-border">
            {section.items.map((item) => {
              const done = checked.has(item.id);
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => onToggle(item.id)}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                >
                  {done ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                  ) : (
                    <Circle
                      className={cn(
                        "h-4 w-4 shrink-0 mt-0.5",
                        item.required ? "text-muted-foreground" : "text-muted-foreground/40",
                      )}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-sm flex items-center gap-1.5 flex-wrap",
                        done ? "line-through text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                      <span>{item.label}</span>
                      {item.required && !done && (
                        <span className="text-[10px] bg-destructive/15 text-destructive px-1.5 py-0.5 rounded font-medium">
                          required
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── CustomSubdomainPicker ─────────────────────────────────────────────────────
// Lets users pick a human-friendly subdomain after their first publish.
// Calls POST /api/projects/:id/subdomain and updates the displayed URL.

// ── DeploymentSubstratePanel ─────────────────────────────────────────────────
// Task #543: deployment type, region, CDN flag, health-check path, uptime
// summary, schedules CRUD. Uses raw fetch (canvas-variants pattern).
type DeploymentConfig = {
  deploymentType: "static" | "autoscale" | "reserved_vm";
  region: string | null;
  cdnEnabled: boolean;
  cdnLastPushedAt: string | null;
  healthCheckPath: string;
  uptimeAlertEmail: string | null;
  cdn: { configured: boolean; provider: string };
  availableTypes: readonly ("static" | "autoscale" | "reserved_vm")[];
  availableRegions: readonly string[];
  pricing: Record<string, { label: string; price: string; description: string }>;
};
type UptimeSummary = {
  uptimePct: number | null;
  sampleSize: number;
  lastCheck: {
    status: string;
    rootStatus: number | null;
    rootLatencyMs: number | null;
    createdAt: string;
  } | null;
};
type Schedule = {
  id: number;
  kind: "redeploy" | "task_run" | "health_probe";
  cronExpr: string;
  enabled: boolean;
  note: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
};

function DeploymentSubstratePanel({ projectId }: { projectId: number }) {
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [uptime, setUptime] = useState<UptimeSummary | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCron, setNewCron] = useState("0 * * * *");
  const [newKind, setNewKind] = useState<Schedule["kind"]>("health_probe");
  const [newNote, setNewNote] = useState("");
  const [userTier, setUserTier] = useState<string>("free");

  const refresh = useCallback(async () => {
    try {
      const [cRes, uRes, sRes] = await Promise.all([
        authFetch(`/api/projects/${projectId}/deployment-config`),
        authFetch(`/api/projects/${projectId}/uptime`),
        authFetch(`/api/projects/${projectId}/schedules`),
      ]);
      if (cRes.ok) setConfig((await cRes.json()) as DeploymentConfig);
      if (uRes.ok) setUptime((await uRes.json()) as UptimeSummary);
      if (sRes.ok) {
        const data = (await sRes.json()) as { schedules: Schedule[] };
        setSchedules(data.schedules);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await authFetch("/api/billing/subscription");
        if (res.ok) {
          const data = (await res.json()) as { tier?: string };
          setUserTier(data.tier ?? "free");
        }
      } catch {
        /* best-effort */
      }
    })();
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function patch(update: Partial<DeploymentConfig>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/deployment-config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runProbeNow(): Promise<void> {
    setBusy(true);
    try {
      await authFetch(`/api/projects/${projectId}/uptime/probe`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createSchedule(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpr: newCron, kind: newKind, note: newNote || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setNewNote("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleSchedule(id: number, enabled: boolean): Promise<void> {
    await authFetch(`/api/projects/${projectId}/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await refresh();
  }

  async function deleteSchedule(id: number): Promise<void> {
    await authFetch(`/api/projects/${projectId}/schedules/${id}`, { method: "DELETE" });
    await refresh();
  }

  if (!config) {
    return (
      <div className="border border-border rounded-xl p-5 bg-card text-xs text-muted-foreground">
        Loading deployment config…
      </div>
    );
  }

  const uptimeColor =
    uptime?.uptimePct === null
      ? "text-muted-foreground"
      : (uptime?.uptimePct ?? 0) >= 99
        ? "text-green-600"
        : (uptime?.uptimePct ?? 0) >= 95
          ? "text-yellow-600"
          : "text-red-600";

  return (
    <div className="border border-border rounded-xl p-5 bg-card space-y-5">
      <h3 className="font-semibold text-sm flex items-center gap-2">
        <Rocket className="h-4 w-4 text-muted-foreground" />
        Deployment Substrate
      </h3>

      {error && (
        <div className="text-xs text-red-600 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Deployment type */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Deployment type
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {config.availableTypes.map((t) => {
            const meta = config.pricing[t];
            const active = config.deploymentType === t;
            const autoscaleLocked = t === "autoscale" && userTier === "free";
            return (
              <div key={t} className="relative group">
                <button
                  type="button"
                  disabled={busy || autoscaleLocked}
                  onClick={() => !autoscaleLocked && void patch({ deploymentType: t })}
                  className={cn(
                    "w-full text-left rounded-lg border p-3 transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/40",
                    autoscaleLocked && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <div className="text-sm font-medium">{meta?.label ?? t}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{meta?.price}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">{meta?.description}</div>
                  {autoscaleLocked && (
                    <div className="text-[10px] text-primary font-semibold mt-1">
                      Core plan required
                    </div>
                  )}
                </button>
                {autoscaleLocked && (
                  <div className="absolute inset-x-0 -bottom-7 hidden group-hover:block z-10">
                    <div className="bg-popover border border-border rounded px-2 py-1 text-[11px] text-center shadow-lg whitespace-nowrap">
                      Autoscale is not available on your current workspace plan.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Region + CDN + health path */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs space-y-1">
          <span className="font-medium text-muted-foreground uppercase tracking-wide">Region</span>
          <select
            disabled={busy}
            value={config.region ?? ""}
            onChange={(e) => void patch({ region: (e.target.value || null) as never })}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Default</option>
            {config.availableRegions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs space-y-1">
          <span className="font-medium text-muted-foreground uppercase tracking-wide">
            Health check path
          </span>
          <input
            disabled={busy}
            defaultValue={config.healthCheckPath}
            onBlur={(e) => {
              if (e.target.value !== config.healthCheckPath) {
                void patch({ healthCheckPath: e.target.value as never });
              }
            }}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm font-mono"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="font-medium text-muted-foreground uppercase tracking-wide">
            Uptime alert email
          </span>
          <input
            type="email"
            disabled={busy}
            defaultValue={config.uptimeAlertEmail ?? ""}
            placeholder="alerts@example.com"
            onBlur={(e) => void patch({ uptimeAlertEmail: (e.target.value || null) as never })}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs flex items-center gap-2 pt-5">
          <input
            type="checkbox"
            disabled={busy || !config.cdn.configured}
            checked={config.cdnEnabled}
            onChange={(e) => void patch({ cdnEnabled: e.target.checked as never })}
          />
          <span>
            Push to edge CDN on publish{" "}
            {!config.cdn.configured && (
              <span className="text-muted-foreground">
                (CDN_PROVIDER not configured — disabled)
              </span>
            )}
            {config.cdnLastPushedAt && (
              <span className="text-muted-foreground block text-[10px]">
                Last push: {new Date(config.cdnLastPushedAt).toLocaleString()}
              </span>
            )}
          </span>
        </label>
      </div>

      {/* Uptime tile */}
      <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between">
        <div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Uptime (last {uptime?.sampleSize ?? 0} probes)
          </div>
          <div className={cn("text-xl font-semibold tabular-nums", uptimeColor)}>
            {uptime?.uptimePct === null || uptime?.uptimePct === undefined
              ? "—"
              : `${uptime.uptimePct.toFixed(1)}%`}
          </div>
          {uptime?.lastCheck && (
            <div className="text-[11px] text-muted-foreground mt-1">
              Last: {uptime.lastCheck.status} · {uptime.lastCheck.rootStatus ?? "—"} ·{" "}
              {uptime.lastCheck.rootLatencyMs ?? "—"}ms ·{" "}
              {new Date(uptime.lastCheck.createdAt).toLocaleString()}
            </div>
          )}
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void runProbeNow()}>
          <Activity className="h-3 w-3 mr-1" /> Probe now
        </Button>
      </div>

      {/* Schedules */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Scheduled deploys & probes
        </p>
        <div className="flex flex-col md:flex-row gap-2">
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as Schedule["kind"])}
            className="rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="health_probe">Health probe</option>
            <option value="task_run">Task run</option>
            <option value="redeploy">Redeploy (preview)</option>
          </select>
          <input
            value={newCron}
            onChange={(e) => setNewCron(e.target.value)}
            placeholder="0 * * * *"
            className="rounded border border-border bg-background px-2 py-1.5 text-sm font-mono flex-1 md:max-w-[160px]"
          />
          <input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Optional note"
            className="rounded border border-border bg-background px-2 py-1.5 text-sm flex-1"
          />
          <Button size="sm" disabled={busy} onClick={() => void createSchedule()}>
            Add
          </Button>
        </div>
        {schedules.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">No schedules configured.</p>
        ) : (
          <ul className="space-y-1.5">
            {schedules.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded border border-border bg-background px-3 py-2 text-xs"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono">
                    {s.kind} · {s.cronExpr}
                  </div>
                  {s.note && <div className="text-muted-foreground truncate">{s.note}</div>}
                  <div className="text-[10px] text-muted-foreground">
                    next: {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
                    {s.lastRunAt &&
                      ` · last: ${new Date(s.lastRunAt).toLocaleString()} (${s.lastRunStatus ?? "—"})`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void toggleSchedule(s.id, !s.enabled)}
                  className="text-[10px] px-2 py-0.5 rounded-full border border-border hover:bg-muted"
                >
                  {s.enabled ? "enabled" : "paused"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSchedule(s.id)}
                  className="text-muted-foreground hover:text-red-600"
                  aria-label="Delete schedule"
                >
                  <XCircle className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CustomSubdomainPicker({
  projectId,
  currentSlug,
  platformDomain,
  onSuccess,
}: {
  projectId: number;
  currentSlug: string;
  platformDomain: string;
  onSuccess: (slug: string, subdomain: string) => void;
}) {
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const slug = input.trim().toLowerCase();
    if (!slug) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await authFetch(`/api/projects/${projectId}/subdomain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; publicSlug?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to update subdomain.");
        return;
      }
      const newSlug = data.publicSlug ?? slug;
      onSuccess(newSlug, `${newSlug}.${platformDomain}`);
      setInput("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Custom Subdomain
      </p>
      <p className="text-xs text-muted-foreground">
        Pick a memorable name for your app. Your current slug is{" "}
        <span className="font-mono text-foreground">{currentSlug}</span>.
      </p>
      <div className="flex items-center gap-1 bg-muted rounded-lg px-3 py-2 overflow-hidden">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
          }}
          placeholder={currentSlug}
          maxLength={40}
          className="flex-1 bg-transparent text-sm font-mono placeholder:text-muted-foreground/40 focus:outline-none min-w-0"
        />
        <span className="text-sm text-muted-foreground shrink-0">.{platformDomain}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !input.trim()}
          className="ml-2 shrink-0"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          <span className="ml-1">{saved ? "Saved" : "Save"}</span>
        </Button>
      </div>
      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground/60">
        Lowercase letters, numbers, and hyphens only. 3–40 characters.
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

// ── Readiness gate types & components ────────────────────────────────────────

type CriticalFindingMeta = {
  key: string;
  checkName: string;
  file: string;
  line?: number;
  message: string;
};

type ReadinessCheck = {
  id: string;
  label: string;
  description: string;
  status: "pass" | "fail" | "warning" | "info";
  severity: "blocking" | "warning" | "info";
  message?: string;
  criticalFindingCount?: number;
  criticalFindings?: CriticalFindingMeta[];
};

type ReadinessResult = {
  env: string;
  canPublish: boolean;
  checks: ReadinessCheck[];
};

function ReadinessCheckRow({ check, onFix }: { check: ReadinessCheck; onFix?: () => void }) {
  const icon = {
    pass: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
    fail: <XCircle className="h-3.5 w-3.5 text-destructive" />,
    warning: <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />,
    info: <Info className="h-3.5 w-3.5 text-muted-foreground" />,
  }[check.status] ?? <Circle className="h-3.5 w-3.5 text-muted-foreground" />;

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium flex items-center gap-2 flex-wrap">
          {check.label}
          {check.severity === "blocking" && check.status === "fail" && (
            <span className="text-[9px] bg-destructive/15 text-destructive px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">
              Required
            </span>
          )}
        </div>
        {check.message && (
          <div className="text-[11px] text-muted-foreground mt-0.5">{check.message}</div>
        )}
        {onFix && check.status === "fail" && (
          <button
            onClick={onFix}
            className="mt-1 flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Fix in Mobile Settings
          </button>
        )}
      </div>
    </div>
  );
}

function ReadinessGate({
  readiness,
  loading,
  onRefresh,
  projectId,
  onFindingDismissed,
  onNavigateToSecurity,
}: {
  readiness: ReadinessResult | null;
  loading: boolean;
  onRefresh: () => void;
  projectId: number;
  onFindingDismissed?: () => void;
  onNavigateToSecurity?: () => void;
}) {
  const [dismissing, setDismissing] = useState<string | null>(null);

  if (loading && !readiness) {
    return (
      <div className="border border-border rounded-xl p-4 bg-card flex items-center gap-2 text-xs text-muted-foreground animate-pulse">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking publish readiness…
      </div>
    );
  }
  if (!readiness) return null;

  const blockingFailed = readiness.checks.filter(
    (c) => c.severity === "blocking" && c.status === "fail",
  );
  const warnings = readiness.checks.filter((c) => c.status === "warning");
  const securityCheck = readiness.checks.find((c) => c.id === "no_critical_findings");
  const securityBlocked =
    securityCheck?.status === "fail" &&
    securityCheck.criticalFindings &&
    securityCheck.criticalFindings.length > 0;

  const dismissFinding = async (key: string) => {
    setDismissing(key);
    try {
      await authFetch(`/api/projects/${projectId}/findings/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingKey: key }),
      });
      onFindingDismissed?.();
    } catch {
      /* ignore */
    } finally {
      setDismissing(null);
    }
  };

  return (
    <div className="border border-border rounded-xl p-4 bg-card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Publish Readiness</h3>
        <button
          onClick={onRefresh}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          Refresh
        </button>
      </div>
      <div className="space-y-2">
        {readiness.checks.map((check) => (
          <ReadinessCheckRow key={check.id} check={check} />
        ))}
      </div>

      {/* Security findings detail panel — shown when the gate is blocked by critical findings */}
      {securityBlocked && securityCheck?.criticalFindings && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
              <ShieldCheck className="h-3.5 w-3.5" />
              Blocked by {securityCheck.criticalFindings.length} critical finding
              {securityCheck.criticalFindings.length !== 1 ? "s" : ""}
            </div>
            {onNavigateToSecurity && (
              <button
                onClick={onNavigateToSecurity}
                className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors shrink-0"
              >
                <ExternalLink className="h-3 w-3" />
                Go to Security tab
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {securityCheck.criticalFindings.map((f) => (
              <div
                key={f.key}
                className="flex items-start gap-2 bg-background/60 rounded-md px-2.5 py-2 border border-border"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium text-foreground truncate">
                    {f.message}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {f.file}
                    {f.line != null ? `:${f.line}` : ""}
                    <span className="ml-1.5 text-muted-foreground/60">[{f.checkName}]</span>
                  </div>
                </div>
                <button
                  onClick={() => void dismissFinding(f.key)}
                  disabled={dismissing === f.key}
                  className="shrink-0 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 rounded px-1.5 py-1 hover:bg-muted whitespace-nowrap"
                  title="Dismiss this finding — it will no longer block publishing"
                >
                  {dismissing === f.key ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  Dismiss
                </button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Dismissing a finding removes it from the publish block. Fix the underlying issue or
            rebuild to clear it permanently.
          </p>
        </div>
      )}

      {!readiness.canPublish && blockingFailed.length > 0 && !securityBlocked && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {blockingFailed.length} required gate{blockingFailed.length !== 1 ? "s" : ""} must pass
            before publishing.
          </span>
        </div>
      )}
      {readiness.canPublish && warnings.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {warnings.length} warning{warnings.length !== 1 ? "s" : ""} — you can publish, but
            review them first.
          </span>
        </div>
      )}
      {readiness.canPublish && warnings.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-green-600">
          <CheckCircle2 className="h-3.5 w-3.5" />
          All gates passed — ready to publish.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EAS Build panel — shared by iOS and Android tabs
// ─────────────────────────────────────────────────────────────────────────────

type EasBuildEntry = {
  id: number;
  env: string;
  status: string;
  publicUrl: string | null;
  note: string | null;
  easBuildId: string | null;
  logsPageUrl: string | null;
  easStatus: string | null;
  logSnippet: string | null;
  createdAt: string;
};

type EasState = {
  hasToken: boolean;
  hasEasJson: boolean;
  appSlug: string | null;
  appName: string | null;
  builds: EasBuildEntry[];
};

type TriggerResult = {
  id?: number;
  easBuildId?: string;
  logsPageUrl?: string;
  status?: string;
  error?: string;
  hint?: string;
  fullName?: string;
  cliCommand?: string;
};

/** Returns true if the URL is an Expo Go launch URL (exp:// scheme). */
function isExpUrl(url: string): boolean {
  return url.startsWith("exp://") || url.startsWith("exp+");
}

/** Returns a human-readable "fetched X min ago" label for a log fetch timestamp. */
function formatLogAge(fetchedAt: Date): string {
  const diffMs = Date.now() - fetchedAt.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "fetched just now";
  if (mins === 1) return "fetched 1 min ago";
  return `fetched ${mins} min ago`;
}

/** Hook that returns a live-updating relative-time label for a log fetch timestamp.
 *  Re-evaluates every 60 seconds so the label stays accurate without a full data refetch. */
function useRelativeTime(fetchedAt: Date | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!fetchedAt) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [fetchedAt]);
  if (!fetchedAt) return "";
  return formatLogAge(fetchedAt);
}

function EasBuildPanel({
  projectId,
  platform,
}: {
  projectId: number;
  platform: "ios" | "android";
}) {
  const [state, setState] = useState<EasState | null>(null);
  const [loading, setLoading] = useState(true);

  const [tokenInput, setTokenInput] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenOk, setTokenOk] = useState<string | null>(null);
  const [tokenExpanded, setTokenExpanded] = useState(false);

  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerHint, setTriggerHint] = useState<string | null>(null);

  const [linkBuildId, setLinkBuildId] = useState("");
  const [expUrlInput, setExpUrlInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkExpanded, setLinkExpanded] = useState(false);

  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [expandedLogsId, setExpandedLogsId] = useState<number | null>(null);
  const [reloadingLogsId, setReloadingLogsId] = useState<number | null>(null);
  const [logFetchedAt, setLogFetchedAt] = useState<Map<number, Date>>(() => new Map());
  const [, setAgeTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const logPreRef = useRef<HTMLPreElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ref tracks in-progress build log IDs so the interval can PATCH them without stale closure issues
  const inProgressRef = useRef<number[]>([]);

  const env = `eas-${platform}`;

  const fetchState = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/eas/builds`);
      if (res.ok) {
        const data = (await res.json()) as EasState & { builds: EasBuildEntry[] };
        const filtered = data.builds.filter((b) => b.env === env);
        // Track which builds are still in-progress so the poll interval can auto-refresh them
        inProgressRef.current = filtered
          .filter((b) => b.status === "started" && !!b.easBuildId)
          .map((b) => b.id);
        setState({ ...data, builds: filtered });
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId, env]);

  useEffect(() => {
    void fetchState();
    // Every 15 s: PATCH any in-progress builds (polls EAS API), then re-read DB
    pollRef.current = setInterval(async () => {
      const ids = inProgressRef.current;
      if (ids.length > 0) {
        await Promise.allSettled(
          ids.map((id) =>
            authFetch(`/api/projects/${projectId}/eas/builds/${id}`, { method: "PATCH" }).catch(
              () => {},
            ),
          ),
        );
      }
      void fetchState();
    }, 15_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchState, projectId]);

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setTokenSaving(true);
    setTokenError(null);
    setTokenOk(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/eas/validate-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        username?: string;
        error?: string;
        appSlug?: string;
      };
      if (!res.ok || !data.ok) {
        setTokenError(data.error ?? "Failed to validate token");
      } else {
        setTokenOk(
          `Authenticated as @${data.username}${data.appSlug ? ` · app: ${data.appSlug}` : ""}`,
        );
        setTokenInput("");
        setTokenExpanded(false);
        void fetchState();
      }
    } catch {
      setTokenError("Network error — please try again");
    } finally {
      setTokenSaving(false);
    }
  };

  // ── Real build trigger — calls POST /eas/trigger on the server ──────────────
  const triggerBuild = async () => {
    setTriggering(true);
    setTriggerError(null);
    setTriggerHint(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/eas/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, profile: "preview" }),
      });
      const data = (await res.json()) as TriggerResult;
      if (!res.ok) {
        setTriggerError(data.error ?? "Build trigger failed");
        if (data.hint === "eas_init_required") {
          setTriggerHint(
            `The app "${data.fullName ?? ""}" isn't registered in EAS yet. ` +
              `Export your project ZIP, run \`eas init\` in the project folder, then try again.`,
          );
        }
      } else {
        // Build queued — refresh state to show it in Build History
        void fetchState();
      }
    } catch {
      setTriggerError("Network error — please try again");
    } finally {
      setTriggering(false);
    }
  };

  const linkBuild = async () => {
    setLinking(true);
    setLinkError(null);
    try {
      const body: Record<string, string> = { platform };
      if (linkBuildId.trim()) body.easBuildId = linkBuildId.trim();
      if (expUrlInput.trim()) body.expUrl = expUrlInput.trim();
      const res = await authFetch(`/api/projects/${projectId}/eas/builds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { id?: number; error?: string };
      if (!res.ok) {
        setLinkError(data.error ?? "Failed to link build");
      } else {
        setLinkBuildId("");
        setExpUrlInput("");
        setLinkExpanded(false);
        void fetchState();
      }
    } catch {
      setLinkError("Network error — please try again");
    } finally {
      setLinking(false);
    }
  };

  const refreshBuild = async (logId: number) => {
    setRefreshing(logId);
    try {
      await authFetch(`/api/projects/${projectId}/eas/builds/${logId}`, { method: "PATCH" });
      void fetchState();
    } finally {
      setRefreshing(null);
    }
  };

  const reloadLogs = async (logId: number) => {
    setReloadingLogsId(logId);
    try {
      const res = await authFetch(`/api/projects/${projectId}/eas/builds/${logId}?force=1`, {
        method: "PATCH",
      });
      if (res.ok) {
        const data = (await res.json()) as { logSnippet?: string | null };
        setState((prev) =>
          prev
            ? {
                ...prev,
                builds: prev.builds.map((b) =>
                  b.id === logId ? { ...b, logSnippet: data.logSnippet ?? b.logSnippet } : b,
                ),
              }
            : prev,
        );
        setLogFetchedAt((prev) => new Map(prev).set(logId, new Date()));
        requestAnimationFrame(() => {
          if (logPreRef.current) {
            logPreRef.current.scrollTop = logPreRef.current.scrollHeight;
          }
        });
      }
    } finally {
      setReloadingLogsId(null);
    }
  };

  const platformLabel = platform === "ios" ? "iOS" : "Android";
  const cliFlag = platform === "ios" ? "--platform ios" : "--platform android";
  const appSlug = state?.appSlug;

  const latestBuild = state?.builds[0] ?? null;
  const hasReadyBuild = latestBuild?.status === "passed" && !!latestBuild.publicUrl;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading EAS status…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + progress steps */}
      <div className="border border-border rounded-xl p-4 bg-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-green-500/10 p-2 rounded-lg">
            <Package className="h-4 w-4 text-green-400" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Store Build — Real Device Testing</h3>
            <p className="text-xs text-muted-foreground">
              Build a native {platformLabel} binary and install it on your device via Expo Go.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          {[
            { label: "Configure Token", done: !!state?.hasToken },
            { label: "Build for Device", done: !!latestBuild },
            { label: "Install on Device", done: hasReadyBuild },
          ].map((step, i) => (
            <div key={step.label} className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border",
                  step.done
                    ? "bg-green-500/15 text-green-400 border-green-500/30"
                    : i === (!state?.hasToken ? 0 : !latestBuild ? 1 : 2)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-border",
                )}
              >
                {step.done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span
                className={cn(
                  "text-[10px]",
                  step.done ? "text-green-400" : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Token configuration */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <button
          onClick={() => setTokenExpanded((o) => !o)}
          className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors"
        >
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="flex-1 text-left font-medium">EAS Access Token</span>
          {state?.hasToken ? (
            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="h-3 w-3" /> Configured
            </span>
          ) : (
            <span className="text-xs text-muted-foreground bg-muted border border-border px-2 py-0.5 rounded-full">
              Not set
            </span>
          )}
          {tokenExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
        {tokenExpanded && (
          <div className="border-t border-border p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Create a personal access token at{" "}
              <a
                href="https://expo.dev/settings/access-tokens"
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                expo.dev/settings/access-tokens
              </a>
              . It will be stored encrypted in your project secrets.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveToken();
                }}
                placeholder="expo_pat_…"
                className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <Button
                size="sm"
                onClick={() => void saveToken()}
                disabled={tokenSaving || !tokenInput.trim()}
              >
                {tokenSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                <span className="ml-1.5">{state?.hasToken ? "Update" : "Save"}</span>
              </Button>
            </div>
            {tokenError && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{tokenError}</span>
              </div>
            )}
            {tokenOk && (
              <div className="flex items-center gap-2 text-xs text-green-500 bg-green-500/10 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{tokenOk}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Build for Device ─────────────────────────────────────────────────── */}
      {state?.hasToken && (
        <div className="border border-border rounded-xl p-4 bg-card space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold">Build for Device</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                Triggers a native {platformLabel} build on EAS servers (preview profile).
                {appSlug && <span className="ml-1 text-foreground font-mono">{appSlug}</span>}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => void triggerBuild()}
              disabled={triggering}
              className="shrink-0"
            >
              {triggering ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Queueing…
                </>
              ) : (
                <>
                  <Package className="h-3.5 w-3.5 mr-1.5" /> Build for {platformLabel}
                </>
              )}
            </Button>
          </div>

          {/* eas.json status row */}
          <div className="flex items-center gap-2 text-xs py-0.5">
            {state?.hasEasJson ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            ) : (
              <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className={state?.hasEasJson ? "text-green-400" : "text-muted-foreground"}>
              {state?.hasEasJson
                ? "eas.json configured (preview + production profiles)"
                : "eas.json will be auto-generated on first build trigger"}
            </span>
          </div>

          {triggerError && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{triggerError}</span>
            </div>
          )}
          {triggerHint && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-500" />
              <span>{triggerHint}</span>
            </div>
          )}

          {/* CLI fallback — collapsed by default */}
          <details className="group">
            <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none list-none">
              <Terminal className="h-3 w-3 shrink-0" />
              Prefer CLI instead? Run manually
              <ChevronDown className="h-3 w-3 ml-auto group-open:rotate-180 transition-transform" />
            </summary>
            <div className="mt-3 space-y-2">
              {[`export EXPO_TOKEN=<your-eas-token>`, `eas build ${cliFlag} --profile preview`].map(
                (cmd) => (
                  <div key={cmd} className="relative group/cmd">
                    <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
                      <code className="text-xs font-mono text-zinc-300 flex-1 break-all">
                        {cmd}
                      </code>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(cmd);
                        }}
                        className="shrink-0 opacity-0 group-hover/cmd:opacity-100 transition-opacity text-zinc-500 hover:text-zinc-300"
                        title="Copy"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ),
              )}
              <a
                href="https://docs.expo.dev/build/setup/"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                EAS Build setup guide <ArrowUpRight className="h-3 w-3" />
              </a>
            </div>
          </details>
        </div>
      )}

      {/* Link a completed build (by ID or exp:// URL) */}
      {state?.hasToken && (
        <div className="border border-border rounded-xl bg-card overflow-hidden">
          <button
            onClick={() => setLinkExpanded((o) => !o)}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors"
          >
            <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="flex-1 text-left font-medium">Link Existing Build</span>
            <span className="text-xs text-muted-foreground">Paste build ID or exp:// URL</span>
            {linkExpanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
          {linkExpanded && (
            <div className="border-t border-border p-4 space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground block">
                  EAS Build ID
                </label>
                <input
                  value={linkBuildId}
                  onChange={(e) => setLinkBuildId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground block">
                  Or paste an exp:// Expo Go URL
                </label>
                <input
                  value={expUrlInput}
                  onChange={(e) => setExpUrlInput(e.target.value)}
                  placeholder="exp://u.expo.dev/…"
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {linkError && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                  <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{linkError}</span>
                </div>
              )}
              <Button
                size="sm"
                className="w-full"
                onClick={() => void linkBuild()}
                disabled={linking || (!linkBuildId.trim() && !expUrlInput.trim())}
              >
                {linking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                ) : (
                  <Link2 className="h-3.5 w-3.5 mr-2" />
                )}
                Link Build
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Build history — also visible in Deployment Logs tab */}
      {(state?.builds ?? []).length > 0 && (
        <div className="border border-border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h4 className="text-sm font-medium">Build History</h4>
            <button
              onClick={() => void fetchState()}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
          <div className="divide-y divide-border">
            {(state?.builds ?? []).map((build) => {
              // Determine what to show in the QR / URL row.
              // Prefer an exp:// URL (Expo Go launch). Fall back to artifact download URL.
              const expUrl = build.publicUrl && isExpUrl(build.publicUrl) ? build.publicUrl : null;
              const downloadUrl =
                build.publicUrl && !isExpUrl(build.publicUrl) ? build.publicUrl : null;
              const qrUrl = expUrl ?? downloadUrl;

              const isLogsOpen = expandedLogsId === build.id;
              // Show "View Logs" for any build with a URL/snippet, plus always for failed builds
              const hasLogs =
                !!(build.logsPageUrl || build.logSnippet) || build.status === "failed";

              return (
                <div key={build.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={cn(
                        "text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0",
                        build.status === "passed"
                          ? "bg-green-500/15 text-green-400"
                          : build.status === "failed"
                            ? "bg-destructive/15 text-destructive"
                            : "bg-yellow-500/15 text-yellow-500",
                      )}
                    >
                      {build.status === "started" ? "building" : build.status}
                    </span>
                    {build.status === "started" && (
                      <Loader2 className="h-3 w-3 animate-spin text-yellow-500 shrink-0" />
                    )}
                    <span className="text-xs text-muted-foreground flex-1 truncate min-w-0">
                      {build.note ?? `EAS ${platform} build`}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(build.createdAt).toLocaleDateString()}
                    </span>
                    {build.easBuildId && build.status === "started" && (
                      <button
                        onClick={() => void refreshBuild(build.id)}
                        disabled={refreshing === build.id}
                        className="shrink-0 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                      >
                        <RefreshCw
                          className={cn("h-3 w-3", refreshing === build.id && "animate-spin")}
                        />
                        Check status
                      </button>
                    )}
                    {hasLogs && (
                      <button
                        onClick={() => setExpandedLogsId(isLogsOpen ? null : build.id)}
                        className={cn(
                          "shrink-0 text-xs flex items-center gap-1 transition-colors",
                          build.status === "failed"
                            ? "text-destructive hover:text-destructive/80"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <FileText className="h-3 w-3" />
                        {isLogsOpen ? "Hide Logs" : "View Logs"}
                        {isLogsOpen ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </button>
                    )}
                  </div>

                  {/* Inline log panel */}
                  {isLogsOpen && (
                    <div className="border border-border rounded-lg overflow-hidden bg-zinc-950/80 text-xs">
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
                        {build.logsPageUrl ? (
                          <>
                            <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="text-muted-foreground">Full log on Expo:</span>
                            <a
                              href={build.logsPageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline truncate flex-1 min-w-0"
                            >
                              {build.logsPageUrl}
                            </a>
                            <a
                              href={build.logsPageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <ArrowUpRight className="h-3 w-3" />
                            </a>
                          </>
                        ) : (
                          <span className="text-muted-foreground flex-1">Build logs</span>
                        )}
                        {build.status !== "started" && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            {logFetchedAt.has(build.id) && (
                              <span className="text-[10px] text-muted-foreground/70 whitespace-nowrap">
                                {formatLogAge(logFetchedAt.get(build.id) as Date)}
                              </span>
                            )}
                            <button
                              onClick={() => void reloadLogs(build.id)}
                              disabled={reloadingLogsId === build.id}
                              title="Reload logs"
                              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                            >
                              <RefreshCw
                                className={cn(
                                  "h-3 w-3",
                                  reloadingLogsId === build.id && "animate-spin",
                                )}
                              />
                            </button>
                          </div>
                        )}
                      </div>
                      {build.logSnippet ? (
                        <pre
                          ref={expandedLogsId === build.id ? logPreRef : null}
                          className="px-3 py-3 text-[11px] leading-relaxed text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto"
                        >
                          {build.logSnippet}
                        </pre>
                      ) : (
                        <div className="px-3 py-3 text-muted-foreground italic">
                          {build.status === "started"
                            ? "Log output will appear here once the build finishes."
                            : "No inline log output available — view the full log on expo.dev."}
                        </div>
                      )}
                    </div>
                  )}

                  {/* URL row — exp:// gets Expo Go label; other URLs get "Download" label */}
                  {build.publicUrl && (
                    <div className="flex items-center gap-2 bg-muted/60 rounded-lg px-3 py-2">
                      {expUrl ? (
                        <Smartphone className="h-3.5 w-3.5 text-green-400 shrink-0" />
                      ) : (
                        <QrCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-xs font-mono text-foreground flex-1 truncate min-w-0">
                        {build.publicUrl}
                      </span>
                      <CopyUrlButton url={build.publicUrl} />
                      <a
                        href={build.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  )}

                  {/* QR code — shown for completed builds */}
                  {build.status === "passed" && qrUrl && (
                    <div className="space-y-1.5">
                      <div className="flex justify-center">
                        <img
                          src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qrUrl)}&size=140x140&bgcolor=ffffff&color=000000&margin=6`}
                          alt={expUrl ? "Expo Go QR code" : "Install QR code"}
                          width={140}
                          height={140}
                          className="rounded-lg border border-border"
                        />
                      </div>
                      <p className="text-[10px] text-center text-muted-foreground">
                        {expUrl
                          ? "Scan with Expo Go to launch on device"
                          : "Scan to download — then open with Expo Go"}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!state?.hasToken && (
        <div className="border border-dashed border-border rounded-xl p-6 text-center space-y-2">
          <KeyRound className="h-6 w-6 text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">
            Configure your EAS access token above to enable real device builds.
          </p>
          <Button variant="outline" size="sm" onClick={() => setTokenExpanded(true)}>
            Set EAS Token
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

type Platform = "web" | "ios" | "android";

type MobileBuildLog = {
  id: number;
  env: string;
  status: string;
  platform: string | null;
  buildId: string | null;
  downloadUrl: string | null;
  testflightUrl: string | null;
  note: string | null;
  createdAt: string;
};

const ACTIVE_BUILD_STATUSES = new Set(["queued", "building", "submitting"]);

type BuildLogResponse = {
  buildId?: string;
  status: string;
  platform?: string | null;
  downloadUrl?: string | null;
  testflightUrl?: string | null;
  note?: string | null;
  logs: string;
};

function BuildLogViewer({
  projectId,
  buildLogId,
  buildStatus,
}: {
  projectId: number;
  buildLogId: number;
  buildStatus: string;
}) {
  const [data, setData] = useState<BuildLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const logAge = useRelativeTime(fetchedAt);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isActive = ACTIVE_BUILD_STATUSES.has(buildStatus);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/builds/${buildLogId}/logs`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as BuildLogResponse;
      setData(json);
      setError(null);
      setFetchedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [projectId, buildLogId]);

  useEffect(() => {
    void fetchLogs();
    if (!isActive) return;
    const interval = setInterval(() => void fetchLogs(), 5000);
    return () => clearInterval(interval);
  }, [fetchLogs, isActive]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.logs]);

  return (
    <div className="border-t border-border bg-zinc-950">
      {/* Log viewer header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50">
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
          <Terminal className="h-3 w-3" />
          <span>EAS Build Logs</span>
          {isActive && (
            <span className="flex items-center gap-1 text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {fetchedAt && (
            <span className="text-[10px] text-zinc-600 whitespace-nowrap">{logAge}</span>
          )}
          <button
            onClick={() => void fetchLogs()}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <RefreshCw className="h-2.5 w-2.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Log content */}
      <div className="h-56 overflow-y-auto font-mono text-[11px] leading-relaxed p-3 space-y-0.5">
        {loading && (
          <div className="flex items-center gap-2 text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading logs…
          </div>
        )}
        {error && <div className="text-destructive">{error}</div>}
        {!loading && !error && (!data?.logs || data.logs.trim() === "") && (
          <div className="text-zinc-600">
            {data?.note ?? "No log output yet. Build may still be initializing…"}
          </div>
        )}
        {data?.logs &&
          data.logs.trim() !== "" &&
          data.logs.split("\n").map((line, i) => {
            const isError = /error|fail|exception/i.test(line);
            const isWarn = /warn/i.test(line);
            const isSuccess = /success|passed|complete/i.test(line);
            return (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-all",
                  isError
                    ? "text-red-400"
                    : isWarn
                      ? "text-yellow-400"
                      : isSuccess
                        ? "text-green-400"
                        : "text-zinc-400",
                )}
              >
                {line || "\u00A0"}
              </div>
            );
          })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── SigningFileUpload ──────────────────────────────────────────────────────────
// Allows users to upload native signing credentials (P12 + provisioning profile
// for iOS, keystore for Android) directly in the publishing tab. Files are
// base64-encoded client-side before being sent to POST /signing/ios|android.

type SigningStatus = {
  ios: { hasP12: boolean; hasProvisioning: boolean; hasTeamId: boolean; configured: boolean };
  android: { hasKeystore: boolean; hasAlias: boolean; configured: boolean };
} | null;

function SigningFileUpload({
  projectId,
  platform,
  signingStatus,
  onSaved,
}: {
  projectId: number;
  platform: "ios" | "android";
  signingStatus: SigningStatus;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // iOS state
  const [p12File, setP12File] = useState<string | null>(null);
  const [p12Password, setP12Password] = useState("");
  const [provisionFile, setProvisionFile] = useState<string | null>(null);
  const [teamId, setTeamId] = useState("");

  // Android state
  const [keystoreFile, setKeystoreFile] = useState<string | null>(null);
  const [ksPassword, setKsPassword] = useState("");
  const [keyAlias, setKeyAlias] = useState("");
  const [keyPassword, setKeyPassword] = useState("");

  const status = platform === "ios" ? signingStatus?.ios : signingStatus?.android;
  const isConfigured = status?.configured ?? false;

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip the data URL prefix if present
        const base64 = result.includes(",") ? (result.split(",")[1] ?? result) : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function handleIosFile(e: React.ChangeEvent<HTMLInputElement>, kind: "p12" | "provision") {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const b64 = await readFileAsBase64(file);
      if (kind === "p12") setP12File(b64);
      else setProvisionFile(b64);
    } catch {
      setError("Failed to read file");
    }
  }

  async function handleAndroidFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const b64 = await readFileAsBase64(file);
      setKeystoreFile(b64);
    } catch {
      setError("Failed to read file");
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      let body: Record<string, string>;
      if (platform === "ios") {
        if (!p12File) {
          setError("Select a P12 certificate file");
          setSaving(false);
          return;
        }
        if (!provisionFile) {
          setError("Select a provisioning profile file");
          setSaving(false);
          return;
        }
        body = { p12Base64: p12File, p12Password, provisioningProfileBase64: provisionFile };
        if (teamId.trim()) body.teamId = teamId.trim();
      } else {
        if (!keystoreFile) {
          setError("Select a keystore file");
          setSaving(false);
          return;
        }
        if (!ksPassword) {
          setError("Keystore password is required");
          setSaving(false);
          return;
        }
        if (!keyAlias) {
          setError("Key alias is required");
          setSaving(false);
          return;
        }
        body = {
          keystoreBase64: keystoreFile,
          keystorePassword: ksPassword,
          keyAlias,
          keyPassword,
        };
      }

      const res = await authFetch(`/api/projects/${projectId}/signing/${platform}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSuccess(true);
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/signing/${platform}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setSaving(false);
    }
  }

  const platformLabel = platform === "ios" ? "iOS" : "Android";

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      <div className="flex items-center px-4 py-2.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity"
          aria-expanded={open}
        >
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold">Signing Credentials</span>
          {isConfigured ? (
            <span className="text-[10px] bg-green-500/15 text-green-500 px-1.5 py-0.5 rounded font-medium">
              Uploaded
            </span>
          ) : (
            <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
              Not uploaded
            </span>
          )}
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={open}
        >
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {success && (
            <div className="text-xs text-green-600 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              {platformLabel} signing credentials saved securely.
            </div>
          )}

          {platform === "ios" ? (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Upload your Apple Distribution certificate (.p12) and provisioning profile
                (.mobileprovision) so EAS can sign your IPA without leaving NabuFlow.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Distribution Certificate (.p12)
                </span>
                <input
                  type="file"
                  accept=".p12,.pfx"
                  onChange={(e) => void handleIosFile(e, "p12")}
                  className="block w-full text-xs text-muted-foreground file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-muted file:text-foreground hover:file:bg-muted/80"
                />
                {p12File && (
                  <span className="text-[10px] text-green-500 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> File loaded
                  </span>
                )}
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Certificate Password
                </span>
                <input
                  type="password"
                  value={p12Password}
                  onChange={(e) => setP12Password(e.target.value)}
                  placeholder="Leave blank if no password"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Provisioning Profile (.mobileprovision)
                </span>
                <input
                  type="file"
                  accept=".mobileprovision"
                  onChange={(e) => void handleIosFile(e, "provision")}
                  className="block w-full text-xs text-muted-foreground file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-muted file:text-foreground hover:file:bg-muted/80"
                />
                {provisionFile && (
                  <span className="text-[10px] text-green-500 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> File loaded
                  </span>
                )}
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Team ID (optional)
                </span>
                <input
                  type="text"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  placeholder="ABCD1234EF"
                  maxLength={10}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
                />
              </label>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Upload your Android keystore file so EAS can sign your AAB/APK. The keystore is
                stored encrypted and never returned.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Keystore File (.jks / .keystore)
                </span>
                <input
                  type="file"
                  accept=".jks,.keystore"
                  onChange={(e) => void handleAndroidFile(e)}
                  className="block w-full text-xs text-muted-foreground file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-muted file:text-foreground hover:file:bg-muted/80"
                />
                {keystoreFile && (
                  <span className="text-[10px] text-green-500 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> File loaded
                  </span>
                )}
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Keystore Password
                </span>
                <input
                  type="password"
                  value={ksPassword}
                  onChange={(e) => setKsPassword(e.target.value)}
                  placeholder="Keystore password"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Key Alias
                </span>
                <input
                  type="text"
                  value={keyAlias}
                  onChange={(e) => setKeyAlias(e.target.value)}
                  placeholder="e.g. my-release-key"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Key Password (if different from keystore)
                </span>
                <input
                  type="password"
                  value={keyPassword}
                  onChange={(e) => setKeyPassword(e.target.value)}
                  placeholder="Leave blank to use keystore password"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                />
              </label>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex-1"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              {saving ? "Saving…" : "Save credentials"}
            </Button>
            {isConfigured && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleRemove()}
                disabled={saving}
                className="shrink-0 text-destructive hover:text-destructive"
              >
                Remove
              </Button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Credentials are AES-256 encrypted at rest. Raw values are never returned by the API.
          </p>
        </div>
      )}
    </div>
  );
}

// ── MobileSetupGuide ──────────────────────────────────────────────────────────
// Expandable step-by-step guide for Apple / Google store setup, linked from
// the iOS and Android publishing tabs.

function MobileSetupGuide({ platform }: { platform: "ios" | "android" }) {
  const [open, setOpen] = useState(false);

  const iosSteps = [
    {
      title: "1. Enroll in Apple Developer Program",
      body: "Go to developer.apple.com and enroll as an Individual ($99/yr) or Organization. You'll need a D‑U‑N‑S number for organizations. Approval takes 1–2 business days.",
      link: {
        label: "Apple Developer enrollment",
        href: "https://developer.apple.com/programs/enroll/",
      },
    },
    {
      title: "2. Create an App ID and Bundle Identifier",
      body: "In the Developer portal under Identifiers, create a new App ID with your reverse-domain bundle identifier (e.g. com.yourco.appname). Enable any capabilities you need (Push Notifications, Sign in with Apple, etc.).",
      link: {
        label: "Identifiers in Apple Developer portal",
        href: "https://developer.apple.com/account/resources/identifiers/list",
      },
    },
    {
      title: "3. Generate a Distribution Certificate",
      body: "In Certificates, create an Apple Distribution certificate. You'll generate a Certificate Signing Request (CSR) via Keychain Access on Mac. Download the .cer and export it as a .p12 file with a password. Upload the .p12 here in the Signing Credentials section above.",
    },
    {
      title: "4. Create a Provisioning Profile",
      body: "Under Profiles, create an App Store Distribution profile linked to your App ID and Distribution certificate. Download the .mobileprovision file and upload it here.",
      link: {
        label: "Provisioning Profiles",
        href: "https://developer.apple.com/account/resources/profiles/list",
      },
    },
    {
      title: "5. Create an App in App Store Connect",
      body: "Go to App Store Connect and create a new app. Set the Bundle ID to match what's in your app.json. Add your app name, primary language, and category.",
      link: { label: "App Store Connect", href: "https://appstoreconnect.apple.com/apps" },
    },
    {
      title: "6. Generate an App Store Connect API Key",
      body: "In App Store Connect → Users and Access → Keys, create a new API key with App Manager role. Save the Key ID, Issuer ID, and download the .p8 private key. Add these as APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, and APPLE_ASC_PRIVATE_KEY in the EAS Credentials section.",
    },
    {
      title: "7. Trigger an EAS Build and Upload to TestFlight",
      body: "Add your EAS_ACCESS_TOKEN in the EAS Credentials section and click 'Build for iOS'. Once the build finishes, EAS will automatically upload the IPA to TestFlight. Invite testers from App Store Connect → TestFlight → Internal Testing.",
    },
    {
      title: "8. Submit for App Store Review",
      body: "Once testing is complete, go to App Store Connect, add required metadata (screenshots, description, privacy policy URL), set the build from TestFlight, and submit for review. Review typically takes 1–3 business days.",
    },
  ];

  const androidSteps = [
    {
      title: "1. Create a Google Play Developer Account",
      body: "Go to play.google.com/console and pay the $25 one-time registration fee. Verification takes 2–3 business days.",
      link: {
        label: "Google Play Console sign-up",
        href: "https://play.google.com/console/signup",
      },
    },
    {
      title: "2. Create a New Application",
      body: "In the Play Console, click 'Create app'. Set the app name, default language, and whether it's an app or game. Accept the declarations. Your package name (from app.json android.package) cannot be changed after first submission.",
    },
    {
      title: "3. Generate an Upload Keystore",
      body: "Generate a keystore using keytool: `keytool -genkeypair -v -storetype PKCS12 -keystore my-release-key.keystore -alias my-key-alias -keyalg RSA -keysize 2048 -validity 10000`. Upload the .keystore file and its credentials in the Signing Credentials section above.",
    },
    {
      title: "4. Create a Google Play Service Account",
      body: "In Google Play Console → Setup → API access, link to a Google Cloud project and create a Service Account with 'Release manager' role. Download the JSON key file and add it as GOOGLE_SERVICE_ACCOUNT_JSON in the EAS Credentials section.",
      link: { label: "Google Play API access", href: "https://play.google.com/console/api-access" },
    },
    {
      title: "5. Trigger an EAS Build",
      body: "Add your EAS_ACCESS_TOKEN and click 'Build for Android'. EAS will produce a signed AAB (Android App Bundle). Once complete, download the AAB from the build logs.",
    },
    {
      title: "6. Upload to Internal Testing Track",
      body: "In Google Play Console → Testing → Internal testing, create a new release and upload your AAB. Add testers by email. Internal testing releases are available within minutes of upload.",
    },
    {
      title: "7. Promote to Production",
      body: "After collecting feedback, promote through Closed → Open testing → Production in the Play Console. Production releases are reviewed by Google (1–7 days) before going live.",
    },
  ];

  const steps = platform === "ios" ? iosSteps : androidSteps;
  const platformLabel = platform === "ios" ? "iOS (App Store)" : "Android (Google Play)";

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={open}
      >
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{platformLabel} Setup Guide</p>
          <p className="text-xs text-muted-foreground">
            Step-by-step: enrollment, signing, {platform === "ios" ? "TestFlight" : "Play Console"},
            and submission
          </p>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t border-border divide-y divide-border/50">
          {steps.map((step, idx) => (
            <div key={idx} className="px-4 py-3 space-y-1">
              <p className="text-xs font-semibold text-foreground">{step.title}</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{step.body}</p>
              {step.link && (
                <a
                  href={step.link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  {step.link.label} <ArrowUpRight className="h-3 w-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MobileBuildStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string; spin?: boolean }> = {
    queued: { label: "Queued", className: "bg-muted text-muted-foreground border-border" },
    building: {
      label: "Building",
      className: "bg-primary/10 text-primary border-primary/20",
      spin: true,
    },
    submitting: {
      label: "Submitting",
      className: "bg-violet-500/10 text-violet-400 border-violet-500/20",
      spin: true,
    },
    submitted: {
      label: "Submitted",
      className: "bg-green-500/10 text-green-400 border-green-500/20",
    },
    passed: { label: "Passed", className: "bg-green-500/10 text-green-400 border-green-500/20" },
    failed: {
      label: "Failed",
      className: "bg-destructive/10 text-destructive border-destructive/20",
    },
  };
  const c = cfg[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0",
        c.className,
      )}
    >
      {c.spin && (
        <span className="w-1.5 h-1.5 rounded-full border border-current border-t-transparent animate-spin" />
      )}
      {c.label}
    </span>
  );
}

// ─── GitHub Auto-Sync panel ───────────────────────────────────────────────────
// Connects a project to a GitHub repository via a personal access token. Once
// configured, every successful AI build automatically pushes the latest files
// as a commit. The connection is stored server-side in project_github_connections.

interface GithubConnection {
  id: number;
  githubAccountName: string;
  repositoryOwner: string | null;
  repositoryName: string | null;
  defaultBranch: string;
  lastSyncAt: string | null;
  syncStatus: string;
}

interface GithubRepo {
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
}

function GitHubAutoSyncPanel({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  // undefined = not fetched yet, null = not connected, GithubConnection = connected
  const [connection, setConnection] = useState<GithubConnection | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [fetchingRepos, setFetchingRepos] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/github/status`);
      const data = (await res.json()) as {
        connected: boolean;
        connection?: GithubConnection;
      };
      setConnection(data.connected ? (data.connection ?? null) : null);
    } catch {
      setConnection(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open && connection === undefined) {
      void fetchStatus();
    }
  }, [open, connection, fetchStatus]);

  const handleConnect = async () => {
    if (!token.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/github/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = (await res.json()) as { connected?: boolean; error?: string };
      if (!res.ok) {
        setConnectError(data.error ?? "Connection failed");
      } else {
        setToken("");
        await fetchStatus();
      }
    } catch {
      setConnectError("Connection failed — check your network");
    } finally {
      setConnecting(false);
    }
  };

  const fetchRepos = async () => {
    setFetchingRepos(true);
    setRepoError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/github/repositories`);
      const data = (await res.json()) as { repositories?: GithubRepo[]; error?: string };
      if (!res.ok) {
        setRepoError(data.error ?? "Failed to load repositories");
      } else {
        setRepos(data.repositories ?? []);
      }
    } catch {
      setRepoError("Failed to load repositories");
    } finally {
      setFetchingRepos(false);
    }
  };

  const handleSelectRepo = async (r: GithubRepo) => {
    setSelecting(true);
    try {
      const [owner, name] = r.fullName.split("/");
      await authFetch(`/api/projects/${projectId}/github/select-repository`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryOwner: owner,
          repositoryName: name,
          defaultBranch: r.defaultBranch,
        }),
      });
      setRepos(null);
      setShowRepoPicker(false);
      await fetchStatus();
    } catch {
      // Non-fatal
    } finally {
      setSelecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await authFetch(`/api/projects/${projectId}/github/disconnect`, { method: "POST" });
      setConnection(null);
      setRepos(null);
      setShowRepoPicker(false);
    } catch {
      // Non-fatal
    } finally {
      setDisconnecting(false);
    }
  };

  const isConnected = connection !== null && connection !== undefined;
  const hasRepo = isConnected && !!connection.repositoryOwner && !!connection.repositoryName;

  let headerSubtitle: React.ReactNode;
  if (isConnected && hasRepo) {
    headerSubtitle = (
      <div className="flex items-center gap-1 mt-0.5">
        <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
        <span className="text-xs text-green-500 truncate">
          {connection.repositoryOwner}/{connection.repositoryName} · auto-sync on
        </span>
      </div>
    );
  } else if (isConnected) {
    headerSubtitle = (
      <div className="text-xs text-muted-foreground">
        Connected as @{connection.githubAccountName} — select a repo
      </div>
    );
  } else {
    headerSubtitle = (
      <div className="text-xs text-muted-foreground">
        Push to GitHub automatically after every build
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <Github className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">GitHub Auto-Sync</div>
          {headerSubtitle}
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : !isConnected ? (
            // ── Phase 1: not connected ─────────────────────────────────────────
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Paste a GitHub personal access token with <span className="font-mono">repo</span>{" "}
                scope. Every successful build will be pushed as a commit to the repository you
                select.
              </p>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">Personal access token</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleConnect();
                  }}
                  placeholder="ghp_…"
                  className="w-full text-xs bg-background border border-border rounded px-3 py-1.5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
              {connectError && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  {connectError}
                </div>
              )}
              <Button
                className="w-full"
                disabled={!token.trim() || connecting}
                onClick={() => void handleConnect()}
              >
                {connecting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <Github className="h-4 w-4 mr-2" />
                    Connect GitHub
                  </>
                )}
              </Button>
            </div>
          ) : !hasRepo || showRepoPicker ? (
            // ── Phase 2: connected, selecting a repo ──────────────────────────
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-green-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Connected as @{connection.githubAccountName}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={disconnecting}
                  className="text-[10px] text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Select the repository that will receive automatic commits after each build.
              </p>
              {repos === null && !fetchingRepos && (
                <Button variant="outline" className="w-full" onClick={() => void fetchRepos()}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Load repositories
                </Button>
              )}
              {fetchingRepos && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading repositories…
                </div>
              )}
              {repoError && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  {repoError}
                </div>
              )}
              {repos !== null && repos.length > 0 && (
                <div className="max-h-52 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                  {repos.map((r) => (
                    <button
                      key={r.fullName}
                      type="button"
                      disabled={selecting}
                      onClick={() => void handleSelectRepo(r)}
                      className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors disabled:opacity-50"
                    >
                      <Lock
                        className={cn(
                          "h-3 w-3 mt-0.5 shrink-0",
                          r.private ? "text-muted-foreground" : "text-muted-foreground/40",
                        )}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-foreground truncate">
                          {r.fullName}
                        </div>
                        {r.description && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {r.description}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {repos !== null && repos.length === 0 && (
                <p className="text-xs text-muted-foreground">No repositories found.</p>
              )}
              {hasRepo && showRepoPicker && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setShowRepoPicker(false)}
                >
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            // ── Phase 3: fully configured ──────────────────────────────────────
            <div className="space-y-3">
              <div className="bg-muted/40 rounded-lg px-3 py-2.5 space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-14 shrink-0">Account</span>
                  <span className="text-foreground font-mono">@{connection.githubAccountName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-14 shrink-0">Repository</span>
                  <a
                    href={`https://github.com/${connection.repositoryOwner}/${connection.repositoryName}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline flex items-center gap-1 font-mono truncate"
                  >
                    {connection.repositoryOwner}/{connection.repositoryName}
                    <ArrowUpRight className="h-3 w-3 shrink-0" />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-14 shrink-0">Branch</span>
                  <span className="text-foreground font-mono">{connection.defaultBranch}</span>
                </div>
                {connection.lastSyncAt && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-14 shrink-0">Last sync</span>
                    <span className="text-foreground">
                      {new Date(connection.lastSyncAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {connection.syncStatus === "syncing" && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                    {connection.syncStatus === "error" && (
                      <span className="text-destructive">· sync failed</span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/20 border border-border rounded-lg px-3 py-2">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                Files are pushed automatically after every successful build.
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setShowRepoPicker(true);
                    setRepos(null);
                    void fetchRepos();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Change repo
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive border-destructive/30 hover:border-destructive/60"
                  disabled={disconnecting}
                  onClick={() => void handleDisconnect()}
                >
                  {disconnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Buy a domain — collapsible inline search/purchase widget ─────────────────
function BuyDomainSection({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-2 text-xs text-primary hover:text-primary/80 transition-colors"
      >
        <Globe className="h-3.5 w-3.5" />
        <span>Buy a domain</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2">
          <DomainPurchaseWidget projectId={projectId} />
        </div>
      )}
    </div>
  );
}

export function PublishingTab({
  projectId,
  kind,
  builderMode,
  containerStatus: _containerStatus,
  containerUrl: _containerUrl,
  containerId,
  testedSnapshotId,
  testingStatus,
  onNavigateToSecret,
  onNavigateToMobileSettings,
  onNavigateToChecks,
  onNavigateToLogs,
  onNavigateToTestEnv,
  onPublishingActivity,
}: {
  projectId: number;
  kind?: string;
  builderMode?: string;
  containerStatus?: string;
  containerUrl?: string | null;
  /** Task #768: truthy when the project has a dev container (full-stack). Gates testing requirement. */
  containerId?: string | null;
  /** Task #768: version ID of most recently approved test snapshot. Null = not yet tested. */
  testedSnapshotId?: number | null;
  /** Task #768: current testing workflow state (idle/stale/ready/passed). */
  testingStatus?: string | null;
  onNavigateToSecret?: (secretName: string) => void;
  onNavigateToMobileSettings?: () => void;
  onNavigateToChecks?: () => void;
  onNavigateToLogs?: () => void;
  /** Task #768: navigate to the Test Environment tab. Shown in the testing gate banner. */
  onNavigateToTestEnv?: () => void;
  onPublishingActivity?: (update: InlineSurfaceActivityUpdate) => void;
}) {
  const isMobile = kind?.startsWith("mobile-") ?? false;
  const isAgentic = builderMode === "agentic";
  // Task #768: full-stack projects (containerId set) must pass a test preview before
  // deploying to production. Static projects can publish directly.
  const isFullStackWithoutTest = !!containerId && !testedSnapshotId;
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<Platform>("web");
  const [webEnv, setWebEnv] = useState<"testing" | "production">("testing");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [logsOpen, setLogsOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    ok: boolean;
    publicUrl: string;
    internalPathUrl: string;
    publicSlug: string;
    publishedAt: string;
    snapshotVersionId?: number;
    filesPublished?: number;
    containerDeployed?: boolean;
    containerUrl?: string | null;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Deploy to Production state (Phase E)
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{
    ok: boolean;
    publicUrl: string;
    internalPathUrl?: string;
    publicSlug: string;
    deployedAt: string;
    filesDeployed?: number;
    containerDeployed: boolean;
    prodContainerUrl?: string | null;
    note?: string;
  } | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [showDeployConfirm, setShowDeployConfirm] = useState(false);
  const [prodContainerStatus, setProdContainerStatus] = useState<string | null>(null);
  const [prodContainerUrl, setProdContainerUrl] = useState<string | null>(null);

  // Readiness gate state (web)
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);

  // Readiness gate state (mobile store)
  const [iosReadiness, setIosReadiness] = useState<ReadinessResult | null>(null);
  const [iosReadinessLoading, setIosReadinessLoading] = useState(false);
  const [andReadiness, setAndReadiness] = useState<ReadinessResult | null>(null);
  const [andReadinessLoading, setAndReadinessLoading] = useState(false);

  // Version approval gate (Task #767 — agentic projects)
  const { data: versions = [], refetch: refetchVersions } = useListVersions(projectId, {
    query: {
      queryKey: getListVersionsQueryKey(projectId),
      enabled: isAgentic,
    },
  });
  const approveVersionMutation = useApproveVersionForTesting();
  const provisionPreviewDbMutation = useProvisionPreviewDatabase();
  const latestApprovedVersion = versions.find((v) => v.testingApprovedAt != null);

  // Deployment history state
  const [deployments, setDeployments] = useState<
    Array<{
      id: number;
      env: string;
      status: string;
      publicUrl: string | null;
      filesCount: number | null;
      createdAt: string;
    }>
  >([]);

  // Mobile build state
  const [mobileBuilds, setMobileBuilds] = useState<MobileBuildLog[]>([]);
  const [triggeringBuild, setTriggeringBuild] = useState<"ios" | "android" | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [credsMissing, setCredsMissing] = useState<string | null>(null);
  const [openLogBuildId, setOpenLogBuildId] = useState<number | null>(null);

  // Expandable credentials panels
  const [iosCredsOpen, setIosCredsOpen] = useState(true);
  const [androidCredsOpen, setAndroidCredsOpen] = useState(true);

  // Signing key status (whether P12, provisioning profile, keystore are uploaded)
  const [signingStatus, setSigningStatus] = useState<SigningStatus>(null);
  const fetchSigningStatus = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await authFetch(`/api/projects/${projectId}/signing`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as SigningStatus;
        setSigningStatus(data);
      }
    } catch {
      // non-fatal — signing status is informational only
    }
  }, [isMobile, projectId]);

  // Credit balance for low-credit warning near EAS build buttons
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const EAS_BUILD_COST = 5;
  const creditFetchRef = useRef<(() => Promise<void>) | null>(null);

  // EAS credentials checklist — tracks which secret names are configured + their IDs + verification status
  const [configuredSecrets, setConfiguredSecrets] = useState<
    Map<string, { id: number; verificationStatus: string }>
  >(new Map());
  const fetchConfiguredSecrets = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await authFetch(`/api/projects/${projectId}/secrets`);
      if (res.ok) {
        const data = (await res.json()) as {
          secrets?: Array<{ name: string; id: number; verificationStatus?: string | null }>;
        };
        setConfiguredSecrets(
          new Map(
            (data.secrets ?? []).map((s) => [
              s.name,
              { id: s.id, verificationStatus: s.verificationStatus ?? "unverified" },
            ]),
          ),
        );
      }
    } catch {
      /* ignore */
    }
  }, [projectId, isMobile]);

  // Site settings state
  const [siteTitle, setSiteTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [themeColor, setThemeColor] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  // Security gate toggle state
  const [blockPublishOnCritical, setBlockPublishOnCritical] = useState(true);
  const [savingSecurityGate, setSavingSecurityGate] = useState(false);

  // Environment sub-tab (inside the web platform tab)
  const [envTab, setEnvTab] = useState<"production" | "staging" | "previews" | "analytics">(
    "production",
  );

  // Staging publish state
  const [isStaging, setIsStaging] = useState(false);
  const [stagingResult, setStagingResult] = useState<{
    ok: boolean;
    stagingUrl: string;
    publicSlug: string;
    snapshotVersionId?: number;
    filesPublished?: number;
  } | null>(null);
  const [stagingError, setStagingError] = useState<string | null>(null);

  // Promote state
  const [isPromoting, setIsPromoting] = useState(false);
  const [promoteResult, setPromoteResult] = useState<{
    ok: boolean;
    publicUrl: string;
    publicSlug: string;
    stagingSnapshotLabel?: string | null;
  } | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [showPromoteConfirm, setShowPromoteConfirm] = useState(false);

  // Preview snapshots state
  type PreviewSnapshotEntry = {
    id: number;
    versionId: number;
    taskId: number | null;
    previewSlug: string;
    previewUrl: string;
    internalUrl: string;
    expired: boolean;
    expiresAt: string | null;
    createdAt: string;
    versionLabel: string | null;
  };
  const [previewSnapshots, setPreviewSnapshots] = useState<PreviewSnapshotEntry[]>([]);
  const [previewSnapshotsLoading, setPreviewSnapshotsLoading] = useState(false);

  const fetchPreviewSnapshots = useCallback(async () => {
    setPreviewSnapshotsLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/preview-snapshots`);
      if (res.ok) {
        const data = (await res.json()) as { previewSnapshots: PreviewSnapshotEntry[] };
        setPreviewSnapshots(data.previewSnapshots ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setPreviewSnapshotsLoading(false);
    }
  }, [projectId]);

  // ── Preview link generator state (Task #624) ─────────────────────────────
  const [previewLinkLoading, setPreviewLinkLoading] = useState(false);
  const [previewLinkResult, setPreviewLinkResult] = useState<{
    previewSlug: string;
    internalUrl: string;
    expiresAt: string;
  } | null>(null);
  const [previewLinkError, setPreviewLinkError] = useState<string | null>(null);
  const [previewLinkCopied, setPreviewLinkCopied] = useState(false);

  const createPreviewLink = useCallback(async () => {
    setPreviewLinkLoading(true);
    setPreviewLinkError(null);
    setPreviewLinkResult(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/preview-link`, { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        internalUrl?: string;
        previewSlug?: string;
        expiresAt?: string;
      };
      if (!res.ok || !data.ok) {
        setPreviewLinkError(data.error ?? "Failed to create preview link");
      } else {
        setPreviewLinkResult({
          previewSlug: data.previewSlug ?? "",
          internalUrl: data.internalUrl ?? "",
          expiresAt: data.expiresAt ?? "",
        });
      }
    } catch {
      setPreviewLinkError("Network error. Please try again.");
    } finally {
      setPreviewLinkLoading(false);
    }
  }, [projectId]);

  const copyPreviewLink = useCallback(() => {
    if (!previewLinkResult) return;
    void navigator.clipboard.writeText(window.location.origin + previewLinkResult.internalUrl);
    setPreviewLinkCopied(true);
    setTimeout(() => setPreviewLinkCopied(false), 2000);
  }, [previewLinkResult]);

  // ── Bandwidth metering state (Task #624) ─────────────────────────────────
  type BandwidthData = {
    month: string;
    bytesServed: number;
    requestCount: number;
    bytesServedFormatted: string;
    tierBytes: number;
    tierBytesFormatted: string;
    pctUsed: number;
    atSoftCap: boolean;
    atHardCap: boolean;
  };
  const [bandwidthData, setBandwidthData] = useState<BandwidthData | null>(null);
  const [bandwidthLoading, setBandwidthLoading] = useState(false);

  const fetchBandwidth = useCallback(async () => {
    setBandwidthLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/bandwidth`);
      if (res.ok) {
        const data = (await res.json()) as BandwidthData;
        setBandwidthData(data);
      }
    } catch {
      /* ignore */
    } finally {
      setBandwidthLoading(false);
    }
  }, [projectId]);

  // ── Analytics traffic state (Task #624) ──────────────────────────────────
  type TrafficData = {
    totalViews: number;
    uniqueVisitors: number;
    windowDays: number;
    dailyBreakdown: { day: string; views: number; uniqueSessions: number }[];
    topPages: { path: string; views: number }[];
    topReferrers: { referrer: string; count: number }[];
  };
  const [trafficData, setTrafficData] = useState<TrafficData | null>(null);
  const [trafficLoading, setTrafficLoading] = useState(false);

  const fetchTrafficData = useCallback(async () => {
    setTrafficLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/analytics/traffic?days=30`);
      if (res.ok) {
        const data = (await res.json()) as TrafficData;
        setTrafficData(data);
      }
    } catch {
      /* ignore */
    } finally {
      setTrafficLoading(false);
    }
  }, [projectId]);

  // ── Custom error pages state (Task #624) ─────────────────────────────────
  const [errorPage404, setErrorPage404] = useState<string>("");
  const [errorPage500, setErrorPage500] = useState<string>("");
  const [savingErrorPages, setSavingErrorPages] = useState(false);
  const [errorPagesSaved, setErrorPagesSaved] = useState(false);

  const saveErrorPages = useCallback(async () => {
    setSavingErrorPages(true);
    setErrorPagesSaved(false);
    try {
      const res = await authFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          errorPage404: errorPage404.trim() || null,
          errorPage500: errorPage500.trim() || null,
        }),
      });
      if (res.ok) setErrorPagesSaved(true);
    } catch {
      /* ignore */
    } finally {
      setSavingErrorPages(false);
    }
  }, [projectId, errorPage404, errorPage500]);

  // Domain management state
  type DomainInfo = {
    subdomain: string | null;
    subdomainUrl: string | null;
    cnameTarget: string;
    platformDomain: string;
    customDomain: string | null;
    domainStatus: string;
    sslStatus: string;
    isPublished: boolean;
    verificationToken: string | null;
    txtName: string | null;
    txtValue: string | null;
  };
  const [domainInfo, setDomainInfo] = useState<DomainInfo | null>(null);

  // Multi-domain collection state
  type ProjectDomain = {
    id: number;
    projectId: number;
    hostname: string;
    isPrimary: boolean;
    recordType: "a" | "cname";
    verificationToken: string;
    verificationStatus: "pending" | "verified" | "failed";
    sslStatus: "pending" | "provisioning" | "active" | "failed";
    verifiedAt: string | null;
    createdAt: string;
    updatedAt: string;
    // BYO cert + CF fields (Task #554)
    cfHostnameId?: string | null;
    sslSource?: string;
    byoCertExpiresAt?: string | null;
    byoCertSubject?: string | null;
    /** Live error reason from SSE stream — cleared on next success event */
    liveError?: string;
  };
  type DomainsResponse = {
    domains: ProjectDomain[];
    subdomain: string | null;
    subdomainUrl: string | null;
    cnameTarget: string;
    platformDomain: string;
    redirectWwwApex: boolean;
  };
  type DiagnosticCheck = {
    id: string;
    label: string;
    passed: boolean | null;
    detail: string;
    fixHint: string | null;
  };
  type DiagnoseResult = {
    hostname: string;
    isApex: boolean;
    recordType: "a" | "cname";
    verificationStatus: "pending" | "verified" | "failed";
    sslStatus: "pending" | "provisioning" | "active" | "failed";
    checks: DiagnosticCheck[];
    allPassed: boolean;
    cnameTarget: string;
    txtName: string;
    txtValue: string;
  };
  const [domainsData, setDomainsData] = useState<DomainsResponse | null>(null);

  // Workspace plan quota — surfaced inline in the Custom Domains section (Task #660).
  const { currentWorkspace } = useWorkspace();
  const workspaceIdForQuota = currentWorkspace?.id ?? null;
  type DomainQuotaInfo = {
    plan: string;
    maxCustomDomains: number;
    customDomainsUsed: number;
    domainsPercentUsed: number;
  };
  const [domainQuota, setDomainQuota] = useState<DomainQuotaInfo | null>(null);

  const fetchDomainQuota = useCallback(async () => {
    if (!workspaceIdForQuota) return;
    try {
      const res = await authFetch(`/api/workspaces/${workspaceIdForQuota}/usage`);
      if (!res.ok) return;
      const data = (await res.json()) as { quota?: DomainQuotaInfo };
      if (data?.quota) setDomainQuota(data.quota);
    } catch {
      /* non-fatal */
    }
  }, [workspaceIdForQuota]);

  useEffect(() => {
    void fetchDomainQuota();
  }, [fetchDomainQuota]);

  const [newDomainInput, setNewDomainInput] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [domainAddError, setDomainAddError] = useState<string | null>(null);
  const [verifyingDomainId, setVerifyingDomainId] = useState<number | null>(null);
  const [diagnosingDomainId, setDiagnosingDomainId] = useState<number | null>(null);
  const [diagnoseResults, setDiagnoseResults] = useState<Record<number, DiagnoseResult>>({});
  const [expandedDomainId, setExpandedDomainId] = useState<number | null>(null);

  const fetchMobileBuilds = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await authFetch(`/api/projects/${projectId}/builds`);
      if (res.ok) {
        const data = (await res.json()) as { builds: MobileBuildLog[] };
        setMobileBuilds(data.builds ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [projectId, isMobile]);

  const fetchCreditBalance = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await authFetch("/api/credits");
      if (res.ok) {
        const data = (await res.json()) as { balance: number };
        setCreditBalance(data.balance);
      }
    } catch {
      /* ignore */
    }
  }, [isMobile]);

  // Keep a stable ref so the focus listener doesn't need to be recreated
  creditFetchRef.current = fetchCreditBalance;

  const triggerBuild = async (p: "ios" | "android") => {
    setTriggeringBuild(p);
    setBuildError(null);
    setCredsMissing(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/builds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: p }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        if (res.status === 422) {
          setCredsMissing(err.error ?? "EAS credentials not configured.");
        } else {
          setBuildError(err.error ?? `HTTP ${res.status}`);
        }
        return;
      }
      // Refresh builds list and credit balance immediately after queuing
      await Promise.all([fetchMobileBuilds(), fetchCreditBalance()]);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Build trigger failed");
    } finally {
      setTriggeringBuild(null);
    }
  };

  async function handleDeploy() {
    setIsDeploying(true);
    setDeployError(null);
    onPublishingActivity?.({ status: "running", label: "Publishing to production" });
    try {
      const res = await authFetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        ok: boolean;
        publicUrl: string;
        internalPathUrl?: string;
        publicSlug: string;
        deployedAt: string;
        filesDeployed?: number;
        containerDeployed: boolean;
        prodContainerUrl?: string | null;
        note?: string;
      };
      setDeployResult(data);
      setShowDeployConfirm(false);
      onPublishingActivity?.({ status: "completed", label: "Published to production" });
      if (data.prodContainerUrl) setProdContainerUrl(data.prodContainerUrl);
      void fetchDomain();
      void fetchDeployments();
      void fetchSiteSettings();
    } catch (err) {
      onPublishingActivity?.({ status: "failed", label: "Publishing needs attention" });
      setDeployError(err instanceof Error ? err.message : "Deploy failed — please try again.");
    } finally {
      setIsDeploying(false);
    }
  }

  async function handlePublishStaging() {
    setIsStaging(true);
    setStagingError(null);
    setStagingResult(null);
    onPublishingActivity?.({ status: "running", label: "Publishing to staging" });
    try {
      const res = await authFetch(`/api/projects/${projectId}/publish?env=staging`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        ok: boolean;
        stagingUrl: string;
        publicSlug: string;
        snapshotVersionId?: number;
        filesPublished?: number;
      };
      setStagingResult(data);
      onPublishingActivity?.({ status: "completed", label: "Published to staging" });
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      void fetchDeployments();
    } catch (err) {
      onPublishingActivity?.({ status: "failed", label: "Publishing needs attention" });
      setStagingError(
        err instanceof Error ? err.message : "Staging publish failed — please try again.",
      );
    } finally {
      setIsStaging(false);
    }
  }

  async function handlePromote() {
    setIsPromoting(true);
    setPromoteError(null);
    setPromoteResult(null);
    onPublishingActivity?.({ status: "running", label: "Publishing staging changes" });
    try {
      const res = await authFetch(`/api/projects/${projectId}/promote`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        ok: boolean;
        publicUrl: string;
        publicSlug: string;
        stagingSnapshotLabel?: string | null;
      };
      setPromoteResult(data);
      setShowPromoteConfirm(false);
      onPublishingActivity?.({ status: "completed", label: "Published staging changes" });
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      void fetchDeployments();
    } catch (err) {
      onPublishingActivity?.({ status: "failed", label: "Publishing needs attention" });
      setPromoteError(err instanceof Error ? err.message : "Promote failed — please try again.");
    } finally {
      setIsPromoting(false);
    }
  }

  async function handlePublish() {
    setIsPublishing(true);
    setPublishError(null);
    onPublishingActivity?.({ status: "running", label: "Publishing" });
    try {
      const res = await authFetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        ok: boolean;
        publicUrl: string;
        internalPathUrl: string;
        publicSlug: string;
        publishedAt: string;
        snapshotVersionId?: number;
        filesPublished?: number;
        containerDeployed?: boolean;
        containerUrl?: string | null;
      };
      setPublishResult(data);
      onPublishingActivity?.({ status: "completed", label: "Published" });
      // Refresh project query so publicSlug is available immediately (e.g. QR panel in Preview tab)
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      // Refresh domain info (subdomain url is now available) and deployment logs
      void fetchDomain();
      void fetchDeployments();
    } catch (err) {
      onPublishingActivity?.({ status: "failed", label: "Publishing needs attention" });
      setPublishError(err instanceof Error ? err.message : "Publish failed — please try again.");
    } finally {
      setIsPublishing(false);
    }
  }

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const fetchReadiness = useCallback(async () => {
    if (platform !== "web") return;
    setReadinessLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/publish-readiness?env=${webEnv}`);
      if (res.ok) setReadiness((await res.json()) as ReadinessResult);
    } catch {
      /* ignore */
    } finally {
      setReadinessLoading(false);
    }
  }, [projectId, webEnv, platform]);

  const fetchIosReadiness = useCallback(async () => {
    if (!isMobile) return;
    setIosReadinessLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/publish-readiness?env=ios`);
      if (res.ok) setIosReadiness((await res.json()) as ReadinessResult);
    } catch {
      /* ignore */
    } finally {
      setIosReadinessLoading(false);
    }
  }, [projectId, isMobile]);

  const fetchAndReadiness = useCallback(async () => {
    if (!isMobile) return;
    setAndReadinessLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/publish-readiness?env=android`);
      if (res.ok) setAndReadiness((await res.json()) as ReadinessResult);
    } catch {
      /* ignore */
    } finally {
      setAndReadinessLoading(false);
    }
  }, [projectId, isMobile]);

  const fetchDeployments = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/deployments`);
      if (res.ok) {
        const data = (await res.json()) as {
          deployments: Array<{
            id: number;
            env: string;
            status: string;
            publicUrl: string | null;
            filesCount: number | null;
            createdAt: string;
          }>;
        };
        setDeployments(data.deployments ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const fetchSiteSettings = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}`);
      if (res.ok) {
        const data = (await res.json()) as {
          siteTitle?: string | null;
          metaDescription?: string | null;
          themeColor?: string | null;
          prodContainerStatus?: string | null;
          prodContainerUrl?: string | null;
          blockPublishOnCritical?: boolean | null;
        };
        setSiteTitle(data.siteTitle ?? "");
        setMetaDescription(data.metaDescription ?? "");
        setThemeColor(data.themeColor ?? "");
        setProdContainerStatus(data.prodContainerStatus ?? null);
        setProdContainerUrl(data.prodContainerUrl ?? null);
        setBlockPublishOnCritical(data.blockPublishOnCritical ?? true);
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const fetchDomain = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/domain`);
      if (res.ok) {
        const data = (await res.json()) as DomainInfo;
        setDomainInfo(data);
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const fetchDomains = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/domains`);
      if (res.ok) {
        const data = (await res.json()) as DomainsResponse;
        setDomainsData(data);
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  const addDomain = async () => {
    const hostname = newDomainInput
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!hostname) return;
    setAddingDomain(true);
    setDomainAddError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname }),
      });
      const data = (await res.json()) as { error?: string; domain?: ProjectDomain };
      if (!res.ok) {
        setDomainAddError(data.error ?? "Failed to add domain.");
      } else {
        setNewDomainInput("");
        await fetchDomains();
      }
    } catch {
      setDomainAddError("Failed to add domain. Please try again.");
    } finally {
      setAddingDomain(false);
    }
  };

  const removeDomainById = async (domainId: number) => {
    try {
      await authFetch(`/api/projects/${projectId}/domains/${domainId}`, { method: "DELETE" });
      await fetchDomains();
      setDiagnoseResults((prev) => {
        const next = { ...prev };
        delete next[domainId];
        return next;
      });
      if (expandedDomainId === domainId) setExpandedDomainId(null);
    } catch {
      /* ignore */
    }
  };

  const setPrimaryDomain = async (domainId: number) => {
    try {
      await authFetch(`/api/projects/${projectId}/domains/${domainId}/primary`, {
        method: "PATCH",
      });
      await fetchDomains();
    } catch {
      /* ignore */
    }
  };

  const verifyDomainById = async (domainId: number) => {
    setVerifyingDomainId(domainId);
    try {
      await authFetch(`/api/projects/${projectId}/domains/${domainId}/verify`, { method: "POST" });
      await fetchDomains();
    } catch {
      /* ignore */
    } finally {
      setVerifyingDomainId(null);
    }
  };

  const diagnosedomainById = async (domainId: number) => {
    setDiagnosingDomainId(domainId);
    setExpandedDomainId(domainId);
    try {
      const res = await authFetch(`/api/projects/${projectId}/domains/${domainId}/diagnose`);
      if (res.ok) {
        const data = (await res.json()) as DiagnoseResult;
        setDiagnoseResults((prev) => ({ ...prev, [domainId]: data }));
      }
    } catch {
      /* ignore */
    } finally {
      setDiagnosingDomainId(null);
    }
  };

  const toggleWwwRedirect = async (domainId: number, enabled: boolean) => {
    try {
      await authFetch(`/api/projects/${projectId}/domains/${domainId}/www-redirect`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await fetchDomains();
    } catch {
      /* ignore */
    }
  };

  const saveSiteSettings = async () => {
    setSavingSettings(true);
    try {
      await authFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteTitle: siteTitle || null,
          metaDescription: metaDescription || null,
          themeColor: themeColor || null,
        }),
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveSecurityGate = async (value: boolean) => {
    setBlockPublishOnCritical(value);
    setSavingSecurityGate(true);
    try {
      await authFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockPublishOnCritical: value }),
      });
      // Re-run readiness check so gate status updates immediately
      void fetchReadiness();
    } finally {
      setSavingSecurityGate(false);
    }
  };

  // Fetch signing key status when the mobile tab is active
  useEffect(() => {
    void fetchSigningStatus();
  }, [fetchSigningStatus]);

  // Fetch secrets list for credentials checklist; re-fetch when the tab
  // becomes visible again so stale badge states are cleared automatically.
  useEffect(() => {
    void fetchConfiguredSecrets();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchConfiguredSecrets();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchConfiguredSecrets]);

  useEffect(() => {
    void fetchCreditBalance();
    // Refresh on window focus so returning from Stripe checkout shows updated balance
    const onFocus = () => {
      void creditFetchRef.current?.();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchCreditBalance]);

  // Poll mobile builds every 5 s while any build is in progress
  useEffect(() => {
    void fetchMobileBuilds();
  }, [fetchMobileBuilds]);

  // Re-fetch store readiness whenever a build transitions to "passed"
  const prevPassedBuildIds = useRef<Set<number>>(new Set());
  useEffect(() => {
    const currentPassed = new Set(
      mobileBuilds.filter((b) => b.status === "passed").map((b) => b.id),
    );
    const newlyPassed = mobileBuilds.filter(
      (b) => b.status === "passed" && !prevPassedBuildIds.current.has(b.id),
    );
    if (newlyPassed.length > 0) {
      if (newlyPassed.some((b) => b.platform === "ios" || b.platform === null)) {
        void fetchIosReadiness();
      }
      if (newlyPassed.some((b) => b.platform === "android" || b.platform === null)) {
        void fetchAndReadiness();
      }
    }
    prevPassedBuildIds.current = currentPassed;
  }, [mobileBuilds, fetchIosReadiness, fetchAndReadiness]);

  useEffect(() => {
    const inProgress = mobileBuilds.some((b) =>
      ["queued", "building", "submitting"].includes(b.status),
    );
    if (!inProgress) return;
    const timer = setInterval(() => {
      void fetchMobileBuilds();
    }, 5000);
    return () => clearInterval(timer);
  }, [mobileBuilds, fetchMobileBuilds]);

  useEffect(() => {
    void fetchReadiness();
    void fetchDeployments();
    void fetchSiteSettings();
    void fetchDomain();
    void fetchDomains();
    void fetchIosReadiness();
    void fetchAndReadiness();
  }, [
    fetchReadiness,
    fetchDeployments,
    fetchSiteSettings,
    fetchDomain,
    fetchDomains,
    fetchIosReadiness,
    fetchAndReadiness,
  ]);

  // ── Domain SSE stream ─────────────────────────────────────────────────────
  // Subscribe to real-time domain events (verified, ssl_issued, error) so the
  // domain list updates inline without requiring a manual refresh.
  // useEventSource handles exponential back-off reconnection automatically.
  useEventSource(`/api/projects/${projectId}/domains/events/stream`, {
    onMessage: (evt) => {
      try {
        const payload = JSON.parse(evt.data as string) as {
          type: string;
          domainId?: number;
          domain?: string;
          hostname?: string;
          verificationStatus?: string;
          sslStatus?: string;
          error?: string;
        };

        if (payload.type === "added" || payload.type === "removed") {
          void fetchDomains();
          return;
        }

        // "snapshot" and status-change events update individual domain rows inline
        setDomainsData((prev) => {
          if (!prev) return prev;
          const domains = prev.domains.map((d) => {
            const matchById = payload.domainId !== undefined && d.id === payload.domainId;
            const matchByHostname =
              (payload.domain !== undefined && d.hostname === payload.domain) ||
              (payload.hostname !== undefined && d.hostname === payload.hostname);
            if (!matchById && !matchByHostname) return d;

            const updates: Partial<typeof d> = {};

            if (payload.type === "verified") {
              updates.verificationStatus = "verified";
              updates.liveError = undefined; // clear any prior error
            } else if (payload.type === "error") {
              if (payload.verificationStatus) {
                updates.verificationStatus =
                  payload.verificationStatus as typeof d.verificationStatus;
              }
              updates.liveError = payload.error;
            } else if (payload.type === "snapshot" || payload.type === "updated") {
              // Snapshot events carry the canonical status from the DB
              if (payload.verificationStatus) {
                updates.verificationStatus =
                  payload.verificationStatus as typeof d.verificationStatus;
              }
            }

            if (payload.type === "ssl_issued") {
              updates.sslStatus = "active";
              updates.liveError = undefined;
            } else if (payload.sslStatus) {
              updates.sslStatus = payload.sslStatus as typeof d.sslStatus;
            }

            return { ...d, ...updates };
          });
          return { ...prev, domains };
        });
      } catch {
        /* ignore malformed events */
      }
    },
  });

  const webChecklist = webEnv === "testing" ? WEB_TESTING_CHECKLIST : WEB_PRODUCTION_CHECKLIST;
  const webRequired = webChecklist.flatMap((s) => s.items).filter((i) => i.required);
  const webReadyToPublish = webRequired.every((i) => checked.has(i.id));

  const iosRequired = IOS_CHECKLIST.flatMap((s) => s.items).filter((i) => i.required);
  const iosChecklistComplete = iosRequired.every((i) => checked.has(i.id));
  // Gate on server-side readiness when available; fall back to checklist-only
  const iosReady = iosReadiness
    ? iosReadiness.canPublish && iosChecklistComplete
    : iosChecklistComplete;

  const andRequired = ANDROID_CHECKLIST.flatMap((s) => s.items).filter((i) => i.required);
  const andChecklistComplete = andRequired.every((i) => checked.has(i.id));
  // Gate on server-side readiness when available; fall back to checklist-only
  const andReady = andReadiness
    ? andReadiness.canPublish && andChecklistComplete
    : andChecklistComplete;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold">Publishing</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Complete all required steps before making your app live.
          </p>
        </div>

        <HealthCheckBanner projectId={projectId} onShowProdErrors={onNavigateToLogs} />

        {/* Platform tabs — iOS/Android only visible for mobile projects */}
        <div className="flex gap-2">
          {(["web", ...(isMobile ? ["ios", "android"] : [])] as Platform[]).map((p) => {
            const icons: Record<Platform, React.ElementType> = {
              web: Globe,
              ios: Smartphone,
              android: PlaySquare,
            };
            const labels: Record<Platform, string> = { web: "Web", ios: "iOS", android: "Android" };
            const Icon = icons[p];
            return (
              <button
                key={p}
                onClick={() => {
                  setPlatform(p);
                  if (p === "ios") void fetchIosReadiness();
                  if (p === "android") void fetchAndReadiness();
                }}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors",
                  platform === p
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Icon className="h-4 w-4" />
                {labels[p]}
              </button>
            );
          })}
        </div>

        {/* ── WEB ─────────────────────────────────────────────────────────── */}
        {platform === "web" && (
          <div className="space-y-5">
            {/* Environment sub-tabs: Production / Staging / Previews / Analytics */}
            <div className="flex gap-1 bg-muted/40 rounded-lg p-1 border border-border">
              {(
                [
                  { id: "production" as const, label: "Production" },
                  { id: "staging" as const, label: "Staging" },
                  { id: "previews" as const, label: "Previews" },
                  { id: "analytics" as const, label: "Analytics" },
                ] as { id: "production" | "staging" | "previews" | "analytics"; label: string }[]
              ).map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => {
                    setEnvTab(id);
                    if (id === "previews") void fetchPreviewSnapshots();
                    if (id === "analytics") {
                      void fetchTrafficData();
                      void fetchBandwidth();
                    }
                  }}
                  className={cn(
                    "flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors",
                    envTab === id
                      ? "bg-background text-foreground shadow-sm border border-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── Staging tab ──────────────────────────────────────────────── */}
            {envTab === "staging" && (
              <div className="space-y-4">
                <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                  <h3 className="font-semibold text-sm">Staging environment</h3>
                  <p className="text-xs text-muted-foreground">
                    Publish to staging to test your app at a separate URL before going live. Use
                    Promote to push the staged snapshot to production when you're ready.
                  </p>
                  {stagingError && <p className="text-xs text-destructive">{stagingError}</p>}
                  {stagingResult?.ok && (
                    <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 space-y-1">
                      <p className="text-xs font-medium text-green-600">
                        Staged successfully — {stagingResult.filesPublished} file(s)
                      </p>
                      <a
                        href={stagingResult.stagingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary underline break-all"
                      >
                        {stagingResult.stagingUrl}
                      </a>
                      <p className="text-[10px] text-muted-foreground">
                        Staging URL. Not publicly linked — share for review only.
                      </p>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={isStaging}
                    onClick={() => void handlePublishStaging()}
                  >
                    {isStaging ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Server className="h-4 w-4 mr-2" />
                    )}
                    {isStaging ? "Publishing to staging…" : "Publish to Staging"}
                  </Button>
                </div>

                <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                  <h3 className="font-semibold text-sm">Promote to production</h3>
                  <p className="text-xs text-muted-foreground">
                    Copies the current staging snapshot directly to your live production URL — no
                    rebuild required.
                  </p>
                  {promoteError && <p className="text-xs text-destructive">{promoteError}</p>}
                  {promoteResult?.ok && (
                    <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 space-y-1">
                      <p className="text-xs font-medium text-green-600">Promoted to production</p>
                      <a
                        href={promoteResult.publicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary underline break-all"
                      >
                        {promoteResult.publicUrl}
                      </a>
                    </div>
                  )}
                  {showPromoteConfirm ? (
                    <div className="space-y-2">
                      <p className="text-xs text-amber-500">
                        This will replace your current live production app with the staged snapshot.
                        Continue?
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="flex-1"
                          disabled={isPromoting}
                          onClick={() => void handlePromote()}
                        >
                          {isPromoting ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          ) : null}
                          {isPromoting ? "Promoting…" : "Promote"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => setShowPromoteConfirm(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => setShowPromoteConfirm(true)}
                    >
                      <Globe className="h-4 w-4 mr-2" />
                      Promote to Production
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* ── Previews tab ─────────────────────────────────────────────── */}
            {envTab === "previews" && (
              <div className="space-y-4">
                <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">Per-build preview URLs</h3>
                    <button
                      onClick={() => void fetchPreviewSnapshots()}
                      className="text-xs text-primary hover:text-primary/80 transition-colors"
                      disabled={previewSnapshotsLoading}
                    >
                      {previewSnapshotsLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Every successful build creates a preview link valid for 7 days. Share these
                    links for quick reviews without affecting production.
                  </p>

                  {previewSnapshotsLoading && (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  )}

                  {!previewSnapshotsLoading && previewSnapshots.length === 0 && (
                    <p className="text-xs text-muted-foreground italic py-4 text-center">
                      No previews yet. Build the app to generate a preview URL.
                    </p>
                  )}
                  {/* Manual preview link generator */}
                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-xs font-medium">Create a shareable draft link</p>
                    <p className="text-xs text-muted-foreground">
                      Snapshot current files into a new 7-day preview link without publishing to
                      production.
                    </p>
                    {previewLinkError && (
                      <p className="text-xs text-destructive">{previewLinkError}</p>
                    )}
                    {previewLinkResult && (
                      <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <a
                            href={previewLinkResult.internalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary underline break-all flex-1"
                          >
                            {window.location.origin + previewLinkResult.internalUrl}
                          </a>
                          <button
                            onClick={copyPreviewLink}
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                            title="Copy link"
                          >
                            {previewLinkCopied ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Expires{" "}
                          {new Date(previewLinkResult.expiresAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => void createPreviewLink()}
                      disabled={previewLinkLoading}
                    >
                      {previewLinkLoading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : (
                        <Link2 className="h-3.5 w-3.5 mr-2" />
                      )}
                      {previewLinkLoading ? "Creating…" : "Create Preview Link"}
                    </Button>
                  </div>

                  {!previewSnapshotsLoading && previewSnapshots.length > 0 && (
                    <div className="space-y-2">
                      {previewSnapshots.map((snap) => {
                        const expiresAt = snap.expiresAt ? new Date(snap.expiresAt) : null;
                        const now = new Date();
                        const msLeft = expiresAt ? expiresAt.getTime() - now.getTime() : 0;
                        const daysLeft = Math.max(0, Math.floor(msLeft / 86400000));
                        return (
                          <div
                            key={snap.id}
                            className={cn(
                              "rounded-lg border p-3 space-y-1",
                              snap.expired
                                ? "border-muted bg-muted/20 opacity-60"
                                : "border-border bg-muted/10",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] text-muted-foreground font-mono truncate">
                                {snap.previewSlug}
                              </p>
                              {snap.expired ? (
                                <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
                                  Expired
                                </span>
                              ) : (
                                <span className="text-[10px] bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded shrink-0">
                                  {daysLeft}d left
                                </span>
                              )}
                            </div>
                            {snap.versionLabel && (
                              <p className="text-[10px] text-muted-foreground">
                                {snap.versionLabel}
                              </p>
                            )}
                            {!snap.expired && (
                              <a
                                href={snap.internalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary underline break-all"
                              >
                                Open preview
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Analytics tab (Task #624) ─────────────────────────────────── */}
            {envTab === "analytics" && (
              <div className="space-y-4">
                {/* Traffic overview */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <Activity className="h-4 w-4 text-muted-foreground" />
                      Traffic Overview — last 30 days
                    </h3>
                    <button
                      onClick={() => void fetchTrafficData()}
                      disabled={trafficLoading}
                      className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                    >
                      {trafficLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>

                  {trafficLoading && (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  )}

                  {!trafficLoading && !trafficData && (
                    <p className="text-xs text-muted-foreground text-center py-4 italic">
                      Click Refresh to load traffic data.
                    </p>
                  )}

                  {trafficData && (
                    <>
                      {/* Summary row */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-lg bg-muted/40 border border-border px-4 py-3 space-y-0.5">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            Page Views
                          </p>
                          <p className="text-xl font-semibold tabular-nums">
                            {trafficData.totalViews.toLocaleString()}
                          </p>
                        </div>
                        <div className="rounded-lg bg-muted/40 border border-border px-4 py-3 space-y-0.5">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            Unique Visitors
                          </p>
                          <p className="text-xl font-semibold tabular-nums">
                            {trafficData.uniqueVisitors.toLocaleString()}
                          </p>
                        </div>
                      </div>

                      {/* Daily bar chart */}
                      {trafficData.dailyBreakdown.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            Daily Views
                          </p>
                          <div className="flex items-end gap-0.5 h-20">
                            {(() => {
                              const maxViews = Math.max(
                                1,
                                ...trafficData.dailyBreakdown.map((d) => d.views),
                              );
                              return trafficData.dailyBreakdown.slice(-30).map((d) => (
                                <div
                                  key={d.day}
                                  title={`${d.day}: ${d.views} views`}
                                  className="flex-1 bg-primary/70 rounded-sm hover:bg-primary transition-colors min-w-0"
                                  style={{
                                    height: `${Math.max(4, (d.views / maxViews) * 100)}%`,
                                  }}
                                />
                              ));
                            })()}
                          </div>
                          <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>{trafficData.dailyBreakdown[0]?.day?.slice(5) ?? ""}</span>
                            <span>
                              {trafficData.dailyBreakdown[
                                trafficData.dailyBreakdown.length - 1
                              ]?.day?.slice(5) ?? ""}
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Top pages */}
                {trafficData && trafficData.topPages.length > 0 && (
                  <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      Top Pages
                    </h3>
                    <div className="space-y-1.5">
                      {trafficData.topPages.map((p) => {
                        const maxViews = trafficData.topPages[0]?.views ?? 1;
                        const pct = Math.round((p.views / maxViews) * 100);
                        return (
                          <div key={p.path} className="space-y-0.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-mono text-muted-foreground truncate max-w-[60%]">
                                {p.path || "/"}
                              </span>
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                {p.views.toLocaleString()} views
                              </span>
                            </div>
                            <div className="h-1 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary/60 rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Top referrers */}
                {trafficData && trafficData.topReferrers.length > 0 && (
                  <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-muted-foreground" />
                      Top Referrers
                    </h3>
                    <div className="divide-y divide-border">
                      {trafficData.topReferrers.map((r) => (
                        <div
                          key={r.referrer}
                          className="flex items-center justify-between py-2 text-xs"
                        >
                          <span className="text-muted-foreground truncate max-w-[70%]">
                            {r.referrer}
                          </span>
                          <span className="text-muted-foreground shrink-0">
                            {r.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bandwidth summary in analytics tab */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      Bandwidth — {bandwidthData?.month ?? "this month"}
                    </h3>
                    <button
                      onClick={() => void fetchBandwidth()}
                      disabled={bandwidthLoading}
                      className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                    >
                      {bandwidthLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                  {bandwidthData ? (
                    <div className="space-y-3">
                      {(bandwidthData.atSoftCap || bandwidthData.atHardCap) && (
                        <div
                          className={cn(
                            "flex items-start gap-2 text-xs rounded-lg px-3 py-2",
                            bandwidthData.atHardCap
                              ? "bg-destructive/10 border border-destructive/20 text-destructive"
                              : "bg-yellow-500/10 border border-yellow-500/20 text-yellow-600",
                          )}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          <span>
                            {bandwidthData.atHardCap ? (
                              <>
                                Hard cap reached.{" "}
                                <SupportReportLink>
                                  Ask support to increase the allowance
                                </SupportReportLink>
                                .
                              </>
                            ) : (
                              "Approaching bandwidth limit (80%+ used this month)."
                            )}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {bandwidthData.bytesServedFormatted} of {bandwidthData.tierBytesFormatted}
                        </span>
                        <span className="font-medium">{bandwidthData.pctUsed}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            bandwidthData.atHardCap
                              ? "bg-destructive"
                              : bandwidthData.atSoftCap
                                ? "bg-yellow-500"
                                : "bg-primary",
                          )}
                          style={{ width: `${Math.min(100, bandwidthData.pctUsed)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{bandwidthData.requestCount.toLocaleString()} requests</span>
                        <span>Resets next month</span>
                      </div>
                    </div>
                  ) : bandwidthLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">
                      Click Refresh to load bandwidth data.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* ── Production tab (existing content) ────────────────────────── */}
            {envTab === "production" && (
              <>
                {/* Version approval gate — agentic projects only (Task #767) */}
                {isAgentic && versions.length > 0 && (
                  <div
                    data-testid="version-snapshots-panel"
                    className="border border-border rounded-xl bg-card overflow-hidden"
                  >
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <div>
                        <h3 className="font-semibold text-sm">Version Snapshots</h3>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Approve a snapshot to allow production publishing.
                        </p>
                      </div>
                      <button
                        onClick={() => void refetchVersions()}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Refresh
                      </button>
                    </div>
                    <div className="divide-y divide-border max-h-64 overflow-y-auto">
                      {versions.slice(0, 10).map((v) => {
                        const approvedAt = v.testingApprovedAt;
                        const approvedBy = v.testingApprovedBy;
                        const isApproved = approvedAt != null;
                        return (
                          <div key={v.id} className="px-4 py-2.5 flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-mono text-muted-foreground shrink-0">
                                  v{v.id}
                                </span>
                                {v.label && (
                                  <span className="text-xs font-medium truncate">{v.label}</span>
                                )}
                                <span className="text-[10px] text-muted-foreground shrink-0">
                                  {new Date(v.createdAt).toLocaleDateString()}
                                </span>
                              </div>
                              {isApproved && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                                  <span className="text-[10px] text-green-600">
                                    Approved for testing
                                    {approvedBy ? ` by ${approvedBy}` : ""}
                                  </span>
                                </div>
                              )}
                            </div>
                            {!isApproved && (
                              <button
                                data-testid="approve-version-btn"
                                onClick={() => {
                                  approveVersionMutation.mutate(
                                    { id: projectId, versionId: v.id },
                                    { onSuccess: () => void refetchVersions() },
                                  );
                                }}
                                disabled={
                                  approveVersionMutation.isPending ||
                                  (!!containerId && testingStatus !== "ready")
                                }
                                title={
                                  !!containerId && testingStatus !== "ready"
                                    ? "Start the test environment first — navigate to the Preview tab and launch a test run before approving."
                                    : undefined
                                }
                                className="shrink-0 text-[11px] px-2.5 py-1 rounded-md border border-primary/40 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {approveVersionMutation.isPending ? "Approving…" : "Approve"}
                              </button>
                            )}
                            {isApproved && (
                              <span
                                data-testid="version-approved-badge"
                                className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 font-semibold"
                              >
                                Approved
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Agentic publish gate notice */}
                {isAgentic && !latestApprovedVersion && versions.length > 0 && (
                  <div
                    data-testid="testing-approval-warning"
                    className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-4 py-3 flex items-start gap-2"
                  >
                    <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-yellow-700 dark:text-yellow-400">
                      Approve at least one version snapshot above before publishing to production.
                    </p>
                  </div>
                )}

                {/* Preview DB provisioning — agentic projects */}
                {isAgentic && (
                  <div className="border border-border rounded-xl p-4 bg-card space-y-2">
                    <h3 className="font-semibold text-sm">Preview Database</h3>
                    <p className="text-xs text-muted-foreground">
                      Provision a dedicated Postgres database for the preview / testing environment.
                      This keeps preview traffic isolated from production data.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={provisionPreviewDbMutation.isPending}
                      onClick={() =>
                        provisionPreviewDbMutation.mutate(
                          { id: projectId },
                          {
                            onSuccess: () =>
                              void queryClient.invalidateQueries({
                                queryKey: getGetProjectQueryKey(projectId),
                              }),
                          },
                        )
                      }
                    >
                      {provisionPreviewDbMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Server className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {provisionPreviewDbMutation.isPending
                        ? "Provisioning…"
                        : "Provision Preview DB"}
                    </Button>
                    {provisionPreviewDbMutation.isError && (
                      <p className="text-xs text-destructive">
                        {provisionPreviewDbMutation.error instanceof Error
                          ? provisionPreviewDbMutation.error.message
                          : "Failed to provision preview database"}
                      </p>
                    )}
                    {provisionPreviewDbMutation.isSuccess && (
                      <p className="text-xs text-green-600">
                        Preview database provisioning started. This may take a moment.
                      </p>
                    )}
                  </div>
                )}

                {/* 1-2-3 publish flow */}
                <div className="border border-border rounded-xl p-4 bg-card">
                  <h3 className="font-semibold text-sm mb-3">How to publish</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {/* Step 1: Check */}
                    <div
                      className={cn(
                        "flex flex-col items-center gap-2 p-3 rounded-lg border-2 text-center transition-colors",
                        readiness?.canPublish
                          ? "border-green-500/40 bg-green-500/5"
                          : "border-border bg-muted/30",
                      )}
                    >
                      <div
                        className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                          readiness?.canPublish
                            ? "bg-green-500 text-white"
                            : "bg-muted text-muted-foreground border border-border",
                        )}
                      >
                        {readiness?.canPublish ? <CheckCircle2 className="h-4 w-4" /> : "1"}
                      </div>
                      <div>
                        <div className="text-xs font-semibold">Check</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {readiness?.canPublish ? "All good" : "Run readiness check"}
                        </div>
                      </div>
                      {!readiness?.canPublish && (
                        <button
                          onClick={() => void fetchReadiness()}
                          disabled={readinessLoading}
                          className="text-[10px] font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                        >
                          {readinessLoading ? "Checking…" : "Run check"}
                        </button>
                      )}
                    </div>
                    {/* Step 2: Publish */}
                    <div
                      className={cn(
                        "flex flex-col items-center gap-2 p-3 rounded-lg border-2 text-center transition-colors",
                        publishResult || deployResult
                          ? "border-green-500/40 bg-green-500/5"
                          : readiness?.canPublish
                            ? "border-primary/40 bg-primary/5"
                            : "border-border bg-muted/30 opacity-60",
                      )}
                    >
                      <div
                        className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                          publishResult || deployResult
                            ? "bg-green-500 text-white"
                            : readiness?.canPublish
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground border border-border",
                        )}
                      >
                        {publishResult || deployResult ? <CheckCircle2 className="h-4 w-4" /> : "2"}
                      </div>
                      <div>
                        <div className="text-xs font-semibold">Publish</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {publishResult || deployResult ? "Published" : "Make it live"}
                        </div>
                      </div>
                      {readiness?.canPublish &&
                        !publishResult &&
                        !deployResult &&
                        webEnv === "testing" &&
                        (!isAgentic || latestApprovedVersion != null) && (
                          <button
                            onClick={() => void handlePublish()}
                            disabled={isPublishing}
                            className="text-[10px] font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                          >
                            {isPublishing ? "Publishing…" : "Publish now"}
                          </button>
                        )}
                    </div>
                    {/* Step 3: Share */}
                    <div
                      className={cn(
                        "flex flex-col items-center gap-2 p-3 rounded-lg border-2 text-center transition-colors",
                        publishResult || deployResult
                          ? "border-green-500/40 bg-green-500/5"
                          : "border-border bg-muted/30 opacity-40",
                      )}
                    >
                      <div
                        className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                          publishResult || deployResult
                            ? "bg-green-500 text-white"
                            : "bg-muted text-muted-foreground border border-border",
                        )}
                      >
                        {publishResult || deployResult ? <CheckCircle2 className="h-4 w-4" /> : "3"}
                      </div>
                      <div>
                        <div className="text-xs font-semibold">Share</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Copy your public link
                        </div>
                      </div>
                      {(publishResult || deployResult) && (
                        <CopyUrlButton
                          url={deployResult?.publicUrl ?? publishResult?.publicUrl ?? ""}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Environment toggle card */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-sm">Deployment Environment</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Testing for internal review, Production for public traffic.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setWebEnv((e) => (e === "testing" ? "production" : "testing"));
                        setShowDeployConfirm(false);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-muted hover:bg-muted/80 text-sm font-medium transition-colors"
                    >
                      {webEnv === "testing" ? (
                        <ToggleLeft className="h-4 w-4 text-yellow-500" />
                      ) : (
                        <ToggleRight className="h-4 w-4 text-green-500" />
                      )}
                      {webEnv === "testing" ? "Testing" : "Production"}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {(["testing", "production"] as const).map((env) => (
                      <div
                        key={env}
                        className={cn(
                          "p-3 rounded-lg border-2 transition-colors",
                          webEnv === env
                            ? env === "testing"
                              ? "border-yellow-500/50 bg-yellow-500/5"
                              : "border-green-500/50 bg-green-500/5"
                            : "border-border bg-muted/30",
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          {env === "testing" ? (
                            <Server className="h-3.5 w-3.5 text-yellow-500" />
                          ) : (
                            <Globe className="h-3.5 w-3.5 text-green-500" />
                          )}
                          <span className="text-xs font-semibold capitalize">{env}</span>
                          {webEnv === env && (
                            <span
                              className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded font-bold",
                                env === "testing"
                                  ? "bg-yellow-500/20 text-yellow-600"
                                  : "bg-green-500/20 text-green-600",
                              )}
                            >
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {env === "testing"
                            ? "Preview URL — internal use only, test keys."
                            : "Live domain — public traffic, production keys."}
                        </p>
                        <div className="mt-2 font-mono text-[10px] text-muted-foreground bg-muted rounded px-2 py-1 truncate">
                          {env === "testing" ? "mustaflow.app/preview/…" : "yourdomain.com"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Deployment status */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">Deployment Status</h3>
                    <button
                      onClick={() => void fetchSiteSettings()}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Refresh
                    </button>
                  </div>
                  <div className="space-y-2">
                    {/* Production container health */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground text-xs flex items-center gap-1.5">
                        <Activity className="h-3 w-3" />
                        Production server
                      </span>
                      <div className="flex items-center gap-2">
                        {prodContainerStatus === "running" ? (
                          <>
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-green-500/15 text-green-600">
                              running
                            </span>
                            {prodContainerUrl && (
                              <a
                                href={prodContainerUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-primary hover:underline truncate max-w-[160px]"
                              >
                                {prodContainerUrl}
                              </a>
                            )}
                          </>
                        ) : prodContainerStatus === "deploying" || isDeploying ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-500/15 text-blue-600 flex items-center gap-1">
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            deploying
                          </span>
                        ) : prodContainerStatus === "error" ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-destructive/15 text-destructive">
                            error
                          </span>
                        ) : prodContainerStatus === "stopped" ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">
                            stopped
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">
                            not deployed
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Custom domain */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground text-xs">Custom domain</span>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "text-[10px] px-2 py-0.5 rounded-full font-medium",
                            domainInfo?.domainStatus === "active"
                              ? "bg-green-500/15 text-green-600"
                              : domainInfo?.customDomain
                                ? "bg-yellow-500/15 text-yellow-600"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {domainInfo?.domainStatus === "active"
                            ? "active"
                            : domainInfo?.customDomain
                              ? "pending DNS"
                              : "unconfigured"}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {domainInfo?.customDomain ?? "Configure below"}
                        </span>
                      </div>
                    </div>
                    {/* SSL */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground text-xs">SSL / HTTPS</span>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "text-[10px] px-2 py-0.5 rounded-full font-medium",
                            domainInfo?.sslStatus === "active"
                              ? "bg-green-500/15 text-green-600"
                              : "bg-yellow-500/15 text-yellow-600",
                          )}
                        >
                          {domainInfo?.sslStatus === "active" ? "active" : "partial"}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {domainInfo?.sslStatus === "active"
                            ? "Certificate active"
                            : "Requires manual cert setup"}
                        </span>
                      </div>
                    </div>
                    {/* Rollback */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground text-xs">Rollback point</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-green-500/15 text-green-600">
                          ready
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          Latest snapshot available
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Deployment Substrate (Task #543) */}
                <DeploymentSubstratePanel projectId={projectId} />

                {/* Domain Management */}
                <div className="border border-border rounded-xl p-5 bg-card space-y-5">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    Domains
                  </h3>

                  {/* Auto-subdomain */}
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Your Subdomain
                    </p>
                    <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2.5">
                      <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      {domainInfo?.subdomain ? (
                        <>
                          <span className="text-sm font-mono flex-1 truncate">
                            {domainInfo.subdomain}
                          </span>
                          <a
                            href={domainInfo.subdomainUrl ?? "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </a>
                          <CopyUrlButton url={domainInfo.subdomainUrl ?? domainInfo.subdomain} />
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">
                          Generated on first publish
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Automatically assigned. Available as soon as you publish.
                    </p>
                  </div>

                  {/* Custom subdomain picker */}
                  {domainInfo?.subdomain && (
                    <CustomSubdomainPicker
                      projectId={projectId}
                      currentSlug={domainInfo.subdomain.split(".")[0] ?? ""}
                      platformDomain={domainInfo.platformDomain}
                      onSuccess={(newSlug, newSubdomain) => {
                        setDomainInfo((prev) =>
                          prev
                            ? {
                                ...prev,
                                subdomain: newSubdomain,
                                subdomainUrl: `https://${newSubdomain}`,
                              }
                            : prev,
                        );
                      }}
                    />
                  )}

                  <div className="border-t border-border" />

                  {/* Buy a domain — embedded search/purchase panel */}
                  <BuyDomainSection projectId={projectId} />

                  <div className="border-t border-border" />

                  {/* Multi-domain list */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Custom Domains
                      </p>
                      {domainQuota &&
                        domainQuota.maxCustomDomains !== Infinity &&
                        (() => {
                          const used = domainQuota.customDomainsUsed;
                          const max = domainQuota.maxCustomDomains;
                          const pct = domainQuota.domainsPercentUsed ?? 0;
                          const atCap = used >= max;
                          const nearCap = !atCap && pct > 80;
                          const planLabel =
                            domainQuota.plan.charAt(0).toUpperCase() + domainQuota.plan.slice(1);
                          const showUpgrade = atCap || nearCap || domainQuota.plan === "free";
                          return (
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "text-xs px-2 py-1 rounded-md border",
                                  atCap
                                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                                    : nearCap
                                      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                                      : "border-border bg-muted/40 text-muted-foreground",
                                )}
                              >
                                {used} of {max} used
                                <span className="ml-1.5 opacity-70">({planLabel} plan)</span>
                              </span>
                              {showUpgrade && domainQuota.plan !== "enterprise" && (
                                <span className="text-xs text-muted-foreground">
                                  Review plans in Billing &amp; Usage
                                </span>
                              )}
                            </div>
                          );
                        })()}
                    </div>

                    {/* Add domain input */}
                    <div className="flex gap-2">
                      <input
                        value={newDomainInput}
                        onChange={(e) => setNewDomainInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addDomain();
                        }}
                        placeholder="app.yourdomain.com or yourdomain.com"
                        className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void addDomain()}
                        disabled={addingDomain || !newDomainInput.trim()}
                        className="shrink-0"
                      >
                        {addingDomain ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Link2 className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1.5">Add</span>
                      </Button>
                    </div>

                    {domainAddError && (
                      <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>{domainAddError}</span>
                      </div>
                    )}

                    {/* Domain rows */}
                    {domainsData && domainsData.domains.length > 0 && (
                      <div className="space-y-2">
                        {domainsData.domains.map((domain) => {
                          const isApex = domain.recordType === "a";
                          const isVerified = domain.verificationStatus === "verified";
                          const isSslActive = domain.sslStatus === "active";
                          const isVerifying = verifyingDomainId === domain.id;
                          const isDiagnosing = diagnosingDomainId === domain.id;
                          const isExpanded = expandedDomainId === domain.id;
                          const diagResult = diagnoseResults[domain.id];

                          return (
                            <div
                              key={domain.id}
                              className="border border-border rounded-lg bg-muted/30 overflow-hidden"
                            >
                              {/* Domain row header */}
                              <div className="flex items-center gap-2 px-3 py-2.5">
                                {/* Status icon */}
                                {isVerified && isSslActive ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                                ) : isVerified ? (
                                  <Lock className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
                                ) : domain.verificationStatus === "failed" ? (
                                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                                ) : (
                                  <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                )}

                                {/* Hostname + badges */}
                                <div className="flex items-center gap-1.5 flex-1 min-w-0 flex-wrap">
                                  <span className="text-sm font-mono truncate">
                                    {domain.hostname}
                                  </span>
                                  {domain.isPrimary && (
                                    <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium shrink-0">
                                      primary
                                    </span>
                                  )}
                                  {isApex && (
                                    <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-medium shrink-0">
                                      apex
                                    </span>
                                  )}
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0",
                                      isVerified
                                        ? "bg-green-500/15 text-green-400"
                                        : domain.verificationStatus === "failed"
                                          ? "bg-destructive/15 text-destructive"
                                          : "bg-yellow-500/15 text-yellow-400",
                                    )}
                                  >
                                    {isVerified
                                      ? "DNS verified"
                                      : domain.verificationStatus === "failed"
                                        ? "DNS failed"
                                        : "DNS pending"}
                                  </span>
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0",
                                      isSslActive
                                        ? "bg-green-500/15 text-green-400"
                                        : domain.sslStatus === "failed"
                                          ? "bg-destructive/15 text-destructive"
                                          : "bg-yellow-500/15 text-yellow-400",
                                    )}
                                  >
                                    <Lock className="h-2.5 w-2.5" />
                                    {isSslActive
                                      ? "SSL"
                                      : domain.sslStatus === "provisioning"
                                        ? "SSL provisioning"
                                        : domain.sslStatus === "failed"
                                          ? "SSL failed"
                                          : "SSL pending"}
                                  </span>
                                </div>

                                {/* Action buttons */}
                                <div className="flex items-center gap-1 shrink-0">
                                  {isVerified && (
                                    <a
                                      href={`https://${domain.hostname}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                                      title="Open domain"
                                    >
                                      <ArrowUpRight className="h-3.5 w-3.5" />
                                    </a>
                                  )}
                                  {!isVerified && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => void verifyDomainById(domain.id)}
                                      disabled={isVerifying}
                                      className="h-7 px-2 text-xs"
                                      title="Check DNS"
                                    >
                                      {isVerifying ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      isExpanded && diagResult
                                        ? setExpandedDomainId(null)
                                        : void diagnosedomainById(domain.id)
                                    }
                                    disabled={isDiagnosing}
                                    className="h-7 px-2 text-xs"
                                    title="Diagnose"
                                  >
                                    {isDiagnosing ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : isExpanded ? (
                                      <ChevronUp className="h-3.5 w-3.5" />
                                    ) : (
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                  {!domain.isPrimary && isVerified && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => void setPrimaryDomain(domain.id)}
                                      className="h-7 px-2 text-[10px]"
                                      title="Make primary"
                                    >
                                      Set primary
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void removeDomainById(domain.id)}
                                    className="h-7 px-2 text-destructive hover:text-destructive"
                                    title="Remove"
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>

                              {/* Live error reason from SSE stream */}
                              {domain.liveError && (
                                <div className="px-3 py-1.5 border-t border-destructive/30 bg-destructive/5 flex items-start gap-1.5">
                                  <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-px" />
                                  <p className="text-xs text-destructive leading-snug">
                                    {domain.liveError}
                                  </p>
                                </div>
                              )}

                              {/* DNS setup instructions (unverified domains) */}
                              {!isVerified && (
                                <div className="px-3 pb-3 space-y-2.5 border-t border-border/60 pt-2.5">
                                  {/* TXT verification record */}
                                  <div className="space-y-1.5">
                                    <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
                                      <Info className="h-3 w-3" />
                                      {isApex
                                        ? "Option A — TXT ownership record"
                                        : "Option A — TXT ownership record (preferred)"}
                                    </p>
                                    <DnsTable
                                      rows={[
                                        {
                                          type: "TXT",
                                          name: `_mustaflow-verify.${domain.hostname}`,
                                          value: domain.verificationToken,
                                        },
                                      ]}
                                    />
                                  </div>

                                  {/* Routing record (CNAME for subdomains, A for apex) */}
                                  <div className="space-y-1.5">
                                    <p className="text-xs text-muted-foreground font-medium">
                                      {isApex
                                        ? "Option B — A record routing (apex)"
                                        : "Option B — CNAME routing record"}
                                    </p>
                                    {isApex ? (
                                      <div className="space-y-1">
                                        <DnsTable
                                          rows={[
                                            { type: "A", name: "@", value: "76.76.21.21" },
                                            { type: "A", name: "@", value: "76.76.21.22" },
                                          ]}
                                        />
                                        <p className="text-[11px] text-muted-foreground">
                                          Apex domains require A records (not CNAME). Add both IPs.
                                        </p>
                                      </div>
                                    ) : (
                                      <DnsTable
                                        rows={[
                                          {
                                            type: "CNAME",
                                            name: domain.hostname,
                                            value: domainsData.cnameTarget,
                                          },
                                        ]}
                                      />
                                    )}
                                  </div>

                                  <p className="text-[11px] text-muted-foreground">
                                    DNS propagation can take up to 48 h. Click the refresh button
                                    once records are in place.
                                  </p>

                                  {/* Registrar-specific setup steps */}
                                  <div className="border-t border-border/40 pt-2.5">
                                    <RegistrarGuideSection />
                                  </div>
                                </div>
                              )}

                              {/* Diagnostic panel */}
                              {isExpanded && diagResult && (
                                <div className="px-3 pb-3 border-t border-border/60 pt-2.5 space-y-2">
                                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                    <Activity className="h-3.5 w-3.5" />
                                    Diagnostic results
                                  </p>
                                  <div className="space-y-1">
                                    {diagResult.checks.map((check) => (
                                      <div
                                        key={check.id}
                                        className="flex items-start gap-2 text-xs py-1"
                                      >
                                        {check.passed === true ? (
                                          <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0 mt-0.5" />
                                        ) : check.passed === false ? (
                                          <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                                        ) : (
                                          <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                                        )}
                                        <div className="flex-1 min-w-0">
                                          <p
                                            className={cn(
                                              "font-medium",
                                              check.passed === true
                                                ? "text-green-400"
                                                : check.passed === false
                                                  ? "text-destructive"
                                                  : "text-muted-foreground",
                                            )}
                                          >
                                            {check.label}
                                          </p>
                                          <p className="text-muted-foreground">{check.detail}</p>
                                          {check.fixHint && check.passed === false && (
                                            <p className="text-yellow-400 mt-0.5">
                                              {check.fixHint}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="flex justify-end">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => void diagnosedomainById(domain.id)}
                                      disabled={isDiagnosing}
                                      className="h-7 text-xs gap-1"
                                    >
                                      <RefreshCw className="h-3 w-3" />
                                      Re-run
                                    </Button>
                                  </div>
                                </div>
                              )}

                              {/* www-redirect toggle (apex domains only, when verified) */}
                              {isApex && isVerified && (
                                <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 bg-muted/20">
                                  <span className="text-xs text-muted-foreground">
                                    Redirect www.{domain.hostname} → {domain.hostname}
                                  </span>
                                  <button
                                    onClick={() =>
                                      void toggleWwwRedirect(
                                        domain.id,
                                        !domainsData.redirectWwwApex,
                                      )
                                    }
                                    className="shrink-0 flex items-center"
                                    title="Toggle www redirect"
                                  >
                                    {domainsData.redirectWwwApex ? (
                                      <ToggleRight className="h-5 w-5 text-primary" />
                                    ) : (
                                      <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                                    )}
                                  </button>
                                </div>
                              )}

                              {/* DNS Records editor + Email wizard (expanded, verified domains) */}
                              {isExpanded && isVerified && (
                                <div className="px-3 pb-3 border-t border-border/60 pt-3 space-y-3">
                                  <DnsRecordsPanel
                                    projectId={projectId}
                                    domain={{
                                      id: domain.id,
                                      hostname: domain.hostname,
                                      cfHostnameId: domain.cfHostnameId ?? null,
                                      sslSource: domain.sslSource ?? "cloudflare",
                                      byoCertExpiresAt: domain.byoCertExpiresAt ?? null,
                                      byoCertSubject: domain.byoCertSubject ?? null,
                                      sslStatus: domain.sslStatus,
                                      verificationToken: domain.verificationToken ?? null,
                                    }}
                                  />
                                  <EmailSetupWizard
                                    projectId={projectId}
                                    domainId={domain.id}
                                    hostname={domain.hostname}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {domainsData && domainsData.domains.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-3">
                        No custom domains yet. Add one above to get started.
                      </p>
                    )}
                  </div>
                </div>

                {/* Domain analytics + webhooks */}
                {domainsData &&
                  domainsData.domains.some((d) => d.verificationStatus === "verified") && (
                    <div className="border border-border rounded-xl p-4 bg-card space-y-4">
                      <h3 className="font-semibold text-sm flex items-center gap-2">
                        <Activity className="h-4 w-4 text-muted-foreground" />
                        Domain Analytics &amp; Webhooks
                      </h3>
                      <div className="space-y-3">
                        {domainsData.domains
                          .filter((d) => d.verificationStatus === "verified")
                          .map((d) => (
                            <DomainAnalyticsCard
                              key={d.id}
                              projectId={projectId}
                              domainId={d.id}
                              hostname={d.hostname}
                            />
                          ))}
                        <div className="pt-1">
                          <WebhooksPanel projectId={projectId} />
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Manage domain webhooks and traffic analytics.{" "}
                        <a
                          href="/help/domains-api"
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          API &amp; CLI docs
                        </a>
                      </p>
                    </div>
                  )}

                {/* Site metadata */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-4">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    Published Site Metadata
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        Site Title
                      </label>
                      <input
                        value={siteTitle}
                        onChange={(e) => setSiteTitle(e.target.value)}
                        placeholder="My Awesome App"
                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        Meta Description
                      </label>
                      <textarea
                        value={metaDescription}
                        onChange={(e) => setMetaDescription(e.target.value)}
                        placeholder="A brief description for search engines and social sharing…"
                        rows={2}
                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        Theme Color
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={themeColor || "#000000"}
                          onChange={(e) => setThemeColor(e.target.value)}
                          className="h-9 w-12 rounded border border-border cursor-pointer bg-muted p-0.5"
                        />
                        <input
                          value={themeColor}
                          onChange={(e) => setThemeColor(e.target.value)}
                          placeholder="#3b82f6"
                          className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void saveSiteSettings()}
                      disabled={savingSettings}
                      className="w-full"
                    >
                      {savingSettings ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5 mr-2" />
                      )}
                      Save Settings
                    </Button>
                  </div>
                </div>

                {/* Custom error pages (Task #624) */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-4">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    Custom Error Pages
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Paste full HTML to serve for 404 (not found) and 500 (server error) responses.
                    Leave blank to use the platform default pages.
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        404 — Page not found
                      </label>
                      <textarea
                        value={errorPage404}
                        onChange={(e) => setErrorPage404(e.target.value)}
                        placeholder="<!doctype html><html>…</html>"
                        rows={3}
                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        500 — Server error
                      </label>
                      <textarea
                        value={errorPage500}
                        onChange={(e) => setErrorPage500(e.target.value)}
                        placeholder="<!doctype html><html>…</html>"
                        rows={3}
                        className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                    {errorPagesSaved && (
                      <div className="flex items-center gap-1.5 text-xs text-green-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Saved
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => void saveErrorPages()}
                      disabled={savingErrorPages}
                    >
                      {savingErrorPages ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5 mr-2" />
                      )}
                      Save Error Pages
                    </Button>
                  </div>
                </div>

                {/* Advanced settings — security gate toggle */}
                <div className="border border-border rounded-xl p-4 bg-card space-y-4">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                    Advanced
                  </h3>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">Block publish on critical findings</div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        When on, publishing is blocked if any unresolved critical security findings
                        exist from the latest quality scan. Disable to publish despite open
                        findings.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveSecurityGate(!blockPublishOnCritical)}
                      disabled={savingSecurityGate}
                      className="shrink-0 flex items-center gap-1.5 mt-0.5 disabled:opacity-50"
                      title={
                        blockPublishOnCritical
                          ? "Click to disable the security gate"
                          : "Click to enable the security gate"
                      }
                    >
                      {savingSecurityGate ? (
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      ) : blockPublishOnCritical ? (
                        <ToggleRight className="h-6 w-6 text-primary" />
                      ) : (
                        <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                  {!blockPublishOnCritical && (
                    <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        Security gate is disabled. Critical findings will not block publishing.
                      </span>
                    </div>
                  )}
                </div>

                {/* Deployment logs — includes EAS build entries (env="eas-ios"/"eas-android") */}
                <div className="border border-border rounded-xl overflow-hidden bg-card">
                  <button
                    onClick={() => setLogsOpen((o) => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span>Deployment History</span>
                      {deployments.length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-normal">
                          {deployments.length}
                        </span>
                      )}
                    </div>
                    {logsOpen ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  {logsOpen &&
                    (deployments.length === 0 ? (
                      <div className="bg-zinc-950 font-mono text-xs text-zinc-500 p-4 border-t border-border min-h-[80px] flex items-center justify-center">
                        No deployments yet. History will appear here after your first deploy or EAS
                        build.
                      </div>
                    ) : (
                      <div className="divide-y divide-border border-t border-border">
                        {deployments.map((d) => {
                          const isEas = d.env.startsWith("eas-");
                          const isProduction = d.env === "production";
                          const isTesting = d.env === "testing";
                          const envLabel = isEas
                            ? d.env
                                .replace("eas-ios", "EAS iOS")
                                .replace("eas-android", "EAS Android")
                            : d.env;
                          return (
                            <div
                              key={d.id}
                              className="flex items-center gap-3 px-4 py-2.5 text-xs flex-wrap"
                            >
                              {/* Status badge */}
                              <span
                                className={cn(
                                  "shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold",
                                  d.status === "passed"
                                    ? "bg-green-500/15 text-green-600"
                                    : d.status === "failed"
                                      ? "bg-destructive/15 text-destructive"
                                      : d.status === "unpublished"
                                        ? "bg-muted text-muted-foreground"
                                        : "bg-yellow-500/15 text-yellow-600",
                                )}
                              >
                                {d.status === "started" ? "building" : d.status}
                              </span>
                              {/* Environment label */}
                              {isEas ? (
                                <span className="shrink-0 flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-400 border border-orange-500/20">
                                  <Package className="h-2.5 w-2.5" />
                                  {envLabel}
                                </span>
                              ) : isProduction ? (
                                <span className="shrink-0 flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded text-[10px] bg-green-500/15 text-green-600 border border-green-500/20">
                                  <Rocket className="h-2.5 w-2.5" />
                                  production
                                </span>
                              ) : isTesting ? (
                                <span className="shrink-0 flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/15 text-yellow-600 border border-yellow-500/20">
                                  <Server className="h-2.5 w-2.5" />
                                  testing
                                </span>
                              ) : (
                                <span className="text-muted-foreground font-mono shrink-0 uppercase tracking-wide">
                                  {envLabel}
                                </span>
                              )}
                              {/* URL link */}
                              {d.publicUrl && (
                                <a
                                  href={d.publicUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-primary truncate hover:underline min-w-0"
                                >
                                  {d.publicUrl}
                                </a>
                              )}
                              {d.filesCount != null && (
                                <span className="text-muted-foreground shrink-0">
                                  {d.filesCount} file{d.filesCount !== 1 ? "s" : ""}
                                </span>
                              )}
                              <span className="ml-auto text-muted-foreground shrink-0">
                                {new Date(d.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                </div>

                {/* Readiness gate */}
                {platform === "web" && (
                  <ReadinessGate
                    readiness={readiness}
                    loading={readinessLoading}
                    onRefresh={() => void fetchReadiness()}
                    projectId={projectId}
                    onFindingDismissed={() => void fetchReadiness()}
                    onNavigateToSecurity={onNavigateToChecks}
                  />
                )}

                {/* Checklist */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-semibold text-sm whitespace-nowrap">
                      {webEnv === "testing" ? "Testing" : "Production"} Checklist
                    </h3>
                    <ProgressBar sections={webChecklist} checked={checked} />
                  </div>
                  <ChecklistGroup sections={webChecklist} checked={checked} onToggle={toggle} />
                </div>

                {/* Deploy action (Phase E) */}
                {webEnv === "production" && (
                  <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Rocket className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">Deploy to Production</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Snapshots your app, provisions a production container with blue/green swap,
                      and makes it publicly available. Secrets are injected as environment
                      variables.
                    </p>

                    {!webReadyToPublish && (
                      <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>
                          Complete all required checklist items before deploying to production.
                        </span>
                      </div>
                    )}

                    {/* Task #768: testing required gate for full-stack projects */}
                    {isFullStackWithoutTest && (
                      <div className="flex items-start gap-2 text-xs bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span className="flex-1">
                          {testingStatus === "stale"
                            ? "Draft changed after the last test — run a new test before deploying to production."
                            : testingStatus === "ready"
                              ? "Test environment is running. Approve it in the Test Environment tab to unlock production deploys."
                              : "This project must pass a test preview before deploying to production."}
                        </span>
                        {onNavigateToTestEnv && (
                          <button
                            onClick={onNavigateToTestEnv}
                            className="shrink-0 font-semibold whitespace-nowrap hover:underline focus:outline-none"
                          >
                            Test Environment
                          </button>
                        )}
                      </div>
                    )}

                    {!showDeployConfirm ? (
                      <Button
                        className="w-full"
                        disabled={
                          !webReadyToPublish ||
                          readiness?.canPublish === false ||
                          isDeploying ||
                          isFullStackWithoutTest
                        }
                        onClick={() => setShowDeployConfirm(true)}
                      >
                        <Rocket className="h-4 w-4 mr-2" />
                        Deploy to Production
                      </Button>
                    ) : (
                      <div className="space-y-3">
                        <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm space-y-1">
                          <p className="font-semibold text-xs">Confirm production deploy</p>
                          <p className="text-muted-foreground text-xs">
                            This will snapshot the current build, boot a fresh production container,
                            run a health check, then route traffic. The old container stays live
                            until the new one is healthy. A rollback point is saved automatically.
                          </p>
                        </div>
                        {deployError && (
                          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>{deployError}</span>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Button
                            className="flex-1"
                            onClick={() => void handleDeploy()}
                            disabled={isDeploying}
                          >
                            {isDeploying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            {isDeploying ? "Deploying…" : "Confirm Deploy"}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => setShowDeployConfirm(false)}
                            disabled={isDeploying}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {deployResult && (
                  <div className="border border-green-500/20 rounded-xl p-4 bg-green-500/5 space-y-3">
                    <div className="flex items-center gap-2 text-green-500 text-sm font-semibold">
                      <CheckCircle2 className="h-4 w-4" />
                      {deployResult.containerDeployed
                        ? "App deployed and live"
                        : "Snapshot published"}
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href={deployResult.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-primary hover:text-primary/80 text-sm break-all min-w-0"
                      >
                        <span className="truncate">{deployResult.publicUrl}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                      </a>
                      <CopyUrlButton url={deployResult.publicUrl} />
                    </div>
                    {deployResult.prodContainerUrl && (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">Dev Server:</span>
                        <a
                          href={deployResult.prodContainerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-primary hover:underline truncate"
                        >
                          {deployResult.prodContainerUrl}
                        </a>
                        <CopyUrlButton url={deployResult.prodContainerUrl} />
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Slug: <span className="font-mono">{deployResult.publicSlug}</span>
                      {deployResult.filesDeployed != null && (
                        <span>
                          {" · "}
                          {deployResult.filesDeployed} file
                          {deployResult.filesDeployed !== 1 ? "s" : ""}
                        </span>
                      )}
                      {" · "}
                      {deployResult.containerDeployed ? "Server deployed" : "Snapshot only"}
                      {" · "}Deployed {new Date(deployResult.deployedAt).toLocaleString()}
                    </p>
                    {deployResult.note && (
                      <p className="text-[11px] text-muted-foreground italic">
                        {deployResult.note}
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        await authFetch(`/api/projects/${projectId}/unpublish`, { method: "POST" });
                        setDeployResult(null);
                        void fetchDomain();
                        void fetchDeployments();
                        void fetchSiteSettings();
                      }}
                    >
                      Unpublish
                    </Button>
                  </div>
                )}

                {publishResult && (
                  <div className="border border-green-500/20 rounded-xl p-4 bg-green-500/5 space-y-3">
                    <div className="flex items-center gap-2 text-green-500 text-sm font-semibold">
                      <CheckCircle2 className="h-4 w-4" />
                      App is live (snapshot)
                    </div>
                    {publishResult.containerDeployed && (
                      <div className="flex items-center gap-2 text-xs bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                        <Server className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="text-primary font-medium">Server deployed</span>
                        <span className="text-muted-foreground">
                          — public URL proxies to a live production server
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <a
                        href={publishResult.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-primary hover:text-primary/80 text-sm break-all min-w-0"
                      >
                        <span className="truncate">{publishResult.publicUrl}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                      </a>
                      <CopyUrlButton url={publishResult.publicUrl} />
                    </div>
                    {publishResult.containerDeployed && publishResult.containerUrl && (
                      <p className="text-[11px] text-muted-foreground">
                        Server URL:{" "}
                        <span className="font-mono break-all">{publishResult.containerUrl}</span>
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Slug: <span className="font-mono">{publishResult.publicSlug}</span>
                      {!publishResult.containerDeployed && publishResult.filesPublished != null && (
                        <span>
                          {" · "}
                          {publishResult.filesPublished} file
                          {publishResult.filesPublished !== 1 ? "s" : ""}
                        </span>
                      )}
                      {" · "}Published {new Date(publishResult.publishedAt).toLocaleString()}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Internal path:{" "}
                      <span className="font-mono">{publishResult.internalPathUrl}</span>
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        await authFetch(`/api/projects/${projectId}/unpublish`, { method: "POST" });
                        setPublishResult(null);
                        void fetchDomain();
                        void fetchDeployments();
                      }}
                    >
                      Unpublish
                    </Button>
                  </div>
                )}

                {/* GitHub auto-sync panel */}
                <GitHubAutoSyncPanel projectId={projectId} />

                {webEnv === "testing" && (
                  <div className="space-y-2">
                    {publishError && <p className="text-xs text-destructive">{publishError}</p>}
                    {(() => {
                      const secCheck = readiness?.checks.find(
                        (c) => c.id === "no_critical_findings" && c.status === "fail",
                      );
                      const secCount = secCheck?.criticalFindingCount ?? 0;
                      const isSecBlocked = Boolean(secCheck) && blockPublishOnCritical;
                      return (
                        <Button
                          variant="outline"
                          className="w-full"
                          disabled={!webReadyToPublish || isPublishing || isSecBlocked}
                          onClick={() => void handlePublish()}
                        >
                          {isPublishing ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : isSecBlocked ? (
                            <ShieldCheck className="h-4 w-4 mr-2 text-destructive" />
                          ) : (
                            <Server className="h-4 w-4 mr-2" />
                          )}
                          {isPublishing
                            ? "Publishing…"
                            : isSecBlocked
                              ? `Blocked by ${secCount} critical finding${secCount !== 1 ? "s" : ""}`
                              : "Publish to Testing"}
                        </Button>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── iOS ─────────────────────────────────────────────────────────── */}
        {platform === "ios" && (
          <div className="space-y-5">
            {/* EAS Build panel */}
            <EasBuildPanel projectId={projectId} platform="ios" />

            {/* App Store links */}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a
                  href="https://developer.apple.com/account"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1"
                >
                  Apple Developer <ArrowUpRight className="h-3 w-3" />
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a
                  href="https://appstoreconnect.apple.com"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1"
                >
                  App Store Connect <ArrowUpRight className="h-3 w-3" />
                </a>
              </Button>
            </div>

            {/* EAS Build panel for mobile projects */}
            {isMobile && (
              <div className="border border-border rounded-xl bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border space-y-0.5">
                  <h3 className="font-semibold text-sm">Store Build</h3>
                  <p className="text-xs text-muted-foreground">
                    Triggers an Expo Application Services cloud build. Costs 5 credits per build.
                  </p>
                </div>

                {/* Configure EAS Credentials — expandable */}
                <div className="border-b border-border">
                  <div className="flex items-center px-4 py-2.5">
                    <button
                      onClick={() => setIosCredsOpen((o) => !o)}
                      className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity"
                      aria-expanded={iosCredsOpen}
                    >
                      <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs font-semibold">Configure EAS Credentials</span>
                      {(() => {
                        const iosCreds = [
                          { name: "EAS_ACCESS_TOKEN", required: true },
                          { name: "EXPO_ACCOUNT_NAME", required: true },
                          { name: "EXPO_APP_SLUG", required: false },
                          { name: "APPLE_TEAM_ID", required: true },
                          { name: "APPLE_ASC_KEY_ID", required: true },
                          { name: "APPLE_ASC_ISSUER_ID", required: true },
                          { name: "APPLE_ASC_PRIVATE_KEY", required: true },
                        ];
                        const required = iosCreds.filter((c) => c.required);
                        const missing = required.filter((c) => !configuredSecrets.has(c.name));
                        return missing.length === 0 ? (
                          <span className="text-[10px] bg-green-500/15 text-green-500 px-1.5 py-0.5 rounded font-medium">
                            All set
                          </span>
                        ) : (
                          <span className="text-[10px] bg-yellow-500/15 text-yellow-500 px-1.5 py-0.5 rounded font-medium">
                            {missing.length} missing
                          </span>
                        );
                      })()}
                    </button>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => void fetchConfiguredSecrets()}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Refresh secret status"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => setIosCredsOpen((o) => !o)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        aria-expanded={iosCredsOpen}
                      >
                        {iosCredsOpen ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {iosCredsOpen && (
                    <div className="divide-y divide-border/50">
                      {[
                        {
                          name: "EAS_ACCESS_TOKEN",
                          label: "EAS Access Token",
                          required: true,
                          hint: "From expo.dev → Access Tokens",
                        },
                        {
                          name: "EXPO_ACCOUNT_NAME",
                          label: "Expo Account Name",
                          required: true,
                          hint: "Your Expo username or org slug",
                        },
                        {
                          name: "EXPO_APP_SLUG",
                          label: "Expo App Slug",
                          required: false,
                          hint: "Defaults to project name if not set",
                        },
                        {
                          name: "APPLE_TEAM_ID",
                          label: "Apple Developer Team ID",
                          required: true,
                          hint: "10-character ID from developer.apple.com",
                        },
                        {
                          name: "APPLE_ASC_KEY_ID",
                          label: "ASC API Key ID",
                          required: true,
                          hint: "From App Store Connect → Users → Keys",
                        },
                        {
                          name: "APPLE_ASC_ISSUER_ID",
                          label: "ASC Issuer ID",
                          required: true,
                          hint: "Shown alongside the API key",
                        },
                        {
                          name: "APPLE_ASC_PRIVATE_KEY",
                          label: "ASC Private Key (.p8)",
                          required: true,
                          hint: "Paste the full .p8 file contents",
                        },
                      ].map(({ name, label, required, hint }) => {
                        const isSet = configuredSecrets.has(name);
                        const secretEntry = configuredSecrets.get(name);
                        return (
                          <div key={name} className="flex items-start gap-2.5 px-4 py-2.5 text-xs">
                            {isSet ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                            ) : (
                              <Circle
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0 mt-0.5",
                                  required ? "text-yellow-500" : "text-muted-foreground/60",
                                )}
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span
                                  className={cn(
                                    "font-medium",
                                    isSet
                                      ? "text-foreground"
                                      : required
                                        ? "text-foreground"
                                        : "text-muted-foreground",
                                  )}
                                >
                                  {label}
                                </span>
                                {required && !isSet && (
                                  <span className="text-[9px] bg-yellow-500/15 text-yellow-600 px-1 py-0.5 rounded font-semibold">
                                    required
                                  </span>
                                )}
                                {!required && (
                                  <span className="text-[9px] bg-muted text-muted-foreground px-1 py-0.5 rounded">
                                    optional
                                  </span>
                                )}
                              </div>
                              <code className="font-mono text-[9px] text-muted-foreground">
                                {name}
                              </code>
                              {hint && (
                                <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>
                              )}
                            </div>
                            {!isSet && onNavigateToSecret && (
                              <button
                                onClick={() => onNavigateToSecret(name)}
                                className="shrink-0 flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 font-medium transition-colors"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Add
                              </button>
                            )}
                            {isSet && secretEntry && (
                              <EasCredVerifyButton
                                secretId={secretEntry.id}
                                projectId={projectId}
                                initialStatus={secretEntry.verificationStatus}
                                onVerified={(status) => {
                                  setConfiguredSecrets((prev) => {
                                    const next = new Map(prev);
                                    const entry = next.get(name);
                                    if (entry)
                                      next.set(name, { ...entry, verificationStatus: status });
                                    return next;
                                  });
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="p-4 space-y-3">
                  {credsMissing && (
                    <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{credsMissing}</span>
                    </div>
                  )}
                  {buildError && platform === "ios" && (
                    <p className="text-xs text-destructive">{buildError}</p>
                  )}
                  <SigningFileUpload
                    projectId={projectId}
                    platform="ios"
                    signingStatus={signingStatus}
                    onSaved={() => void fetchSigningStatus()}
                  />
                  {/* Credit gate intentionally disabled while billing is free/unlimited. */}

                  {!configuredSecrets.has("EAS_ACCESS_TOKEN") ? (
                    <div className="space-y-2">
                      <div className="flex items-start gap-2 text-xs bg-muted border border-border rounded-lg px-3 py-2.5">
                        <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">
                          <span className="font-semibold text-foreground">EAS_ACCESS_TOKEN</span> is
                          required before you can trigger a build. Get yours at{" "}
                          <a
                            href="https://expo.dev/accounts"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            expo.dev
                          </a>
                          .
                        </span>
                      </div>
                      {onNavigateToSecret && (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => onNavigateToSecret("EAS_ACCESS_TOKEN")}
                        >
                          <Key className="h-4 w-4 mr-2" />
                          Add EAS_ACCESS_TOKEN to Secrets
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => void triggerBuild("ios")}
                      disabled={
                        triggeringBuild !== null ||
                        (creditBalance !== null && creditBalance < EAS_BUILD_COST)
                      }
                    >
                      {triggeringBuild === "ios" ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Smartphone className="h-4 w-4 mr-2" />
                      )}
                      {triggeringBuild === "ios" ? "Queuing build…" : "Build for iOS (TestFlight)"}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Build history for iOS */}
            {isMobile && mobileBuilds.filter((b) => b.platform === "ios").length > 0 && (
              <div className="border border-border rounded-xl overflow-hidden bg-card">
                <div className="px-4 py-3 border-b border-border text-sm font-semibold">
                  iOS Build History
                </div>
                <div className="divide-y divide-border">
                  {mobileBuilds
                    .filter((b) => b.platform === "ios")
                    .slice(0, 10)
                    .map((b) => {
                      const isOpen = openLogBuildId === b.id;
                      return (
                        <div key={b.id}>
                          <div className="flex items-center gap-3 px-4 py-2.5 text-xs hover:bg-muted/30 transition-colors">
                            <MobileBuildStatusBadge status={b.status} />
                            {b.buildId && (
                              <span className="font-mono text-muted-foreground truncate">
                                {b.buildId.slice(0, 8)}…
                              </span>
                            )}
                            {b.testflightUrl && (
                              <a
                                href={b.testflightUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-green-500 hover:underline flex items-center gap-0.5"
                              >
                                TestFlight <ArrowUpRight className="h-2.5 w-2.5" />
                              </a>
                            )}
                            <span className="ml-auto text-muted-foreground shrink-0">
                              {new Date(b.createdAt).toLocaleDateString()}
                            </span>
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              title={isOpen ? "Hide build logs" : "View build logs"}
                              onClick={() => setOpenLogBuildId(isOpen ? null : b.id)}
                              className="shrink-0 flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors rounded px-1 py-0.5 hover:bg-muted"
                            >
                              <Terminal className="h-3 w-3" />
                              {isOpen ? (
                                <ChevronUp className="h-3 w-3" />
                              ) : (
                                <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                          {isOpen && (
                            <BuildLogViewer
                              projectId={projectId}
                              buildLogId={b.id}
                              buildStatus={b.status}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <h3 className="font-semibold text-sm whitespace-nowrap">iOS Submission Checklist</h3>
              <ProgressBar sections={IOS_CHECKLIST} checked={checked} />
            </div>
            <ChecklistGroup sections={IOS_CHECKLIST} checked={checked} onToggle={toggle} />

            <div className="border border-border rounded-xl p-4 bg-card space-y-3">
              {/* Server-side readiness checks */}
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-foreground">
                  Store Submission Requirements
                </p>
                <button
                  onClick={() => void fetchIosReadiness()}
                  disabled={iosReadinessLoading}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-3 w-3", iosReadinessLoading && "animate-spin")} />
                  Re-check
                </button>
              </div>
              {iosReadiness && (
                <div className="space-y-2">
                  {iosReadiness.checks.map((check) => (
                    <ReadinessCheckRow
                      key={check.id}
                      check={check}
                      onFix={
                        check.id === "ios_bundle_id" &&
                        check.status === "fail" &&
                        onNavigateToMobileSettings
                          ? onNavigateToMobileSettings
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {iosReadinessLoading && !iosReadiness && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Checking submission requirements…</span>
                </div>
              )}
              {/* Status banner */}
              {!iosReady ? (
                <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    {iosReadiness && !iosReadiness.canPublish
                      ? "Complete all required server-side checks and checklist items before submitting."
                      : "Complete all required checklist items before submitting to App Store Connect."}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-xs text-green-600 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>All required checks complete. Ready to submit to App Store Connect.</span>
                </div>
              )}
              {/* Submit button — gated on server-side canPublish + checklist */}
              <Button className="w-full" disabled={!iosReady} asChild={iosReady}>
                {iosReady ? (
                  <a
                    href="https://appstoreconnect.apple.com"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-2"
                  >
                    <Smartphone className="h-4 w-4" />
                    Open App Store Connect
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    Submit to App Store Connect
                  </span>
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">
                Use the EAS Build panel above to build your IPA, then upload it manually via App
                Store Connect.
              </p>
            </div>

            {/* iOS setup guide */}
            <MobileSetupGuide platform="ios" />
          </div>
        )}

        {/* ── Android ─────────────────────────────────────────────────────── */}
        {platform === "android" && (
          <div className="space-y-5">
            {/* EAS Build panel */}
            <EasBuildPanel projectId={projectId} platform="android" />

            {/* Play Console link */}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a
                  href="https://play.google.com/console"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1"
                >
                  Play Console <ArrowUpRight className="h-3 w-3" />
                </a>
              </Button>
            </div>

            {/* EAS Build panel for mobile projects */}
            {isMobile && (
              <div className="border border-border rounded-xl bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border space-y-0.5">
                  <h3 className="font-semibold text-sm">Store Build</h3>
                  <p className="text-xs text-muted-foreground">
                    Triggers an Expo Application Services cloud build. Costs 5 credits per build.
                  </p>
                </div>

                {/* Configure EAS Credentials — expandable */}
                <div className="border-b border-border">
                  <div className="flex items-center px-4 py-2.5">
                    <button
                      onClick={() => setAndroidCredsOpen((o) => !o)}
                      className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity"
                      aria-expanded={androidCredsOpen}
                    >
                      <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs font-semibold">Configure EAS Credentials</span>
                      {(() => {
                        const androidCreds = [
                          { name: "EAS_ACCESS_TOKEN", required: true },
                          { name: "EXPO_ACCOUNT_NAME", required: true },
                          { name: "EXPO_APP_SLUG", required: false },
                          { name: "GOOGLE_SERVICE_ACCOUNT_JSON", required: true },
                        ];
                        const required = androidCreds.filter((c) => c.required);
                        const missing = required.filter((c) => !configuredSecrets.has(c.name));
                        return missing.length === 0 ? (
                          <span className="text-[10px] bg-green-500/15 text-green-500 px-1.5 py-0.5 rounded font-medium">
                            All set
                          </span>
                        ) : (
                          <span className="text-[10px] bg-yellow-500/15 text-yellow-500 px-1.5 py-0.5 rounded font-medium">
                            {missing.length} missing
                          </span>
                        );
                      })()}
                    </button>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => void fetchConfiguredSecrets()}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Refresh secret status"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => setAndroidCredsOpen((o) => !o)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        aria-expanded={androidCredsOpen}
                      >
                        {androidCredsOpen ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {androidCredsOpen && (
                    <div className="divide-y divide-border/50">
                      {[
                        {
                          name: "EAS_ACCESS_TOKEN",
                          label: "EAS Access Token",
                          required: true,
                          hint: "From expo.dev → Access Tokens",
                        },
                        {
                          name: "EXPO_ACCOUNT_NAME",
                          label: "Expo Account Name",
                          required: true,
                          hint: "Your Expo username or org slug",
                        },
                        {
                          name: "EXPO_APP_SLUG",
                          label: "Expo App Slug",
                          required: false,
                          hint: "Defaults to project name if not set",
                        },
                        {
                          name: "GOOGLE_SERVICE_ACCOUNT_JSON",
                          label: "Google Play Service Account JSON",
                          required: true,
                          hint: "Service account JSON with releasemanager role from Google Play Console",
                        },
                      ].map(({ name, label, required, hint }) => {
                        const isSet = configuredSecrets.has(name);
                        const secretEntry = configuredSecrets.get(name);
                        return (
                          <div key={name} className="flex items-start gap-2.5 px-4 py-2.5 text-xs">
                            {isSet ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                            ) : (
                              <Circle
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0 mt-0.5",
                                  required ? "text-yellow-500" : "text-muted-foreground/60",
                                )}
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span
                                  className={cn(
                                    "font-medium",
                                    isSet
                                      ? "text-foreground"
                                      : required
                                        ? "text-foreground"
                                        : "text-muted-foreground",
                                  )}
                                >
                                  {label}
                                </span>
                                {required && !isSet && (
                                  <span className="text-[9px] bg-yellow-500/15 text-yellow-600 px-1 py-0.5 rounded font-semibold">
                                    required
                                  </span>
                                )}
                                {!required && (
                                  <span className="text-[9px] bg-muted text-muted-foreground px-1 py-0.5 rounded">
                                    optional
                                  </span>
                                )}
                              </div>
                              <code className="font-mono text-[9px] text-muted-foreground">
                                {name}
                              </code>
                              {hint && (
                                <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>
                              )}
                            </div>
                            {!isSet && onNavigateToSecret && (
                              <button
                                onClick={() => onNavigateToSecret(name)}
                                className="shrink-0 flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 font-medium transition-colors"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Add
                              </button>
                            )}
                            {isSet && secretEntry && (
                              <EasCredVerifyButton
                                secretId={secretEntry.id}
                                projectId={projectId}
                                initialStatus={secretEntry.verificationStatus}
                                onVerified={(status) => {
                                  setConfiguredSecrets((prev) => {
                                    const next = new Map(prev);
                                    const entry = next.get(name);
                                    if (entry)
                                      next.set(name, { ...entry, verificationStatus: status });
                                    return next;
                                  });
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="p-4 space-y-3">
                  {credsMissing && (
                    <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{credsMissing}</span>
                    </div>
                  )}
                  {buildError && platform === "android" && (
                    <p className="text-xs text-destructive">{buildError}</p>
                  )}
                  <SigningFileUpload
                    projectId={projectId}
                    platform="android"
                    signingStatus={signingStatus}
                    onSaved={() => void fetchSigningStatus()}
                  />
                  {/* Credit gate intentionally disabled while billing is free/unlimited. */}

                  {!configuredSecrets.has("EAS_ACCESS_TOKEN") ? (
                    <div className="space-y-2">
                      <div className="flex items-start gap-2 text-xs bg-muted border border-border rounded-lg px-3 py-2.5">
                        <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">
                          <span className="font-semibold text-foreground">EAS_ACCESS_TOKEN</span> is
                          required before you can trigger a build. Get yours at{" "}
                          <a
                            href="https://expo.dev/accounts"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            expo.dev
                          </a>
                          .
                        </span>
                      </div>
                      {onNavigateToSecret && (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => onNavigateToSecret("EAS_ACCESS_TOKEN")}
                        >
                          <Key className="h-4 w-4 mr-2" />
                          Add EAS_ACCESS_TOKEN to Secrets
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      className="w-full bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => void triggerBuild("android")}
                      disabled={
                        triggeringBuild !== null ||
                        (creditBalance !== null && creditBalance < EAS_BUILD_COST)
                      }
                    >
                      {triggeringBuild === "android" ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <PlaySquare className="h-4 w-4 mr-2" />
                      )}
                      {triggeringBuild === "android"
                        ? "Queuing build…"
                        : "Build for Android (Play Store)"}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Build history for Android */}
            {isMobile && mobileBuilds.filter((b) => b.platform === "android").length > 0 && (
              <div className="border border-border rounded-xl overflow-hidden bg-card">
                <div className="px-4 py-3 border-b border-border text-sm font-semibold">
                  Android Build History
                </div>
                <div className="divide-y divide-border">
                  {mobileBuilds
                    .filter((b) => b.platform === "android")
                    .slice(0, 10)
                    .map((b) => {
                      const isOpen = openLogBuildId === b.id;
                      return (
                        <div key={b.id}>
                          <div className="flex items-center gap-3 px-4 py-2.5 text-xs hover:bg-muted/30 transition-colors">
                            <MobileBuildStatusBadge status={b.status} />
                            {b.buildId && (
                              <span className="font-mono text-muted-foreground truncate">
                                {b.buildId.slice(0, 8)}…
                              </span>
                            )}
                            {b.testflightUrl && (
                              <a
                                href={b.testflightUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-green-500 hover:underline flex items-center gap-0.5"
                              >
                                Play Console <ArrowUpRight className="h-2.5 w-2.5" />
                              </a>
                            )}
                            <span className="ml-auto text-muted-foreground shrink-0">
                              {new Date(b.createdAt).toLocaleDateString()}
                            </span>
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              title={isOpen ? "Hide build logs" : "View build logs"}
                              onClick={() => setOpenLogBuildId(isOpen ? null : b.id)}
                              className="shrink-0 flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors rounded px-1 py-0.5 hover:bg-muted"
                            >
                              <Terminal className="h-3 w-3" />
                              {isOpen ? (
                                <ChevronUp className="h-3 w-3" />
                              ) : (
                                <ChevronDown className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                          {isOpen && (
                            <BuildLogViewer
                              projectId={projectId}
                              buildLogId={b.id}
                              buildStatus={b.status}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <h3 className="font-semibold text-sm whitespace-nowrap">
                Android Submission Checklist
              </h3>
              <ProgressBar sections={ANDROID_CHECKLIST} checked={checked} />
            </div>
            <ChecklistGroup sections={ANDROID_CHECKLIST} checked={checked} onToggle={toggle} />

            <div className="border border-border rounded-xl p-4 bg-card space-y-3">
              {/* Server-side readiness checks */}
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-foreground">
                  Store Submission Requirements
                </p>
                <button
                  onClick={() => void fetchAndReadiness()}
                  disabled={andReadinessLoading}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-3 w-3", andReadinessLoading && "animate-spin")} />
                  Re-check
                </button>
              </div>
              {andReadiness && (
                <div className="space-y-2">
                  {andReadiness.checks.map((check) => (
                    <ReadinessCheckRow
                      key={check.id}
                      check={check}
                      onFix={
                        check.id === "android_package_name" &&
                        check.status === "fail" &&
                        onNavigateToMobileSettings
                          ? onNavigateToMobileSettings
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {andReadinessLoading && !andReadiness && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Checking submission requirements…</span>
                </div>
              )}
              {/* Status banner */}
              {!andReady ? (
                <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    {andReadiness && !andReadiness.canPublish
                      ? "Complete all required server-side checks and checklist items before uploading."
                      : "Complete all required checklist items before uploading to Google Play."}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-xs text-green-600 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>All required checks complete. Ready to upload to Google Play Console.</span>
                </div>
              )}
              {/* Submit button — gated on server-side canPublish + checklist */}
              <Button className="w-full" disabled={!andReady} asChild={andReady}>
                {andReady ? (
                  <a
                    href="https://play.google.com/console"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-2"
                  >
                    <PlaySquare className="h-4 w-4" />
                    Open Google Play Console
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <PlaySquare className="h-4 w-4" />
                    Upload to Google Play Console
                  </span>
                )}
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">
                Use the EAS Build panel above to build your AAB, then upload it manually via the
                Google Play Console.
              </p>
            </div>

            {/* Android setup guide */}
            <MobileSetupGuide platform="android" />
          </div>
        )}
      </div>
    </div>
  );
}
