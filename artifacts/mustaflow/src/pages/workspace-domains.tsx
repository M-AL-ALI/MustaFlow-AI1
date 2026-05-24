import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  ChevronLeft,
  RefreshCw,
  Plus,
  CheckCircle,
  XCircle,
  Clock,
  Copy,
  Trash2,
  Users,
  Link2,
  Zap,
  AlertCircle,
  ShieldCheck,
} from "lucide-react";
import { Link, useRoute } from "wouter";
import { useToast } from "@/hooks/use-toast";

type DomainStatus = "pending_verification" | "verified" | "failed";

interface WorkspaceDomain {
  id: number;
  workspaceId: number;
  hostname: string;
  recordType: "a" | "cname";
  verificationToken: string;
  status: DomainStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DomainQuota {
  plan: string;
  // API uses JS `Infinity` for unlimited plans, which JSON serializes to `null`.
  // Treat both `null` and a non-finite number as "unlimited".
  maxCustomDomains: number | null;
  used: number;
  remaining: number | null;
}

function isUnlimited(limit: number | null | undefined): boolean {
  return limit == null || !Number.isFinite(limit);
}

interface DomainsListResponse {
  domains: WorkspaceDomain[];
  quota: DomainQuota;
}

interface RoleGrant {
  id: number;
  workspaceDomainId: number;
  userId: string;
  role: "viewer" | "editor" | "owner";
  grantedBy: string;
  createdAt: string;
  updatedAt: string;
  email?: string | null;
  displayName?: string | null;
  imageUrl?: string | null;
}

interface ProjectSummary {
  id: number;
  name: string;
  workspaceId: number | null;
}

function StatusBadge({ status }: { status: DomainStatus }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <CheckCircle size={11} /> Verified
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-500/10 text-red-400 border border-red-500/20">
        <XCircle size={11} /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20">
      <Clock size={11} /> Pending
    </span>
  );
}

function CopyField({ value, label }: { value: string; label?: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex-1 px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg font-mono text-xs text-neutral-200 overflow-x-auto whitespace-nowrap">
        {value}
      </div>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast({ title: `${label ?? "Value"} copied` });
        }}
        className="px-2.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg text-neutral-300 transition-colors"
        title="Copy"
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

export default function WorkspaceDomainsPage() {
  const [, params] = useRoute("/workspaces/:id/domains");
  const workspaceId = params?.id;
  const { toast } = useToast();

  const [data, setData] = useState<DomainsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [newHostname, setNewHostname] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rolesByDomain, setRolesByDomain] = useState<Record<number, RoleGrant[]>>({});
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const fetchDomains = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (err) {
      toast({
        title: "Failed to load domains",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, toast]);

  const fetchProjects = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/projects?workspaceId=${workspaceId}`);
      if (!res.ok) return;
      const json = (await res.json()) as { projects?: ProjectSummary[] } | ProjectSummary[];
      const list = Array.isArray(json) ? json : (json.projects ?? []);
      setProjects(list);
    } catch {
      /* non-fatal */
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchDomains();
    void fetchProjects();
  }, [fetchDomains, fetchProjects]);

  async function claimDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!newHostname.trim() || !workspaceId) return;
    setClaiming(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: newHostname.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        upgradeMessage?: string;
        domain?: WorkspaceDomain;
      };
      if (!res.ok) {
        throw new Error(body.error ?? body.upgradeMessage ?? `HTTP ${res.status}`);
      }
      toast({ title: "Domain claimed", description: "Add the TXT record, then verify." });
      setNewHostname("");
      await fetchDomains();
      if (body.domain) setExpandedId(body.domain.id);
    } catch (err) {
      toast({
        title: "Failed to claim domain",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setClaiming(false);
    }
  }

  async function verifyDomain(domainId: number) {
    if (!workspaceId) return;
    setVerifyingId(domainId);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains/${domainId}/verify`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        verified?: boolean;
        hint?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.verified) {
        toast({ title: "Domain verified", description: "DNS check succeeded." });
      } else {
        toast({
          title: "Not verified yet",
          description: body.hint ?? "TXT record not found.",
          variant: "destructive",
        });
      }
      await fetchDomains();
    } catch (err) {
      toast({
        title: "Verification failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setVerifyingId(null);
    }
  }

  async function releaseDomain(domain: WorkspaceDomain) {
    if (!workspaceId) return;
    if (
      !window.confirm(
        `Release ${domain.hostname}? Projects using it will be detached and the hostname will be released to other workspaces.`,
      )
    )
      return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains/${domain.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      toast({ title: "Domain released" });
      await fetchDomains();
    } catch (err) {
      toast({
        title: "Failed to release domain",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function loadRoles(domainId: number) {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains/${domainId}/roles`);
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { roles: RoleGrant[] };
      setRolesByDomain((m) => ({ ...m, [domainId]: body.roles }));
    } catch (err) {
      toast({
        title: "Failed to load roles",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  function toggleExpand(domainId: number) {
    if (expandedId === domainId) {
      setExpandedId(null);
    } else {
      setExpandedId(domainId);
      if (!rolesByDomain[domainId]) void loadRoles(domainId);
    }
  }

  const quota = data?.quota;
  const unlimited = quota ? isUnlimited(quota.maxCustomDomains) : false;
  const overQuota = quota && !unlimited && quota.used >= (quota.maxCustomDomains as number);
  const percentUsed =
    quota && !unlimited
      ? Math.min(100, (quota.used / (quota.maxCustomDomains as number)) * 100)
      : 0;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link
            href={`/workspaces/${workspaceId}`}
            className="flex items-center gap-1 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            <ChevronLeft size={16} />
            Workspace
          </Link>
          <span className="text-neutral-700">/</span>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Globe size={20} className="text-blue-400" />
            Domains
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href={`/workspaces/${workspaceId}/audit`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg text-neutral-300 transition-colors"
            >
              <ShieldCheck size={13} /> Audit log
            </Link>
            <button
              onClick={() => void fetchDomains()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-lg text-neutral-300 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* Quota bar */}
        {quota && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-medium">Domain quota</div>
                <div className="text-xs text-neutral-500 mt-0.5">
                  {quota.plan.charAt(0).toUpperCase() + quota.plan.slice(1)} plan
                </div>
              </div>
              <span className="text-sm text-neutral-400">
                {quota.used} / {unlimited ? "∞" : quota.maxCustomDomains}
              </span>
            </div>
            {!unlimited && (
              <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    overQuota ? "bg-red-500" : percentUsed > 80 ? "bg-amber-500" : "bg-blue-500"
                  }`}
                  style={{ width: `${percentUsed}%` }}
                />
              </div>
            )}
            {overQuota && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <AlertCircle size={13} />
                  You've hit your domain limit. Upgrade to claim more.
                </div>
                <Link
                  href="/billing"
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-medium transition-colors"
                >
                  <Zap size={12} /> Upgrade plan
                </Link>
              </div>
            )}
            {!overQuota && quota.plan === "free" && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-xs text-neutral-500">
                  Need more domains or teammate roles? Upgrade for higher limits.
                </div>
                <Link
                  href="/billing"
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg text-xs font-medium text-neutral-200 transition-colors"
                >
                  <Zap size={12} /> See plans
                </Link>
              </div>
            )}
          </div>
        )}

        {/* Claim form */}
        <form
          onSubmit={claimDomain}
          className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 mb-6"
        >
          <div className="text-sm font-medium mb-3 flex items-center gap-2">
            <Plus size={14} className="text-blue-400" /> Claim a domain
          </div>
          <div className="flex items-stretch gap-2">
            <input
              type="text"
              value={newHostname}
              onChange={(e) => setNewHostname(e.target.value)}
              placeholder="example.com"
              disabled={claiming || overQuota}
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={claiming || !newHostname.trim() || overQuota}
              className="px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
            >
              {claiming ? "Claiming…" : "Claim"}
            </button>
          </div>
          <div className="text-xs text-neutral-500 mt-2">
            Bare hostname only — no protocol or path. You'll get a TXT record to add to your DNS for
            ownership proof.
          </div>
        </form>

        {/* Domains list */}
        {loading ? (
          <div className="flex items-center justify-center h-32 text-neutral-500">
            <RefreshCw size={18} className="animate-spin mr-2" /> Loading domains…
          </div>
        ) : data && data.domains.length > 0 ? (
          <div className="space-y-3">
            {data.domains.map((d) => (
              <DomainCard
                key={d.id}
                domain={d}
                expanded={expandedId === d.id}
                onToggle={() => toggleExpand(d.id)}
                onVerify={() => void verifyDomain(d.id)}
                onRelease={() => void releaseDomain(d)}
                verifying={verifyingId === d.id}
                roles={rolesByDomain[d.id]}
                onRolesChange={() => void loadRoles(d.id)}
                workspaceId={workspaceId!}
                projects={projects}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-neutral-500 text-sm bg-neutral-900/40 border border-dashed border-neutral-800 rounded-xl">
            No domains claimed yet. Add one above to get started.
          </div>
        )}
      </div>
    </div>
  );
}

function DomainCard({
  domain,
  expanded,
  onToggle,
  onVerify,
  onRelease,
  verifying,
  roles,
  onRolesChange,
  workspaceId,
  projects,
}: {
  domain: WorkspaceDomain;
  expanded: boolean;
  onToggle: () => void;
  onVerify: () => void;
  onRelease: () => void;
  verifying: boolean;
  roles: RoleGrant[] | undefined;
  onRolesChange: () => void;
  workspaceId: string;
  projects: ProjectSummary[];
}) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-3">
        <Globe size={16} className="text-neutral-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm text-neutral-100 truncate">{domain.hostname}</div>
          <div className="text-xs text-neutral-500 mt-0.5 uppercase tracking-wider">
            {domain.recordType} record
          </div>
        </div>
        <StatusBadge status={domain.status} />
        {domain.status !== "verified" && (
          <button
            onClick={onVerify}
            disabled={verifying}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg font-medium transition-colors"
          >
            {verifying ? "Checking…" : "Check DNS"}
          </button>
        )}
        <button
          onClick={onToggle}
          className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg text-neutral-300 transition-colors"
        >
          {expanded ? "Hide" : "Manage"}
        </button>
        <button
          onClick={onRelease}
          title="Release domain"
          className="p-1.5 text-neutral-500 hover:text-red-400 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-neutral-800 px-5 py-4 space-y-5 bg-neutral-950/40">
          {/* TXT verification instructions */}
          {domain.status !== "verified" && (
            <div>
              <div className="text-xs font-medium text-neutral-300 mb-2 uppercase tracking-wider">
                DNS verification
              </div>
              <p className="text-xs text-neutral-500 mb-3">
                Add this TXT record at your DNS provider, then click "Check DNS". Propagation can
                take up to 48 hours.
              </p>
              <div className="grid grid-cols-[80px_1fr] gap-2 items-center text-xs">
                <span className="text-neutral-500">Type</span>
                <CopyField value="TXT" label="Record type" />
                <span className="text-neutral-500">Name</span>
                <CopyField value={`_mustaflow-org.${domain.hostname}`} label="Record name" />
                <span className="text-neutral-500">Value</span>
                <CopyField value={domain.verificationToken} label="Verification token" />
              </div>
            </div>
          )}

          {/* Roles panel */}
          <RolesPanel
            domain={domain}
            roles={roles}
            onChange={onRolesChange}
            workspaceId={workspaceId}
          />

          {/* Sub-hostname panel */}
          {domain.status === "verified" && (
            <SubHostnamePanel domain={domain} workspaceId={workspaceId} projects={projects} />
          )}
        </div>
      )}
    </div>
  );
}

function RolesPanel({
  domain,
  roles,
  onChange,
  workspaceId,
}: {
  domain: WorkspaceDomain;
  roles: RoleGrant[] | undefined;
  onChange: () => void;
  workspaceId: string;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "owner">("viewer");
  const [submitting, setSubmitting] = useState(false);

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (!trimmed.includes("@")) {
      toast({
        title: "Enter a valid email address",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains/${domain.id}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, role }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        upgradeMessage?: string;
      };
      if (!res.ok) throw new Error(body.error ?? body.upgradeMessage ?? `HTTP ${res.status}`);
      toast({ title: "Teammate added", description: trimmed });
      setEmail("");
      onChange();
    } catch (err) {
      toast({
        title: "Couldn't add teammate",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(targetUserId: string, label: string) {
    if (!window.confirm(`Revoke access for ${label}?`)) return;
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/domains/${domain.id}/roles/${encodeURIComponent(targetUserId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(await res.text());
      toast({ title: "Role revoked" });
      onChange();
    } catch (err) {
      toast({
        title: "Failed to revoke role",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div>
      <div className="text-xs font-medium text-neutral-300 mb-2 uppercase tracking-wider flex items-center gap-2">
        <Users size={12} /> Teammate access
      </div>
      <form onSubmit={grant} className="flex items-stretch gap-2 mb-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          autoComplete="email"
          disabled={submitting}
          className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "editor" | "owner")}
          disabled={submitting}
          className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="owner">Owner</option>
        </select>
        <button
          type="submit"
          disabled={submitting || !email.trim()}
          className="px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors"
        >
          {submitting ? "Adding…" : "Add"}
        </button>
      </form>
      <p className="text-[11px] text-neutral-500 mb-3">
        Teammates must have signed in to this workspace at least once. If they haven't, ask them to
        visit the sign-in page first, then add them here.
      </p>
      {roles === undefined ? (
        <div className="text-xs text-neutral-500">Loading…</div>
      ) : roles.length === 0 ? (
        <div className="text-xs text-neutral-500">No teammates have access yet.</div>
      ) : (
        <div className="divide-y divide-neutral-800 border border-neutral-800 rounded-lg overflow-hidden">
          {roles.map((r) => {
            const primary = r.displayName ?? r.email ?? r.userId;
            const secondary =
              r.displayName && r.email ? r.email : r.email || r.displayName ? r.userId : null;
            return (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2 bg-neutral-900/40">
                {r.imageUrl ? (
                  <img
                    src={r.imageUrl}
                    alt=""
                    className="w-6 h-6 rounded-full bg-neutral-800 object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-neutral-800 text-neutral-400 text-[10px] font-medium flex items-center justify-center flex-shrink-0 uppercase">
                    {(r.email ?? r.userId).charAt(0)}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-neutral-100 truncate">{primary}</div>
                  {secondary && (
                    <div className="text-[10px] text-neutral-500 font-mono truncate">
                      {secondary}
                    </div>
                  )}
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] bg-neutral-800 text-neutral-300 border border-neutral-700 uppercase tracking-wider">
                  {r.role}
                </span>
                <button
                  onClick={() => void revoke(r.userId, primary)}
                  title="Revoke"
                  className="p-1 text-neutral-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SubHostnamePanel({
  domain,
  workspaceId,
  projects,
}: {
  domain: WorkspaceDomain;
  workspaceId: string;
  projects: ProjectSummary[];
}) {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<string>("");
  const [subdomain, setSubdomain] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !subdomain.trim()) return;
    const sub = subdomain.trim().replace(/\.$/, "");
    const fullHostname = sub.includes(".") ? sub : `${sub}.${domain.hostname}`;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/domains/${domain.id}/sub-claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: parseInt(projectId, 10),
          hostname: fullHostname,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast({
        title: "Sub-hostname attached",
        description: `${fullHostname} → project #${projectId}`,
      });
      setSubdomain("");
    } catch (err) {
      toast({
        title: "Failed to claim sub-hostname",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="text-xs font-medium text-neutral-300 mb-2 uppercase tracking-wider flex items-center gap-2">
        <Link2 size={12} /> Sub-hostname for a project
      </div>
      <p className="text-xs text-neutral-500 mb-3">
        Because <span className="font-mono text-neutral-400">{domain.hostname}</span> is verified by
        this workspace, sub-hostnames under it are auto-verified — no extra TXT record needed.
      </p>
      <form onSubmit={claim} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-stretch">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={submitting || projects.length === 0}
          className="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
        >
          <option value="">
            {projects.length === 0 ? "No projects in workspace" : "Select project…"}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} (#{p.id})
            </option>
          ))}
        </select>
        <div className="flex items-stretch">
          <input
            type="text"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            placeholder="app"
            disabled={submitting}
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded-l-lg px-3 py-2 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <span className="px-3 flex items-center bg-neutral-900 border border-l-0 border-neutral-800 rounded-r-lg text-xs text-neutral-400 font-mono">
            .{domain.hostname}
          </span>
        </div>
        <button
          type="submit"
          disabled={submitting || !projectId || !subdomain.trim()}
          className="px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors"
        >
          Attach
        </button>
      </form>
    </div>
  );
}
