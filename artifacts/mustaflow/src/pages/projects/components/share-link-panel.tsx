import { useState, useEffect, useCallback } from "react";
import {
  Link2,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  Eye,
  Clock,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface ShareLink {
  id: number;
  token: string;
  label: string | null;
  scope: string;
  revoked: boolean;
  viewCount: number;
  expiresAt: string | null;
  createdAt: string;
}

interface ShareLinkPanelProps {
  projectId: number;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

export function ShareLinkPanel({ projectId }: ShareLinkPanelProps) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/share`);
      if (r.ok) setLinks(await r.json() as ShareLink[]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchLinks();
  }, [fetchLinks]);

  const createLink = async () => {
    setCreating(true);
    try {
      const body: Record<string, unknown> = { scope: "draft" };
      if (label.trim()) body.label = label.trim();
      if (expiresInDays.trim()) body.expiresInDays = parseInt(expiresInDays, 10);

      const r = await fetch(`/api/projects/${projectId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setLabel("");
        setExpiresInDays("");
        setShowForm(false);
        void fetchLinks();
      }
    } finally {
      setCreating(false);
    }
  };

  const revokeLink = async (linkId: number) => {
    await fetch(`/api/projects/${projectId}/share/${linkId}`, { method: "DELETE" });
    void fetchLinks();
  };

  const copyLink = async (token: string, linkId: number) => {
    const url = `${window.location.origin}/api/share/${token}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(linkId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const activeLinks = links.filter((l) => !l.revoked && !isExpired(l.expiresAt));
  const inactiveLinks = links.filter((l) => l.revoked || isExpired(l.expiresAt));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Share Links
          </h3>
          <p className="text-xs text-muted-foreground">
            Anyone with the link can view this project — but not edit it.
          </p>
        </div>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setShowForm((s) => !s)}
        >
          <Plus className="h-3 w-3" />
          New link
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-lg border border-border bg-card p-3 space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Label (optional)</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Client review"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Expires in (days, optional)</Label>
            <Input
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              placeholder="e.g. 7"
              type="number"
              min={1}
              max={365}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void createLink()}
              disabled={creating}
            >
              {creating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Create link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Active links */}
      {loading && links.length === 0 && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {activeLinks.length === 0 && !loading && !showForm && (
        <div className="flex flex-col items-center justify-center py-10 text-center space-y-2">
          <Link2 className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No active share links</p>
          <p className="text-xs text-muted-foreground">Create a link to share a view-only draft</p>
        </div>
      )}

      <div className="space-y-2">
        {activeLinks.map((link) => (
          <div
            key={link.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
          >
            <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium truncate">{link.label ?? "Share link"}</span>
                <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Eye className="h-2.5 w-2.5" />
                  {link.viewCount}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>Created {timeAgo(link.createdAt)}</span>
                {link.expiresAt && (
                  <span className="flex items-center gap-0.5">
                    <Clock className="h-2.5 w-2.5" />
                    Expires {new Date(link.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => void copyLink(link.token, link.id)}
                title="Copy link"
              >
                {copiedId === link.id ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 hover:text-destructive"
                onClick={() => void revokeLink(link.id)}
                title="Revoke link"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}

        {inactiveLinks.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground list-none flex items-center gap-1">
              <span className="group-open:rotate-90 inline-block transition-transform">›</span>
              {inactiveLinks.length} revoked / expired
            </summary>
            <div className="mt-2 space-y-1.5 opacity-50">
              {inactiveLinks.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 line-through"
                >
                  <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground truncate">
                    {link.label ?? "Share link"} — {link.revoked ? "revoked" : "expired"}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
