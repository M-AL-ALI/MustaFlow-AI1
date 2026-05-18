import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";

interface AdminCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "partial";
  note: string;
  blocking: boolean;
}

interface LaunchReadiness {
  ready: boolean;
  blockingFailCount: number;
  totalChecks: number;
  passed: number;
  partial: number;
  failed: number;
  checks: AdminCheck[];
}

interface AdminStats {
  projects: { total: number; published: number };
  users: { withCredits: number; withRoles: number };
  transactions: number;
  deployments: number;
}

interface AdminMe {
  userId: string;
  role: string;
  isAdmin: boolean;
  grantedViaEnv: boolean;
  grantedBy: string | null;
}

export default function AdminPage() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [readiness, setReadiness] = useState<LaunchReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [readinessLoading, setReadinessLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const meRes = await fetch("/api/admin/me");
      if (meRes.status === 403 || meRes.status === 401) {
        setForbidden(true);
        return;
      }
      if (meRes.ok) {
        setMe((await meRes.json()) as AdminMe);
      }

      const [statsRes] = await Promise.all([fetch("/api/admin/stats")]);
      if (statsRes.ok) setStats((await statsRes.json()) as AdminStats);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReadiness = useCallback(async () => {
    setReadinessLoading(true);
    try {
      const r = await fetch("/api/admin/launch-readiness");
      if (r.ok) setReadiness((await r.json()) as LaunchReadiness);
    } catch {
      // ignore
    } finally {
      setReadinessLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
    void fetchReadiness();
  }, [fetchAll, fetchReadiness]);

  if (forbidden) {
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
          onClick={() => { void fetchAll(); void fetchReadiness(); }}
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

      {/* Stats grid */}
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

      {/* Launch readiness checklist */}
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
              onClick={() => void fetchReadiness()}
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

      {/* Status sections */}
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
              process.env.CF_ZONE_ID ? "Configured" : "Not configured (manual cert)"
            }
            status="warn"
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
            value="Setup required — see /billing"
            status="warn"
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

function ReadinessRow({ check }: { check: AdminCheck }) {
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
