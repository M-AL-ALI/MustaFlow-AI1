import { useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

type Platform = "web" | "ios" | "android";

export function PublishingTab({ projectId }: { projectId: number }) {
  const [platform, setPlatform] = useState<Platform>("web");
  const [webEnv, setWebEnv] = useState<"testing" | "production">("testing");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [logsOpen, setLogsOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    publicUrl: string;
    publishedAt: string;
  } | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

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
        publicUrl: string;
        publishedAt: string;
      };
      setPublishResult(data);
      setShowConfirm(false);
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
                  { label: "SSL / HTTPS", badge: "pending", note: "Auto-provisioned on publish" },
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

            {/* Custom domain */}
            <div className="border border-border rounded-xl p-4 bg-card space-y-3">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                Custom Domain
              </h3>
              <div className="flex gap-2">
                <input
                  disabled
                  placeholder="yourdomain.com"
                  className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm text-muted-foreground placeholder:text-muted-foreground/50"
                />
                <Button variant="outline" size="sm" disabled>
                  Configure
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Custom domains are available after your first production publish.
              </p>
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
                <div className="bg-zinc-950 font-mono text-xs text-zinc-500 p-4 border-t border-border min-h-[80px] flex items-center justify-center">
                  No deployments yet. Logs will appear here after your first publish.
                </div>
              )}
            </div>

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
                    disabled={!webReadyToPublish}
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
                <a
                  href={publishResult.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300 text-sm break-all"
                >
                  {publishResult.publicUrl}
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                </a>
                <p className="text-[11px] text-muted-foreground">
                  Published {new Date(publishResult.publishedAt).toLocaleString()}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await fetch(`/api/projects/${projectId}/unpublish`, { method: "POST" });
                    setPublishResult(null);
                  }}
                >
                  Unpublish
                </Button>
              </div>
            )}

            {webEnv === "testing" && (
              <Button variant="outline" className="w-full" disabled>
                <Server className="h-4 w-4 mr-2" />
                Deploy to Testing Environment
                <span className="ml-2 text-[11px] opacity-50">(internal preview only)</span>
              </Button>
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
                    Build with Expo → TestFlight beta → App Store production.
                  </p>
                </div>
              </div>

              {/* Step pipeline */}
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                {["Expo Build", "TestFlight", "App Store"].map((step, i) => (
                  <div key={step} className="flex flex-col items-center gap-1.5">
                    <div
                      className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold",
                        i === 0
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {i + 1}
                    </div>
                    <span className="text-muted-foreground">{step}</span>
                  </div>
                ))}
              </div>

              {/* Expo placeholder */}
              <div className="bg-muted/50 border border-border rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Server className="h-3.5 w-3.5" /> Expo Preview
                </div>
                <p className="text-muted-foreground">
                  Mobile app generation (Expo / React Native) is planned for Phase 3. The checklist below covers everything you will need when it arrives.
                </p>
              </div>

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
            </div>

            <div className="flex items-center justify-between gap-4">
              <h3 className="font-semibold text-sm whitespace-nowrap">iOS Submission Checklist</h3>
              <ProgressBar sections={IOS_CHECKLIST} checked={checked} />
            </div>
            <ChecklistGroup sections={IOS_CHECKLIST} checked={checked} onToggle={toggle} />

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
                    Build with Expo → Internal testing → Google Play production.
                  </p>
                </div>
              </div>

              {/* Step pipeline */}
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                {["Expo Build", "Play Console", "Production"].map((step, i) => (
                  <div key={step} className="flex flex-col items-center gap-1.5">
                    <div
                      className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold",
                        i === 0
                          ? "bg-green-500 text-white"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {i + 1}
                    </div>
                    <span className="text-muted-foreground">{step}</span>
                  </div>
                ))}
              </div>

              {/* Android preview placeholder */}
              <div className="bg-muted/50 border border-border rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Server className="h-3.5 w-3.5" /> Android Preview
                </div>
                <p className="text-muted-foreground">
                  Mobile app generation (Expo / React Native) is planned for Phase 3.
                </p>
              </div>

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
            </div>

            <div className="flex items-center justify-between gap-4">
              <h3 className="font-semibold text-sm whitespace-nowrap">
                Android Submission Checklist
              </h3>
              <ProgressBar sections={ANDROID_CHECKLIST} checked={checked} />
            </div>
            <ChecklistGroup sections={ANDROID_CHECKLIST} checked={checked} onToggle={toggle} />

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
          </div>
        )}

      </div>
    </div>
  );
}
