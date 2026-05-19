import { useState } from "react";
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
  Lock,
  UserPlus,
  UserMinus,
} from "lucide-react";
import {
  useGetAdminMe,
  useGetAdminStats,
  useGetAdminLaunchReadiness,
  useListAdminRoles,
  useGrantAdminRole,
  useRevokeAdminRole,
  getGetAdminMeQueryKey,
  getGetAdminStatsQueryKey,
  getGetAdminLaunchReadinessQueryKey,
  getListAdminRolesQueryKey,
} from "@workspace/api-client-react";

import type {
  AdminLaunchCheck,
  AdminRole,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

function isHttpError(err: unknown): err is { status: number; data: unknown; message: string } {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

export default function AdminPage() {
  const queryClient = useQueryClient();

  const meQuery = useGetAdminMe();
  const statsQuery = useGetAdminStats();
  const readinessQuery = useGetAdminLaunchReadiness();
  const rolesQuery = useListAdminRoles();

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

  const isForbidden =
    isHttpError(meQuery.error) &&
    (meQuery.error.status === 401 || meQuery.error.status === 403);

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: getGetAdminMeQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminLaunchReadinessQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListAdminRolesQueryKey() });
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

  if (isForbidden) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16 text-center space-y-4">
        <div className="flex justify-center">
          <Lock className="h-10 w-10 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="text-muted-foreground text-sm">
          You don't have admin privileges. Contact your platform administrator to request access.
        </p>
      </div>
    );
  }

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
            <span className="font-semibold">Admin RBAC is active.</span>
            {" "}Signed in as <code className="font-mono text-xs">{me.role}</code>
            {me.grantedViaEnv && " (granted via ADMIN_USER_IDS env var)"}
            {!me.grantedViaEnv && me.grantedBy && ` (granted by ${me.grantedBy})`}.
          </div>
        </div>
      )}

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
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            Running checks…
          </div>
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
            No role grants found. Admins may be configured via the ADMIN_USER_IDS environment variable.
          </div>
        )}

        {roles.length > 0 && (
          <div className="divide-y divide-border">
            {roles.map((r: AdminRole) => (
              <div
                key={r.userId}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
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
          <AdminItem
            label="Starter credits"
            value="100 per user (auto-grant)"
            status="ok"
          />
          <AdminItem
            label="Credit enforcement"
            value="Active — enforced in builder"
            status="ok"
          />
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
      {expanded && (
        <p className="mt-1.5 ml-5 text-xs text-muted-foreground">{check.note}</p>
      )}
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

function AdminSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
