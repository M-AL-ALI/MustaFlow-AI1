import { useState, useCallback, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  FolderTree,
  FileCode2,
  TerminalSquare,
  Lock,
  Blocks,
  Save,
  History as HistoryIcon,
  Info,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Puzzle,
  ToggleLeft,
  ToggleRight,
  KeyRound,
  Package,
  ChevronDown,
  ChevronUp,
  Clock,
  ShieldCheck,
  Github,
  FlaskConical,
  RefreshCw,
  Loader2,
  PenLine,
  AlertTriangle,
} from "lucide-react";
import { IntegrationsRegistry } from "./integrations-registry";
import { GithubTab } from "./github-tab";
import { VersionTimeline } from "./version-timeline";
import { CheckpointsTab } from "./checkpoints-tab";
import { WorkflowsPanel } from "./workflows-panel";
import { QualityPanel } from "./quality-panel";
import {
  useListSecrets,
  useCreateSecret,
  getListSecretsQueryKey,
  useListProjectFiles,
  getListProjectFilesQueryKey,
  useGetProjectFile,
  getGetProjectFileQueryKey,
  useListVersions,
  getListVersionsQueryKey,
  useListTasks,
  getListTasksQueryKey,
  useUpdateTask,
  useRerunTaskTests,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const MOBILE_MODULES = [
  {
    id: "auth",
    name: "Authentication",
    provider: "Clerk",
    description: "User sign-in, sign-up, and session management.",
    requiredSecrets: ["CLERK_PUBLISHABLE_KEY"],
    packageDependencies: ["@clerk/clerk-expo", "expo-secure-store"],
  },
  {
    id: "payments",
    name: "In-App Purchases",
    provider: "RevenueCat",
    description: "Subscription paywalls, purchase flows, and entitlement checks.",
    requiredSecrets: ["REVENUECAT_API_KEY"],
    packageDependencies: ["@revenuecat/purchases-react-native"],
  },
  {
    id: "push",
    name: "Push Notifications",
    provider: "Expo Notifications",
    description: "FCM and APNS push notifications with registration flow.",
    requiredSecrets: [],
    packageDependencies: ["expo-notifications", "expo-device"],
  },
  {
    id: "realtime-db",
    name: "Real-time Database",
    provider: "Supabase",
    description: "Typed queries, real-time subscriptions, and Row Level Security.",
    requiredSecrets: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    packageDependencies: ["@supabase/supabase-js"],
  },
  {
    id: "analytics",
    name: "Analytics",
    provider: "Amplitude",
    description: "Event tracking wired to key user actions.",
    requiredSecrets: ["AMPLITUDE_API_KEY"],
    packageDependencies: ["@amplitude/analytics-react-native"],
  },
  {
    id: "deep-links",
    name: "Deep Links",
    provider: "Expo Linking",
    description: "Share links, invites, and referral flows.",
    requiredSecrets: [],
    packageDependencies: ["expo-linking"],
  },
  {
    id: "offline",
    name: "Offline Support",
    provider: "AsyncStorage + SQLite",
    description: "Local caching and SQLite for offline-first apps.",
    requiredSecrets: [],
    packageDependencies: ["@react-native-async-storage/async-storage", "expo-sqlite"],
  },
  {
    id: "camera-media",
    name: "Camera & Media",
    provider: "Expo Camera",
    description: "Camera capture, photo/video picking, and media upload.",
    requiredSecrets: [],
    packageDependencies: ["expo-camera", "expo-image-picker"],
  },
];

// ── Secrets Guide ─────────────────────────────────────────────────────────────
// Static catalogue of common secret categories with typical key names and links.
const SECRETS_GUIDE = [
  {
    category: "Authentication",
    name: "CLERK_PUBLISHABLE_KEY",
    description: "Clerk auth — publishable key for client-side use.",
    doc: "https://clerk.com/docs",
  },
  {
    category: "Authentication",
    name: "CLERK_SECRET_KEY",
    description: "Clerk auth — secret key for server-side API calls.",
    doc: "https://clerk.com/docs",
  },
  {
    category: "Database",
    name: "DATABASE_URL",
    description: "PostgreSQL connection string (postgres://user:pass@host/db).",
    doc: "https://www.postgresql.org/docs/current/libpq-connect.html",
  },
  {
    category: "Database",
    name: "SUPABASE_URL",
    description: "Supabase project URL.",
    doc: "https://supabase.com/docs",
  },
  {
    category: "Database",
    name: "SUPABASE_ANON_KEY",
    description: "Supabase anon/public key for client-side queries.",
    doc: "https://supabase.com/docs",
  },
  {
    category: "Payments",
    name: "STRIPE_SECRET_KEY",
    description: "Stripe secret key for server-side payment operations.",
    doc: "https://stripe.com/docs/keys",
  },
  {
    category: "Payments",
    name: "STRIPE_PUBLISHABLE_KEY",
    description: "Stripe publishable key for client-side Stripe.js.",
    doc: "https://stripe.com/docs/keys",
  },
  {
    category: "Payments",
    name: "STRIPE_WEBHOOK_SECRET",
    description: "Stripe webhook signing secret for verifying events.",
    doc: "https://stripe.com/docs/webhooks",
  },
  {
    category: "AI / ML",
    name: "OPENAI_API_KEY",
    description: "OpenAI API key for GPT and embedding calls.",
    doc: "https://platform.openai.com/api-keys",
  },
  {
    category: "AI / ML",
    name: "ANTHROPIC_API_KEY",
    description: "Anthropic API key for Claude models.",
    doc: "https://docs.anthropic.com",
  },
  {
    category: "Email",
    name: "RESEND_API_KEY",
    description: "Resend email API key for transactional email.",
    doc: "https://resend.com/docs",
  },
  {
    category: "Email",
    name: "SENDGRID_API_KEY",
    description: "SendGrid API key for email delivery.",
    doc: "https://docs.sendgrid.com",
  },
  {
    category: "Storage",
    name: "AWS_ACCESS_KEY_ID",
    description: "AWS access key for S3 and other services.",
    doc: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
  },
  {
    category: "Storage",
    name: "AWS_SECRET_ACCESS_KEY",
    description: "AWS secret key (pair with AWS_ACCESS_KEY_ID).",
    doc: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
  },
  {
    category: "Storage",
    name: "CLOUDINARY_URL",
    description: "Cloudinary connection URL for image/video storage.",
    doc: "https://cloudinary.com/documentation",
  },
  {
    category: "Maps & Location",
    name: "GOOGLE_MAPS_API_KEY",
    description: "Google Maps API key for map embeds and geocoding.",
    doc: "https://developers.google.com/maps/documentation",
  },
  {
    category: "Analytics",
    name: "AMPLITUDE_API_KEY",
    description: "Amplitude analytics API key.",
    doc: "https://www.docs.developers.amplitude.com",
  },
  {
    category: "SMS",
    name: "TWILIO_ACCOUNT_SID",
    description: "Twilio account SID for SMS sending.",
    doc: "https://www.twilio.com/docs",
  },
  {
    category: "SMS",
    name: "TWILIO_AUTH_TOKEN",
    description: "Twilio auth token (pair with TWILIO_ACCOUNT_SID).",
    doc: "https://www.twilio.com/docs",
  },
  {
    category: "Push Notifications",
    name: "EXPO_ACCESS_TOKEN",
    description: "Expo access token for EAS Build and push notifications.",
    doc: "https://docs.expo.dev/eas/json",
  },
] as const;

type SecretsGuideEntry = { category: string; name: string; description: string; doc: string };

function SecretsGuide({ onSelect }: { onSelect: (name: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = (SECRETS_GUIDE as readonly SecretsGuideEntry[]).filter(
    (e) =>
      !search ||
      e.name.toLowerCase().includes(search.toLowerCase()) ||
      e.category.toLowerCase().includes(search.toLowerCase()) ||
      e.description.toLowerCase().includes(search.toLowerCase()),
  );
  const grouped = filtered.reduce<Record<string, SecretsGuideEntry[]>>((acc, e) => {
    (acc[e.category] ??= []).push(e);
    return acc;
  }, {});

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Secrets Guide</span>
        <span className="text-xs text-muted-foreground ml-auto">Click to pre-fill name</span>
      </div>
      <div className="p-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search services, key names…"
          className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary mb-3"
        />
        <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
          {Object.entries(grouped).map(([cat, entries]) => (
            <div key={cat}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5 px-0.5">
                {cat}
              </div>
              <div className="space-y-1">
                {entries.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    onClick={() => onSelect(e.name)}
                    className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-md hover:bg-muted transition-colors group"
                  >
                    <div className="shrink-0 mt-0.5 h-5 w-5 rounded bg-primary/10 flex items-center justify-center">
                      <Lock className="h-2.5 w-2.5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-foreground group-hover:text-primary transition-colors">
                        {e.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground/70 mt-0.5 line-clamp-1">
                        {e.description}
                      </div>
                    </div>
                    <a
                      href={e.doc}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(ev) => ev.stopPropagation()}
                      className="shrink-0 mt-0.5 text-muted-foreground/30 hover:text-primary transition-colors"
                      title="Documentation"
                    >
                      <Info className="h-3 w-3" />
                    </a>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground/50">
              No matching secrets found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  accessed: "Accessed",
  verified: "Verified",
  verification_failed: "Verify failed",
};

const ACTION_COLORS: Record<string, string> = {
  created: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  updated: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  deleted: "text-red-400 bg-red-500/10 border-red-500/20",
  accessed: "text-muted-foreground bg-muted border-border",
  verified: "text-green-400 bg-green-500/10 border-green-500/20",
  verification_failed: "text-destructive bg-destructive/10 border-destructive/20",
};

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function SecretAuditTimeline({ secretId, projectId }: { secretId: number; projectId: number }) {
  const [expanded, setExpanded] = useState(false);

  type AuditEntry = { id: number; action: string; createdAt: string; actorId?: string };
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/projects/${projectId}/secrets/${secretId}/audit`)
      .then(async (r) => {
        if (r.ok) {
          const data = (await r.json()) as AuditEntry[];
          if (!cancelled) setEntries(Array.isArray(data) ? data : []);
        }
      })
      .catch(() => {
        /* endpoint may not exist yet — show empty */
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, secretId]);

  if (isLoading) {
    return (
      <div className="px-3 pb-3 pt-0">
        <div className="text-[10px] text-muted-foreground animate-pulse">Loading history…</div>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="px-3 pb-3 pt-0">
        <div className="text-[10px] text-muted-foreground">No activity recorded yet.</div>
      </div>
    );
  }

  const visibleEntries = expanded ? entries : entries.slice(0, 5);
  const hasMore = entries.length > 5;

  return (
    <div className="px-3 pb-3 pt-0 space-y-1.5">
      {visibleEntries.map((entry: AuditEntry, i: number) => (
        <div key={entry.id} className="flex items-start gap-2 min-w-0">
          <div className="relative flex flex-col items-center shrink-0 mt-0.5">
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
            {i < visibleEntries.length - 1 && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 w-px h-full bg-border" />
            )}
          </div>
          <div className="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
            <span
              className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded border ${ACTION_COLORS[entry.action] ?? ACTION_COLORS.accessed}`}
            >
              {ACTION_LABELS[entry.action] ?? entry.action}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {relativeTime(entry.createdAt)}
            </span>
          </div>
        </div>
      ))}

      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors mt-0.5"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Show {entries.length - 5} more
            </>
          )}
        </button>
      )}
    </div>
  );
}

function SecretVerifyButton({
  secretId,
  projectId,
  initialStatus,
}: {
  secretId: number;
  projectId: number;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus ?? "unverified");
  const [loading, setLoading] = useState(false);

  const verify = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets/${secretId}/verify`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as { status: string };
        setStatus(data.status);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId, secretId]);

  const icon =
    status === "verified" ? (
      <CheckCircle2 className="h-3 w-3 text-green-500" />
    ) : status === "verification_failed" ? (
      <XCircle className="h-3 w-3 text-destructive" />
    ) : (
      <AlertCircle className="h-3 w-3 text-muted-foreground" />
    );

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {icon}
      <button
        onClick={() => void verify()}
        disabled={loading}
        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 whitespace-nowrap"
      >
        {loading ? "Checking…" : "Verify"}
      </button>
    </div>
  );
}

function ModuleLibrary({
  projectId,
  secrets,
  wiredModuleIds,
  onSendMessage,
}: {
  projectId: number;
  secrets: Array<{ name: string; id: number }>;
  wiredModuleIds?: string[];
  onSendMessage?: (text: string) => void;
}) {
  const secretNames = new Set(secrets.map((s) => s.name));
  const [activeModules, setActiveModules] = useState<Set<string>>(
    () => new Set(wiredModuleIds ?? []),
  );

  // Sync when parent derives wired modules from a newly completed task report
  useEffect(() => {
    if (wiredModuleIds) {
      setActiveModules(new Set(wiredModuleIds));
    }
  }, [wiredModuleIds?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [addSecretFor, setAddSecretFor] = useState<string | null>(null);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const createSecret = useCreateSecret();
  const queryClient = useQueryClient();

  const getModuleStatus = (
    mod: (typeof MOBILE_MODULES)[0],
  ): "active" | "inactive" | "needs-secret" => {
    if (!activeModules.has(mod.id)) {
      if (mod.requiredSecrets.length > 0 && !mod.requiredSecrets.every((s) => secretNames.has(s))) {
        return "needs-secret";
      }
      return "inactive";
    }
    return "active";
  };

  const handleToggle = (mod: (typeof MOBILE_MODULES)[0]) => {
    const status = getModuleStatus(mod);

    if (status === "needs-secret") {
      setAddSecretFor(mod.id);
      setNewSecretName(mod.requiredSecrets.find((s) => !secretNames.has(s)) ?? "");
      return;
    }

    if (status === "active") {
      setActiveModules((prev) => {
        const next = new Set(prev);
        next.delete(mod.id);
        return next;
      });
      if (onSendMessage) {
        onSendMessage(
          `Remove the ${mod.name} (${mod.provider}) integration cleanly. Remove all related imports, initialization code, and screens added for this module.`,
        );
      }
    } else {
      setActiveModules((prev) => new Set([...prev, mod.id]));
      const secretsList =
        mod.requiredSecrets.length > 0
          ? ` using the API key stored in ${mod.requiredSecrets.join(", ")}`
          : "";
      if (onSendMessage) {
        onSendMessage(
          `Wire in ${mod.name} (${mod.provider}) for this app${secretsList}. Follow the official ${mod.provider} Expo SDK patterns: correct imports, initialization in app/_layout.tsx, typed hooks, error boundaries, and loading states. Add all required packages to package.json.`,
        );
      }
    }
  };

  const handleAddSecret = (modId: string) => {
    if (!newSecretName || !newSecretValue) return;
    createSecret.mutate(
      {
        id: projectId,
        data: { name: newSecretName, value: newSecretValue, environment: "development" },
      },
      {
        onSuccess: () => {
          setNewSecretName("");
          setNewSecretValue("");
          setAddSecretFor(null);
          queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
          const mod = MOBILE_MODULES.find((m) => m.id === modId);
          if (mod && onSendMessage) {
            const secretsList = mod.requiredSecrets.join(", ");
            onSendMessage(
              `Wire in ${mod.name} (${mod.provider}) for this app using the API key stored in ${secretsList}. Follow the official ${mod.provider} Expo SDK patterns.`,
            );
          }
          setActiveModules((prev) => new Set([...prev, modId]));
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Toggle modules to auto-wire them into your app. The AI builder will add the correct SDK
        code, imports, and initialization.
      </div>

      {MOBILE_MODULES.map((mod) => {
        const status = getModuleStatus(mod);
        const isActive = status === "active";
        const needsSecret = status === "needs-secret";
        const isExpanded = addSecretFor === mod.id;

        return (
          <div
            key={mod.id}
            className={`border rounded-lg overflow-hidden transition-colors ${
              isActive
                ? "border-primary/40 bg-primary/5"
                : needsSecret
                  ? "border-yellow-500/30 bg-yellow-500/5"
                  : "border-border bg-card"
            }`}
          >
            <div className="flex items-start gap-3 p-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{mod.name}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded font-mono">
                    {mod.provider}
                  </span>
                  {isActive && (
                    <Badge
                      variant="default"
                      className="text-[10px] h-4 px-1.5 bg-primary/20 text-primary border-primary/30"
                    >
                      Active
                    </Badge>
                  )}
                  {!isActive && !needsSecret && (
                    <Badge
                      variant="outline"
                      className="text-[10px] h-4 px-1.5 text-muted-foreground border-border"
                    >
                      Inactive
                    </Badge>
                  )}
                  {needsSecret && (
                    <Badge
                      variant="outline"
                      className="text-[10px] h-4 px-1.5 text-yellow-500 border-yellow-500/30"
                    >
                      Needs secret
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{mod.description}</p>
                {mod.requiredSecrets.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <KeyRound className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                    {mod.requiredSecrets.map((s) => (
                      <span
                        key={s}
                        className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                          secretNames.has(s)
                            ? "text-green-400 bg-green-500/10"
                            : "text-yellow-400 bg-yellow-500/10"
                        }`}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                {mod.packageDependencies.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <Package className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                    {mod.packageDependencies.slice(0, 2).map((p) => (
                      <span key={p} className="text-[10px] font-mono text-muted-foreground">
                        {p}
                      </span>
                    ))}
                    {mod.packageDependencies.length > 2 && (
                      <span className="text-[10px] text-muted-foreground">
                        +{mod.packageDependencies.length - 2} more
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => handleToggle(mod)}
                className={`shrink-0 mt-0.5 transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
                title={
                  isActive
                    ? "Remove module"
                    : needsSecret
                      ? "Add required secret first"
                      : "Wire in module"
                }
              >
                {isActive ? (
                  <ToggleRight className="h-6 w-6" />
                ) : (
                  <ToggleLeft className="h-6 w-6" />
                )}
              </button>
            </div>

            {isExpanded && (
              <div className="px-3 pb-3 pt-0 border-t border-border bg-background/50 space-y-2">
                <p className="text-xs text-yellow-400 pt-2">
                  Add the required secret to enable this module:
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Key name"
                    value={newSecretName}
                    onChange={(e) => setNewSecretName(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                  <Input
                    placeholder="Value"
                    type="password"
                    value={newSecretValue}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={() => handleAddSecret(mod.id)}
                    disabled={!newSecretName || !newSecretValue || createSecret.isPending}
                    className="h-8 text-xs whitespace-nowrap"
                  >
                    {createSecret.isPending ? "Saving…" : "Save & wire"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAddSecretFor(null)}
                    className="h-8 text-xs"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const SECRET_MIN_ROLE_LABELS: Record<string, string> = {
  viewer: "All members",
  member: "Members+",
  admin: "Admins+",
  owner: "Owner only",
};

function SecretRowWithAudit({
  secret,
  projectId,
}: {
  secret: {
    id: number;
    name: string;
    masked: string;
    verificationStatus?: string | null;
    minRole?: string | null;
  };
  projectId: number;
}) {
  const queryClient = useQueryClient();
  const [showAudit, setShowAudit] = useState(false);
  const [savingRole, setSavingRole] = useState(false);

  const handleMinRoleChange = async (newRole: string) => {
    setSavingRole(true);
    try {
      await fetch(`/api/projects/${projectId}/secrets/${secret.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minRole: newRole }),
      });
      queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
    } catch {
      // best-effort
    } finally {
      setSavingRole(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 p-3 text-sm min-w-0">
        <div className="font-mono text-foreground truncate flex-1 min-w-0">{secret.name}</div>
        <div className="font-mono text-muted-foreground flex items-center gap-1.5 shrink-0">
          <Lock className="h-3 w-3 shrink-0" />
          {secret.masked}
        </div>
        <select
          value={secret.minRole ?? "viewer"}
          onChange={(e) => void handleMinRoleChange(e.target.value)}
          disabled={savingRole}
          title="Minimum role to view this secret"
          className="text-[10px] bg-muted border border-border rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground focus:outline-none shrink-0 disabled:opacity-50"
        >
          {Object.entries(SECRET_MIN_ROLE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>
        <SecretVerifyButton
          secretId={secret.id}
          projectId={projectId}
          initialStatus={secret.verificationStatus ?? "unverified"}
        />
        <button
          onClick={() => setShowAudit((v) => !v)}
          title={showAudit ? "Hide activity" : "Show activity"}
          className={`flex items-center gap-1 text-[10px] transition-colors shrink-0 ${
            showAudit ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Clock className="h-3 w-3" />
          {showAudit ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>
      {showAudit && (
        <div className="border-t border-border bg-background/40">
          <SecretAuditTimeline secretId={secret.id} projectId={projectId} />
        </div>
      )}
    </div>
  );
}

function TestPlanEditor({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const { data: tasks, isLoading } = useListTasks(projectId, {
    query: { enabled: !!projectId, queryKey: getListTasksQueryKey(projectId) },
  });

  // Find the most recent task that has test results or a testScript
  const taskWithTests = tasks?.find(
    (t) =>
      (t.report as { testScript?: string | null } | null | undefined)?.testScript != null ||
      (t.report as { testResults?: unknown[] | null } | null | undefined)?.testResults != null,
  );

  const savedScript =
    (taskWithTests?.report as { testScript?: string | null } | null | undefined)?.testScript ??
    null;

  const [editedScript, setEditedScript] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const updateTask = useUpdateTask();
  const rerunTests = useRerunTaskTests();

  useEffect(() => {
    if (!isEditing && savedScript) {
      try {
        setEditedScript(JSON.stringify(JSON.parse(savedScript), null, 2));
      } catch {
        setEditedScript(savedScript);
      }
      setParseError(null);
    }
  }, [savedScript, isEditing]);

  const handleEdit = () => {
    if (savedScript) {
      try {
        setEditedScript(JSON.stringify(JSON.parse(savedScript), null, 2));
      } catch {
        setEditedScript(savedScript);
      }
    } else {
      setEditedScript(
        JSON.stringify(
          {
            steps: [
              { action: "navigate", value: "/" },
              { action: "waitForSelector", selector: "body" },
              { action: "assertText", selector: "body", value: "" },
            ],
          },
          null,
          2,
        ),
      );
    }
    setParseError(null);
    setIsEditing(true);
  };

  const handleScriptChange = (value: string) => {
    setEditedScript(value);
    try {
      JSON.parse(value);
      setParseError(null);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  const handleSave = () => {
    if (!taskWithTests || parseError) return;
    try {
      JSON.parse(editedScript);
    } catch {
      return;
    }
    updateTask.mutate(
      { id: projectId, taskId: taskWithTests.id, data: { testScript: editedScript } },
      {
        onSuccess: () => {
          setIsEditing(false);
          void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
        },
      },
    );
  };

  const handleRerun = () => {
    if (!taskWithTests) return;
    rerunTests.mutate(
      { id: projectId, taskId: taskWithTests.id },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading test plans...
      </div>
    );
  }

  if (!taskWithTests) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
        <FlaskConical className="h-8 w-8 opacity-30" />
        <p className="text-sm font-medium">No test plan yet</p>
        <p className="text-xs max-w-xs leading-relaxed">
          After a build completes, the AI generates a test plan and runs it automatically. The test
          plan will appear here so you can review and customize it.
        </p>
      </div>
    );
  }

  const testResults =
    (
      taskWithTests.report as
        | { testResults?: Array<{ name: string; passed: boolean; durationMs: number }> | null }
        | null
        | undefined
    )?.testResults ?? null;
  const testRanAt =
    (taskWithTests.report as { testRanAt?: string | null } | null | undefined)?.testRanAt ?? null;
  const isCustom = savedScript != null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" />
            Test Plan
            {isCustom && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-medium">
                Custom
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isCustom
              ? "Using your custom test script. The AI will not overwrite it on re-run."
              : "AI-generated test plan from the last build."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsEditing(false);
                  setParseError(null);
                }}
                className="text-xs h-7"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!!parseError || updateTask.isPending}
                className="text-xs h-7"
              >
                {updateTask.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Save className="h-3 w-3 mr-1" />
                )}
                Save
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={handleEdit} className="text-xs h-7">
                <PenLine className="h-3 w-3 mr-1" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRerun}
                disabled={rerunTests.isPending}
                className="text-xs h-7"
              >
                {rerunTests.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Re-run
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Last run summary */}
      {testResults && !isEditing && (
        <div className="border border-border rounded-lg p-3 bg-card space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-foreground/80">Last run</span>
            {testRanAt && (
              <span className="text-muted-foreground/60">
                {new Date(testRanAt).toLocaleString()}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-green-400" />
              <span className="text-green-400">
                {testResults.filter((r) => r.passed).length} passed
              </span>
              {testResults.filter((r) => !r.passed).length > 0 && (
                <>
                  <XCircle className="h-3 w-3 text-red-400 ml-1" />
                  <span className="text-red-400">
                    {testResults.filter((r) => !r.passed).length} failed
                  </span>
                </>
              )}
            </span>
          </div>
          <ul className="space-y-0.5">
            {testResults.map((r, i) => (
              <li key={i} className="flex items-center gap-1.5 text-[11px]">
                {r.passed ? (
                  <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
                ) : (
                  <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                )}
                <span className={r.passed ? "text-foreground/70" : "text-foreground"}>
                  {r.name}
                </span>
                <span className="ml-auto text-muted-foreground/40 text-[10px]">
                  {r.durationMs}ms
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Editor */}
      {isEditing ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Edit the JSON test plan below. Each step has an{" "}
              <code className="bg-muted px-1 rounded text-[11px]">action</code> and optional fields.
            </p>
          </div>
          {parseError && (
            <div className="flex items-start gap-1.5 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{parseError}</span>
            </div>
          )}
          <textarea
            className="w-full h-[400px] bg-[#0d1117] text-[#d4d4d4] font-mono text-xs p-4 rounded-lg border border-border resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
            value={editedScript}
            onChange={(e) => handleScriptChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      ) : (
        savedScript && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
              <span className="text-[11px] font-mono text-muted-foreground">test-plan.json</span>
              <span className="text-[10px] text-muted-foreground/50">
                read-only — click Edit to modify
              </span>
            </div>
            <pre className="bg-[#0d1117] text-[#d4d4d4] font-mono text-xs p-4 overflow-x-auto max-h-[400px] overflow-y-auto">
              <code>
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(savedScript), null, 2);
                  } catch {
                    return savedScript;
                  }
                })()}
              </code>
            </pre>
          </div>
        )
      )}
    </div>
  );
}

export function ToolsTab({
  projectId,
  projectKind,
  wiredModuleIds,
  prefillSecretName,
  defaultTab,
  onSendMessage,
  onNavigateToFile,
}: {
  projectId: number;
  projectKind?: string;
  wiredModuleIds?: string[];
  prefillSecretName?: string | null;
  defaultTab?: string;
  onSendMessage?: (text: string) => void;
  onNavigateToFile?: (filePath: string, line?: number | null) => void;
}) {
  const queryClient = useQueryClient();
  const isMobile =
    projectKind === "mobile-cross" ||
    projectKind === "mobile-ios" ||
    projectKind === "mobile-android";

  const [innerTab, setInnerTab] = useState<string>(
    prefillSecretName ? "secrets" : (defaultTab ?? "files"),
  );

  const { data: files } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const activeFileId =
    selectedFileId ?? files?.find((f) => f.path === "index.html")?.id ?? files?.[0]?.id ?? null;
  const { data: fileContent } = useGetProjectFile(projectId, activeFileId ?? 0, {
    query: {
      enabled: !!projectId && !!activeFileId,
      queryKey: getGetProjectFileQueryKey(projectId, activeFileId ?? 0),
    },
  });

  const { data: versions, isLoading: versionsLoading } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });

  const { data: secrets } = useListSecrets(projectId, {
    query: { enabled: !!projectId, queryKey: getListSecretsQueryKey(projectId) },
  });
  const createSecret = useCreateSecret();

  const [newSecretName, setNewSecretName] = useState(prefillSecretName ?? "");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretEnv, setSecretEnv] = useState<"development" | "testing" | "staging" | "production">(
    "development",
  );

  useEffect(() => {
    if (prefillSecretName) {
      setInnerTab("secrets");
      setNewSecretName(prefillSecretName);
    }
  }, [prefillSecretName]);

  const handleCreateSecret = () => {
    if (!newSecretName || !newSecretValue) return;
    createSecret.mutate(
      {
        id: projectId,
        data: { name: newSecretName, value: newSecretValue, environment: secretEnv },
      },
      {
        onSuccess: () => {
          setNewSecretName("");
          setNewSecretValue("");
          queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
        },
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-2 bg-card flex-1 overflow-hidden">
        <Tabs value={innerTab} onValueChange={setInnerTab} className="w-full h-full flex flex-col">
          <TabsList className="bg-muted flex-wrap h-auto gap-y-1">
            <TabsTrigger value="files">
              <FolderTree className="h-4 w-4 mr-2" /> Files
            </TabsTrigger>
            <TabsTrigger value="versions">
              <HistoryIcon className="h-4 w-4 mr-2" /> Versions
            </TabsTrigger>
            <TabsTrigger value="shell">
              <TerminalSquare className="h-4 w-4 mr-2" /> Shell
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <Lock className="h-4 w-4 mr-2" /> Secrets
            </TabsTrigger>
            <TabsTrigger value="integrations">
              <Blocks className="h-4 w-4 mr-2" /> Integrations
            </TabsTrigger>
            <TabsTrigger value="quality">
              <ShieldCheck className="h-4 w-4 mr-2" /> Quality
            </TabsTrigger>
            <TabsTrigger value="tests">
              <FlaskConical className="h-4 w-4 mr-2" /> Tests
            </TabsTrigger>
            {isMobile && (
              <TabsTrigger value="modules">
                <Puzzle className="h-4 w-4 mr-2" /> Modules
              </TabsTrigger>
            )}
          </TabsList>

          <div className="mt-4 flex-1 h-[calc(100vh-280px)] overflow-y-auto">
            <TabsContent
              value="files"
              className="h-full m-0 border border-border rounded-md flex overflow-hidden"
            >
              <div className="w-60 bg-card border-r border-border p-2 overflow-y-auto">
                {(!files || files.length === 0) && (
                  <div className="text-xs text-muted-foreground p-2">
                    No files yet. Send the AI Builder a message to generate your app.
                  </div>
                )}
                {files?.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setSelectedFileId(f.id)}
                    className={`w-full text-left text-sm flex items-center gap-2 py-1 px-2 rounded ${
                      activeFileId === f.id
                        ? "bg-primary/15 text-primary"
                        : "hover:bg-muted text-muted-foreground"
                    }`}
                    title={f.path}
                  >
                    <FileCode2 className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate font-mono text-xs">{f.path}</span>
                  </button>
                ))}
              </div>
              <div className="flex-1 bg-[#0d1117] p-4 text-[#d4d4d4] font-mono text-xs relative overflow-auto">
                <div className="absolute top-2 right-2 flex items-center gap-2">
                  {fileContent && (
                    <span className="text-[10px] text-muted-foreground px-2 py-1 bg-background/30 rounded">
                      {fileContent.mimeType}
                    </span>
                  )}
                  <Button size="sm" variant="secondary" disabled>
                    <Save className="h-4 w-4 mr-2" /> Read only
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap break-words mt-10">
                  <code>{fileContent?.content ?? "// Select a file"}</code>
                </pre>
              </div>
            </TabsContent>

            <TabsContent value="versions" className="h-full m-0 pt-2 overflow-y-auto">
              <CheckpointsTab projectId={projectId} />
              <details className="mt-4 mx-3 border-t border-border/40 pt-3">
                <summary className="text-[11px] text-muted-foreground cursor-pointer select-none">
                  Show legacy version timeline
                </summary>
                <div className="mt-2">
                  <VersionTimeline
                    projectId={projectId}
                    versions={versions}
                    isLoading={versionsLoading}
                    currentFiles={files ?? []}
                  />
                </div>
              </details>
            </TabsContent>

            <TabsContent value="shell" className="h-full m-0 p-4 overflow-y-auto">
              <WorkflowsPanel projectId={projectId} />
              <div className="mt-6 text-[11px] text-gray-400">
                Full interactive shell access is available in the Terminal tab. Workflows above run
                inside the project's container.
              </div>
            </TabsContent>

            <TabsContent value="secrets" className="h-full m-0 p-4 space-y-6">
              {/* Secrets Guide — searchable catalogue of common key names */}
              <SecretsGuide onSelect={(name) => setNewSecretName(name)} />

              <div className="grid grid-cols-4 gap-3 border border-border rounded-lg p-4 bg-card">
                <div className="col-span-4 font-semibold mb-1">Add new secret</div>
                <Input
                  placeholder="Key (e.g. STRIPE_API_KEY)"
                  value={newSecretName}
                  onChange={(e) => setNewSecretName(e.target.value)}
                />
                <Input
                  placeholder="Value"
                  type="password"
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                />
                <select
                  className="bg-background border border-border rounded-md px-2 text-sm"
                  value={secretEnv}
                  onChange={(e) =>
                    setSecretEnv(
                      e.target.value as "development" | "testing" | "staging" | "production",
                    )
                  }
                >
                  <option value="development">Development</option>
                  <option value="testing">Testing</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                </select>
                <Button
                  onClick={handleCreateSecret}
                  disabled={!newSecretName || !newSecretValue || createSecret.isPending}
                >
                  {createSecret.isPending ? "Adding..." : "Add secret"}
                </Button>
                <div className="col-span-4 text-xs text-muted-foreground">
                  Values are never returned by the API — only a masked preview. Separate test and
                  production secrets so the AI Builder can target the right environment.
                </div>
              </div>

              {!secrets || secrets.length === 0 ? (
                <div className="border border-border rounded-lg p-8 text-center text-muted-foreground bg-card">
                  No secrets configured yet. Add your first key above.
                </div>
              ) : (
                <div className="space-y-4">
                  {(["development", "testing", "staging", "production"] as const).map((env) => {
                    const envSecrets = secrets.filter((s) => s.environment === env);
                    if (envSecrets.length === 0) return null;
                    const envConfig = {
                      development: {
                        label: "Development",
                        color: "text-blue-400",
                        bg: "bg-blue-500/10 border-blue-500/20",
                      },
                      testing: {
                        label: "Testing",
                        color: "text-yellow-400",
                        bg: "bg-yellow-500/10 border-yellow-500/20",
                      },
                      staging: {
                        label: "Staging",
                        color: "text-orange-400",
                        bg: "bg-orange-500/10 border-orange-500/20",
                      },
                      production: {
                        label: "Production",
                        color: "text-green-400",
                        bg: "bg-green-500/10 border-green-500/20",
                      },
                    }[env];
                    return (
                      <div
                        key={env}
                        className="border border-border rounded-lg overflow-hidden bg-card"
                      >
                        <div
                          className={`px-4 py-2 border-b border-border flex items-center gap-2 ${envConfig.bg}`}
                        >
                          <span
                            className={`text-xs font-semibold uppercase tracking-wider ${envConfig.color}`}
                          >
                            {envConfig.label} Keys
                          </span>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {envSecrets.length} secret{envSecrets.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="divide-y divide-border">
                          {envSecrets.map((s) => (
                            <SecretRowWithAudit key={s.id} secret={s} projectId={projectId} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Container environment display */}
              {secrets && secrets.length > 0 && (
                <div className="border border-border rounded-lg overflow-hidden bg-card">
                  <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center gap-2">
                    <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold">Dev Server Environment</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {secrets.length} var{secrets.length !== 1 ? "s" : ""} injected on start
                    </span>
                  </div>
                  <div className="p-3 bg-[#0d1117]">
                    <div className="font-mono text-xs space-y-0.5">
                      {secrets.map((s) => (
                        <div key={s.id} className="flex items-center gap-2">
                          <span className="text-[#79c0ff]">{s.name}</span>
                          <span className="text-[#8b949e]">=</span>
                          <span className="text-[#a5d6ff] opacity-60">••••••••</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground/50 mt-2">
                      All secrets are injected as environment variables when the container starts.
                      Changing a secret restarts a running container automatically.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-2 text-xs text-muted-foreground mt-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Secret values are never returned by the API. Use Development keys for local testing,
                Test keys for staging, and Production keys for your live app.
              </div>
            </TabsContent>

            <TabsContent value="integrations" className="h-full m-0">
              <Tabs defaultValue="marketplace" className="h-full flex flex-col">
                <TabsList className="shrink-0 w-full justify-start rounded-none border-b border-border bg-transparent px-4 pt-1 h-9 gap-1">
                  <TabsTrigger
                    value="marketplace"
                    className="h-7 text-xs px-3 rounded-md data-[state=active]:bg-muted"
                  >
                    <Blocks className="h-3 w-3 mr-1.5" /> Marketplace
                  </TabsTrigger>
                  <TabsTrigger
                    value="github"
                    className="h-7 text-xs px-3 rounded-md data-[state=active]:bg-muted"
                  >
                    <Github className="h-3 w-3 mr-1.5" /> GitHub
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="marketplace" className="flex-1 overflow-y-auto m-0 p-4">
                  <IntegrationsRegistry projectId={projectId} secrets={secrets ?? []} />
                </TabsContent>
                <TabsContent value="github" className="flex-1 overflow-y-auto m-0 p-4">
                  <GithubTab projectId={projectId} />
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="quality" className="h-full m-0 p-4">
              <QualityPanel
                projectId={projectId}
                projectKind={projectKind}
                onSendMessage={onSendMessage}
                onNavigateToFile={onNavigateToFile}
              />
            </TabsContent>

            <TabsContent value="tests" className="h-full m-0 p-4">
              <TestPlanEditor projectId={projectId} />
            </TabsContent>

            {isMobile && (
              <TabsContent value="modules" className="h-full m-0 p-4">
                <ModuleLibrary
                  projectId={projectId}
                  secrets={secrets ?? []}
                  wiredModuleIds={wiredModuleIds}
                  onSendMessage={onSendMessage}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
