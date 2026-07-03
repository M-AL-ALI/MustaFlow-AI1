import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  ChevronLeft,
  Copy,
  Loader2,
  Monitor,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { authFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type OraxHostPermissionMode =
  | "read_only"
  | "ask_everything"
  | "ask_risky"
  | "trusted_project"
  | "full_access"
  | "custom";

interface OraxHostSummary {
  id: string;
  deviceName: string;
  platform: string;
  osVersion: string | null;
  appVersion: string | null;
  status: "online" | "offline" | "revoked";
  capabilities: Record<string, boolean>;
  permissionMode: OraxHostPermissionMode;
  lastSeenAt: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ActivePairingCode {
  hostId: string;
  code: string;
  qrPayload: string;
  expiresAt: string;
}

function isHostOnline(host: OraxHostSummary): boolean {
  if (!host.lastSeenAt) return false;
  return Date.now() - new Date(host.lastSeenAt).getTime() < 90_000;
}

function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Never";
  const diff = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 1000);
  if (diff < 10) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function PairingCodeDisplay({
  pairingCode,
  onCancel,
}: {
  pairingCode: ActivePairingCode;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [secondsLeft, setSecondsLeft] = useState(() => {
    const diff = Math.floor(
      (new Date(pairingCode.expiresAt).getTime() - Date.now()) / 1000,
    );
    return Math.max(0, diff);
  });

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  function copyCode() {
    navigator.clipboard.writeText(pairingCode.code).catch(() => {});
    toast({ title: "Copied", description: "Pairing code copied to clipboard." });
  }

  const expired = secondsLeft <= 0;

  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/40 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Pairing code
        </span>
        <button
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Cancel pairing code"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <span className="font-mono text-3xl font-bold tracking-[0.3em] text-foreground">
          {pairingCode.code}
        </span>
        <button
          onClick={copyCode}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Copy code"
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>

      {expired ? (
        <p className="text-xs text-destructive font-medium">Expired — create a new code</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Expires in{" "}
          <span className="font-medium text-foreground">
            {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
          </span>
        </p>
      )}

      <div className="rounded-lg border border-border bg-background px-3 py-2">
        <p className="text-xs text-muted-foreground mb-1">QR payload</p>
        <p className="font-mono text-xs break-all text-foreground">{pairingCode.qrPayload}</p>
      </div>

      <p className="text-xs text-muted-foreground">
        Enter this code in the Orax mobile app or scan the QR payload to pair your device.
      </p>
    </div>
  );
}

function HostCard({
  host,
  pairingCode,
  pairingLoading,
  onRevoke,
  onPermissionModeChange,
  onCreatePairingCode,
  onCancelPairingCode,
}: {
  host: OraxHostSummary;
  pairingCode: ActivePairingCode | null;
  pairingLoading: boolean;
  onRevoke: (host: OraxHostSummary) => void;
  onPermissionModeChange: (host: OraxHostSummary, mode: OraxHostPermissionMode) => void;
  onCreatePairingCode: (host: OraxHostSummary) => void;
  onCancelPairingCode: (code: string) => void;
}) {
  const online = isHostOnline(host);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center justify-center h-10 w-10 rounded-xl border border-border bg-muted/60 shrink-0">
            <Monitor className="h-5 w-5 text-foreground" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-foreground truncate">{host.deviceName}</p>
            <p className="text-sm text-muted-foreground capitalize">{host.platform}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {online ? (
            <Badge className="gap-1.5 bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/10">
              <Wifi className="h-3 w-3" />
              Online
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1.5 text-muted-foreground">
              <WifiOff className="h-3 w-3" />
              Offline
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground mb-0.5">Last seen</p>
          <p className="text-foreground font-medium">{formatLastSeen(host.lastSeenAt)}</p>
        </div>
        {host.appVersion && (
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">App version</p>
            <p className="text-foreground font-medium">{host.appVersion}</p>
          </div>
        )}
        {host.osVersion && (
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">OS</p>
            <p className="text-foreground font-medium truncate">{host.osVersion}</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground mb-1.5">Permission mode</p>
          <Select
            value={host.permissionMode}
            onValueChange={(v) =>
              onPermissionModeChange(host, v as OraxHostPermissionMode)
            }
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read_only">Read only — no changes</SelectItem>
              <SelectItem value="ask_everything">Ask everything — confirm each action</SelectItem>
              <SelectItem value="ask_risky">Ask risky — confirm risky actions only</SelectItem>
              <SelectItem value="trusted_project">Trusted project — minimal prompts</SelectItem>
              <SelectItem value="full_access">Full access — run without confirmation</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="pt-5">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => onRevoke(host)}
            title="Revoke this desktop"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {online && (
        <div className="border-t border-border pt-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
            Pair a device
          </p>
          {pairingCode ? (
            <PairingCodeDisplay
              pairingCode={pairingCode}
              onCancel={() => onCancelPairingCode(pairingCode.code)}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCreatePairingCode(host)}
              disabled={pairingLoading}
            >
              {pairingLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Create pairing code
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function OraxDevicesPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [hosts, setHosts] = useState<OraxHostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<OraxHostSummary | null>(null);
  const [revoking, setRevoking] = useState(false);

  const [pairingCodes, setPairingCodes] = useState<Record<string, ActivePairingCode>>({});
  const [pairingLoading, setPairingLoading] = useState<Record<string, boolean>>({});

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function loadHosts() {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/orax/hosts");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { hosts: OraxHostSummary[] };
      if (mountedRef.current) setHosts(data.hosts ?? []);
    } catch {
      if (mountedRef.current) setError("Could not load Orax Desktop status. Please try again.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void loadHosts();
  }, []);

  async function handlePermissionModeChange(
    host: OraxHostSummary,
    mode: OraxHostPermissionMode,
  ) {
    try {
      const res = await authFetch(`/api/orax/hosts/${host.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionMode: mode }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setHosts((prev) =>
        prev.map((h) => (h.id === host.id ? { ...h, permissionMode: mode } : h)),
      );
      toast({ title: "Permission mode updated" });
    } catch {
      toast({ title: "Update failed", description: "Could not update permission mode.", variant: "destructive" });
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const res = await authFetch(`/api/orax/hosts/${revokeTarget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}`);
      setHosts((prev) => prev.filter((h) => h.id !== revokeTarget.id));
      setPairingCodes((prev) => {
        const next = { ...prev };
        delete next[revokeTarget.id];
        return next;
      });
      toast({ title: "Desktop revoked", description: `${revokeTarget.deviceName} has been removed.` });
      setRevokeTarget(null);
    } catch {
      toast({ title: "Revoke failed", description: "Could not revoke this desktop.", variant: "destructive" });
    } finally {
      setRevoking(false);
    }
  }

  async function handleCreatePairingCode(host: OraxHostSummary) {
    setPairingLoading((prev) => ({ ...prev, [host.id]: true }));
    try {
      const res = await authFetch("/api/orax/pairing-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId: host.id }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { code: string; qrPayload: string; expiresAt: string };
      setPairingCodes((prev) => ({
        ...prev,
        [host.id]: { hostId: host.id, ...data },
      }));
    } catch {
      toast({ title: "Failed", description: "Could not create pairing code.", variant: "destructive" });
    } finally {
      setPairingLoading((prev) => ({ ...prev, [host.id]: false }));
    }
  }

  async function handleCancelPairingCode(code: string, hostId: string) {
    try {
      await authFetch(`/api/orax/pairing-codes/${encodeURIComponent(code)}`, { method: "DELETE" });
      setPairingCodes((prev) => {
        const next = { ...prev };
        delete next[hostId];
        return next;
      });
    } catch {
      toast({ title: "Failed", description: "Could not cancel pairing code.", variant: "destructive" });
    }
  }

  const activeHosts = hosts.filter((h) => h.status !== "revoked");

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => setLocation("/orax")}
            className="flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-card hover:bg-muted transition-colors"
            title="Back"
          >
            <ChevronLeft className="h-5 w-5 text-foreground" />
          </button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Orax Desktop</h1>
            <p className="text-sm text-muted-foreground">Manage your connected computers</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void loadHosts()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Checking Orax Desktop&hellip;</p>
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive font-medium mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void loadHosts()}>
              Try again
            </Button>
          </div>
        ) : activeHosts.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-10 text-center flex flex-col items-center gap-4">
            <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-border bg-muted/60">
              <Monitor className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground mb-1">No desktop connected</h2>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                Install Orax Desktop on your computer to start coding with Orax remotely.
              </p>
            </div>
            <Button onClick={() => setLocation("/orax-product")}>Download Orax Desktop</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {activeHosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                pairingCode={pairingCodes[host.id] ?? null}
                pairingLoading={pairingLoading[host.id] ?? false}
                onRevoke={setRevokeTarget}
                onPermissionModeChange={handlePermissionModeChange}
                onCreatePairingCode={handleCreatePairingCode}
                onCancelPairingCode={(code) => void handleCancelPairingCode(code, host.id)}
              />
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeTarget?.deviceName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect this desktop from your account. Your files and projects will not
              be affected. You can re-register by running Orax Desktop again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRevoke()}
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Revoke desktop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
