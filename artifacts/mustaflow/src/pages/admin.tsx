import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  Users,
  FolderKanban,
  Globe,
  CreditCard,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  ChevronRight,
  UserPlus,
  UserMinus,
  ScrollText,
  ChevronLeft,
  BrainCircuit,
  Activity,
  BookOpen,
  Sparkles,
} from "lucide-react";
import {
  useGetAdminMe,
  useGetAdminStats,
  useGetAdminLaunchReadiness,
  useListAdminRoles,
  useGrantAdminRole,
  useRevokeAdminRole,
  useGetAdminAuditLog,
  getGetAdminMeQueryKey,
  getGetAdminStatsQueryKey,
  getGetAdminLaunchReadinessQueryKey,
  getListAdminRolesQueryKey,
  getGetAdminAuditLogQueryKey,
} from "@workspace/api-client-react";

import type { AdminLaunchCheck, AdminRole, AdminAuditLogEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

function isHttpError(err: unknown): err is { status: number; data: unknown; message: string } {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

const AUDIT_PAGE_SIZE = 50;

export default function AdminPage() {
  const queryClient = useQueryClient();

  const meQuery = useGetAdminMe();
  const statsQuery = useGetAdminStats();
  const readinessQuery = useGetAdminLaunchReadiness();
  const rolesQuery = useListAdminRoles();

  const [auditOffset, setAuditOffset] = useState(0);
  const [auditLive, setAuditLive] = useState(true);
  const auditParams = { limit: AUDIT_PAGE_SIZE, offset: auditOffset };
  const auditQuery = useGetAdminAuditLog(auditParams, {
    query: {
      queryKey: getGetAdminAuditLogQueryKey(auditParams),
      refetchInterval: auditLive ? 10_000 : false,
    },
  });

  const grantRoleMutation = useGrantAdminRole();
  const revokeRoleMutation = useRevokeAdminRole();

  const [roleUserId, setRoleUserId] = useState("");
  const [roleValue, setRoleValue] = useState<"admin" | "owner" | "user">("admin");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleSuccess, setRoleSuccess] = useState<string | null>(null);

  const me = meQuery.data;
  const stats = statsQuery.data;
  const readiness = readinessQuery.data;
  const roles = rolesQuery.data?.roles ?? [];
  const loading = statsQuery.isPending;
  const readinessLoading = readinessQuery.isPending || readinessQuery.isFetching;
  const rolesLoading = rolesQuery.isPending || rolesQuery.isFetching;
  const auditLoading = auditQuery.isPending || auditQuery.isFetching;
  const auditPage = auditQuery.data;

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: getGetAdminMeQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminLaunchReadinessQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListAdminRolesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminAuditLogQueryKey() });
  }

  function refreshReadiness() {
    void queryClient.invalidateQueries({ queryKey: getGetAdminLaunchReadinessQueryKey() });
  }

  async function handleGrantRole() {
    if (!roleUserId.trim()) {
      setRoleError("User ID is required.");
      return;
    }
    setRoleError(null);
    setRoleSuccess(null);
    grantRoleMutation.mutate(
      { data: { userId: roleUserId.trim(), role: roleValue } },
      {
        onSuccess: () => {
          setRoleSuccess(`Role "${roleValue}" granted to ${roleUserId.trim()}`);
          setRoleUserId("");
          void queryClient.invalidateQueries({ queryKey: getListAdminRolesQueryKey() });
        },
        onError: (err) => {
          const msg = isHttpError(err)
            ? ((err.data as { error?: string })?.error ?? err.message)
            : "Failed to update role";
          setRoleError(msg);
        },
      },
    );
  }

  function handleRevokeRole(userId: string) {
    revokeRoleMutation.mutate(
      { userId },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListAdminRolesQueryKey() });
        },
      },
    );
  }

  const readinessCheck = (id: string): AdminLaunchCheck | undefined =>
    readiness?.checks.find((c) => c.id === id);

  const checkToStatus = (check?: AdminLaunchCheck): "ok" | "warn" | "error" => {
    if (!check) return "warn";
    if (check.status === "pass") return "ok";
    if (check.status === "fail") return "error";
    return "warn";
  };

  const stripeCheck = readinessCheck("stripe");
  const cfCheck = readinessCheck("cloudflare_ssl");

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Platform-level monitoring and management.
            </p>
          </div>
        </div>
        <button
          onClick={refreshAll}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {me && (
        <div className="border border-green-500/20 bg-green-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-green-600">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Admin RBAC is active.</span> Signed in as{" "}
            <code className="font-mono text-xs">{me.role}</code>
            {me.grantedViaEnv && " (granted via ADMIN_USER_IDS env var)"}
            {!me.grantedViaEnv && me.grantedBy && ` (granted by ${me.grantedBy})`}.
          </div>
        </div>
      )}

      <EvalResultsTile />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={FolderKanban}
          label="Total Projects"
          value={loading ? "…" : String(stats?.projects.total ?? 0)}
          sub="across all users"
        />
        <StatCard
          icon={Globe}
          label="Published"
          value={loading ? "…" : String(stats?.projects.published ?? 0)}
          sub="live projects"
        />
        <StatCard
          icon={Users}
          label="Users with Credits"
          value={loading ? "…" : String(stats?.users.withCredits ?? 0)}
          sub="active accounts"
        />
        <StatCard
          icon={CreditCard}
          label="Transactions"
          value={loading ? "…" : String(stats?.transactions ?? 0)}
          sub="credit transactions"
        />
      </div>

      {stats &&
        (() => {
          const arch = stats.architectReviews;
          if (!arch) return null;
          return (
            <div className="border border-border rounded-xl bg-card overflow-hidden">
              <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <BrainCircuit className="h-3.5 w-3.5 text-violet-400" />
                  Architect Review (last {arch.windowDays} days)
                </h3>
                <span className="text-xs text-muted-foreground">
                  {arch.reviewed} reviewed build{arch.reviewed === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border/40">
                <ArchitectMetric
                  label="Avg findings / build"
                  value={arch.avgFindingsPerBuild.toFixed(2)}
                  tone="neutral"
                />
                <ArchitectMetric label="Pass" value={String(arch.passCount)} tone="ok" />
                <ArchitectMetric label="Partial" value={String(arch.partialCount)} tone="warn" />
                <ArchitectMetric label="Fail" value={String(arch.failCount)} tone="error" />
                <ArchitectMetric
                  label="Auto-fixes queued"
                  value={String(arch.autoFixesQueued)}
                  tone="info"
                />
              </div>
            </div>
          );
        })()}

      {stats &&
        (() => {
          const ts = (
            stats as {
              topSkills?: {
                windowDays: number;
                totalBuildsWithSkills: number;
                skills: Array<{ name: string; count: number }>;
              };
            }
          ).topSkills;
          if (!ts || ts.skills.length === 0) return null;
          const max = ts.skills[0]?.count ?? 1;
          return (
            <div className="border border-border rounded-xl bg-card overflow-hidden">
              <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                  Top skills used (last {ts.windowDays} days)
                </h3>
                <span className="text-xs text-muted-foreground">
                  {ts.totalBuildsWithSkills} build{ts.totalBuildsWithSkills === 1 ? "" : "s"} loaded
                  skills
                </span>
              </div>
              <ul className="divide-y divide-border">
                {ts.skills.map((s, i) => {
                  const pct = max > 0 ? Math.max(4, Math.round((s.count / max) * 100)) : 0;
                  return (
                    <li key={s.name} className="px-4 py-2 flex items-center gap-3 text-sm">
                      <span className="w-6 text-xs text-muted-foreground tabular-nums">
                        {i + 1}.
                      </span>
                      <span className="flex-1 min-w-0 truncate font-mono text-xs">{s.name}</span>
                      <div className="hidden sm:block w-32 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-amber-400/70" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-12 text-right tabular-nums text-muted-foreground">
                        {s.count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()}

      <ProdErrorsTile
        loading={loading}
        last14Days={
          (stats as { prodErrors?: { last14Days?: number } } | undefined)?.prodErrors?.last14Days ??
          0
        }
        byDay={
          (stats as { prodErrors?: { byDay?: Array<{ day: string; count: number }> } } | undefined)
            ?.prodErrors?.byDay ?? []
        }
      />

      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Launch Readiness Checklist
          </h3>
          <div className="flex items-center gap-3 text-xs">
            {readiness && (
              <>
                <span className="text-green-500">{readiness.passed} pass</span>
                {readiness.partial > 0 && (
                  <span className="text-yellow-500">{readiness.partial} partial</span>
                )}
                {readiness.failed > 0 && (
                  <span className="text-destructive">{readiness.failed} fail</span>
                )}
              </>
            )}
            <button
              onClick={refreshReadiness}
              className="text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={`h-3 w-3 ${readinessLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        {readiness && (
          <div className="divide-y divide-border">
            {readiness.checks.map((c) => (
              <ReadinessRow key={c.id} check={c} />
            ))}
          </div>
        )}
        {!readiness && readinessLoading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">Running checks…</div>
        )}
        {readiness && (
          <div
            className={`px-4 py-3 border-t border-border text-xs font-semibold ${
              readiness.ready ? "text-green-500" : "text-destructive"
            }`}
          >
            {readiness.ready
              ? "All blocking checks pass — ready to launch."
              : `${readiness.blockingFailCount} blocking check(s) must be resolved before launch.`}
          </div>
        )}
      </div>

      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            Role Management
          </h3>
          {rolesLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>

        <div className="px-4 py-4 border-b border-border space-y-3">
          <p className="text-xs text-muted-foreground">
            Grant or revoke admin/owner roles for any user by their Clerk user ID.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={roleUserId}
              onChange={(e) => setRoleUserId(e.target.value)}
              placeholder="Clerk user ID (e.g. user_abc123)"
              className="flex-1 min-w-0 px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <select
              value={roleValue}
              onChange={(e) => setRoleValue(e.target.value as "admin" | "owner" | "user")}
              className="px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
              <option value="user">User (revoke)</option>
            </select>
            <button
              onClick={() => void handleGrantRole()}
              disabled={grantRoleMutation.isPending || !roleUserId.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {grantRoleMutation.isPending ? "Saving…" : "Grant Role"}
            </button>
          </div>
          {roleError && <p className="text-sm text-destructive">{roleError}</p>}
          {roleSuccess && <p className="text-sm text-green-500">{roleSuccess}</p>}
        </div>

        {roles.length === 0 && !rolesLoading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            No role grants found. Admins may be configured via the ADMIN_USER_IDS environment
            variable.
          </div>
        )}

        {roles.length > 0 && (
          <div className="divide-y divide-border">
            {roles.map((r: AdminRole) => (
              <div key={r.userId} className="flex items-center justify-between px-4 py-3 text-sm">
                <div className="min-w-0">
                  <code className="font-mono text-xs text-foreground">{r.userId}</code>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                        r.role === "owner"
                          ? "bg-purple-500/10 text-purple-500"
                          : r.role === "admin"
                            ? "bg-blue-500/10 text-blue-500"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {r.role}
                    </span>
                    {r.grantedBy && (
                      <span className="text-xs text-muted-foreground">
                        granted by {r.grantedBy}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRevokeRole(r.userId)}
                  title="Revoke role"
                  className="p-1.5 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
                >
                  <UserMinus className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <SkillsPanel />

      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <ScrollText className="h-3.5 w-3.5" />
            Secret Audit Log
            {auditPage && (
              <span className="text-muted-foreground font-normal normal-case tracking-normal">
                — {auditPage.total.toLocaleString()} total event{auditPage.total !== 1 ? "s" : ""}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setAuditLive((v) => !v)}
              className={`flex items-center gap-1 text-[10px] font-semibold uppercase px-2 py-0.5 rounded border transition-colors ${
                auditLive
                  ? "border-green-500/40 text-green-500 bg-green-500/10"
                  : "border-border text-muted-foreground bg-transparent"
              }`}
              title={
                auditLive
                  ? "Auto-refresh on (every 10s) — click to pause"
                  : "Auto-refresh off — click to enable"
              }
            >
              {auditLive ? "Live" : "Paused"}
            </button>
            {auditLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
            <button
              onClick={() =>
                void queryClient.invalidateQueries({ queryKey: getGetAdminAuditLogQueryKey() })
              }
              className="text-muted-foreground hover:text-foreground"
              title="Refresh now"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        </div>

        {!auditPage && auditLoading && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            Loading audit log…
          </div>
        )}

        {auditQuery.isError && !auditPage && (
          <div className="px-4 py-6 text-sm text-destructive text-center">
            Failed to load audit log. Check your connection or try refreshing.
          </div>
        )}

        {auditPage && auditPage.entries.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            No audit events recorded yet.
          </div>
        )}

        {auditPage && auditPage.entries.length > 0 && (
          <>
            <div className="divide-y divide-border">
              {auditPage.entries.map((entry: AdminAuditLogEntry) => (
                <AuditLogRow key={entry.id} entry={entry} />
              ))}
            </div>
            <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing {auditOffset + 1}–{Math.min(auditOffset + AUDIT_PAGE_SIZE, auditPage.total)}{" "}
                of {auditPage.total.toLocaleString()}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setAuditOffset(Math.max(0, auditOffset - AUDIT_PAGE_SIZE))}
                  disabled={auditOffset === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-2">
                  Page {Math.floor(auditOffset / AUDIT_PAGE_SIZE) + 1} of{" "}
                  {Math.max(1, Math.ceil(auditPage.total / AUDIT_PAGE_SIZE))}
                </span>
                <button
                  onClick={() => setAuditOffset(auditOffset + AUDIT_PAGE_SIZE)}
                  disabled={auditOffset + AUDIT_PAGE_SIZE >= auditPage.total}
                  className="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <AdminSection title="Security">
          <AdminItem label="Encryption" value="AES-256-GCM active" status="ok" />
          <AdminItem label="Auth provider" value="Clerk (managed)" status="ok" />
          <AdminItem
            label="Admin RBAC"
            value={me ? `Active — role: ${me.role}` : "Active"}
            status="ok"
          />
          <AdminItem label="Rate limits" value="Active (in-memory)" status="ok" />
          <AdminItem label="Secret rotation" value="Manual (script available)" status="warn" />
        </AdminSection>

        <AdminSection title="Infrastructure">
          <AdminItem label="Database" value="PostgreSQL (Replit)" status="ok" />
          <AdminItem label="AI provider" value="OpenAI via Replit proxy" status="ok" />
          <AdminItem
            label="Cloudflare SSL"
            value={
              cfCheck
                ? cfCheck.status === "pass"
                  ? "Configured — automated SSL active"
                  : "Not configured (manual cert)"
                : "Checking…"
            }
            status={checkToStatus(cfCheck)}
          />
          <AdminItem
            label="Deployments logged"
            value={loading ? "…" : `${stats?.deployments ?? 0} deployment(s)`}
            status="ok"
          />
        </AdminSection>

        <AdminSection title="Publishing">
          <AdminItem label="Public URLs" value="Slug-based (/api/p/:slug/)" status="ok" />
          <AdminItem label="Snapshot storage" value="DB (project_versions)" status="ok" />
          <AdminItem label="Deployment logs" value="Active" status="ok" />
          <AdminItem label="Audit trail" value="Secret audit log active" status="ok" />
        </AdminSection>

        <AdminSection title="Billing">
          <AdminItem label="Starter credits" value="100 per user (auto-grant)" status="ok" />
          <AdminItem label="Credit enforcement" value="Active — enforced in builder" status="ok" />
          <AdminItem
            label="Stripe payments"
            value={
              stripeCheck
                ? stripeCheck.status === "pass"
                  ? "Configured — billing active"
                  : "Setup required — see /billing"
                : "Checking…"
            }
            status={checkToStatus(stripeCheck)}
          />
          <AdminItem
            label="Transactions"
            value={loading ? "…" : `${stats?.transactions ?? 0} total`}
            status="ok"
          />
        </AdminSection>
      </div>
    </div>
  );
}

const ACTION_COLORS: Record<string, string> = {
  created: "text-green-500 bg-green-500/10",
  updated: "text-blue-500 bg-blue-500/10",
  deleted: "text-destructive bg-destructive/10",
  accessed: "text-muted-foreground bg-muted",
  verified: "text-green-500 bg-green-500/10",
  verification_failed: "text-yellow-500 bg-yellow-500/10",
};

// ─── Skills panel (per-task skills system, Task #506; drafts Task #536) ────
type SkillSummary = {
  name: string;
  description: string;
  triggers: string[];
  enabled: boolean;
  loadCount: number;
  lastLoadedAt: string | null;
  bytes: number;
  draft?: boolean;
  authoredBy?: string | null;
  authoredAt?: string | null;
  authoringContext?: string | null;
};

function SkillsPanel() {
  const [tab, setTab] = useState<"active" | "drafts">("active");
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [drafts, setDrafts] = useState<SkillSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [draftRaw, setDraftRaw] = useState<string>("");
  const [draftLoading, setDraftLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [active, pending] = await Promise.all([
        fetch("/api/admin/skills").then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ skills: SkillSummary[] }>;
        }),
        fetch("/api/admin/skills/drafts").then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ drafts: SkillSummary[] }>;
        }),
      ]);
      setSkills(active.skills);
      setDrafts(pending.drafts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openDraft(name: string) {
    setEditingDraft(name);
    setDraftRaw("");
    setDraftLoading(true);
    try {
      const res = await fetch(`/api/admin/skills/drafts/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { raw: string };
      setDraftRaw(json.raw);
    } catch (err) {
      setError((err as Error).message);
      setEditingDraft(null);
    } finally {
      setDraftLoading(false);
    }
  }

  async function saveDraft(name: string) {
    setPendingName(name);
    try {
      const res = await fetch(`/api/admin/skills/drafts/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: draftRaw }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingName(null);
    }
  }

  async function approveDraft(name: string) {
    setPendingName(name);
    try {
      const res = await fetch(`/api/admin/skills/drafts/${encodeURIComponent(name)}/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setEditingDraft(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingName(null);
    }
  }

  async function rejectDraft(name: string) {
    if (!confirm(`Delete draft "${name}" permanently?`)) return;
    setPendingName(name);
    try {
      const res = await fetch(`/api/admin/skills/drafts/${encodeURIComponent(name)}/reject`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingDraft(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingName(null);
    }
  }

  async function toggle(name: string, enabled: boolean) {
    setPendingName(name);
    try {
      const res = await fetch(`/api/admin/skills/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSkills((cur) => (cur ? cur.map((s) => (s.name === name ? { ...s, enabled } : s)) : cur));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingName(null);
    }
  }

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <BookOpen className="h-3.5 w-3.5" />
          Builder Skills
          {skills && (
            <span className="text-muted-foreground font-normal normal-case tracking-normal">
              — {skills.length} active
              {drafts && drafts.length > 0 ? `, ${drafts.length} pending` : ""}
            </span>
          )}
        </h3>
        <button
          onClick={() => void reload()}
          className="text-muted-foreground hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="px-4 pt-3 border-b border-border flex gap-1">
        <button
          onClick={() => setTab("active")}
          className={`text-xs font-medium px-3 py-1.5 rounded-t-md border-b-2 ${
            tab === "active"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Active ({skills?.length ?? "…"})
        </button>
        <button
          onClick={() => setTab("drafts")}
          className={`text-xs font-medium px-3 py-1.5 rounded-t-md border-b-2 ${
            tab === "drafts"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Pending review{" "}
          {drafts && drafts.length > 0 && (
            <span className="ml-1 bg-yellow-500/20 text-yellow-500 text-[10px] font-bold px-1.5 py-0.5 rounded">
              {drafts.length}
            </span>
          )}
        </button>
      </div>

      <div className="px-4 py-3 border-b border-border text-xs text-muted-foreground">
        {tab === "active" ? (
          <>
            Skills are markdown instruction sets the agent loop can pull on demand via{" "}
            <code className="font-mono">load_skill</code>. Disabling a skill hides it from the
            system prompt index and rejects load requests.
          </>
        ) : (
          <>
            Drafts authored by the agent via <code className="font-mono">author_skill</code>.
            Review, edit, then approve to move into{" "}
            <code className="font-mono">skills/&lt;slug&gt;/</code> and enable for all builds.
          </>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-destructive border-b border-border">{error}</div>
      )}

      {!skills && loading && (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">Loading skills…</div>
      )}

      {skills && skills.length === 0 && (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">
          No skill files found on disk. Add files under{" "}
          <code className="font-mono">skills/&lt;name&gt;/SKILL.md</code>.
        </div>
      )}

      {tab === "drafts" && drafts && drafts.length === 0 && (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">
          No drafts pending review. The agent will queue new skills here when it discovers a
          reusable pattern via <code className="font-mono">author_skill</code>.
        </div>
      )}

      {tab === "drafts" && drafts && drafts.length > 0 && (
        <div className="divide-y divide-border">
          {drafts.map((d) => {
            const isOpen = editingDraft === d.name;
            return (
              <div key={d.name} className="px-4 py-3 text-sm">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="font-mono text-xs font-semibold text-foreground">
                        {d.name}
                      </code>
                      <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500">
                        draft
                      </span>
                      {d.authoredBy && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          by {d.authoredBy}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{d.description}</p>
                    {d.authoringContext && (
                      <p className="text-xs text-muted-foreground/80 mt-1 italic">
                        rationale: {d.authoringContext}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground/80">
                      <span>{d.bytes.toLocaleString()} bytes</span>
                      {d.authoredAt && <span>{new Date(d.authoredAt).toLocaleString()}</span>}
                      {d.triggers.length > 0 && (
                        <span className="truncate">
                          triggers: {d.triggers.slice(0, 6).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col gap-1">
                    <button
                      onClick={() => (isOpen ? setEditingDraft(null) : void openDraft(d.name))}
                      className="text-xs font-medium px-3 py-1.5 rounded-md border border-border hover:bg-muted"
                    >
                      {isOpen ? "Close" : "Review"}
                    </button>
                    <button
                      onClick={() => void approveDraft(d.name)}
                      disabled={pendingName === d.name}
                      className="text-xs font-medium px-3 py-1.5 rounded-md border border-green-500/40 text-green-500 hover:bg-green-500/10 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => void rejectDraft(d.name)}
                      disabled={pendingName === d.name}
                      className="text-xs font-medium px-3 py-1.5 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 space-y-2">
                    {draftLoading ? (
                      <div className="text-xs text-muted-foreground">Loading…</div>
                    ) : (
                      <>
                        <textarea
                          value={draftRaw}
                          onChange={(e) => setDraftRaw(e.target.value)}
                          spellCheck={false}
                          rows={20}
                          className="w-full font-mono text-xs bg-muted/30 border border-border rounded p-2 resize-y"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => void saveDraft(d.name)}
                            disabled={pendingName === d.name}
                            className="text-xs font-medium px-3 py-1.5 rounded-md border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50"
                          >
                            Save changes
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "active" && skills && skills.length > 0 && (
        <div className="divide-y divide-border">
          {skills.map((s) => (
            <div key={s.name} className="px-4 py-3 text-sm flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs font-semibold text-foreground">{s.name}</code>
                  <span
                    className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                      s.enabled
                        ? "bg-green-500/10 text-green-500"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{s.description}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground/80">
                  <span>{s.bytes.toLocaleString()} bytes</span>
                  <span>
                    loaded <span className="text-foreground font-medium">{s.loadCount}</span> time
                    {s.loadCount === 1 ? "" : "s"}
                  </span>
                  {s.lastLoadedAt && <span>last {new Date(s.lastLoadedAt).toLocaleString()}</span>}
                  {s.triggers.length > 0 && (
                    <span className="truncate">triggers: {s.triggers.slice(0, 6).join(", ")}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => void toggle(s.name, !s.enabled)}
                disabled={pendingName === s.name}
                className={`shrink-0 text-xs font-medium px-3 py-1.5 rounded-md border transition-colors disabled:opacity-50 ${
                  s.enabled
                    ? "border-border text-foreground hover:bg-muted"
                    : "border-primary/40 text-primary hover:bg-primary/10"
                }`}
              >
                {pendingName === s.name ? "…" : s.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditLogRow({ entry }: { entry: AdminAuditLogEntry }) {
  const colorClass = ACTION_COLORS[entry.action] ?? "text-muted-foreground bg-muted";
  const date = new Date(entry.createdAt);
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/30 transition-colors">
      <span
        className={`shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${colorClass}`}
      >
        {entry.action.replace(/_/g, " ")}
      </span>
      <div className="min-w-0 flex-1">
        <span className="font-mono text-xs text-foreground truncate">{entry.secretName}</span>
        <span className="text-muted-foreground text-xs ml-2">
          project <span className="font-mono">{entry.projectId}</span>
        </span>
      </div>
      <div className="shrink-0 text-right">
        <code className="text-[10px] text-muted-foreground block font-mono truncate max-w-[140px]">
          {entry.actorId}
        </code>
        <span className="text-[10px] text-muted-foreground/70">
          {dateStr} {timeStr}
        </span>
      </div>
    </div>
  );
}

function ProdErrorsTile({
  loading,
  last14Days,
  byDay,
}: {
  loading: boolean;
  last14Days: number;
  byDay: Array<{ day: string; count: number }>;
}) {
  const max = byDay.reduce((m, d) => Math.max(m, d.count ?? 0), 1);
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Activity className="h-3.5 w-3.5" />
          Production Errors (last 14 days)
        </h3>
        <span
          className={`text-xs font-semibold ${
            last14Days > 0 ? "text-destructive" : "text-green-500"
          }`}
        >
          {loading ? "…" : `${last14Days.toLocaleString()} total`}
        </span>
      </div>
      <div className="px-4 py-4">
        {byDay.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No production errors recorded in the last 14 days.
          </p>
        ) : (
          <div className="flex items-end gap-1 h-24">
            {byDay.map((d) => {
              const pct = Math.max(2, Math.round((d.count / max) * 100));
              return (
                <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-full flex-1 flex items-end">
                    <div
                      className={`w-full rounded-sm ${
                        d.count > 0 ? "bg-destructive/70" : "bg-muted"
                      }`}
                      style={{ height: `${pct}%` }}
                      title={`${d.day}: ${d.count} error${d.count !== 1 ? "s" : ""}`}
                    />
                  </div>
                  <span className="text-[9px] text-muted-foreground font-mono">
                    {d.day.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ReadinessRow({ check }: { check: AdminLaunchCheck }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="px-4 py-2.5 text-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full gap-2"
      >
        <div className="flex items-center gap-2">
          {check.status === "pass" ? (
            <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
          ) : check.status === "fail" ? (
            <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
          )}
          <span className={check.status === "fail" ? "text-destructive" : ""}>{check.label}</span>
          {check.blocking && check.status === "fail" && (
            <span className="text-[9px] font-bold uppercase text-destructive border border-destructive/40 rounded px-1">
              blocking
            </span>
          )}
        </div>
        <ChevronRight
          className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {expanded && <p className="mt-1.5 ml-5 text-xs text-muted-foreground">{check.note}</p>}
    </div>
  );
}

function ArchitectMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "error" | "info" | "neutral";
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-500"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "error"
          ? "text-destructive"
          : tone === "info"
            ? "text-violet-400"
            : "text-foreground";
  return (
    <div className="bg-card px-4 py-3">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
        {label}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="border border-border rounded-xl p-4 bg-card space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function AdminSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-2.5 bg-muted/40 border-b border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

type EvalSummary = {
  ran?: boolean;
  startedAt?: string;
  finishedAt?: string;
  model?: string;
  totalFixtures?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  perStage?: Record<string, { passed: number; failed: number; avgScore: number }>;
  comparison?: {
    winners: string[];
    losers: string[];
    ties: string[];
    totalDeltaScore: number;
    regressionRatio: number;
  };
};

function EvalResultsTile() {
  const [data, setData] = useState<EvalSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/admin/eval-results");
        if (r.ok) setData((await r.json()) as EvalSummary);
      } catch {
        /* ignore */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);
  if (!loaded) return null;
  const ran = data?.ran === true;
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-cyan-400" />
          Prompt Eval (Task #545)
        </h3>
        {ran && data?.finishedAt && (
          <span className="text-xs text-muted-foreground">
            {new Date(data.finishedAt).toLocaleString()} · {data.model ?? "—"}
          </span>
        )}
      </div>
      {!ran ? (
        <div className="p-4 text-sm text-muted-foreground">
          No eval results yet. Run{" "}
          <code className="text-xs bg-muted/60 px-1.5 py-0.5 rounded">
            pnpm --filter @workspace/scripts run eval-prompts
          </code>{" "}
          to generate them.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border/40">
            <ArchitectMetric
              label="Pass"
              value={`${data?.passed ?? 0}/${data?.totalFixtures ?? 0}`}
              tone="ok"
            />
            <ArchitectMetric label="Fail" value={String(data?.failed ?? 0)} tone="warn" />
            <ArchitectMetric label="Errored" value={String(data?.errored ?? 0)} tone="error" />
            <ArchitectMetric
              label="Δ Score"
              value={
                data?.comparison
                  ? (data.comparison.totalDeltaScore >= 0 ? "+" : "") +
                    String(data.comparison.totalDeltaScore)
                  : "—"
              }
              tone={
                data?.comparison && data.comparison.totalDeltaScore < 0 ? "warn" : "neutral"
              }
            />
          </div>
          {data?.perStage && (
            <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border/40">
              {(
                Object.keys(data.perStage) as Array<keyof typeof data.perStage>
              ).map((stage) => {
                const ps = data.perStage![stage as string]!;
                return (
                  <div key={stage as string} className="bg-card px-3 py-2 text-xs">
                    <div className="text-muted-foreground uppercase tracking-wider">
                      {stage as string}
                    </div>
                    <div className="font-medium mt-0.5">
                      {ps.passed}/{ps.passed + ps.failed} · avg {ps.avgScore.toFixed(1)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {data?.comparison && (
            <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
              {data.comparison.winners.length} win · {data.comparison.ties.length} tie ·{" "}
              {data.comparison.losers.length} lose vs baseline
              {data.comparison.regressionRatio > 0.1 && (
                <span className="ml-2 text-destructive font-semibold">
                  REGRESSION ({(data.comparison.regressionRatio * 100).toFixed(0)}%)
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AdminItem({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: "ok" | "warn" | "error";
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={
            status === "ok"
              ? "text-green-500 text-[10px] font-semibold"
              : status === "warn"
                ? "text-yellow-500 text-[10px] font-semibold"
                : "text-destructive text-[10px] font-semibold"
          }
        >
          {status === "ok" ? "OK" : status === "warn" ? "WARN" : "ERROR"}
        </span>
        <span className="text-xs">{value}</span>
      </div>
    </div>
  );
}
