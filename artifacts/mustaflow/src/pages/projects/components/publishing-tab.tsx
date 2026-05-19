import { useState, useCallback, useEffect } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
      { id: "w-content", label: "All placeholder content replaced with real content", required: true },
      { id: "w-links", label: "All navigation links work", required: true },
      { id: "w-forms", label: "Contact / signup forms submit correctly", required: false },
    ],
  },
];

const WEB_PRODUCTION_CHECKLIST: ChecklistSection[] = [
  {
    title: "Pre-publish Gates",
    items: [
      { id: "wp-secrets", label: "Production secrets configured (not test keys)", icon: Lock, required: true },
      { id: "wp-rollback", label: "Rollback point saved (latest version snapshot)", icon: RefreshCw, required: true },
      { id: "wp-env", label: "Environment validated — no dev / test keys in production", icon: ShieldCheck, required: true },
      { id: "wp-report", label: "Test report reviewed and approved", icon: FileText, required: true },
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
      { id: "ios-account", label: "Apple Developer account active ($99 / yr)", icon: UserCheck, required: true },
      { id: "ios-bundleid", label: "Bundle ID registered (com.yourco.appname)", required: true },
      { id: "ios-certs", label: "Distribution certificate and provisioning profile created", required: true },
    ],
  },
  {
    title: "App Assets",
    items: [
      { id: "ios-icon", label: "App icon set (1024×1024 PNG, no alpha, no rounded corners)", icon: Image, required: true },
      { id: "ios-splash", label: "Launch screen / splash configured", required: true },
      { id: "ios-screenshots", label: "App Store screenshots (6.7\", 6.1\", iPad 12.9\")", icon: Camera, required: true },
    ],
  },
  {
    title: "TestFlight",
    items: [
      { id: "ios-expo", label: "Expo build configured (eas build --platform ios)", required: true },
      { id: "ios-tf-upload", label: "IPA uploaded to App Store Connect", required: true },
      { id: "ios-tf-testers", label: "TestFlight testers invited and build distributed", required: true },
      { id: "ios-tf-feedback", label: "TestFlight feedback collected and addressed", required: true },
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
      { id: "and-account", label: "Google Play Developer account active ($25 one-time)", icon: UserCheck, required: true },
      { id: "and-pkg", label: "Package name registered (com.yourco.appname)", required: true },
      { id: "and-keystore", label: "Upload keystore generated and stored securely", required: true },
    ],
  },
  {
    title: "App Assets",
    items: [
      { id: "and-icon", label: "App icon (512×512 PNG) and adaptive icon configured", icon: Image, required: true },
      { id: "and-feature", label: "Feature graphic (1024×500 PNG)", required: true },
      { id: "and-screenshots", label: "Play Store screenshots (phone + 7\" tablet)", icon: Camera, required: true },
    ],
  },
  {
    title: "Build & Upload",
    items: [
      { id: "and-expo", label: "Expo build configured (eas build --platform android)", required: true },
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

// ─── Main component ───────────────────────────────────────────────────────────

// ── Readiness gate types & components ────────────────────────────────────────

type ReadinessCheck = {
  id: string;
  label: string;
  description: string;
  status: "pass" | "fail" | "warning" | "info";
  severity: "blocking" | "warning" | "info";
  message?: string;
};

type ReadinessResult = {
  env: string;
  canPublish: boolean;
  checks: ReadinessCheck[];
};

function ReadinessCheckRow({ check }: { check: ReadinessCheck }) {
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
      </div>
    </div>
  );
}

function ReadinessGate({
  readiness,
  loading,
  onRefresh,
}: {
  readiness: ReadinessResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
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
      {!readiness.canPublish && blockingFailed.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {blockingFailed.length} required gate{blockingFailed.length !== 1 ? "s" : ""} must
            pass before publishing.
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

function MobileBuildStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string; spin?: boolean }> = {
    queued: { label: "Queued", className: "bg-muted text-muted-foreground border-border" },
    building: { label: "Building", className: "bg-primary/10 text-primary border-primary/20", spin: true },
    submitting: { label: "Submitting", className: "bg-violet-500/10 text-violet-400 border-violet-500/20", spin: true },
    submitted: { label: "Submitted", className: "bg-green-500/10 text-green-400 border-green-500/20" },
    passed: { label: "Passed", className: "bg-green-500/10 text-green-400 border-green-500/20" },
    failed: { label: "Failed", className: "bg-destructive/10 text-destructive border-destructive/20" },
  };
  const c = cfg[status] ?? { label: status, className: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0", c.className)}>
      {c.spin && <span className="w-1.5 h-1.5 rounded-full border border-current border-t-transparent animate-spin" />}
      {c.label}
    </span>
  );
}

export function PublishingTab({ projectId, kind }: { projectId: number; kind?: string }) {
  const isMobile = kind?.startsWith("mobile-") ?? false;
  const [platform, setPlatform] = useState<Platform>("web");
  const [webEnv, setWebEnv] = useState<"testing" | "production">("testing");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [logsOpen, setLogsOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    ok: boolean;
    publicUrl: string;
    internalPathUrl: string;
    publicSlug: string;
    publishedAt: string;
    snapshotVersionId?: number;
    filesPublished?: number;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Readiness gate state
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);

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

  // EAS credentials checklist — tracks which secret names are configured
  const [configuredSecrets, setConfiguredSecrets] = useState<Set<string>>(new Set());
  const fetchConfiguredSecrets = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets`);
      if (res.ok) {
        const data = (await res.json()) as { secrets?: Array<{ name: string }> };
        setConfiguredSecrets(new Set((data.secrets ?? []).map((s) => s.name)));
      }
    } catch { /* ignore */ }
  }, [projectId, isMobile]);

  // Site settings state
  const [siteTitle, setSiteTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [themeColor, setThemeColor] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

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
  const [customDomainInput, setCustomDomainInput] = useState("");
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainVerifying, setDomainVerifying] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  const fetchMobileBuilds = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/builds`);
      if (res.ok) {
        const data = (await res.json()) as { builds: MobileBuildLog[] };
        setMobileBuilds(data.builds ?? []);
      }
    } catch { /* ignore */ }
  }, [projectId, isMobile]);

  const triggerBuild = async (p: "ios" | "android") => {
    setTriggeringBuild(p);
    setBuildError(null);
    setCredsMissing(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/builds`, {
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
      // Refresh builds list immediately
      await fetchMobileBuilds();
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Build trigger failed");
    } finally {
      setTriggeringBuild(null);
    }
  };

  async function handlePublish() {
    setIsPublishing(true);
    setPublishError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/publish`, {
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
      };
      setPublishResult(data);
      setShowConfirm(false);
      // Refresh domain info (subdomain url is now available) and deployment logs
      void fetchDomain();
      void fetchDeployments();
    } catch (err) {
      setPublishError(
        err instanceof Error ? err.message : "Publish failed — please try again.",
      );
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
      const res = await fetch(`/api/projects/${projectId}/publish-readiness?env=${webEnv}`);
      if (res.ok) setReadiness((await res.json()) as ReadinessResult);
    } catch { /* ignore */ }
    finally { setReadinessLoading(false); }
  }, [projectId, webEnv, platform]);

  const fetchDeployments = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/deployments`);
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
    } catch { /* ignore */ }
  }, [projectId]);

  const fetchSiteSettings = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (res.ok) {
        const data = (await res.json()) as {
          siteTitle?: string | null;
          metaDescription?: string | null;
          themeColor?: string | null;
        };
        setSiteTitle(data.siteTitle ?? "");
        setMetaDescription(data.metaDescription ?? "");
        setThemeColor(data.themeColor ?? "");
      }
    } catch { /* ignore */ }
  }, [projectId]);

  const fetchDomain = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/domain`);
      if (res.ok) {
        const data = (await res.json()) as DomainInfo;
        setDomainInfo(data);
        setCustomDomainInput(data.customDomain ?? "");
      }
    } catch { /* ignore */ }
  }, [projectId]);

  const saveDomain = async () => {
    setDomainSaving(true);
    setDomainError(null);
    try {
      const cleaned = customDomainInput.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const res = await fetch(`/api/projects/${projectId}/domain`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customDomain: cleaned || null }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setDomainError(err.error ?? "Failed to save domain.");
      } else {
        await fetchDomain();
      }
    } catch {
      setDomainError("Failed to save domain. Please try again.");
    } finally {
      setDomainSaving(false);
    }
  };

  const verifyDomain = async () => {
    setDomainVerifying(true);
    setDomainError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/domain/verify`, { method: "POST" });
      const data = (await res.json()) as { message?: string; verified?: boolean };
      if (!res.ok || data.verified === false) {
        setDomainError(data.message ?? "DNS verification failed.");
      }
      await fetchDomain();
    } catch {
      setDomainError("Verification check failed. Please try again.");
    } finally {
      setDomainVerifying(false);
    }
  };

  const removeDomain = async () => {
    await fetch(`/api/projects/${projectId}/domain`, { method: "DELETE" });
    setCustomDomainInput("");
    setDomainError(null);
    await fetchDomain();
  };

  const saveSiteSettings = async () => {
    setSavingSettings(true);
    try {
      await fetch(`/api/projects/${projectId}`, {
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

  // Fetch secrets list for credentials checklist
  useEffect(() => {
    void fetchConfiguredSecrets();
  }, [fetchConfiguredSecrets]);

  // Poll mobile builds every 5 s while any build is in progress
  useEffect(() => {
    void fetchMobileBuilds();
  }, [fetchMobileBuilds]);

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
  }, [fetchReadiness, fetchDeployments, fetchSiteSettings, fetchDomain]);

  const webChecklist = webEnv === "testing" ? WEB_TESTING_CHECKLIST : WEB_PRODUCTION_CHECKLIST;
  const webRequired = webChecklist.flatMap((s) => s.items).filter((i) => i.required);
  const webReadyToPublish = webRequired.every((i) => checked.has(i.id));

  const iosRequired = IOS_CHECKLIST.flatMap((s) => s.items).filter((i) => i.required);
  const iosReady = iosRequired.every((i) => checked.has(i.id));

  const andRequired = ANDROID_CHECKLIST.flatMap((s) => s.items).filter((i) => i.required);
  const andReady = andRequired.every((i) => checked.has(i.id));

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

        {/* Platform tabs */}
        <div className="flex gap-2">
          {(["web", "ios", "android"] as Platform[]).map((p) => {
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
                onClick={() => setPlatform(p)}
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
                    setShowConfirm(false);
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
                <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <RefreshCw className="h-3 w-3" />
                  Refresh
                </button>
              </div>
              <div className="space-y-2">
                {[
                  { label: "Health check", badge: "pending", note: "No active deployment" },
                  { label: "Custom domain", badge: "unconfigured", note: "Configure below" },
                  { label: "SSL / HTTPS", badge: "partial", note: "Requires manual cert setup — not automated" },
                  { label: "Rollback point", badge: "ready", note: "Latest snapshot available" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground text-xs">{row.label}</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-[10px] px-2 py-0.5 rounded-full font-medium",
                          row.badge === "ready"
                            ? "bg-green-500/15 text-green-600"
                            : row.badge === "unconfigured"
                            ? "bg-muted text-muted-foreground"
                            : "bg-yellow-500/15 text-yellow-600",
                        )}
                      >
                        {row.badge}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{row.note}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Domain Management */}
            <div className="border border-border rounded-xl p-5 bg-card space-y-5">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                Domains
              </h3>

              {/* Auto-subdomain */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your Subdomain</p>
                <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2.5">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  {domainInfo?.subdomain ? (
                    <>
                      <span className="text-sm font-mono flex-1 truncate">{domainInfo.subdomain}</span>
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
                    <span className="text-sm text-muted-foreground italic">Generated on first publish</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Automatically assigned. Available as soon as you publish.
                </p>
              </div>

              <div className="border-t border-border" />

              {/* Custom domain */}
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Custom Domain</p>

                <div className="flex gap-2">
                  <input
                    value={customDomainInput}
                    onChange={(e) => setCustomDomainInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveDomain(); }}
                    placeholder="app.yourdomain.com"
                    className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void saveDomain()}
                    disabled={domainSaving}
                    className="shrink-0"
                  >
                    {domainSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    <span className="ml-1.5">Save</span>
                  </Button>
                  {domainInfo?.customDomain && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeDomain()}
                      className="shrink-0 text-destructive hover:text-destructive"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {domainError && (
                  <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{domainError}</span>
                  </div>
                )}

                {/* Status badges */}
                {domainInfo?.customDomain && (
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Domain status */}
                    <span className={cn(
                      "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium",
                      domainInfo.domainStatus === "active" && "bg-green-500/15 text-green-400",
                      domainInfo.domainStatus === "pending_verification" && "bg-yellow-500/15 text-yellow-400",
                      domainInfo.domainStatus === "error" && "bg-red-500/15 text-red-400",
                      domainInfo.domainStatus === "unconfigured" && "bg-muted text-muted-foreground",
                    )}>
                      {domainInfo.domainStatus === "active" && <CheckCircle2 className="h-3 w-3" />}
                      {domainInfo.domainStatus === "pending_verification" && <RefreshCw className="h-3 w-3" />}
                      {domainInfo.domainStatus === "error" && <XCircle className="h-3 w-3" />}
                      {domainInfo.domainStatus === "unconfigured" && <Circle className="h-3 w-3" />}
                      DNS {domainInfo.domainStatus === "active" ? "verified" : domainInfo.domainStatus === "error" ? "error" : "pending"}
                    </span>

                    {/* SSL status badge */}
                    <span className={cn(
                      "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium",
                      domainInfo.sslStatus === "active" && "bg-green-500/15 text-green-400",
                      (domainInfo.sslStatus === "provisioning" || domainInfo.sslStatus === "pending") && "bg-yellow-500/15 text-yellow-400",
                      domainInfo.sslStatus === "failed" && "bg-red-500/15 text-red-400",
                    )}>
                      <Lock className="h-3 w-3" />
                      {domainInfo.sslStatus === "active"
                        ? "SSL active"
                        : domainInfo.sslStatus === "failed"
                        ? "SSL failed"
                        : domainInfo.domainStatus === "active"
                        ? "SSL manual setup required"
                        : "SSL pending"}
                    </span>

                    {/* Verify / Re-check button */}
                    {domainInfo.domainStatus !== "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void verifyDomain()}
                        disabled={domainVerifying}
                        className="h-7 text-xs"
                      >
                        {domainVerifying
                          ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Checking…</>
                          : <><RefreshCw className="h-3 w-3 mr-1" />Check DNS</>}
                      </Button>
                    )}
                  </div>
                )}

                {/* SSL gate warning — DNS verified but SSL is not yet active */}
                {domainInfo?.customDomain && domainInfo.domainStatus === "active" && domainInfo.sslStatus !== "active" && (
                  <div className="flex items-start gap-2 text-xs bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" />
                    <span className="text-yellow-300/90">
                      DNS is verified, but SSL certificate automation is not connected yet. This domain may not be safely available over HTTPS until SSL is configured manually.
                    </span>
                  </div>
                )}

                {/* DNS instructions — shown when a custom domain is saved but not yet verified */}
                {domainInfo?.customDomain && domainInfo.domainStatus !== "active" && (
                  <div className="bg-muted/60 border border-border rounded-lg p-3 space-y-3">
                    <p className="text-xs font-medium flex items-center gap-1.5">
                      <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      DNS configuration required
                    </p>

                    {/* CNAME option */}
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground font-medium">Option A — CNAME record</p>
                      <p className="text-xs text-muted-foreground">
                        Add this CNAME record in your DNS provider (Cloudflare, Route53, Namecheap, etc.):
                      </p>
                      <div className="rounded-md bg-background border border-border overflow-hidden text-xs font-mono">
                        <div className="grid grid-cols-3 gap-px bg-border">
                          <div className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">Type</div>
                          <div className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">Name</div>
                          <div className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">Value</div>
                        </div>
                        <div className="grid grid-cols-3 gap-px bg-border">
                          <div className="bg-card px-2 py-1.5">CNAME</div>
                          <div className="bg-card px-2 py-1.5 truncate">{domainInfo.customDomain}</div>
                          <div className="bg-card px-2 py-1.5 flex items-center gap-1 min-w-0">
                            <span className="truncate">{domainInfo.cnameTarget}</span>
                            <CopyUrlButton url={domainInfo.cnameTarget} />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* TXT option */}
                    {domainInfo.verificationToken && domainInfo.txtName && (
                      <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground font-medium">Option B — TXT ownership record (preferred for security)</p>
                        <p className="text-xs text-muted-foreground">
                          Add a TXT record to prove domain ownership without changing your routing:
                        </p>
                        <div className="rounded-md bg-background border border-border overflow-hidden text-xs font-mono">
                          <div className="grid grid-cols-3 gap-px bg-border">
                            <div className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">Type</div>
                            <div className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">Name</div>
                            <div className="bg-muted px-2 py-1.5 text-muted-foreground font-sans font-medium">Value</div>
                          </div>
                          <div className="grid grid-cols-3 gap-px bg-border">
                            <div className="bg-card px-2 py-1.5">TXT</div>
                            <div className="bg-card px-2 py-1.5 flex items-center gap-1 min-w-0">
                              <span className="truncate">{domainInfo.txtName}</span>
                              <CopyUrlButton url={domainInfo.txtName} />
                            </div>
                            <div className="bg-card px-2 py-1.5 flex items-center gap-1 min-w-0">
                              <span className="truncate">{domainInfo.txtValue}</span>
                              <CopyUrlButton url={domainInfo.txtValue ?? ""} />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                      DNS changes can take up to 48 hours to propagate. Click "Check DNS" once you've added either record.
                    </p>
                  </div>
                )}

                {/* Active domain link — shown in green only when both DNS and SSL are confirmed */}
                {domainInfo?.customDomain && domainInfo.domainStatus === "active" && domainInfo.sslStatus === "active" && (
                  <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5">
                    <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                    <a
                      href={`https://${domainInfo.customDomain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono text-green-400 hover:underline flex-1 truncate"
                    >
                      https://{domainInfo.customDomain}
                    </a>
                    <CopyUrlButton url={`https://${domainInfo.customDomain}`} />
                  </div>
                )}

                {/* Active domain link (DNS ok, SSL not yet confirmed) */}
                {domainInfo?.customDomain && domainInfo.domainStatus === "active" && domainInfo.sslStatus !== "active" && (
                  <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-3 py-2.5">
                    <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-mono text-muted-foreground flex-1 truncate">
                      https://{domainInfo.customDomain}
                    </span>
                    <CopyUrlButton url={`https://${domainInfo.customDomain}`} />
                  </div>
                )}
              </div>
            </div>

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

            {/* Deployment logs */}
            <div className="border border-border rounded-xl overflow-hidden bg-card">
              <button
                onClick={() => setLogsOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold hover:bg-muted/30 transition-colors"
              >
                <span>Deployment Logs</span>
                {logsOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {logsOpen && (
                deployments.length === 0 ? (
                  <div className="bg-zinc-950 font-mono text-xs text-zinc-500 p-4 border-t border-border min-h-[80px] flex items-center justify-center">
                    No deployments yet. Logs will appear here after your first publish.
                  </div>
                ) : (
                  <div className="divide-y divide-border border-t border-border">
                    {deployments.map((d) => (
                      <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
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
                          {d.status}
                        </span>
                        <span className="text-muted-foreground font-mono shrink-0 uppercase tracking-wide">
                          {d.env}
                        </span>
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
                        <span className="ml-auto text-muted-foreground shrink-0">
                          {new Date(d.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>

            {/* Readiness gate */}
            {platform === "web" && (
              <ReadinessGate
                readiness={readiness}
                loading={readinessLoading}
                onRefresh={() => void fetchReadiness()}
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

            {/* Publish action */}
            {webEnv === "production" && (
              <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                {!webReadyToPublish && (
                  <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>Complete all required checklist items before publishing to production.</span>
                  </div>
                )}
                {!showConfirm ? (
                  <Button
                    className="w-full"
                    disabled={!webReadyToPublish || readiness?.canPublish === false}
                    onClick={() => setShowConfirm(true)}
                  >
                    <Globe className="h-4 w-4 mr-2" />
                    Publish to Production
                  </Button>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm space-y-1">
                      <p className="font-semibold text-destructive text-xs">Confirm production publish</p>
                      <p className="text-muted-foreground text-xs">
                        This will make your app publicly accessible. A rollback point has been saved automatically.
                      </p>
                    </div>
                    {publishError && (
                      <p className="text-xs text-destructive">{publishError}</p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        className="flex-1"
                        onClick={handlePublish}
                        disabled={isPublishing}
                      >
                        {isPublishing && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        )}
                        {isPublishing ? "Publishing…" : "Confirm Publish"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setShowConfirm(false)}
                        disabled={isPublishing}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {publishResult && (
              <div className="border border-green-500/20 rounded-xl p-4 bg-green-500/5 space-y-3">
                <div className="flex items-center gap-2 text-green-500 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4" />
                  App is live
                </div>
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
                <p className="text-[11px] text-muted-foreground">
                  Slug: <span className="font-mono">{publishResult.publicSlug}</span>
                  {publishResult.filesPublished != null && <span>{" · "}{publishResult.filesPublished} file{publishResult.filesPublished !== 1 ? "s" : ""}</span>}
                  {" · "}Published {new Date(publishResult.publishedAt).toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Internal path: <span className="font-mono">{publishResult.internalPathUrl}</span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await fetch(`/api/projects/${projectId}/unpublish`, { method: "POST" });
                    setPublishResult(null);
                    void fetchDomain();
                    void fetchDeployments();
                  }}
                >
                  Unpublish
                </Button>
              </div>
            )}

            {webEnv === "testing" && (
              <div className="space-y-2">
                {publishError && (
                  <p className="text-xs text-destructive">{publishError}</p>
                )}
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={!webReadyToPublish || isPublishing}
                  onClick={() => void handlePublish()}
                >
                  {isPublishing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Server className="h-4 w-4 mr-2" />
                  )}
                  {isPublishing ? "Publishing…" : "Publish to Testing"}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* ── iOS ─────────────────────────────────────────────────────────── */}
        {platform === "ios" && (
          <div className="space-y-5">
            {/* Header card */}
            <div className="border border-border rounded-xl p-4 bg-card space-y-4">
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 p-2 rounded-lg">
                  <Smartphone className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">iOS App Publishing</h3>
                  <p className="text-sm text-muted-foreground">
                    Build with EAS → TestFlight beta → App Store production.
                  </p>
                </div>
              </div>

              {/* Step pipeline */}
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                {["EAS Build", "TestFlight", "App Store"].map((step, i) => {
                  const iosBuilds = mobileBuilds.filter((b) => b.platform === "ios");
                  const latest = iosBuilds[0];
                  const isActive = i === 0 || (i === 1 && latest?.status === "submitting") || (i === 1 && latest?.status === "submitted");
                  return (
                    <div key={step} className="flex flex-col items-center gap-1.5">
                      <div className={cn("w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold", isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                        {i + 1}
                      </div>
                      <span className="text-muted-foreground">{step}</span>
                    </div>
                  );
                })}
              </div>

              {/* Latest iOS build status */}
              {(() => {
                const iosBuild = mobileBuilds.find((b) => b.platform === "ios");
                if (!iosBuild) return null;
                return (
                  <div className={cn("border rounded-lg p-3 text-xs space-y-2", iosBuild.status === "failed" ? "border-destructive/30 bg-destructive/5" : iosBuild.status === "submitted" ? "border-green-500/30 bg-green-500/5" : "border-border bg-muted/30")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">Latest iOS Build</span>
                      <MobileBuildStatusBadge status={iosBuild.status} />
                    </div>
                    {iosBuild.note && <p className="text-muted-foreground">{iosBuild.note}</p>}
                    {iosBuild.buildId && <p className="font-mono text-[10px] text-muted-foreground">EAS ID: {iosBuild.buildId}</p>}
                    {iosBuild.downloadUrl && (
                      <a href={iosBuild.downloadUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                        Download IPA <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                    {iosBuild.testflightUrl && (
                      <a href={iosBuild.testflightUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-green-500 hover:underline font-medium">
                        Open App Store Connect <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                );
              })()}

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="https://developer.apple.com/account" target="_blank" rel="noreferrer" className="flex items-center gap-1">
                    Apple Developer <ArrowUpRight className="h-3 w-3" />
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="https://appstoreconnect.apple.com" target="_blank" rel="noreferrer" className="flex items-center gap-1">
                    App Store Connect <ArrowUpRight className="h-3 w-3" />
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="https://expo.dev/accounts" target="_blank" rel="noreferrer" className="flex items-center gap-1">
                    EAS Dashboard <ArrowUpRight className="h-3 w-3" />
                  </a>
                </Button>
              </div>
            </div>

            {/* EAS Build panel for mobile projects */}
            {isMobile && (
              <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                <h3 className="font-semibold text-sm">EAS Cloud Build</h3>
                <p className="text-xs text-muted-foreground">
                  Triggers an Expo Application Services cloud build. Costs 5 credits per build.
                </p>

                {/* Credentials checklist */}
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="bg-muted/40 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border">
                    Required Credentials
                  </div>
                  {[
                    { name: "EAS_ACCESS_TOKEN", label: "EAS Access Token", required: true },
                    { name: "EXPO_ACCOUNT_NAME", label: "Expo Account Name", required: true },
                    { name: "EXPO_APP_SLUG", label: "Expo App Slug", required: false },
                    { name: "APPLE_TEAM_ID", label: "Apple Developer Team ID", required: true },
                    { name: "APPLE_ASC_KEY_ID", label: "ASC API Key ID", required: true },
                    { name: "APPLE_ASC_ISSUER_ID", label: "ASC Issuer ID", required: true },
                    { name: "APPLE_ASC_PRIVATE_KEY", label: "ASC Private Key (.p8)", required: true },
                  ].map(({ name, label, required }) => {
                    const isSet = configuredSecrets.has(name);
                    return (
                      <div key={name} className="flex items-center gap-2 px-3 py-2 border-b border-border/50 last:border-0 text-xs">
                        {isSet ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        ) : (
                          <Circle className={cn("h-3.5 w-3.5 shrink-0", required ? "text-yellow-500" : "text-muted-foreground")} />
                        )}
                        <span className={cn("flex-1", isSet ? "text-foreground" : required ? "text-yellow-600" : "text-muted-foreground")}>
                          {label}
                        </span>
                        <code className="font-mono text-[9px] text-muted-foreground bg-muted px-1 rounded">{name}</code>
                      </div>
                    );
                  })}
                </div>

                {credsMissing && (
                  <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{credsMissing}</span>
                  </div>
                )}
                {buildError && platform === "ios" && (
                  <p className="text-xs text-destructive">{buildError}</p>
                )}
                <Button
                  className="w-full"
                  onClick={() => void triggerBuild("ios")}
                  disabled={triggeringBuild !== null}
                >
                  {triggeringBuild === "ios" ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Smartphone className="h-4 w-4 mr-2" />
                  )}
                  {triggeringBuild === "ios" ? "Queuing build…" : "Build for iOS (TestFlight)"}
                </Button>
              </div>
            )}

            {/* Build history for iOS */}
            {isMobile && mobileBuilds.filter((b) => b.platform === "ios").length > 0 && (
              <div className="border border-border rounded-xl overflow-hidden bg-card">
                <div className="px-4 py-3 border-b border-border text-sm font-semibold">iOS Build History</div>
                <div className="divide-y divide-border">
                  {mobileBuilds.filter((b) => b.platform === "ios").slice(0, 10).map((b) => (
                    <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                      <MobileBuildStatusBadge status={b.status} />
                      {b.buildId && <span className="font-mono text-muted-foreground truncate">{b.buildId.slice(0, 8)}…</span>}
                      {b.testflightUrl && (
                        <a href={b.testflightUrl} target="_blank" rel="noreferrer" className="text-green-500 hover:underline flex items-center gap-0.5">
                          TestFlight <ArrowUpRight className="h-2.5 w-2.5" />
                        </a>
                      )}
                      <span className="ml-auto text-muted-foreground shrink-0">{new Date(b.createdAt).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <h3 className="font-semibold text-sm whitespace-nowrap">iOS Submission Checklist</h3>
              <ProgressBar sections={IOS_CHECKLIST} checked={checked} />
            </div>
            <ChecklistGroup sections={IOS_CHECKLIST} checked={checked} onToggle={toggle} />

            {!isMobile && (
              <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                {!iosReady ? (
                  <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>Complete all required items before submitting to App Store Connect.</span>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 text-xs text-green-600 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>All required items complete. Ready to submit to App Store Connect.</span>
                  </div>
                )}
                <Button className="w-full" disabled>
                  <Smartphone className="h-4 w-4 mr-2" />
                  Submit to TestFlight
                  <span className="ml-2 text-[11px] opacity-60">(Expo build required)</span>
                </Button>
              </div>
            )}
          </div>
        )}

        {/* ── Android ─────────────────────────────────────────────────────── */}
        {platform === "android" && (
          <div className="space-y-5">
            {/* Header card */}
            <div className="border border-border rounded-xl p-4 bg-card space-y-4">
              <div className="flex items-center gap-3">
                <div className="bg-green-500/10 p-2 rounded-lg">
                  <PlaySquare className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <h3 className="font-semibold">Android App Publishing</h3>
                  <p className="text-sm text-muted-foreground">
                    Build with EAS → Internal testing → Google Play production.
                  </p>
                </div>
              </div>

              {/* Step pipeline */}
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                {["EAS Build", "Play Console", "Production"].map((step, i) => {
                  const androidBuilds = mobileBuilds.filter((b) => b.platform === "android");
                  const latest = androidBuilds[0];
                  const isActive = i === 0 || (i === 1 && (latest?.status === "submitting" || latest?.status === "submitted"));
                  return (
                    <div key={step} className="flex flex-col items-center gap-1.5">
                      <div className={cn("w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold", isActive ? "bg-green-500 text-white" : "bg-muted text-muted-foreground")}>
                        {i + 1}
                      </div>
                      <span className="text-muted-foreground">{step}</span>
                    </div>
                  );
                })}
              </div>

              {/* Latest Android build status */}
              {(() => {
                const androidBuild = mobileBuilds.find((b) => b.platform === "android");
                if (!androidBuild) return null;
                return (
                  <div className={cn("border rounded-lg p-3 text-xs space-y-2", androidBuild.status === "failed" ? "border-destructive/30 bg-destructive/5" : androidBuild.status === "submitted" ? "border-green-500/30 bg-green-500/5" : "border-border bg-muted/30")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">Latest Android Build</span>
                      <MobileBuildStatusBadge status={androidBuild.status} />
                    </div>
                    {androidBuild.note && <p className="text-muted-foreground">{androidBuild.note}</p>}
                    {androidBuild.buildId && <p className="font-mono text-[10px] text-muted-foreground">EAS ID: {androidBuild.buildId}</p>}
                    {androidBuild.downloadUrl && (
                      <a href={androidBuild.downloadUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                        Download AAB <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                    {androidBuild.testflightUrl && (
                      <a href={androidBuild.testflightUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-green-500 hover:underline font-medium">
                        Open Play Console <ArrowUpRight className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                );
              })()}

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="https://play.google.com/console" target="_blank" rel="noreferrer" className="flex items-center gap-1">
                    Play Console <ArrowUpRight className="h-3 w-3" />
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="https://expo.dev/accounts" target="_blank" rel="noreferrer" className="flex items-center gap-1">
                    EAS Dashboard <ArrowUpRight className="h-3 w-3" />
                  </a>
                </Button>
              </div>
            </div>

            {/* EAS Build panel for mobile projects */}
            {isMobile && (
              <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                <h3 className="font-semibold text-sm">EAS Cloud Build</h3>
                <p className="text-xs text-muted-foreground">
                  Triggers an Expo Application Services cloud build. Costs 5 credits per build.
                </p>

                {/* Credentials checklist */}
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="bg-muted/40 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border">
                    Required Credentials
                  </div>
                  {[
                    { name: "EAS_ACCESS_TOKEN", label: "EAS Access Token", required: true },
                    { name: "EXPO_ACCOUNT_NAME", label: "Expo Account Name", required: true },
                    { name: "EXPO_APP_SLUG", label: "Expo App Slug", required: false },
                    { name: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Google Play Service Account JSON", required: true },
                  ].map(({ name, label, required }) => {
                    const isSet = configuredSecrets.has(name);
                    return (
                      <div key={name} className="flex items-center gap-2 px-3 py-2 border-b border-border/50 last:border-0 text-xs">
                        {isSet ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        ) : (
                          <Circle className={cn("h-3.5 w-3.5 shrink-0", required ? "text-yellow-500" : "text-muted-foreground")} />
                        )}
                        <span className={cn("flex-1", isSet ? "text-foreground" : required ? "text-yellow-600" : "text-muted-foreground")}>
                          {label}
                        </span>
                        <code className="font-mono text-[9px] text-muted-foreground bg-muted px-1 rounded">{name}</code>
                      </div>
                    );
                  })}
                </div>

                {credsMissing && (
                  <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{credsMissing}</span>
                  </div>
                )}
                {buildError && platform === "android" && (
                  <p className="text-xs text-destructive">{buildError}</p>
                )}
                <Button
                  className="w-full bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => void triggerBuild("android")}
                  disabled={triggeringBuild !== null}
                >
                  {triggeringBuild === "android" ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <PlaySquare className="h-4 w-4 mr-2" />
                  )}
                  {triggeringBuild === "android" ? "Queuing build…" : "Build for Android (Play Store)"}
                </Button>
              </div>
            )}

            {/* Build history for Android */}
            {isMobile && mobileBuilds.filter((b) => b.platform === "android").length > 0 && (
              <div className="border border-border rounded-xl overflow-hidden bg-card">
                <div className="px-4 py-3 border-b border-border text-sm font-semibold">Android Build History</div>
                <div className="divide-y divide-border">
                  {mobileBuilds.filter((b) => b.platform === "android").slice(0, 10).map((b) => (
                    <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                      <MobileBuildStatusBadge status={b.status} />
                      {b.buildId && <span className="font-mono text-muted-foreground truncate">{b.buildId.slice(0, 8)}…</span>}
                      {b.testflightUrl && (
                        <a href={b.testflightUrl} target="_blank" rel="noreferrer" className="text-green-500 hover:underline flex items-center gap-0.5">
                          Play Console <ArrowUpRight className="h-2.5 w-2.5" />
                        </a>
                      )}
                      <span className="ml-auto text-muted-foreground shrink-0">{new Date(b.createdAt).toLocaleDateString()}</span>
                    </div>
                  ))}
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

            {!isMobile && (
              <div className="border border-border rounded-xl p-4 bg-card space-y-3">
                {!andReady ? (
                  <div className="flex items-start gap-2 text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>Complete all required items before uploading to Google Play.</span>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 text-xs text-green-600 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>All required items complete. Ready to upload to Google Play Console.</span>
                  </div>
                )}
                <Button className="w-full" disabled>
                  <PlaySquare className="h-4 w-4 mr-2" />
                  Upload to Google Play
                  <span className="ml-2 text-[11px] opacity-60">(Expo build required)</span>
                </Button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
