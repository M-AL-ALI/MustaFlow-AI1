import { ShieldCheck, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { WORKSPACE_TOOLS } from "@workspace/nabuflow-workspace-tools";
import { useMultiplayerPresence, type PresencePeer } from "@/hooks/use-multiplayer-presence";
import { authFetch } from "@/lib/api-fetch";

interface ProjectPresenceProps {
  projectId: number;
  location: string;
  canRevokeSupport: boolean;
}

/** Use the canonical tool registry so presence never invents a workspace destination. */
export function workspacePresenceLocation(tabId: string): string {
  return WORKSPACE_TOOLS.find((tool) => tool.open.tabId === tabId)?.name ?? "Project workspace";
}

function expiryLabel(value: string | null): string | null {
  if (!value) return null;
  const minutes = Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 60_000));
  return minutes > 60 ? `${Math.ceil(minutes / 60)}h left` : `${minutes}m left`;
}

function PeerRow({ peer, canRevokeSupport }: { peer: PresencePeer; canRevokeSupport: boolean }) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async () => {
    if (!peer.grantId || revoking) return;
    setRevoking(true);
    setError(null);
    try {
      const response = await authFetch(`/api/support/access-grants/${peer.grantId}/revoke`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Access could not be revoked right now.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access could not be revoked right now.");
      setRevoking(false);
    }
  };

  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60">
      <img src={peer.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{peer.name}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {peer.kind === "staff" ? "NabuFlow Support" : "Collaborator"} · {peer.location}
          {peer.kind === "staff" && expiryLabel(peer.grantExpiresAt)
            ? ` · ${expiryLabel(peer.grantExpiresAt)}`
            : ""}
        </p>
        {error && <p className="text-[10px] text-destructive">{error}</p>}
      </div>
      {peer.kind === "staff" && canRevokeSupport && peer.grantId && (
        <button
          type="button"
          onClick={() => void revoke()}
          disabled={revoking}
          className="rounded-md border border-destructive/30 px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          aria-label={`Revoke ${peer.name}'s support access`}
        >
          {revoking ? "Revoking…" : "Revoke"}
        </button>
      )}
    </li>
  );
}

/** One truthful presence surface for user-approved staff and project collaborators. */
export function ProjectPresence({ projectId, location, canRevokeSupport }: ProjectPresenceProps) {
  const [open, setOpen] = useState(false);
  const presence = useMultiplayerPresence(projectId, true, location);
  const others = useMemo(
    () => presence.peers.filter((peer) => peer.id !== presence.self?.id),
    [presence.peers, presence.self?.id],
  );
  const staffPresent = others.some((peer) => peer.kind === "staff");

  if (presence.message && others.length === 0) {
    return (
      <span className="hidden max-w-56 truncate text-[10px] text-amber-500 lg:inline" role="status">
        {presence.message}
      </span>
    );
  }
  if (presence.status !== "open" && others.length === 0) return null;

  return (
    <div className="relative shrink-0" data-testid="project-presence">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-full border border-border bg-background/70 px-1.5 py-1 hover:bg-muted"
        aria-label={`${others.length} other ${others.length === 1 ? "person" : "people"} in this project`}
      >
        {staffPresent ? (
          <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <div className="flex -space-x-1.5">
          {others.slice(0, 4).map((peer) => (
            <img
              key={peer.id}
              src={peer.imageUrl}
              alt={peer.name}
              title={`${peer.name} · ${peer.location}`}
              className="h-5 w-5 rounded-full border border-background object-cover"
            />
          ))}
        </div>
        {others.length > 4 && <span className="text-[10px]">+{others.length - 4}</span>}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-popover p-2 shadow-xl">
          <div className="flex items-center justify-between px-2 py-1">
            <div>
              <p className="text-xs font-semibold">In this project now</p>
              <p className="text-[10px] text-muted-foreground">Presence disappears on leave.</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 hover:bg-muted"
              aria-label="Close presence list"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {others.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Only you are here.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {others.map((peer) => (
                <PeerRow key={peer.id} peer={peer} canRevokeSupport={canRevokeSupport} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
