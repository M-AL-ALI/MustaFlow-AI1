import { Copy, Link2, Mail, Shield, Trash2, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/api-fetch";

type ProjectRole = "owner" | "publisher" | "editor" | "viewer";
type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

interface CollaborationMember {
  userId: string;
  role: ProjectRole;
  displayName: string | null;
  email: string | null;
  imageUrl: string | null;
  joinedAt: string;
  isProjectOwner: boolean;
}

interface CollaborationInvite {
  id: number;
  email: string | null;
  role: ProjectRole;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
}

interface CollaborationState {
  project: { id: number; name: string };
  canManage: boolean;
  members: CollaborationMember[];
  invites: CollaborationInvite[];
}

const ROLE_COPY: Record<ProjectRole, { label: string; detail: string }> = {
  owner: { label: "Owner", detail: "Full project control, access and settings." },
  publisher: { label: "Publisher", detail: "Builds and publishes without seeing secret values." },
  editor: { label: "Editor", detail: "Builds and edits, but cannot publish." },
  viewer: { label: "Read-only", detail: "Can inspect the project without changing it." },
};

function initials(member: CollaborationMember) {
  return (member.displayName || member.email || "?")
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

async function readableError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.length <= 180 ? body.error : fallback;
}

export function ProjectCollaboration({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CollaborationState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("editor");
  const [busy, setBusy] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [deliveryNote, setDeliveryNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/collaboration`);
      if (!response.ok)
        throw new Error(await readableError(response, "Project access could not be loaded."));
      setData((await response.json()) as CollaborationState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project access could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createInvite = async (mode: "email" | "link") => {
    setBusy(true);
    setError(null);
    setCreatedLink(null);
    setDeliveryNote(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "email" ? { mode, email, role } : { mode, role }),
      });
      if (!response.ok)
        throw new Error(await readableError(response, "The invitation could not be created."));
      const result = (await response.json()) as { acceptUrl: string; emailStatus?: string };
      setCreatedLink(result.acceptUrl);
      if (mode === "email") {
        setDeliveryNote(
          result.emailStatus === "sent" || result.emailStatus === "delivered"
            ? "The invitation email was sent."
            : "The email could not be delivered. Copy the private link and send it yourself.",
        );
      }
      if (mode === "email") setEmail("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The invitation could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const updateRole = async (member: CollaborationMember, nextRole: ProjectRole) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/members/${member.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!response.ok)
        throw new Error(await readableError(response, "That role could not be changed."));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That role could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: CollaborationMember) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/members/${member.userId}`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new Error(await readableError(response, "That person could not be removed."));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That person could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (invite: CollaborationInvite) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch(`/api/projects/${projectId}/invites/${invite.id}/revoke`, {
        method: "POST",
      });
      if (!response.ok)
        throw new Error(await readableError(response, "That invitation could not be revoked."));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That invitation could not be revoked.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={
          data?.canManage ? "Invite people to this project" : "View people in this project"
        }
      >
        {data?.canManage ? <UserPlus className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
        {data?.canManage ? "Invite" : "People"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" /> Project access
            </DialogTitle>
            <DialogDescription>
              Invite people to this project only. Their work uses the workspace owner&apos;s
              credits.
            </DialogDescription>
          </DialogHeader>

          {loading && !data ? (
            <p className="text-sm text-muted-foreground">Loading project access…</p>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          {data?.canManage ? (
            <section className="space-y-3 rounded-xl border border-border p-4">
              <div>
                <h3 className="text-sm font-semibold">Invite someone</h3>
                <p className="text-xs text-muted-foreground">
                  Email invitations and private links are single-use and expire after seven days.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  placeholder="teammate@example.com"
                  className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                  aria-label="Invitee email"
                />
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value as ProjectRole)}
                  className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                  aria-label="Invite role"
                >
                  {Object.entries(ROLE_COPY).map(([value, copy]) => (
                    <option key={value} value={value}>
                      {copy.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-muted-foreground">{ROLE_COPY[role].detail}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !email.trim()}
                  onClick={() => void createInvite("email")}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Mail className="h-4 w-4" /> Send invitation
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void createInvite("link")}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-50"
                >
                  <Link2 className="h-4 w-4" /> Create private link
                </button>
              </div>
              {createdLink ? (
                <div className="space-y-2">
                  {deliveryNote ? (
                    <p className="text-xs text-muted-foreground">{deliveryNote}</p>
                  ) : null}
                  <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
                    <p
                      className="min-w-0 flex-1 truncate text-xs"
                      aria-label="New project invitation link"
                    >
                      {createdLink}
                    </p>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(createdLink)}
                      className="rounded-md border border-border p-1.5 hover:bg-background"
                      aria-label="Copy invitation link"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">People with access</h3>
            {data?.members.map((member) => (
              <div
                key={member.userId}
                className="flex items-center gap-3 rounded-xl border border-border p-3"
              >
                {member.imageUrl ? (
                  <img
                    src={member.imageUrl}
                    alt={member.displayName ?? "Project member"}
                    className="h-9 w-9 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {initials(member)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.displayName ?? "Profile name required"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email ?? "Account email unavailable"}
                  </p>
                </div>
                {data.canManage ? (
                  <select
                    value={member.role}
                    disabled={busy || member.isProjectOwner}
                    onChange={(event) => void updateRole(member, event.target.value as ProjectRole)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-60"
                    aria-label={`Role for ${member.displayName ?? member.email ?? "project member"}`}
                  >
                    {Object.entries(ROLE_COPY).map(([value, copy]) => (
                      <option key={value} value={value}>
                        {copy.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {ROLE_COPY[member.role].label}
                  </span>
                )}
                {data.canManage && !member.isProjectOwner ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeMember(member)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    aria-label={`Remove ${member.displayName ?? member.email ?? "project member"}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : member.isProjectOwner ? (
                  <Shield className="h-4 w-4 text-primary" aria-label="Project owner" />
                ) : null}
              </div>
            ))}
          </section>

          {data?.canManage && data.invites.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Invitation history</h3>
              {data.invites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{invite.email ?? "Private join link"}</p>
                    <p className="text-muted-foreground">
                      {ROLE_COPY[invite.role].label} · {invite.status}
                    </p>
                  </div>
                  {invite.status === "pending" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void revokeInvite(invite)}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
                    >
                      <X className="h-3 w-3" /> Revoke
                    </button>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
