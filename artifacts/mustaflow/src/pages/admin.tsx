import { useState, useEffect } from "react";
import { ShieldCheck, Users, FolderKanban, Globe, CreditCard, AlertTriangle, RefreshCw } from "lucide-react";

interface AdminStats {
  totalProjects: number;
  publishedProjects: number;
  totalMessages: number;
  totalVersions: number;
}

export default function AdminPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch("/api/projects/summary");
        if (res.ok) {
          const data = (await res.json()) as { total: number; byStatus: Record<string, number> };
          setStats({
            totalProjects: data.total,
            publishedProjects: data.byStatus["published"] ?? 0,
            totalMessages: 0,
            totalVersions: 0,
          });
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    void fetchStats();
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Platform-level monitoring and management.</p>
          </div>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <div className="border border-yellow-500/20 bg-yellow-500/10 rounded-xl px-4 py-3 flex items-start gap-2.5 text-sm text-yellow-600">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          <span className="font-semibold">Admin access is not yet role-gated.</span>
          {" "}Any authenticated user can view this page. Full RBAC is planned for Phase 5.
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={FolderKanban}
          label="Total Projects"
          value={loading ? "…" : String(stats?.totalProjects ?? 0)}
          sub="across all users"
        />
        <StatCard
          icon={Globe}
          label="Published"
          value={loading ? "…" : String(stats?.publishedProjects ?? 0)}
          sub="live projects"
        />
        <StatCard
          icon={Users}
          label="Users"
          value="—"
          sub="Clerk admin required"
        />
        <StatCard
          icon={CreditCard}
          label="Credits Used"
          value="—"
          sub="billing not configured"
        />
      </div>

      {/* Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <AdminSection title="Security">
          <AdminItem label="Encryption" value="AES-256-GCM active" status="ok" />
          <AdminItem label="Auth provider" value="Clerk (managed)" status="ok" />
          <AdminItem label="Rate limits" value="Active (in-memory)" status="ok" />
          <AdminItem label="Secret rotation" value="Manual (script available)" status="warn" />
        </AdminSection>

        <AdminSection title="Infrastructure">
          <AdminItem label="Database" value="PostgreSQL (Replit)" status="ok" />
          <AdminItem label="AI provider" value="OpenAI via Replit proxy" status="ok" />
          <AdminItem label="CDN / edge" value="Not configured (Phase 4)" status="warn" />
          <AdminItem label="Custom domains" value="Not configured" status="warn" />
        </AdminSection>

        <AdminSection title="Publishing">
          <AdminItem label="Public URLs" value="Slug-based (/api/p/:slug/)" status="ok" />
          <AdminItem label="Snapshot storage" value="DB (project_versions)" status="ok" />
          <AdminItem label="Deployment logs" value="Active" status="ok" />
          <AdminItem label="Audit trail" value="Secret audit log active" status="ok" />
        </AdminSection>

        <AdminSection title="Billing (Phase 5)">
          <AdminItem label="Starter credits" value="100 per user (auto-grant)" status="warn" />
          <AdminItem label="Payment gateway" value="Not connected" status="warn" />
          <AdminItem label="Credit enforcement" value="DB tables ready — not enforced" status="warn" />
          <AdminItem label="Subscription plans" value="Not configured" status="warn" />
        </AdminSection>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub: string }) {
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
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function AdminItem({ label, value, status }: { label: string; value: string; status: "ok" | "warn" | "error" }) {
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
          {status.toUpperCase()}
        </span>
        <span className="text-xs">{value}</span>
      </div>
    </div>
  );
}
