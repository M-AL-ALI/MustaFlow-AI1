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
  Inbox,
  Bug,
  Layers,
  LifeBuoy,
  Wrench,
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
  listAdminSkills,
  listAdminSkillDrafts,
  getAdminSkillDraft,
  updateAdminSkillDraft,
  approveAdminSkillDraft,
  rejectAdminSkillDraft,
  toggleAdminSkill,
  getAdminEvalResults,
  listAdminRecentUnreadInbox,
  getAdminJobQueue,
  useListAdminSupportTickets,
  getListAdminSupportTicketsQueryKey,
} from "@workspace/api-client-react";

import type {
  AdminLaunchCheck,
  AdminRole,
  AdminAuditLogEntry,
  AdminInboxRecentUnread,
  AdminJobQueue,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { OraRoutingDiagnosticsPanel } from "@/components/admin/ora-routing-diagnostics-panel";
import { AdminBreadcrumbs } from "@/components/admin/admin-breadcrumbs";
import { AdminAccountAccessPanel } from "@/components/admin/account-access-panel";

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
  const me = meQuery.data;
  const isOwner = me?.role === "owner";
  const canOperate = me?.role === "owner" || me?.role === "operator";
  const canViewAnalytics = canOperate || me?.role === "analyst";
  const canViewSupport = canOperate || me?.role === "support";
  const statsQuery = useGetAdminStats({
    query: { queryKey: getGetAdminStatsQueryKey(), enabled: canViewAnalytics },
  });
  const readinessQuery = useGetAdminLaunchReadiness({
    query: { queryKey: getGetAdminLaunchReadinessQueryKey(), enabled: canViewAnalytics },
  });
  const rolesQuery = useListAdminRoles({
    query: { queryKey: getListAdminRolesQueryKey(), enabled: isOwner },
  });

  const [auditOffset, setAuditOffset] = useState(0);
  const [auditLive, setAuditLive] = useState(true);
  const auditParams = { limit: AUDIT_PAGE_SIZE, offset: auditOffset };
  const auditQuery = useGetAdminAuditLog(auditParams, {
    query: {
      queryKey: getGetAdminAuditLogQueryKey(auditParams),
      enabled: canOperate,
      refetchInterval: canOperate && auditLive ? 10_000 : false,
    },
  });

  const grantRoleMutation = useGrantAdminRole();
  const revokeRoleMutation = useRevokeAdminRole();

  const [roleUserId, setRoleUserId] = useState("");
  const [roleValue, setRoleValue] = useState<"owner" | "operator" | "support" | "analyst">(
    "operator",
  );
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleSuccess, setRoleSuccess] = useState<string | null>(null);

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
  const statValue = (value: number | undefined): string =>
    statsQuery.isError ? "Unavailable" : loading ? "…" : String(value ?? 0);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <AdminBreadcrumbs
        items={[{ label: "Projects", href: "/projects" }, { label: "Admin Page" }]}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Admin Page</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Operational health, support, access controls, accounts, publishing, and audit receipts
              in one place.
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

      {canViewAnalytics && (
        <div
          data-admin-priority="blocking"
          className={`border rounded-xl bg-card overflow-hidden ${
            readinessQuery.isError || (readiness && !readiness.ready)
              ? "border-destructive/60"
              : readiness?.ready
                ? "border-green-500/40"
                : "border-border"
          }`}
        >
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
                  {readiness.blockingFailCount > 0 && (
                    <span className="text-destructive">
                      {readiness.blockingFailCount} blocking fail
                    </span>
                  )}
                  {readiness.failed - readiness.blockingFailCount > 0 && (
                    <span className="text-yellow-500">
                      {readiness.failed - readiness.blockingFailCount} non-blocking fail
                    </span>
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
          <PanelDeclaration
            purpose="Shows every launch-readiness check and identifies which failures block launch."
            action="Open a failing check, resolve it, then refresh before launching."
            freshness="Fetched on page load and whenever an operator refreshes it."
          />
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
          {readinessQuery.isError && (
            <div className="px-4 py-4 border-t border-destructive/30 bg-destructive/5 text-sm text-destructive">
              Launch readiness could not be loaded. Treat launch status as unknown until the check
              succeeds.
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
      )}

      {canViewAnalytics && (
        <div data-admin-priority="operational">
          <ProdErrorsTile
            loading={loading}
            failed={statsQuery.isError}
            last14Days={
              (stats as { prodErrors?: { last14Days?: number } } | undefined)?.prodErrors
                ?.last14Days ?? 0
            }
            byDay={
              (
                stats as
                  | { prodErrors?: { byDay?: Array<{ day: string; count: number }> } }
                  | undefined
              )?.prodErrors?.byDay ?? []
            }
          />
        </div>
      )}

      {canViewAnalytics && (
        <div data-admin-priority="operational">
          <JobQueueTile />
        </div>
      )}

      {me && (
        <div className="border border-green-500/20 bg-green-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-green-600">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Admin Page access is active.</span> Signed in as{" "}
            <code className="font-mono text-xs">{me.role}</code>
            {me.grantedBy && ` (granted by ${me.grantedBy})`}. Authority is read from the Admin Page
            role ledger.
          </div>
        </div>
      )}

      {canOperate && <InboxRecentUnreadTile />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {canViewSupport && <SupportTicketsTile />}
        {canViewAnalytics && (
          <>
            <StatCard
              icon={FolderKanban}
              label="Total Projects"
              value={statValue(stats?.projects.total)}
              sub="across all users"
              href="/admin/records/projects"
              purpose="Shows the total project estate visible to operators."
              action="Open the filterable project records and inspect a project in context."
              freshness="Fetched with the current Admin statistics response."
            />
            <StatCard
              icon={Globe}
              label="Published"
              value={statValue(stats?.projects.published)}
              sub="live projects"
              href="/admin/records/published-projects"
              purpose="Shows how many projects currently have a published release."
              action="Open published records to see the serving version and route."
              freshness="Fetched with the current Admin statistics response."
            />
            <StatCard
              icon={Users}
              label="Users with Credits"
              value={statValue(stats?.users.withCredits)}
              sub="active accounts"
              href="/admin/records/credit-accounts"
              purpose="Shows how many accounts currently hold usable credits."
              action="Open the masked account view and inspect balance activity."
              freshness="Fetched with the current Admin statistics response."
            />
            <StatCard
              icon={CreditCard}
              label="Transactions"
              value={statValue(stats?.transactions)}
              sub="credit transactions"
              href="/admin/records/transactions"
              purpose="Shows the total number of recorded credit transactions."
              action="Open the transaction ledger and inspect each receipt-bearing record."
              freshness="Fetched with the current Admin statistics response."
            />
          </>
        )}
      </div>

      {isOwner && (
        <div className="border border-border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Users className="h-3.5 w-3.5" />
              Staff allowlist
            </h3>
            {rolesLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>

          <PanelDeclaration
            purpose="Controls which trusted staff accounts can enter the operator console."
            action="Add, change, or revoke a staff role; the final Owner cannot be removed."
            freshness="Loaded from the current access records and refreshed after every change."
          />

          <div className="px-4 py-4 border-b border-border space-y-3">
            <p className="text-xs text-muted-foreground">
              Only an Owner can add staff, change a role, or remove access. The last Owner is
              protected.
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
                onChange={(e) =>
                  setRoleValue(e.target.value as "owner" | "operator" | "support" | "analyst")
                }
                className="px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="owner">Owner</option>
                <option value="operator">Operator</option>
                <option value="support">Support</option>
                <option value="analyst">Analyst</option>
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
              No database staff grants found. Bootstrap Owners may be configured in the hidden
              environment allowlist.
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
                            : r.role === "operator"
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

          <div className="border-t border-border px-4 py-3 bg-muted/20">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Allowlist change history
            </h4>
            {(rolesQuery.data?.history ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground mt-2">
                No allowlist changes recorded yet.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {(rolesQuery.data?.history ?? []).map((entry) => (
                  <div key={entry.id} className="text-xs text-muted-foreground">
                    <code>{entry.actorUserId}</code> {entry.action.replaceAll("_", " ")} for{" "}
                    <code>{entry.targetUserId ?? "unknown user"}</code>:{" "}
                    {entry.previousRole ?? "none"}
                    {" → "}
                    {entry.nextRole ?? "none"} · {new Date(entry.createdAt).toLocaleString()}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isOwner && me && <AdminAccountAccessPanel actorUserId={me.userId} />}

      {canOperate && (
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

          <PanelDeclaration
            purpose="Provides the immutable receipt trail for sensitive administrative actions."
            action="Review events, pause live updates when investigating, or refresh on demand."
            freshness="Refreshes every 10 seconds while Live is enabled."
          />

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
                  Showing {auditOffset + 1}–
                  {Math.min(auditOffset + AUDIT_PAGE_SIZE, auditPage.total)} of{" "}
                  {auditPage.total.toLocaleString()}
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
      )}

      {canViewAnalytics && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <AdminSection
            title="Security"
            purpose="Summarizes the safeguards that protect accounts and stored credentials."
            action="Investigate any warning before changing production access or secrets."
            freshness="Derived from the current Admin and launch-readiness responses."
          >
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

          <AdminSection
            title="Infrastructure"
            purpose="Shows whether the core services required to operate NabuFlow are configured."
            action="Resolve a warning before depending on the affected service."
            freshness="Derived from the current Admin statistics and readiness checks."
          >
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

          <AdminSection
            title="Publishing"
            purpose="Summarizes the storage, routing, and audit foundations used by published apps."
            action="Use the linked operational records when a publish needs investigation."
            freshness="Derived from the current Admin statistics response."
          >
            <AdminItem label="Public URLs" value="Slug-based (/api/p/:slug/)" status="ok" />
            <AdminItem label="Snapshot storage" value="DB (project_versions)" status="ok" />
            <AdminItem label="Deployment logs" value="Active" status="ok" />
            <AdminItem label="Audit trail" value="Secret audit log active" status="ok" />
          </AdminSection>

          <AdminSection
            title="Billing"
            purpose="Shows credit enforcement, payment readiness, and recorded transaction volume."
            action="Resolve payment warnings before asking a user to retry billing."
            freshness="Derived from the current Admin statistics and readiness checks."
          >
            <AdminItem label="Starter credits" value="100 per user (auto-grant)" status="ok" />
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
      )}

      {isOwner && (
        <a
          href="/admin/developer-tools"
          className="block border border-border rounded-xl bg-card p-4 hover:bg-muted/40 transition-colors"
        >
          <div className="flex items-center gap-2 font-semibold">
            <Wrench className="h-4 w-4" />
            Developer tools
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Owner-only diagnostics, evaluations, skill controls, and architecture telemetry.
          </p>
        </a>
      )}
    </div>
  );
}

export function AdminDeveloperTools() {
  const statsQuery = useGetAdminStats();
  const stats = statsQuery.data;

  return (
    <section data-admin-tier="owner-developer-tools" className="space-y-8">
      <EvalResultsTile />
      <OraRoutingDiagnosticsPanel />
      {stats?.architectReviews && (
        <div className="border border-border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <BrainCircuit className="h-3.5 w-3.5 text-violet-400" />
              Architect Review (last {stats.architectReviews.windowDays} days)
            </h3>
            <span className="text-xs text-muted-foreground">
              {stats.architectReviews.reviewed} reviewed build
              {stats.architectReviews.reviewed === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border/40">
            <ArchitectMetric
              label="Avg findings / build"
              value={stats.architectReviews.avgFindingsPerBuild.toFixed(2)}
              tone="neutral"
            />
            <ArchitectMetric
              label="Pass"
              value={String(stats.architectReviews.passCount)}
              tone="ok"
            />
            <ArchitectMetric
              label="Partial"
              value={String(stats.architectReviews.partialCount)}
              tone="warn"
            />
            <ArchitectMetric
              label="Fail"
              value={String(stats.architectReviews.failCount)}
              tone="error"
            />
            <ArchitectMetric
              label="Auto-fixes queued"
              value={String(stats.architectReviews.autoFixesQueued)}
              tone="info"
            />
          </div>
        </div>
      )}
      <TopSkillsPanel stats={stats} />
      <SkillsPanel />
    </section>
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
      const [active, pending] = await Promise.all([listAdminSkills(), listAdminSkillDrafts()]);
      setSkills((active as { skills: SkillSummary[] }).skills);
      setDrafts((pending as { drafts: SkillSummary[] }).drafts);
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
      const json = await getAdminSkillDraft(name);
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
      await updateAdminSkillDraft(name, { raw: draftRaw });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingName(null);
    }
  }

  async function approveDraft(name: string) {
    setPendingName(name);
    try {
      await approveAdminSkillDraft(name);
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
      await rejectAdminSkillDraft(name);
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
      await toggleAdminSkill(name, { enabled });
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
  failed,
  last14Days,
  byDay,
}: {
  loading: boolean;
  failed: boolean;
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
            failed || last14Days > 0 ? "text-destructive" : "text-green-500"
          }`}
        >
          {failed ? "unknown" : loading ? "…" : `${last14Days.toLocaleString()} total`}
        </span>
      </div>
      <PanelDeclaration
        purpose="Shows the production error volume recorded during the last 14 days."
        action="Investigate any non-zero day before treating production as healthy."
        freshness="Fetched with the current Admin statistics response."
      />
      <div className="px-4 py-4">
        {failed ? (
          <p className="text-sm text-destructive text-center py-4">
            Production error history could not be loaded. Its current state is unknown.
          </p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            Loading production error history…
          </p>
        ) : byDay.length === 0 ? (
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
          {!check.blocking && check.status === "fail" && (
            <span className="text-[9px] font-bold uppercase text-yellow-500 border border-yellow-500/40 rounded px-1">
              non-blocking
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

function TopSkillsPanel({
  stats,
}: {
  stats:
    | {
        topSkills?: {
          windowDays: number;
          totalBuildsWithSkills: number;
          skills: Array<{ name: string; count: number }>;
        };
      }
    | undefined;
}) {
  const topSkills = stats?.topSkills;
  if (!topSkills || topSkills.skills.length === 0) return null;
  const max = topSkills.skills[0]?.count ?? 1;

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-amber-400" />
          Top skills used (last {topSkills.windowDays} days)
        </h3>
        <span className="text-xs text-muted-foreground">
          {topSkills.totalBuildsWithSkills} build
          {topSkills.totalBuildsWithSkills === 1 ? "" : "s"} loaded skills
        </span>
      </div>
      <ul className="divide-y divide-border">
        {topSkills.skills.map((skill, index) => {
          const width = max > 0 ? Math.max(4, Math.round((skill.count / max) * 100)) : 0;
          return (
            <li key={skill.name} className="px-4 py-2 flex items-center gap-3 text-sm">
              <span className="w-6 text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
              <span className="flex-1 min-w-0 truncate font-mono text-xs">{skill.name}</span>
              <div className="hidden sm:block w-32 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-amber-400/70" style={{ width: `${width}%` }} />
              </div>
              <span className="w-12 text-right tabular-nums text-muted-foreground">
                {skill.count}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SupportTicketsTile() {
  const { data } = useListAdminSupportTickets(
    { limit: 1 },
    {
      query: {
        queryKey: getListAdminSupportTicketsQueryKey({ limit: 1 }),
        refetchInterval: 60_000,
        refetchOnWindowFocus: true,
      },
    },
  );
  const counts = data?.statusCounts;
  const newCount = counts?.new ?? 0;
  const openCount = counts?.open ?? 0;

  return (
    <a
      href="/admin/support"
      className="block border border-border rounded-xl p-4 bg-card space-y-2 transition-colors hover:bg-muted/40 hover:border-border/80"
    >
      <div className="flex items-center justify-between text-muted-foreground">
        <div className="flex items-center gap-2">
          <LifeBuoy className="h-4 w-4" />
          <span className="text-xs">Support Tickets</span>
        </div>
        {newCount > 0 && (
          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold leading-none text-primary-foreground">
            {newCount > 99 ? "99+" : newCount}
          </span>
        )}
      </div>
      <div className="text-2xl font-bold">{data ? newCount : "…"}</div>
      <div className="text-xs text-muted-foreground">new · {openCount} open — view inbox</div>
      <PanelDeclaration
        compact
        purpose="Surfaces support work waiting for an operator."
        action="Open the inbox and select a ticket."
        freshness="Refreshes every 60 seconds and when this window regains focus."
      />
    </a>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
  purpose,
  action,
  freshness,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  href: string;
  purpose: string;
  action: string;
  freshness: string;
}) {
  return (
    <a
      href={href}
      className="block border border-border rounded-xl p-4 bg-card space-y-2 transition-colors hover:bg-muted/40 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
      <PanelDeclaration compact purpose={purpose} action={action} freshness={freshness} />
      <div className="text-xs font-medium text-primary flex items-center gap-1">
        Open records
        <ChevronRight className="h-3 w-3" aria-hidden="true" />
      </div>
    </a>
  );
}

function AdminSection({
  title,
  purpose,
  action,
  freshness,
  children,
}: {
  title: string;
  purpose: string;
  action: string;
  freshness: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-2.5 bg-muted/40 border-b border-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      </div>
      <PanelDeclaration purpose={purpose} action={action} freshness={freshness} />
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function PanelDeclaration({
  purpose,
  action,
  freshness,
  compact = false,
}: {
  purpose: string;
  action: string;
  freshness: string;
  compact?: boolean;
}) {
  return (
    <dl
      data-admin-panel-declaration
      className={`grid gap-2 border-b border-border bg-muted/15 text-muted-foreground ${
        compact ? "mt-2 border rounded-md p-2 text-[10px]" : "px-4 py-3 text-xs md:grid-cols-3"
      }`}
    >
      <div>
        <dt className="font-semibold text-foreground">Purpose</dt>
        <dd>{purpose}</dd>
      </div>
      <div>
        <dt className="font-semibold text-foreground">Operator action</dt>
        <dd>{action}</dd>
      </div>
      <div>
        <dt className="font-semibold text-foreground">Freshness</dt>
        <dd>{freshness}</dd>
      </div>
    </dl>
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

type EvalFixtureResult = {
  id: string;
  stage: string;
  score: number;
  passed: boolean;
  reasoning: string;
  outputPreview?: string;
  error?: string;
};

type EvalFullRecord = EvalSummary & {
  results?: EvalFixtureResult[];
  comparison?: EvalSummary["comparison"] & {
    winners: Array<string | { id: string; from: number; to: number }>;
    losers: Array<string | { id: string; from: number; to: number }>;
  };
};

function InboxRecentUnreadTile() {
  const [data, setData] = useState<AdminInboxRecentUnread | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const result = await listAdminRecentUnreadInbox({ limit: 10 });
        setData(result);
      } catch {
        /* ignore */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);
  if (!loaded) return null;
  const items = data?.items ?? [];
  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Inbox className="h-3.5 w-3.5 text-amber-400" />
          Agent Inbox — Recent Unread Feedback (Task #546)
        </h3>
        <span className="text-xs text-muted-foreground">{data?.totalUnread ?? 0} unread total</span>
      </div>
      <PanelDeclaration
        purpose="Shows unread user feedback that may need an operator response."
        action="Open the linked project to review the feedback in context."
        freshness="Loaded when the Admin Page opens."
      />
      {items.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No unread feedback right now.</div>
      ) : (
        <div className="divide-y divide-border/60">
          {items.map((it) => (
            <a
              key={it.id}
              href={`/projects/${it.projectId}`}
              className="block px-4 py-3 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-2 text-[11px] mb-1">
                <Bug
                  className={
                    "h-3 w-3 " +
                    (it.severity === "high"
                      ? "text-destructive"
                      : it.severity === "medium"
                        ? "text-amber-400"
                        : "text-muted-foreground")
                  }
                />
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  {it.category} · {it.severity}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="font-medium text-foreground">{it.projectName}</span>
                <span className="ml-auto text-muted-foreground">
                  {new Date(it.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="text-sm text-foreground/90 line-clamp-2">{it.description}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function EvalResultsTile() {
  const [data, setData] = useState<EvalFullRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const result = await getAdminEvalResults();
        setData(result as unknown as EvalFullRecord);
      } catch {
        /* ignore */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);
  if (!loaded) return null;
  const ran = data?.ran === true;
  const baselineById = new Map<string, { from: number; to: number }>();
  const annotateDelta = (raw: Array<string | { id: string; from: number; to: number }> = []) => {
    for (const item of raw) {
      if (typeof item === "object") baselineById.set(item.id, { from: item.from, to: item.to });
    }
  };
  annotateDelta(data?.comparison?.winners ?? []);
  annotateDelta(data?.comparison?.losers ?? []);
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
              tone={data?.comparison && data.comparison.totalDeltaScore < 0 ? "warn" : "neutral"}
            />
          </div>
          {data?.perStage && (
            <div className="grid grid-cols-2 md:grid-cols-6 gap-px bg-border/40">
              {(Object.keys(data.perStage) as Array<keyof typeof data.perStage>).map((stage) => {
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
            <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border flex items-center justify-between">
              <span>
                {data.comparison.winners.length} win · {data.comparison.ties.length} tie ·{" "}
                {data.comparison.losers.length} lose vs baseline
                {data.comparison.regressionRatio > 0.1 && (
                  <span className="ml-2 text-destructive font-semibold">
                    REGRESSION ({(data.comparison.regressionRatio * 100).toFixed(0)}%)
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-cyan-400 hover:text-cyan-300 font-medium"
              >
                {expanded ? "Hide details" : "Show per-fixture diff →"}
              </button>
            </div>
          )}
          {expanded && data?.results && (
            <div className="border-t border-border max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                      Fixture
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Stage</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Score</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Δ</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                      Judge reasoning
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => {
                    const delta = baselineById.get(r.id);
                    return (
                      <tr key={r.id} className="border-t border-border/60 align-top">
                        <td className="px-3 py-2 font-mono">{r.id}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.stage}</td>
                        <td
                          className={
                            "px-3 py-2 font-semibold " +
                            (r.error
                              ? "text-destructive"
                              : r.passed
                                ? "text-green-500"
                                : "text-yellow-500")
                          }
                        >
                          {r.error ? "ERR" : `${r.score}/10`}
                        </td>
                        <td className="px-3 py-2">
                          {delta ? (
                            <span
                              className={
                                delta.to > delta.from
                                  ? "text-green-500"
                                  : delta.to < delta.from
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                              }
                            >
                              {delta.from} → {delta.to}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {r.error ? r.error.slice(0, 200) : r.reasoning || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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

// ── Job Queue Tile ─────────────────────────────────────────────────────────────

function JobQueueTile() {
  const [data, setData] = useState<AdminJobQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await getAdminJobQueue({ recentLimit: 5 });
      setData(result);
      setLastUpdated(new Date());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 15_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="px-4 py-3 bg-muted/40 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-blue-400" />
          Job Queue (pg-boss)
        </h3>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-[10px] text-muted-foreground">
              updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => void fetchData()}
            className="text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <PanelDeclaration
        purpose="Shows whether durable background work is moving, waiting, or failing."
        action="Investigate failed or stalled jobs before asking a user to retry."
        freshness="Refreshes every 15 seconds and records the last successful refresh time."
      />

      {!data && loading && (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">Loading…</div>
      )}

      {loadError && (
        <div className="px-4 py-3 border-y border-destructive/30 bg-destructive/5 text-sm text-destructive">
          The job queue could not be refreshed. Its current state is unknown.
        </div>
      )}

      {data && !data.available && (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">
          Durable queue not available — DATABASE_URL missing or DURABLE_QUEUE_ENABLED=false.
        </div>
      )}

      {data && data.available && (
        <div className="divide-y divide-border">
          {data.queues.map((q) => (
            <div key={q.name}>
              <button
                onClick={() => setExpanded(expanded === q.name ? null : q.name)}
                className="w-full px-4 py-3 flex items-center justify-between text-sm hover:bg-muted/30 transition-colors"
              >
                <div className="min-w-0 flex items-center gap-2">
                  <span className="font-medium">{q.label}</span>
                  <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
                    {q.name}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs tabular-nums">
                  <span
                    className={`flex items-center gap-1 ${q.active > 0 ? "text-blue-400 font-semibold" : "text-muted-foreground"}`}
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${q.active > 0 ? "bg-blue-400" : "bg-muted-foreground/30"}`}
                    />
                    {q.active} active
                  </span>
                  <span
                    className={
                      q.queued > 0 ? "text-amber-400 font-semibold" : "text-muted-foreground"
                    }
                  >
                    {q.queued} queued
                  </span>
                  {q.failed > 0 && (
                    <span className="text-destructive font-semibold">{q.failed} failed</span>
                  )}
                  <span className="text-muted-foreground">{q.total} total</span>
                  <ChevronRight
                    className={`h-3 w-3 text-muted-foreground transition-transform ${expanded === q.name ? "rotate-90" : ""}`}
                  />
                </div>
              </button>

              {expanded === q.name && (
                <div className="px-4 pb-3 bg-muted/10">
                  {q.recent.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">
                      No recent pending, active, or failed jobs.
                    </p>
                  ) : (
                    <table className="w-full text-xs mt-1">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border">
                          <th className="text-left py-1 pr-3 font-medium">ID</th>
                          <th className="text-left py-1 pr-3 font-medium">State</th>
                          <th className="text-left py-1 pr-3 font-medium">Created</th>
                          <th className="text-left py-1 font-medium">Error / Output</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {q.recent.map((job) => {
                          const errorMsg =
                            job.state === "failed" && job.output
                              ? typeof job.output === "object" && job.output !== null
                                ? ((
                                    job.output as {
                                      message?: string;
                                      value?: { message?: string };
                                    }
                                  ).value?.message ??
                                  (job.output as { message?: string }).message ??
                                  JSON.stringify(job.output).slice(0, 80))
                                : String(job.output).slice(0, 80)
                              : null;
                          return (
                            <tr key={job.id}>
                              <td className="py-1.5 pr-3 font-mono text-[10px] text-muted-foreground truncate max-w-[80px]">
                                {job.id.slice(0, 8)}…
                              </td>
                              <td className="py-1.5 pr-3">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                    job.state === "active"
                                      ? "bg-blue-500/10 text-blue-400"
                                      : job.state === "failed"
                                        ? "bg-destructive/10 text-destructive"
                                        : job.state === "retry"
                                          ? "bg-amber-500/10 text-amber-400"
                                          : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {job.state}
                                </span>
                              </td>
                              <td className="py-1.5 pr-3 text-muted-foreground text-[10px]">
                                {new Date(job.createdon).toLocaleString()}
                              </td>
                              <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">
                                {errorMsg ?? "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
