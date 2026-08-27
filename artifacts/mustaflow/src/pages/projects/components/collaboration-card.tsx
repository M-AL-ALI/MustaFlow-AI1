import { Users, Wifi, WifiOff } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useMultiplayerPresence } from "@/hooks/use-multiplayer-presence";

interface CollaborationCardProps {
  projectId: number;
  enabled: boolean;
  isPending: boolean;
  onToggle: (checked: boolean) => void | Promise<void>;
}

export function CollaborationCard({
  projectId,
  enabled,
  isPending,
  onToggle,
}: CollaborationCardProps) {
  const presence = useMultiplayerPresence(projectId, enabled, "Settings");
  const otherPeers = presence.peers.filter((p) => p.id !== presence.self?.id);

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Collaboration</h3>
        </div>
        {enabled && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {presence.status === "open" ? (
              <>
                <Wifi className="h-3 w-3 text-emerald-500" />
                <span>
                  {presence.peers.length} live · {otherPeers.length} other
                  {otherPeers.length === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <>
                <WifiOff className="h-3 w-3 text-muted-foreground" />
                <span>{presence.status === "connecting" ? "Connecting…" : "Offline"}</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Real-time multiplayer</p>
          <p className="text-xs text-muted-foreground">
            Open the same project in another tab or device to collaborate live. Edits sync via Yjs
            (CRDT) over WebSocket; presence shows who's here. Opt-in per project — disabled by
            default.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void onToggle(checked)}
          disabled={isPending}
          aria-label="Toggle real-time multiplayer"
        />
      </div>
      {enabled && otherPeers.length > 0 && (
        <div className="pt-2 border-t border-border/50">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
            Live collaborators
          </p>
          <div className="flex flex-wrap gap-1.5">
            {otherPeers.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-xs"
              >
                <img src={p.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
