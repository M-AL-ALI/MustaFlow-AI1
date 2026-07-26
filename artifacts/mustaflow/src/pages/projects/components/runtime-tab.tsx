import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { LiveServerRequired } from "./live-server-required";
import {
  Server,
  Database,
  HardDrive,
  Clock,
  Play,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Cpu,
  Layers,
  GitBranch,
  Zap,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ManagedAddon {
  id: number;
  kind: "redis_kv" | "vector_db" | "object_storage";
  status: "provisioning" | "active" | "error" | "deprovisioning" | "removed";
  externalId: string | null;
  connectionInfo: Record<string, string> | null;
  injectedEnvKeys: string[];
  plan: string;
  usageBytes: number | null;
  usageOps: number | null;
  createdAt: string;
}

interface ProjectEnvironment {
  id: number;
  name: string;
  status: string;
  snapshotVersionId: number | null;
  url: string | null;
  protected: boolean;
  autoPromote: boolean;
  deployedBy: string | null;
  deployedAt: string | null;
}

interface EnvironmentPromotion {
  id: number;
  fromEnvironment: string;
  toEnvironment: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

interface Schedule {
  id: number;
  kind: string;
  cronExpr: string;
  enabled: boolean;
  note: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  nextRunAt: string | null;
}

interface JobRun {
  id: number;
  scheduleId: number;
  status: string;
  exitCode: number | null;
  output: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
}

// ─── Addon metadata ────────────────────────────────────────────────────────────

const ADDON_META: Record<
  string,
  {
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    envVars: string[];
  }
> = {
  redis_kv: {
    label: "Redis / KV",
    description: "In-memory key-value store. REDIS_URL injected as a project secret.",
    icon: Zap,
    envVars: ["REDIS_URL", "REDIS_TOKEN"],
  },
  vector_db: {
    label: "Vector DB",
    description:
      "pgvector extension for AI embeddings and similarity search. VECTOR_DB_URL injected.",
    icon: Database,
    envVars: ["VECTOR_DB_URL"],
  },
  object_storage: {
    label: "Object Storage",
    description: "S3-compatible bucket (R2) per project. OBJECT_STORAGE_* env vars injected.",
    icon: HardDrive,
    envVars: ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ENDPOINT"],
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    active: { label: "Active", className: "bg-green-500/20 text-green-400 border-green-500/30" },
    provisioning: {
      label: "Provisioning",
      className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    },
    deprovisioning: {
      label: "Removing",
      className: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    },
    error: { label: "Error", className: "bg-red-500/20 text-red-400 border-red-500/30" },
    removed: { label: "Removed", className: "bg-muted text-muted-foreground border-border" },
    deployed: {
      label: "Deployed",
      className: "bg-green-500/20 text-green-400 border-green-500/30",
    },
    deploying: { label: "Deploying", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    idle: { label: "Idle", className: "bg-muted text-muted-foreground border-border" },
    failed: { label: "Failed", className: "bg-red-500/20 text-red-400 border-red-500/30" },
    success: { label: "Success", className: "bg-green-500/20 text-green-400 border-green-500/30" },
    running: { label: "Running", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
    in_progress: {
      label: "In Progress",
      className: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    },
    succeeded: {
      label: "Succeeded",
      className: "bg-green-500/20 text-green-400 border-green-500/30",
    },
  };
  const s = map[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${s.className}`}
    >
      {s.label}
    </span>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtMs(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const ENV_ORDER: Record<string, number> = { development: 0, staging: 1, production: 2 };
const ENV_COLORS: Record<string, string> = {
  development: "text-blue-400",
  staging: "text-yellow-400",
  production: "text-green-400",
};
const ENV_NEXT: Record<string, string> = {
  development: "staging",
  staging: "production",
};

// ─── RuntimeTab ───────────────────────────────────────────────────────────────

export function RuntimeTab({
  projectId,
  containerLayerConfigured,
}: {
  projectId: number;
  containerLayerConfigured: boolean;
}) {
  const [activeSection, setActiveSection] = useState<"addons" | "jobs" | "environments">("addons");

  if (!containerLayerConfigured) return <LiveServerRequired />;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Section selector */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-border shrink-0">
        {(["addons", "jobs", "environments"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setActiveSection(s)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              activeSection === s
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {s === "addons" && "Managed Add-ons"}
            {s === "jobs" && "Scheduled Jobs"}
            {s === "environments" && "Environments"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeSection === "addons" && <AddonsSection projectId={projectId} />}
        {activeSection === "jobs" && <JobsSection projectId={projectId} />}
        {activeSection === "environments" && <EnvironmentsSection projectId={projectId} />}
      </div>
    </div>
  );
}

// ─── Managed Add-ons section ───────────────────────────────────────────────────

function AddonsSection({ projectId }: { projectId: number }) {
  const [addons, setAddons] = useState<ManagedAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await authFetch(`/api/projects/${projectId}/addons`);
      if (r.ok) setAddons((await r.json()).addons ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const provision = async (kind: ManagedAddon["kind"]) => {
    setProvisioning(kind);
    setError(null);
    try {
      const r = await authFetch(`/api/projects/${projectId}/addons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Failed to provision add-on");
      } else {
        await load();
      }
    } finally {
      setProvisioning(null);
    }
  };

  const deprovision = async (addonId: number) => {
    if (!confirm("Remove this add-on? Injected env vars will also be deleted.")) return;
    await authFetch(`/api/projects/${projectId}/addons/${addonId}`, { method: "DELETE" });
    await load();
  };

  const activeAddons = addons.filter((a) => a.status !== "removed");
  const activeKinds = new Set(activeAddons.map((a) => a.kind));

  return (
    <div className="p-4 space-y-4">
      {/* Active add-ons */}
      {activeAddons.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Active
          </div>
          {activeAddons.map((addon) => {
            const meta = ADDON_META[addon.kind];
            const Icon = meta?.icon ?? Server;
            const isExpanded = expanded === addon.id;
            return (
              <div key={addon.id} className="border border-border rounded-lg overflow-hidden">
                <div
                  className="flex items-center gap-3 p-3 cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => setExpanded(isExpanded ? null : addon.id)}
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-md bg-accent">
                    <Icon className="h-4 w-4 text-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {meta?.label ?? addon.kind}
                      </span>
                      <StatusBadge status={addon.status} />
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {addon.injectedEnvKeys.length > 0
                        ? `Injects: ${addon.injectedEnvKeys.join(", ")}`
                        : "No env vars injected"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        deprovision(addon.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </div>
                </div>
                {isExpanded && addon.connectionInfo && (
                  <div className="border-t border-border bg-muted/30 p-3 text-xs space-y-1">
                    {Object.entries(addon.connectionInfo).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-muted-foreground w-28 shrink-0">{k}</span>
                        <span className="text-foreground font-mono break-all">{v}</span>
                      </div>
                    ))}
                    <div className="pt-1 text-muted-foreground">
                      Provisioned {fmtDate(addon.createdAt)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Available add-ons */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {activeAddons.length === 0 ? "Available Add-ons" : "Add More"}
        </div>
        {(Object.entries(ADDON_META) as [ManagedAddon["kind"], (typeof ADDON_META)[string]][]).map(
          ([kind, meta]) => {
            const Icon = meta.icon;
            const alreadyActive = activeKinds.has(kind);
            const isProvisioning = provisioning === kind;
            return (
              <div
                key={kind}
                className={`border border-border rounded-lg p-3 flex items-start gap-3 ${
                  alreadyActive ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-md bg-accent shrink-0 mt-0.5">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">{meta.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {meta.description}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {meta.envVars.map((v) => (
                      <code
                        key={v}
                        className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 h-7 text-xs"
                  disabled={alreadyActive || isProvisioning || loading}
                  onClick={() => provision(kind)}
                >
                  {isProvisioning ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : alreadyActive ? (
                    "Active"
                  ) : (
                    <>
                      <Plus className="h-3 w-3 mr-1" />
                      Add
                    </>
                  )}
                </Button>
              </div>
            );
          },
        )}
      </div>

      {loading && activeAddons.length === 0 && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading add-ons…
        </div>
      )}
    </div>
  );
}

// ─── Scheduled Jobs section ────────────────────────────────────────────────────

function JobsSection({ projectId }: { projectId: number }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<Record<number, JobRun[]>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newCron, setNewCron] = useState("0 * * * *");
  const [newNote, setNewNote] = useState("");

  const _load = useCallback(async () => {
    try {
      const r = await authFetch(
        `/api/projects/${projectId}/deployment-config/schedules`.replace("/deployment-config", ""),
      );
      if (r.ok) setSchedules((await r.json()).schedules ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Use the existing /api/projects/:id/schedules endpoint
  const loadSchedules = useCallback(async () => {
    try {
      const r = await authFetch(`/api/projects/${projectId}/schedules`);
      if (r.ok) setSchedules((await r.json()).schedules ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const loadRuns = async (scheduleId: number) => {
    try {
      const r = await authFetch(`/api/projects/${projectId}/schedules/${scheduleId}/runs`);
      if (r.ok) {
        const data = await r.json();
        setRuns((prev) => ({ ...prev, [scheduleId]: data.runs ?? [] }));
      }
    } catch {
      // ignore
    }
  };

  const toggleExpand = async (scheduleId: number) => {
    if (expanded === scheduleId) {
      setExpanded(null);
    } else {
      setExpanded(scheduleId);
      await loadRuns(scheduleId);
    }
  };

  const triggerRun = async (scheduleId: number) => {
    setTriggering(scheduleId);
    try {
      await authFetch(`/api/projects/${projectId}/schedules/${scheduleId}/trigger`, {
        method: "POST",
      });
      setTimeout(() => loadRuns(scheduleId), 2000);
    } finally {
      setTriggering(null);
    }
  };

  const toggleEnabled = async (schedule: Schedule) => {
    await authFetch(`/api/projects/${projectId}/schedules/${schedule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !schedule.enabled }),
    });
    await loadSchedules();
  };

  const deleteSchedule = async (id: number) => {
    if (!confirm("Delete this schedule?")) return;
    await authFetch(`/api/projects/${projectId}/schedules/${id}`, { method: "DELETE" });
    await loadSchedules();
  };

  const createSchedule = async () => {
    setCreating(false);
    await authFetch(`/api/projects/${projectId}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cronExpr: newCron,
        note: newNote || null,
        kind: "task_run",
        enabled: true,
      }),
    });
    setNewCron("0 * * * *");
    setNewNote("");
    await loadSchedules();
  };

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Scheduled jobs run commands in your container on a cron schedule. Enable the container
          first.
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs shrink-0"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3 w-3 mr-1" />
          New Job
        </Button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="border border-border rounded-lg p-3 space-y-2 bg-accent/30">
          <div className="text-xs font-medium text-foreground">New Scheduled Job</div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Cron expression</label>
            <input
              className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 text-foreground font-mono"
              value={newCron}
              onChange={(e) => setNewCron(e.target.value)}
              placeholder="0 * * * *"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Command / note (optional)</label>
            <input
              className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 text-foreground"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="$ npm run sync"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" className="h-7 text-xs" onClick={createSchedule}>
              Create
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Schedule list */}
      {loading && schedules.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-6 text-center">
          <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <div className="text-sm text-foreground font-medium mb-1">No scheduled jobs</div>
          <div className="text-xs text-muted-foreground">
            Create a job to run commands on a recurring schedule inside your container.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((schedule) => (
            <div key={schedule.id} className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 p-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-md bg-accent shrink-0">
                  <Clock className="h-4 w-4 text-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">
                      {schedule.cronExpr}
                    </code>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                        schedule.enabled
                          ? "bg-green-500/20 text-green-400 border-green-500/30"
                          : "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {schedule.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {schedule.lastRunStatus && <StatusBadge status={schedule.lastRunStatus} />}
                  </div>
                  {schedule.note && (
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {schedule.note}
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Next: {fmtDate(schedule.nextRunAt)} · Last: {fmtDate(schedule.lastRunAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    disabled={triggering === schedule.id}
                    onClick={() => triggerRun(schedule.id)}
                    title="Trigger now"
                  >
                    {triggering === schedule.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground"
                    onClick={() => toggleEnabled(schedule)}
                    title={schedule.enabled ? "Disable" : "Enable"}
                  >
                    {schedule.enabled ? (
                      <X className="h-3.5 w-3.5" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteSchedule(schedule.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground"
                    onClick={() => toggleExpand(schedule.id)}
                  >
                    {expanded === schedule.id ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {/* Run history */}
              {expanded === schedule.id && (
                <div className="border-t border-border bg-muted/30">
                  <div className="px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                    Run History
                  </div>
                  {(runs[schedule.id] ?? []).length === 0 ? (
                    <div className="px-3 pb-3 text-xs text-muted-foreground">No runs yet</div>
                  ) : (
                    <div className="divide-y divide-border">
                      {(runs[schedule.id] ?? []).slice(0, 10).map((run) => (
                        <div key={run.id} className="px-3 py-2 text-xs flex items-start gap-2">
                          <StatusBadge status={run.status} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span>{fmtDate(run.startedAt)}</span>
                              <span>·</span>
                              <span>{fmtMs(run.durationMs)}</span>
                              <span>·</span>
                              <span className="capitalize">{run.triggeredBy}</span>
                            </div>
                            {run.output && (
                              <pre className="mt-1 text-[10px] bg-background rounded p-1.5 overflow-x-auto text-muted-foreground max-h-20 whitespace-pre-wrap break-all">
                                {run.output.slice(0, 400)}
                              </pre>
                            )}
                            {run.errorMessage && (
                              <div className="mt-1 text-red-400 text-[10px]">
                                {run.errorMessage}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Deployment kind info */}
      <div className="border border-border rounded-lg p-3 bg-accent/20">
        <div className="text-xs font-medium text-foreground mb-1 flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5" />
          Deployment Kind
        </div>
        <div className="text-xs text-muted-foreground mb-2">
          Choose how your container runs. Configure in the Publishing tab under Deployment Config.
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          {[
            {
              kind: "static",
              label: "Static CDN",
              desc: "Snapshot served from edge. No container.",
            },
            {
              kind: "autoscale",
              label: "Autoscale",
              desc: "Container scales to zero when idle. Fastest iteration.",
            },
            {
              kind: "reserved_vm",
              label: "Reserved VM",
              desc: "Always-on container. No cold starts. Best for background workers.",
            },
          ].map((d) => (
            <div key={d.kind} className="flex items-start gap-2">
              <Server className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <span className="text-xs font-medium text-foreground">{d.label}</span>
                <span className="text-xs text-muted-foreground ml-1.5">{d.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Environments section ──────────────────────────────────────────────────────

function EnvironmentsSection({ projectId }: { projectId: number }) {
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [promotions, setPromotions] = useState<EnvironmentPromotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [promoting, setPromoting] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newEnvName, setNewEnvName] = useState<"development" | "staging" | "production">(
    "development",
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await authFetch(`/api/projects/${projectId}/environments`);
      if (r.ok) {
        const data = await r.json();
        setEnvironments(
          (data.environments ?? []).sort(
            (a: ProjectEnvironment, b: ProjectEnvironment) =>
              (ENV_ORDER[a.name] ?? 99) - (ENV_ORDER[b.name] ?? 99),
          ),
        );
        setPromotions(data.promotions ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const createEnv = async () => {
    setError(null);
    const r = await authFetch(`/api/projects/${projectId}/environments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newEnvName }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "Failed to create environment");
    } else {
      setCreating(false);
      await load();
    }
  };

  const promote = async (envId: number, envName: string) => {
    const next = ENV_NEXT[envName];
    if (!next) return;
    if (!confirm(`Promote '${envName}' to '${next}'?`)) return;
    setPromoting(envId);
    try {
      await authFetch(`/api/projects/${projectId}/environments/${envId}/promote`, {
        method: "POST",
      });
      setTimeout(load, 1500);
    } finally {
      setPromoting(null);
    }
  };

  const deleteEnv = async (envId: number, name: string) => {
    if (!confirm(`Delete '${name}' environment?`)) return;
    const r = await authFetch(`/api/projects/${projectId}/environments/${envId}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const d = await r.json();
      setError(d.error ?? "Failed to delete");
    } else {
      await load();
    }
  };

  const existingNames = new Set(environments.map((e) => e.name));
  const availableToCreate = (["development", "staging", "production"] as const).filter(
    (n) => !existingNames.has(n),
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Isolate secrets and snapshots per environment. Promote changes from dev → staging →
          production.
        </div>
        {availableToCreate.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs shrink-0"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Env
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
          <button className="ml-auto" onClick={() => setError(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="border border-border rounded-lg p-3 space-y-2 bg-accent/30">
          <div className="text-xs font-medium text-foreground">New Environment</div>
          <select
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 text-foreground"
            value={newEnvName}
            onChange={(e) =>
              setNewEnvName(e.target.value as "development" | "staging" | "production")
            }
          >
            {availableToCreate.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <div className="flex gap-2 pt-1">
            <Button size="sm" className="h-7 text-xs" onClick={createEnv}>
              Create
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Environment list */}
      {loading && environments.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading environments…
        </div>
      ) : environments.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-6 text-center">
          <GitBranch className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <div className="text-sm text-foreground font-medium mb-1">No environments configured</div>
          <div className="text-xs text-muted-foreground">
            Create development, staging, and production environments to isolate deployments.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Pipeline visualization */}
          {environments.length > 1 && (
            <div className="flex items-center gap-1 px-1 py-2 overflow-x-auto">
              {environments.map((env, i) => (
                <div key={env.id} className="flex items-center gap-1 shrink-0">
                  <div
                    className={`text-xs font-medium px-2 py-1 rounded border ${
                      env.status === "deployed"
                        ? "border-green-500/40 bg-green-500/10"
                        : env.status === "deploying"
                          ? "border-blue-500/40 bg-blue-500/10"
                          : "border-border bg-muted"
                    }`}
                  >
                    <span className={ENV_COLORS[env.name] ?? "text-foreground"}>{env.name}</span>
                  </div>
                  {i < environments.length - 1 && (
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>
              ))}
            </div>
          )}

          {environments.map((env) => {
            const hasNext = !!ENV_NEXT[env.name];
            const nextEnvExists = existingNames.has(ENV_NEXT[env.name] ?? "");
            return (
              <div key={env.id} className="border border-border rounded-lg p-3">
                <div className="flex items-start gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-md bg-accent shrink-0 mt-0.5">
                    <Layers className="h-4 w-4 text-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-sm font-medium capitalize ${ENV_COLORS[env.name] ?? "text-foreground"}`}
                      >
                        {env.name}
                      </span>
                      <StatusBadge status={env.status} />
                      {env.protected && (
                        <span className="text-[10px] bg-orange-500/20 text-orange-400 border border-orange-500/30 px-1.5 py-0.5 rounded font-medium">
                          Protected
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {env.snapshotVersionId
                        ? `Snapshot #${env.snapshotVersionId}`
                        : "No snapshot deployed"}
                      {env.deployedAt ? ` · Deployed ${fmtDate(env.deployedAt)}` : ""}
                    </div>
                    {env.url && (
                      <a
                        href={env.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:underline mt-0.5 block truncate"
                      >
                        {env.url}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {hasNext && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={promoting === env.id || env.status === "deploying"}
                        onClick={() => promote(env.id, env.name)}
                        title={`Promote to ${ENV_NEXT[env.name]}`}
                      >
                        {promoting === env.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <ArrowRight className="h-3 w-3 mr-1" />
                            {nextEnvExists ? "Promote" : `Create ${ENV_NEXT[env.name]}`}
                          </>
                        )}
                      </Button>
                    )}
                    {!env.protected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteEnv(env.id, env.name)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent promotions */}
      {promotions.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Recent Promotions
          </div>
          <div className="space-y-1">
            {promotions.slice(0, 5).map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge status={p.status} />
                <span className={ENV_COLORS[p.fromEnvironment] ?? ""}>{p.fromEnvironment}</span>
                <ArrowRight className="h-3 w-3" />
                <span className={ENV_COLORS[p.toEnvironment] ?? ""}>{p.toEnvironment}</span>
                <span className="ml-auto">{fmtDate(p.startedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info card */}
      <div className="border border-border rounded-lg p-3 bg-accent/20 text-xs text-muted-foreground space-y-1">
        <div className="font-medium text-foreground flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" />
          Environment isolation
        </div>
        <div>
          Each environment can have its own project secrets. Add secrets scoped to an environment in
          the Secrets tab (coming soon).
        </div>
        <div>
          Promotion copies the current environment snapshot to the next tier. Production promotions
          update the public publish URL.
        </div>
      </div>
    </div>
  );
}
