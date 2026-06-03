import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  Building2,
  Users,
  Mail,
  Trash2,
  Plus,
  Check,
  X,
  Loader2,
  ArrowLeft,
  Crown,
  Shield,
  Eye,
  UserCheck,
  Copy,
  Activity,
  Download,
  Calendar,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Globe2 as Globe } from "lucide-react";

interface Org {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  type: string;
  billingEmail: string | null;
  avatarUrl: string | null;
  myRole: string;
  createdAt: string;
}

interface OrgMember {
  id: number;
  userId: string;
  role: string;
  displayName: string | null;
  email: string | null;
  joinedAt: string;
}

interface OrgInvite {
  id: number;
  email: string;
  role: string;
  status: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

const ROLE_ICONS: Record<string, React.ElementType> = {
  owner: Crown,
  admin: Shield,
  member: UserCheck,
  viewer: Eye,
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

function RoleIcon({ role }: { role: string }) {
  const Icon = ROLE_ICONS[role] ?? UserCheck;
  return <Icon className="h-3.5 w-3.5" />;
}

const EVENT_ICONS: Record<string, React.ElementType> = {
  build: Zap,
  publish: Globe,
  unpublish: Globe,
  rollback: Activity,
  file_edit: Activity,
  comment: Activity,
  duplicate: Activity,
  export: Download,
  share_link_created: Activity,
  share_link_revoked: Activity,
  domain_connected: Globe,
  version_pinned: Activity,
};

function EventIcon({ eventType }: { eventType: string }) {
  const Icon = EVENT_ICONS[eventType] ?? Activity;
  return <Icon className="h-3.5 w-3.5 text-primary" />;
}

export default function OrgSettingsPage() {
  const params = useParams<{ orgId: string }>();
  const [, setLocation] = useLocation();
  const orgId = parseInt(params.orgId ?? "", 10);

  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"general" | "members" | "invites" | "activity">("members");

  // Activity log state
  interface ActivityItem {
    id: number;
    projectId: number;
    projectName: string;
    actorId: string | null;
    actorName: string | null;
    eventType: string;
    summary: string;
    createdAt: string;
  }
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityLoading, setActivityLoading] = useState(false);

  // Edit state
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editBillingEmail, setEditBillingEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    if (!Number.isFinite(orgId)) return;
    setLoading(true);
    try {
      const [orgR, membersR, invitesR] = await Promise.all([
        authFetch(`/api/orgs/${orgId}`),
        authFetch(`/api/orgs/${orgId}/members`),
        authFetch(`/api/orgs/${orgId}/invites`),
      ]);
      if (orgR.ok) {
        const o = (await orgR.json()) as Org;
        setOrg(o);
        setEditName(o.name);
        setEditDesc(o.description ?? "");
        setEditBillingEmail(o.billingEmail ?? "");
      }
      if (membersR.ok) setMembers((await membersR.json()) as OrgMember[]);
      if (invitesR.ok) setInvites((await invitesR.json()) as OrgInvite[]);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const loadActivity = useCallback(async () => {
    if (!Number.isFinite(orgId)) return;
    setActivityLoading(true);
    try {
      const r = await authFetch(`/api/orgs/${orgId}/activity?limit=100`);
      if (r.ok) {
        const data = (await r.json()) as { items: ActivityItem[]; total: number };
        setActivityItems(data.items);
        setActivityTotal(data.total);
      }
    } finally {
      setActivityLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (tab === "activity" && activityItems.length === 0) {
      void loadActivity();
    }
  }, [tab, activityItems.length, loadActivity]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const saveGeneral = async () => {
    setSaving(true);
    try {
      const r = await authFetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDesc.trim() || undefined,
          billingEmail: editBillingEmail.trim() || undefined,
        }),
      });
      if (r.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        void loadAll();
      }
    } finally {
      setSaving(false);
    }
  };

  const sendInvite = async () => {
    setInviteError("");
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const r = await authFetch(`/api/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (r.ok) {
        setInviteEmail("");
        void loadAll();
      } else {
        const d = (await r.json()) as { error?: string };
        setInviteError(d.error ?? "Failed to send invite");
      }
    } finally {
      setInviting(false);
    }
  };

  const revokeInvite = async (inviteId: number) => {
    await authFetch(`/api/orgs/${orgId}/invites/${inviteId}`, { method: "DELETE" });
    void loadAll();
  };

  const removeMember = async (memberId: number) => {
    await authFetch(`/api/orgs/${orgId}/members/${memberId}`, { method: "DELETE" });
    void loadAll();
  };

  const updateMemberRole = async (memberId: number, role: string) => {
    await authFetch(`/api/orgs/${orgId}/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    void loadAll();
  };

  const copyInviteLink = async (token: string, inviteId: number) => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    await navigator.clipboard.writeText(`${window.location.origin}${base}/orgs/invites/${token}`);
    setCopiedInviteId(inviteId);
    setTimeout(() => setCopiedInviteId(null), 2000);
  };

  const canAdmin = org && (org.myRole === "owner" || org.myRole === "admin");
  const canOwner = org?.myRole === "owner";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 gap-3">
        <p className="text-muted-foreground">Organization not found</p>
        <Button variant="ghost" onClick={() => setLocation("/projects")}>
          Back to projects
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Back */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={() => setLocation("/projects")}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Projects
        </Button>

        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{org.name}</h1>
            <p className="text-sm text-muted-foreground">
              {org.type === "personal" ? "Personal organization" : "Team organization"} ·{" "}
              <span className="capitalize">{org.myRole}</span>
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border gap-1">
          {(["members", "invites", "activity", "general"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Activity tab */}
        {tab === "activity" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Activity log
                {activityTotal > 0 && (
                  <span className="text-xs text-muted-foreground font-normal">
                    ({activityTotal} events)
                  </span>
                )}
              </h2>
              {(org?.myRole === "admin" || org?.myRole === "owner") && (
                <a
                  href={`/api/orgs/${orgId}/activity?limit=500&format=csv`}
                  download
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </a>
              )}
            </div>

            {activityLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!activityLoading && activityItems.length === 0 && (
              <div className="rounded-xl border border-border bg-card p-8 text-center">
                <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No activity yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Events appear here when team members build, publish, or edit projects.
                </p>
              </div>
            )}

            {!activityLoading && activityItems.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
                {activityItems.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 px-4 py-3 bg-card">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5">
                      <EventIcon eventType={item.eventType} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">{item.summary}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">{item.projectName}</span>
                        {item.actorName && (
                          <>
                            <span className="text-xs text-muted-foreground/40">·</span>
                            <span className="text-xs text-muted-foreground">{item.actorName}</span>
                          </>
                        )}
                        <span className="text-xs text-muted-foreground/40">·</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(item.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0 mt-1">
                      {item.eventType}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!activityLoading && activityItems.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => void loadActivity()}
              >
                Refresh
              </Button>
            )}
          </div>
        )}

        {/* Members tab */}
        {tab === "members" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              {members.length} member{members.length !== 1 ? "s" : ""}
            </h2>
            <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
              {members.map((member) => (
                <div key={member.id} className="flex items-center gap-3 px-4 py-3 bg-card">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                    {(member.displayName ?? member.email ?? "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {member.displayName ?? member.email ?? member.userId.slice(0, 12)}
                    </p>
                    {member.email && (
                      <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {canAdmin && member.role !== "owner" ? (
                      <select
                        value={member.role}
                        onChange={(e) => void updateMemberRole(member.id, e.target.value)}
                        className="h-7 rounded border border-border bg-background px-2 text-xs"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                        {canOwner && <option value="owner">Owner</option>}
                      </select>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <RoleIcon role={member.role} />
                        {ROLE_LABELS[member.role] ?? member.role}
                      </span>
                    )}
                    {canAdmin && member.role !== "owner" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 hover:text-destructive"
                        onClick={() => void removeMember(member.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {canAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setTab("invites")}
              >
                <Plus className="h-3.5 w-3.5" />
                Invite member
              </Button>
            )}
          </div>
        )}

        {/* Invites tab */}
        {tab === "invites" && (
          <div className="space-y-4">
            {canAdmin && (
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  Invite by email
                </h3>
                <div className="flex gap-2">
                  <Input
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@example.com"
                    type="email"
                    className="h-9 text-sm flex-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void sendInvite();
                    }}
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <Button
                    size="sm"
                    className="h-9"
                    onClick={() => void sendInvite()}
                    disabled={inviting || !inviteEmail.trim()}
                  >
                    {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Invite"}
                  </Button>
                </div>
                {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
              </div>
            )}

            <h2 className="text-sm font-semibold">Pending invites</h2>
            {invites.filter((i) => i.status === "pending").length === 0 && (
              <p className="text-sm text-muted-foreground">No pending invites</p>
            )}
            <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
              {invites
                .filter((i) => i.status === "pending")
                .map((invite) => (
                  <div key={invite.id} className="flex items-center gap-3 px-4 py-3 bg-card">
                    <Mail className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{invite.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {ROLE_LABELS[invite.role] ?? invite.role} · expires{" "}
                        {new Date(invite.expiresAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => void copyInviteLink(invite.token, invite.id)}
                        title="Copy invite link"
                      >
                        {copiedInviteId === invite.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      {canAdmin && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => void revokeInvite(invite.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* General tab */}
        {tab === "general" && (
          <div className="space-y-6">
            {canAdmin ? (
              <>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Organization name</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="max-w-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Description</Label>
                    <Textarea
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      className="max-w-sm min-h-[80px]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Billing email</Label>
                    <Input
                      value={editBillingEmail}
                      onChange={(e) => setEditBillingEmail(e.target.value)}
                      type="email"
                      className="max-w-sm"
                    />
                  </div>
                  <Button onClick={() => void saveGeneral()} disabled={saving} className="gap-2">
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : saved ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : null}
                    {saved ? "Saved" : "Save changes"}
                  </Button>
                </div>

                {canOwner && org.type !== "personal" && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-2">
                    <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
                    <p className="text-xs text-muted-foreground">
                      Deleting the organization is permanent and cannot be undone.
                    </p>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="gap-2"
                      onClick={async () => {
                        if (!confirm(`Delete "${org.name}"? This cannot be undone.`)) return;
                        const r = await authFetch(`/api/orgs/${orgId}`, { method: "DELETE" });
                        if (r.ok) setLocation("/projects");
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete organization
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground">Name</p>
                  <p className="text-sm font-medium">{org.name}</p>
                </div>
                {org.description && (
                  <div>
                    <p className="text-xs text-muted-foreground">Description</p>
                    <p className="text-sm">{org.description}</p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  You are a {org.myRole} — only admins and owners can edit settings.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
