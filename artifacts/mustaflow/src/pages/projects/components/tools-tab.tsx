import { authFetch } from "@/lib/api-fetch";
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
  KeyRound,
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
import { useEventSource } from "@/lib/use-event-source";
import { IntegrationsRegistry } from "./integrations-registry";
import { GithubTab } from "./github-tab";
import { VersionTimeline } from "./version-timeline";
import { CheckpointsTab } from "./checkpoints-tab";
import { WorkflowsPanel } from "./workflows-panel";
import { QualityPanel } from "./quality-panel";
import { ModuleLibrary } from "./module-library";
import { ProjectSecretsPanel } from "./project-secrets-panel";
import {
  useListSecrets,
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
  type SecretEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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
    authFetch(`/api/projects/${projectId}/secrets/${secretId}/audit`)
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
      const res = await authFetch(`/api/projects/${projectId}/secrets/${secretId}/verify`, {
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

const SECRET_MIN_ROLE_LABELS: Record<string, string> = {
  viewer: "All members",
  member: "Members+",
  admin: "Admins+",
  owner: "Owner only",
};

function SecretRowWithAudit({
  secret,
  projectId,
  isFlashing = false,
}: {
  secret: {
    id: number;
    name: string;
    masked: string;
    verificationStatus?: string | null;
    minRole?: string | null;
  };
  projectId: number;
  isFlashing?: boolean;
}) {
  const queryClient = useQueryClient();
  const [showAudit, setShowAudit] = useState(false);
  const [savingRole, setSavingRole] = useState(false);

  const handleMinRoleChange = async (newRole: string) => {
    setSavingRole(true);
    try {
      await authFetch(`/api/projects/${projectId}/secrets/${secret.id}`, {
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
    <div className={`transition-colors duration-500 ${isFlashing ? "bg-green-500/10" : ""}`}>
      <div className="flex items-center gap-3 p-3 text-sm min-w-0">
        <div className="font-mono text-foreground truncate flex-1 min-w-0">
          {secret.name}
          {isFlashing && (
            <span className="ml-2 text-[10px] text-green-400 font-sans font-normal animate-pulse">
              updated
            </span>
          )}
        </div>
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
  onRollbackSuccess,
}: {
  projectId: number;
  projectKind?: string;
  wiredModuleIds?: string[];
  prefillSecretName?: string | null;
  defaultTab?: string;
  onSendMessage?: (text: string) => void;
  onNavigateToFile?: (filePath: string, line?: number | null) => void;
  onRollbackSuccess?: () => void;
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

  const {
    data: secrets,
    isLoading: secretsLoading,
    isError: secretsError,
    isFetching: secretsRefreshing,
    refetch: refetchSecrets,
  } = useListSecrets(projectId, {
    query: { enabled: !!projectId, queryKey: getListSecretsQueryKey(projectId) },
  });
  // ── Secret SSE stream ──────────────────────────────────────────────────────
  // When a collaborator creates/updates/deletes a secret, we update the cache
  // directly (no full refetch) and briefly highlight the affected row.
  const [flashedSecretIds, setFlashedSecretIds] = useState<Set<number>>(new Set());

  // useEventSource handles exponential back-off reconnection automatically.
  // Each reconnect triggers the server's replay-then-stream, so the snapshot
  // reconciles any state missed during the disconnect.
  useEventSource(`/api/projects/${projectId}/secrets/events/stream`, {
    onMessage: (evt) => {
      try {
        type SnapshotPayload = {
          type: "snapshot";
          projectId: number;
          secrets: { id: number; name: string }[];
        };
        type ChangePayload = {
          projectId: number;
          secretId: number;
          action: "created" | "updated" | "deleted";
          secretName: string;
        };

        // "snapshot" events carry the authoritative id list; reconcile cache
        // Discriminate on "action" field to avoid union narrowing issues
        const raw = JSON.parse(evt.data as string) as SnapshotPayload | ChangePayload;
        if (!("action" in raw)) {
          const snap = raw as SnapshotPayload;
          const key = getListSecretsQueryKey(projectId);
          const snapIds = new Set(snap.secrets.map((s) => s.id));
          const nameById = new Map(snap.secrets.map((s) => [s.id, s.name]));

          queryClient.setQueryData<SecretEntry[]>(key, (old) => {
            if (!old) return old;
            const cacheIds = new Set(old.map((s) => s.id));

            // Remove IDs that exist in cache but not in snapshot (missed deletes)
            const pruned = old.filter((s) => snapIds.has(s.id));

            // Update names for entries present in both
            const updated = pruned.map((entry) =>
              nameById.has(entry.id) ? { ...entry, name: nameById.get(entry.id) as string } : entry,
            );

            // If snapshot has IDs not in cache (missed creates), invalidate to refetch
            const hasNewIds = snap.secrets.some((s) => !cacheIds.has(s.id));
            if (hasNewIds) {
              void queryClient.invalidateQueries({ queryKey: key });
            }

            return updated;
          });
          return;
        }

        const payload = raw as ChangePayload;

        const key = getListSecretsQueryKey(projectId);

        if (payload.action === "deleted") {
          // Remove the secret from the cache immediately — no refetch needed
          queryClient.setQueryData<SecretEntry[]>(key, (old) =>
            old ? old.filter((s) => s.id !== payload.secretId) : old,
          );
        } else if (payload.action === "updated") {
          // Patch the name in-place; invalidate in the background for other
          // fields (masked value, environment) that the event doesn't carry
          queryClient.setQueryData<SecretEntry[]>(key, (old) => {
            if (!old) return old;
            return old.map((s) =>
              s.id === payload.secretId ? { ...s, name: payload.secretName } : s,
            );
          });
          void queryClient.invalidateQueries({ queryKey: key });
        } else {
          // "created" — we don't have the full entry, so refetch the list
          void queryClient.invalidateQueries({ queryKey: key });
        }

        const id = payload.secretId;
        setFlashedSecretIds((prev) => new Set(prev).add(id));
        setTimeout(() => {
          setFlashedSecretIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, 2000);
      } catch {
        /* ignore malformed events */
      }
    },
  });

  useEffect(() => {
    if (prefillSecretName) {
      setInnerTab("secrets");
    }
  }, [prefillSecretName]);

  useEffect(() => {
    if (defaultTab) setInnerTab(defaultTab);
  }, [defaultTab]);

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
                    No files yet. Send NabuFlow a message to generate your app.
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
                    onRollbackSuccess={onRollbackSuccess}
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

            <TabsContent value="secrets" className="h-full m-0 p-4">
              <ProjectSecretsPanel
                projectId={projectId}
                secrets={secrets}
                phase={secretsLoading ? "loading" : secretsError ? "error" : "ready"}
                refreshing={secretsRefreshing}
                prefillSecretName={prefillSecretName}
                onRefresh={() => refetchSecrets({ throwOnError: true })}
                renderGuide={(onSelect) => <SecretsGuide onSelect={onSelect} />}
                renderSecret={(secret) => (
                  <SecretRowWithAudit
                    secret={secret}
                    projectId={projectId}
                    isFlashing={flashedSecretIds.has(secret.id)}
                  />
                )}
              />
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
                  secretState={secretsLoading ? "loading" : secretsError ? "error" : "ready"}
                  wiredModuleIds={wiredModuleIds}
                  onSendMessage={onSendMessage}
                  onOpenSecrets={() => setInnerTab("secrets")}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
