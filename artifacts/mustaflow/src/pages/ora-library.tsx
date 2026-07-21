import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  FileText,
  FileSpreadsheet,
  ImageIcon,
  Download,
  ExternalLink,
  Trash2,
  Loader2,
  Library as LibraryIcon,
  ArrowLeft,
  History,
} from "lucide-react";
import { OraVersionHistoryDialog } from "@/components/ora/ora-version-history";
import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraConversationsProvider } from "@/hooks/use-ora-conversations";
import { useOraConversations } from "@/hooks/ora-conversations-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { authFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface OraAsset {
  id: number;
  kind: "file" | "image";
  fileName: string;
  mimeType: string;
  format: string | null;
  prompt: string | null;
  sizeBytes: number;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function fileIconFor(asset: OraAsset) {
  if (asset.kind === "image") return ImageIcon;
  if (asset.format === "csv" || asset.format === "xlsx") return FileSpreadsheet;
  return FileText;
}

/**
 * Lazily fetches an image asset as a blob (via authFetch so the bearer token is
 * attached — an <img src> would only carry the cookie, which expires) and shows
 * it. Revokes the object URL on unmount to avoid leaks.
 */
function OraImageThumb({ assetId, alt }: { assetId: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await authFetch(`${BASE}/api/ora/assets/${assetId}/download`);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!revoked) setFailed(true);
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/40">
        <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/40">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
      </div>
    );
  }
  return <img src={url} alt={alt} className="h-full w-full object-cover" />;
}

const PAGE_SIZE = 30;

interface OraAssetsResponse {
  assets: OraAsset[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  storage: { usedBytes: number; capBytes: number };
}

/**
 * Which project space the Library shows:
 *   "all"      → everything (no filter)
 *   "personal" → only assets not filed under any project
 *   number     → only that project's assets
 */
type LibraryProjectFilter = "all" | "personal" | number;

function OraLibraryInner() {
  const { toast } = useToast();
  const { newConversation, projects } = useOraConversations();
  const [, navigate] = useLocation();
  const [assets, setAssets] = useState<OraAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [storage, setStorage] = useState<{ usedBytes: number; capBytes: number } | null>(null);
  const [historyAssetId, setHistoryAssetId] = useState<number | null>(null);
  const [projectFilter, setProjectFilter] = useState<LibraryProjectFilter>("all");
  const downloadingRef = useRef<Set<number>>(new Set());

  const fetchPage = useCallback(
    async (offset: number): Promise<OraAssetsResponse> => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (projectFilter === "personal") params.set("projectId", "personal");
      else if (typeof projectFilter === "number") params.set("projectId", String(projectFilter));
      const res = await authFetch(`${BASE}/api/ora/assets?${params.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as OraAssetsResponse;
    },
    [projectFilter],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchPage(0);
      setAssets(data.assets);
      setHasMore(data.hasMore);
      setStorage(data.storage);
    } catch {
      setError("Failed to load your library. Please try again.");
      setAssets([]);
      setHasMore(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(assets?.length ?? 0);
      setAssets((prev) => [...(prev ?? []), ...data.assets]);
      setHasMore(data.hasMore);
      setStorage(data.storage);
    } catch {
      toast({ title: "Could not load more assets", variant: "destructive" });
    } finally {
      setLoadingMore(false);
    }
  }, [assets, fetchPage, loadingMore, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchBlobUrl = useCallback(async (asset: OraAsset, forDownload: boolean) => {
    const suffix = forDownload ? "?download=1" : "";
    const res = await authFetch(`${BASE}/api/ora/assets/${asset.id}/download${suffix}`);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }, []);

  const handleOpen = useCallback(
    async (asset: OraAsset) => {
      if (downloadingRef.current.has(asset.id)) return;
      downloadingRef.current.add(asset.id);
      try {
        const url = await fetchBlobUrl(asset, false);
        window.open(url, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch {
        toast({ title: "Could not open asset", variant: "destructive" });
      } finally {
        downloadingRef.current.delete(asset.id);
      }
    },
    [fetchBlobUrl, toast],
  );

  const handleDownload = useCallback(
    async (asset: OraAsset) => {
      if (downloadingRef.current.has(asset.id)) return;
      downloadingRef.current.add(asset.id);
      try {
        const url = await fetchBlobUrl(asset, true);
        const a = document.createElement("a");
        a.href = url;
        a.download = asset.fileName;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 2000);
      } catch {
        toast({ title: "Could not download asset", variant: "destructive" });
      } finally {
        downloadingRef.current.delete(asset.id);
      }
    },
    [fetchBlobUrl, toast],
  );

  const handleDelete = useCallback(
    async (asset: OraAsset) => {
      setBusyId(asset.id);
      try {
        const res = await authFetch(`${BASE}/api/ora/assets/${asset.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(String(res.status));
        setAssets((prev) => (prev ? prev.filter((a) => a.id !== asset.id) : prev));
        toast({ title: "Asset deleted" });
      } catch {
        toast({ title: "Could not delete asset", variant: "destructive" });
      } finally {
        setBusyId(null);
      }
    },
    [toast],
  );

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <OraSidebar
        onNewConversation={() => {
          newConversation();
          navigate("/ora");
        }}
      />

      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>

      <main className="flex-1 px-4 py-12 sm:py-16">
        <div className="mx-auto w-full max-w-5xl space-y-8">
          <div className="space-y-2">
            <Link
              href="/ora"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Ora
            </Link>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <LibraryIcon className="h-5 w-5 text-primary" />
              </span>
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight">Library</h1>
                <p className="text-sm text-muted-foreground">
                  Files and images you've generated with Ora, saved across all your devices.
                </p>
              </div>
            </div>
            {storage && storage.usedBytes > 0 && (
              <p className="text-xs text-muted-foreground">
                Storage used: {formatBytes(storage.usedBytes)} of {formatBytes(storage.capBytes)}
              </p>
            )}
          </div>

          {/* Project-space filter: All / Personal / one chip per project. */}
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by project">
            {(
              [
                { key: "all" as const, label: "All" },
                { key: "personal" as const, label: "Personal" },
                ...projects.map((p) => ({ key: p.id, label: p.name })),
              ] satisfies { key: LibraryProjectFilter; label: string }[]
            ).map(({ key, label }) => (
              <button
                key={String(key)}
                type="button"
                onClick={() => setProjectFilter(key)}
                aria-pressed={projectFilter === key}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  projectFilter === key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/70 text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {assets === null && (
            <div className="flex items-center justify-center py-24 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}

          {error && assets !== null && assets.length === 0 && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {assets !== null && !error && assets.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 py-24 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
                <LibraryIcon className="h-7 w-7 text-muted-foreground/60" />
              </span>
              <h2 className="mt-4 text-lg font-semibold">
                {projectFilter === "all" ? "Your library is empty" : "No files in this space yet"}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {projectFilter === "all"
                  ? "Ask Ora to create a spreadsheet, document, or image and it will be saved here automatically."
                  : "Files and images created while chatting in this space will show up here."}
              </p>
              <Link
                href="/ora"
                className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Start a chat
              </Link>
            </div>
          )}

          {assets !== null && assets.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map((asset) => {
                const Icon = fileIconFor(asset);
                const busy = busyId === asset.id;
                return (
                  <div
                    key={asset.id}
                    className={cn(
                      "group flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card transition-colors hover:border-border",
                      busy && "opacity-50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void handleOpen(asset)}
                      className="aspect-video w-full overflow-hidden bg-muted/30 text-left"
                      aria-label={`Open ${asset.fileName}`}
                    >
                      {asset.kind === "image" ? (
                        <OraImageThumb assetId={asset.id} alt={asset.fileName} />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2">
                          <Icon className="h-9 w-9 text-primary/70" />
                          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {asset.format ?? asset.kind}
                          </span>
                        </div>
                      )}
                    </button>

                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" title={asset.fileName}>
                          {asset.fileName}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {formatBytes(asset.sizeBytes)} · {formatDate(asset.createdAt)}
                        </p>
                      </div>

                      <div className="mt-auto flex items-center gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => void handleOpen(asset)}
                          className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDownload(asset)}
                          className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </button>
                        {asset.kind === "file" && (
                          <button
                            type="button"
                            onClick={() => setHistoryAssetId(asset.id)}
                            title="Version history"
                            className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            aria-label={`Version history for ${asset.fileName}`}
                          >
                            <History className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDelete(asset)}
                          disabled={busy}
                          className="ml-auto inline-flex items-center justify-center rounded-md border border-border/70 p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          aria-label={`Delete ${asset.fileName}`}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {assets !== null && assets.length > 0 && hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 rounded-lg border border-border/70 px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Load more
              </button>
            </div>
          )}
        </div>
      </main>

      <OraVersionHistoryDialog
        assetId={historyAssetId}
        open={historyAssetId != null}
        onOpenChange={(open) => {
          if (!open) setHistoryAssetId(null);
        }}
        onRestored={() => void load()}
      />
    </div>
  );
}

export default function OraLibraryPage() {
  return (
    <OraConversationsProvider>
      <OraLibraryInner />
    </OraConversationsProvider>
  );
}
