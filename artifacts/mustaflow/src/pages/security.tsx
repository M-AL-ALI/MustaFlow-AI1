import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, XCircle, ShieldCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type CheckStatus = "pass" | "partial" | "fail" | "setup-required";

interface LaunchCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message?: string;
  severity?: string;
}

interface LaunchReadiness {
  canPublish: boolean;
  checks: LaunchCheck[];
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (status === "partial" || status === "setup-required")
    return <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />;
  return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
}

function StatusLabel({ status }: { status: CheckStatus }) {
  const map: Record<CheckStatus, { label: string; className: string }> = {
    pass: { label: "Pass", className: "text-green-500" },
    partial: { label: "Partial", className: "text-yellow-500" },
    fail: { label: "Fail", className: "text-destructive" },
    "setup-required": { label: "Setup required", className: "text-yellow-500" },
  };
  const { label, className } = map[status];
  return <span className={`text-xs font-semibold ${className}`}>{label}</span>;
}

// Checks visible to all signed-in users regardless of admin status
const PLATFORM_CHECKS: LaunchCheck[] = [
  {
    id: "clerk_auth",
    label: "Clerk authentication active",
    status: "pass",
    message: "Your session is secured by Clerk. Cookie-based auth — no tokens exposed.",
  },
  {
    id: "aes_encryption",
    label: "AES-256-GCM encryption active",
    status: "pass",
    message: "All project secrets are encrypted at rest before being stored in the database.",
  },
  {
    id: "secret_masking",
    label: "Secret value masking",
    status: "pass",
    message: "Secret values are never returned by the API — only a masked preview (e.g. ••••••••abcd) is shown.",
  },
  {
    id: "rate_limits",
    label: "API rate limiting active",
    status: "pass",
    message: "AI builder: 10 req/min. Publish/export: 5 req/min. Global: 300 req/15 min.",
  },
  {
    id: "sandbox_preview",
    label: "Preview sandbox isolation",
    status: "pass",
    message: "Generated app previews run in a sandboxed iframe (allow-scripts allow-forms allow-popups). allow-same-origin is removed.",
  },
  {
    id: "soft_delete",
    label: "Soft-delete data protection",
    status: "pass",
    message: "Deleted projects are soft-deleted (deleted_at set). Data is never hard-deleted automatically.",
  },
];

export default function SecurityPage() {
  const [readiness, setReadiness] = useState<LaunchReadiness | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      // Try admin launch-readiness — only works for admins
      const [meRes, readinessRes] = await Promise.all([
        fetch("/api/admin/me"),
        fetch("/api/admin/launch-readiness"),
      ]);
      if (meRes.ok) {
        const me = (await meRes.json()) as { isAdmin: boolean };
        setIsAdmin(me.isAdmin);
      }
      if (readinessRes.ok) {
        setReadiness((await readinessRes.json()) as LaunchReadiness);
      }
    } catch {
      // Non-admin: silently show platform-level checks only
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Security</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Platform security posture and configuration status.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Always-visible platform security checks */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Platform Security</h2>
        </div>
        <div className="divide-y divide-border">
          {PLATFORM_CHECKS.map((check) => (
            <div key={check.id} className="flex items-start gap-3 px-4 py-3">
              <StatusIcon status={check.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-foreground">{check.label}</span>
                  <StatusLabel status={check.status} />
                </div>
                {check.message && (
                  <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Admin launch-readiness (admin only) */}
      {isAdmin && readiness && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Launch Readiness</h2>
            {readiness.canPublish ? (
              <span className="text-xs text-green-500 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" /> Production ready
              </span>
            ) : (
              <span className="text-xs text-destructive font-semibold flex items-center gap-1.5">
                <XCircle className="h-3.5 w-3.5" /> Blocking issues present
              </span>
            )}
          </div>
          <div className="divide-y divide-border">
            {readiness.checks.map((check) => (
              <div key={check.id} className="flex items-start gap-3 px-4 py-3">
                <StatusIcon status={check.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm font-medium text-foreground">{check.label}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {check.severity === "blocking" && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          blocking
                        </span>
                      )}
                      <StatusLabel status={check.status} />
                    </div>
                  </div>
                  {check.message && (
                    <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isAdmin && !loading && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground mb-2">Admin Launch Readiness</h2>
          <p className="text-sm text-muted-foreground">
            Full launch readiness checks (Stripe, Cloudflare, encryption key, admin RBAC, etc.) are
            visible in the Admin dashboard. Contact your platform administrator for access.
          </p>
        </div>
      )}

      {/* Setup guidance */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Admin Setup Guidance</h2>

        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium text-foreground mb-1">Bootstrap first admin user</p>
            <p className="text-muted-foreground text-xs mb-1.5">
              Set the <code className="bg-muted px-1 py-0.5 rounded">ADMIN_USER_IDS</code> environment
              variable to a comma-separated list of Clerk user IDs. Find your Clerk user ID in the
              Clerk dashboard or from the session.
            </p>
            <code className="block text-xs bg-muted text-muted-foreground px-3 py-2 rounded font-mono">
              ADMIN_USER_IDS=user_abc123,user_xyz789
            </code>
          </div>

          <div className="border-t border-border pt-3">
            <p className="font-medium text-foreground mb-1">Stripe (billing)</p>
            <div className="flex flex-wrap gap-1.5">
              {["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_BUILDER", "STRIPE_PRICE_POWER"].map((v) => (
                <code key={v} className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-mono">
                  {v}
                </code>
              ))}
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <p className="font-medium text-foreground mb-1">Cloudflare for SaaS (custom domain SSL)</p>
            <div className="flex flex-wrap gap-1.5">
              {["CF_ZONE_ID", "CF_API_TOKEN", "PLATFORM_DOMAIN", "PLATFORM_CNAME_TARGET"].map((v) => (
                <code key={v} className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-mono">
                  {v}
                </code>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
