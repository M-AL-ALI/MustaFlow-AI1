import { useCallback, useEffect, useState } from "react";
import { Download, History, Loader2, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface OraAssetVersion {
  id: number;
  fileName: string;
  mimeType: string;
  format: string | null;
  sizeBytes: number;
  versionNumber: number;
  editSummary: string | null;
  createdAt: string;
  isCurrent: boolean;
}

interface VersionsResponse {
  rootAssetId: number;
  currentAssetId: number;
  versions: OraAssetVersion[];
}

function formatVersionBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatVersionDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

async function downloadVersion(assetId: number, fileName: string) {
  const res = await authFetch(`${BASE}/api/ora/assets/${assetId}/download?download=1`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}

/**
 * Version history for a durable Ora file asset (Phase 2: File Revision
 * History). Lists the append-only version chain newest-first with per-version
 * download, and restores an older version as a NEW current version — history
 * is never rewritten. Only reachable for signed-in users (anonymous outputs
 * have no asset id, so callers hide the affordance entirely).
 */
export function OraVersionHistoryDialog({
  assetId,
  open,
  onOpenChange,
  onRestored,
}: {
  assetId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful restore with the NEW current asset id. */
  onRestored?: (newAssetId: number) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${BASE}/api/ora/assets/${id}/versions`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to load version history");
      }
      setData((await res.json()) as VersionsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load version history");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && assetId != null) void load(assetId);
    if (!open) {
      setData(null);
      setError(null);
      setRestoringId(null);
    }
  }, [open, assetId, load]);

  const handleRestore = useCallback(
    async (version: OraAssetVersion) => {
      setRestoringId(version.id);
      try {
        const res = await authFetch(`${BASE}/api/ora/assets/${version.id}/restore`, {
          method: "POST",
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          assetId?: number;
          versionNumber?: number;
          error?: string;
        } | null;
        if (!res.ok || !body?.ok || body.assetId == null) {
          throw new Error(body?.error ?? "Failed to restore this version");
        }
        toast({
          title: "Version restored",
          description: `Version ${version.versionNumber} is now the current version (saved as version ${body.versionNumber}).`,
        });
        onRestored?.(body.assetId);
        // Reload the chain so the new head shows immediately.
        await load(body.assetId);
      } catch (err) {
        toast({
          title: "Restore failed",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        setRestoringId(null);
      }
    },
    [toast, onRestored, load],
  );

  const versions = data ? [...data.versions].reverse() : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-[hsl(var(--ora-accent-hsl))]" />
            Version history
          </DialogTitle>
          <DialogDescription className="text-xs">
            {versions.length > 0
              ? `${versions[0].fileName} — every edit is kept as its own version. Restoring never deletes history.`
              : "Every edit is kept as its own version. Restoring never deletes history."}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
          </div>
        )}

        {!loading && error && <p className="py-4 text-center text-xs text-destructive">{error}</p>}

        {!loading && !error && versions.length > 0 && (
          <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {versions.map((v) => (
              <li
                key={v.id}
                className={cn(
                  "rounded-lg border px-3 py-2.5",
                  v.isCurrent
                    ? "border-[hsl(var(--ora-accent-hsl)/0.4)] bg-[hsl(var(--ora-accent-hsl)/0.06)]"
                    : "border-border/60 bg-muted/20",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    Version {v.versionNumber}
                  </span>
                  {v.isCurrent && (
                    <span className="rounded-full bg-[hsl(var(--ora-accent-hsl)/0.15)] px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--ora-accent-hsl))]">
                      Current
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-muted-foreground/70">
                    {formatVersionDate(v.createdAt)} · {formatVersionBytes(v.sizeBytes)}
                  </span>
                </div>
                {v.editSummary && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                    {v.editSummary}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void downloadVersion(v.id, v.fileName)}
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted/60"
                  >
                    <Download className="h-3 w-3" />
                    Download
                  </button>
                  {!v.isCurrent && (
                    <button
                      type="button"
                      disabled={restoringId != null}
                      onClick={() => void handleRestore(v)}
                      className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--ora-accent-hsl)/0.3)] bg-background/70 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-[hsl(var(--ora-accent-hsl)/0.1)] disabled:opacity-50"
                    >
                      {restoringId === v.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      Restore
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {!loading && !error && data && versions.length === 0 && (
          <p className="py-4 text-center text-xs text-muted-foreground">No versions found.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
