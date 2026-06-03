import { authFetch } from "@/lib/api-fetch";
import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Paintbrush,
  Check,
  Save,
  Sparkles,
  Palette,
  Type,
  ImageIcon,
  RefreshCw,
  Layers,
  Monitor,
  Wand2,
  Grid3x3,
  Trash2,
  Upload,
  ArrowDownToLine,
  AlertCircle,
  GitBranch,
  GitMerge,
  Library,
  Share2,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Copy,
  BarChart2,
  Eye,
  BookMarked,
  Diff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSendMessage,
  useListProjectFiles,
  getListProjectFilesQueryKey,
  getListMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type TabMode = "design" | "brand-studio" | "variants";
type VariantsSubMode = "grid" | "diff" | "library" | "ab-tests";

type CanvasVariant = {
  id: number;
  projectId: number;
  explorationId: string;
  label: string;
  prompt: string;
  status: "pending" | "generating" | "ready" | "failed";
  assistantSummary: string | null;
  errorMessage: string | null;
  rank: number;
  source: "explore" | "extract";
  variantParentId: number | null;
  savedToLibrary: boolean;
  hasShareToken: boolean;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
  lastViewedAt: string;
  previewUrl: string;
  shareUrl: string | null;
};

type CanvasAbTest = {
  id: number;
  projectId: number;
  variantAId: number;
  variantBId: number;
  trafficSplitPct: number;
  metric: string;
  status: "running" | "paused" | "ended";
  winnerId: number | null;
  viewsA: number;
  viewsB: number;
  conversionsA: number;
  conversionsB: number;
  testUrl: string;
  createdAt: string;
  endedAt: string | null;
};

type LibraryItem = {
  id: number;
  label: string;
  description: string | null;
  fileCount: number;
  sourceProjectId: number | null;
  sourceVariantId: number | null;
  createdAt: string;
};

type DiffLine = {
  type: "added" | "removed" | "unchanged";
  content: string;
};

type StyleOption = "minimal" | "bold" | "playful" | "corporate" | "modern" | "classic";

const STYLE_OPTIONS: { value: StyleOption; label: string; desc: string }[] = [
  { value: "minimal", label: "Minimal", desc: "Clean, whitespace, restrained" },
  { value: "bold", label: "Bold", desc: "Strong colors, heavy type" },
  { value: "playful", label: "Playful", desc: "Rounded, colorful, friendly" },
  { value: "corporate", label: "Corporate", desc: "Professional, trustworthy" },
  { value: "modern", label: "Modern", desc: "Geometric, sleek, tech-forward" },
  { value: "classic", label: "Classic", desc: "Timeless, elegant, refined" },
];

function BrandPreview({ projectId, iframeKey }: { projectId: number; iframeKey: number }) {
  const previewUrl = `/api/projects/${projectId}/preview/brand/preview.html?t=${iframeKey}`;
  const logoUrl = `/api/projects/${projectId}/preview/brand/logo.svg?t=${iframeKey}`;
  const iconUrl = `/api/projects/${projectId}/preview/brand/icon.svg?t=${iframeKey}`;
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-background">
        <iframe
          key={iframeKey}
          src={previewUrl}
          title="Brand preview"
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      <div className="shrink-0 grid grid-cols-2 gap-2 pt-2">
        <div className="border border-border rounded-lg p-2 bg-background flex flex-col items-center gap-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Logo</div>
          <img
            src={logoUrl}
            alt="Logo"
            className="h-8 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
        <div className="border border-border rounded-lg p-2 bg-zinc-900 flex flex-col items-center gap-1">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Dark bg</div>
          <img
            src={iconUrl}
            alt="Icon"
            className="h-8 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BrandEmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <Palette className="h-8 w-8 text-primary/50" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">No brand kit yet</h3>
        <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
          Fill in your brand details and click Generate to create a professional logo, icon, color
          palette, and typography system.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground w-full max-w-xs">
        {[
          { icon: ImageIcon, label: "SVG Logo" },
          { icon: Layers, label: "App Icon" },
          { icon: Palette, label: "Color Palette" },
          { icon: Type, label: "Typography" },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-1.5 bg-muted/40 rounded-md p-2">
            <item.icon className="h-3.5 w-3.5 text-primary/60" />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Adaptive grid columns based on variant count and container width.
 */
function gridColsClass(count: number): string {
  if (count <= 2) return "grid-cols-1 md:grid-cols-2";
  if (count <= 3) return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
  if (count <= 4) return "grid-cols-2 xl:grid-cols-2";
  if (count <= 6) return "grid-cols-2 xl:grid-cols-3";
  return "grid-cols-2 xl:grid-cols-4";
}

function gridRowHeightClass(count: number): string {
  if (count <= 3) return "auto-rows-[460px]";
  if (count <= 6) return "auto-rows-[380px]";
  return "auto-rows-[320px]";
}

/**
 * Single iframe tile for one variant.
 */
function VariantTile({
  variant,
  onGraduate,
  onDelete,
  onFork,
  onShare,
  onSaveToLibrary,
  onSelectForDiff,
  selectedForDiff,
  refreshKey,
}: {
  variant: CanvasVariant;
  onGraduate: (v: CanvasVariant) => void;
  onDelete: (v: CanvasVariant) => void;
  onFork: (v: CanvasVariant) => void;
  onShare: (v: CanvasVariant) => void;
  onSaveToLibrary: (v: CanvasVariant) => void;
  onSelectForDiff: (v: CanvasVariant) => void;
  selectedForDiff: boolean;
  refreshKey: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { threshold: 0.05 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || variant.status !== "ready") return;
    const url = `/api/projects/${variant.projectId}/canvas/variants/${variant.id}/touch`;
    fetch(url, { method: "POST" }).catch(() => {});
  }, [visible, variant.id, variant.projectId, variant.status]);

  const isReady = variant.status === "ready";
  const previewSrc = visible && isReady ? `${variant.previewUrl}?k=${refreshKey}` : "about:blank";

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col rounded-lg border bg-card overflow-hidden min-h-0 transition-all",
        selectedForDiff ? "border-violet-500 ring-1 ring-violet-500/50" : "border-border",
      )}
    >
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-xs font-semibold text-foreground truncate">{variant.label}</div>
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide shrink-0",
              variant.status === "ready" && "bg-green-500/10 text-green-400",
              variant.status === "generating" && "bg-amber-500/10 text-amber-400",
              variant.status === "pending" && "bg-muted text-muted-foreground",
              variant.status === "failed" && "bg-red-500/10 text-red-400",
            )}
          >
            {variant.status}
          </span>
          {variant.variantParentId && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-violet-500/10 text-violet-400 shrink-0 flex items-center gap-0.5">
              <GitBranch className="h-2.5 w-2.5" /> fork
            </span>
          )}
          {variant.source === "extract" && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 uppercase tracking-wide shrink-0">
              extract
            </span>
          )}
          {variant.savedToLibrary && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0 flex items-center gap-0.5">
              <BookMarked className="h-2.5 w-2.5" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            size="sm"
            variant={selectedForDiff ? "default" : "ghost"}
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onSelectForDiff(variant)}
            disabled={!isReady}
            title="Select for comparison diff"
          >
            <Diff className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() => onGraduate(variant)}
            disabled={!isReady}
            title="Merge into main app"
          >
            <ArrowDownToLine className="h-3 w-3" />
          </Button>
          <div className="relative">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={() => setMenuOpen((v) => !v)}
              title="More actions"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border border-border bg-card shadow-xl py-1"
                onMouseLeave={() => setMenuOpen(false)}
              >
                <button
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
                  onClick={() => {
                    onFork(variant);
                    setMenuOpen(false);
                  }}
                  disabled={!isReady}
                >
                  <GitBranch className="h-3 w-3 text-violet-400" /> Fork variant
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
                  onClick={() => {
                    onShare(variant);
                    setMenuOpen(false);
                  }}
                  disabled={!isReady}
                >
                  <Share2 className="h-3 w-3 text-blue-400" /> Share preview link
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
                  onClick={() => {
                    onSaveToLibrary(variant);
                    setMenuOpen(false);
                  }}
                  disabled={!isReady}
                >
                  <Library className="h-3 w-3 text-emerald-400" /> Save to library
                </button>
                <div className="border-t border-border my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted text-red-400 flex items-center gap-2"
                  onClick={() => {
                    void onDelete(variant);
                    setMenuOpen(false);
                  }}
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 bg-muted/10 relative">
        {!isReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4">
            {variant.status === "failed" ? (
              <>
                <AlertCircle className="h-6 w-6 text-red-400" />
                <div className="text-xs text-red-400 font-medium">Generation failed</div>
                {variant.errorMessage && (
                  <div className="text-[11px] text-muted-foreground max-w-xs line-clamp-3">
                    {variant.errorMessage}
                  </div>
                )}
              </>
            ) : (
              <>
                <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
                <div className="text-xs text-muted-foreground">
                  {variant.status === "pending" ? "Queued…" : "Generating variant…"}
                </div>
              </>
            )}
          </div>
        )}
        {isReady && (
          <iframe
            src={previewSrc}
            title={variant.label}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-forms allow-popups"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Structural diff panel — side-by-side line diff between two selected variants.
 */
function DiffPanel({
  projectId,
  selectedIds,
  variants,
  onClear,
}: {
  projectId: number;
  selectedIds: [number, number];
  variants: CanvasVariant[];
  onClear: () => void;
}) {
  const [diffData, setDiffData] = useState<{
    variantA: { id: number; label: string };
    variantB: { id: number; label: string };
    targetFile: string;
    fileStatuses: { path: string; inA: boolean; inB: boolean; status: string }[];
    summary: { additions: number; deletions: number; changes: number };
    lines: DiffLine[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState("index.html");

  const varA = variants.find((v) => v.id === selectedIds[0]);
  const varB = variants.find((v) => v.id === selectedIds[1]);

  const loadDiff = useCallback(
    async (file: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(
          `/api/projects/${projectId}/canvas/diff?a=${selectedIds[0]}&b=${selectedIds[1]}&file=${encodeURIComponent(file)}`,
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `Diff failed (${res.status})`);
        }
        const json = await res.json();
        setDiffData(json as typeof diffData);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [projectId, selectedIds],
  );

  useEffect(() => {
    void loadDiff(selectedFile);
  }, [loadDiff, selectedFile]);

  const allFiles = diffData?.fileStatuses ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-2 flex items-center gap-3">
        <Diff className="h-4 w-4 text-violet-400 shrink-0" />
        <span className="text-sm font-medium text-foreground">
          Comparing <span className="text-violet-400">{varA?.label ?? `#${selectedIds[0]}`}</span>
          {" vs "}
          <span className="text-blue-400">{varB?.label ?? `#${selectedIds[1]}`}</span>
        </span>
        {diffData && (
          <div className="flex items-center gap-2 text-xs ml-2">
            <span className="text-green-400 bg-green-500/10 px-2 py-0.5 rounded">
              +{diffData.summary.additions}
            </span>
            <span className="text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
              -{diffData.summary.deletions}
            </span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            className="h-7 rounded border border-border bg-background text-xs px-2"
            value={selectedFile}
            onChange={(e) => {
              setSelectedFile(e.target.value);
            }}
            disabled={loading}
          >
            {allFiles.length > 0 ? (
              allFiles.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                  {f.status !== "both" ? ` (${f.status})` : ""}
                </option>
              ))
            ) : (
              <option value="index.html">index.html</option>
            )}
          </select>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClear}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Diff body */}
      <div className="flex-1 min-h-0 overflow-y-auto font-mono text-xs bg-muted/5">
        {loading && (
          <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" /> Computing diff…
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-red-400 p-4">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}
        {!loading && !error && diffData && (
          <table className="w-full border-collapse">
            <tbody>
              {diffData.lines.map((line, i) => (
                <tr
                  key={i}
                  className={cn(
                    "leading-5",
                    line.type === "added" && "bg-green-500/10",
                    line.type === "removed" && "bg-red-500/10",
                  )}
                >
                  <td className="w-8 text-right pr-3 text-muted-foreground/40 select-none border-r border-border/50 py-px text-[10px]">
                    {i + 1}
                  </td>
                  <td
                    className={cn(
                      "pl-3 py-px whitespace-pre-wrap break-all",
                      line.type === "added" && "text-green-300",
                      line.type === "removed" && "text-red-300",
                      line.type === "unchanged" && "text-muted-foreground",
                    )}
                  >
                    <span className="select-none mr-2 opacity-50">
                      {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                    </span>
                    {line.content}
                  </td>
                </tr>
              ))}
              {diffData.lines.length === 0 && (
                <tr>
                  <td colSpan={2} className="text-center py-12 text-muted-foreground text-sm">
                    No differences found in {selectedFile}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Side-by-side preview */}
      <div className="shrink-0 h-64 border-t border-border flex gap-0">
        <div className="flex-1 flex flex-col min-w-0 border-r border-border">
          <div className="text-[10px] font-semibold text-violet-400 px-2 py-1 bg-violet-500/5 border-b border-border">
            {varA?.label}
          </div>
          <iframe
            src={`${varA?.previewUrl ?? "about:blank"}`}
            title={varA?.label}
            className="flex-1 border-0 w-full"
            sandbox="allow-scripts allow-forms allow-popups"
          />
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          <div className="text-[10px] font-semibold text-blue-400 px-2 py-1 bg-blue-500/5 border-b border-border">
            {varB?.label}
          </div>
          <iframe
            src={`${varB?.previewUrl ?? "about:blank"}`}
            title={varB?.label}
            className="flex-1 border-0 w-full"
            sandbox="allow-scripts allow-forms allow-popups"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Cross-project Variant Library panel.
 */
function LibraryPanel({
  projectId,
  onImport,
}: {
  projectId: number;
  onImport: (item: LibraryItem) => void;
}) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<number | null>(null);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch("/api/canvas/library");
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`);
      const json = (await res.json()) as { items: LibraryItem[] };
      setItems(json.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const deleteItem = async (id: number) => {
    if (!confirm("Remove this item from your library?")) return;
    try {
      await authFetch(`/api/canvas/library/${id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch {
      /* non-fatal */
    }
  };

  const importItem = async (item: LibraryItem) => {
    setImporting(item.id);
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/library/${item.id}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Import failed (${res.status})`);
      }
      const variant = await res.json();
      onImport(variant as LibraryItem);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 border-b border-border bg-card px-4 py-2 flex items-center gap-2">
        <Library className="h-4 w-4 text-emerald-400" />
        <span className="text-sm font-medium text-foreground">Variant Library</span>
        <span className="text-xs text-muted-foreground ml-1">— saved across all projects</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 ml-auto"
          onClick={() => void loadLibrary()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading && (
          <div className="text-xs text-muted-foreground text-center py-8">Loading library…</div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-xs text-red-400 p-3 bg-red-500/10 rounded-md mb-3">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="text-center py-12 space-y-3">
            <div className="w-12 h-12 mx-auto rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <Library className="h-6 w-6 text-emerald-400/50" />
            </div>
            <div className="text-sm font-medium text-foreground">Library is empty</div>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto leading-relaxed">
              Save any ready variant to the library via the more-actions menu. Saved variants can be
              imported into any project.
            </p>
          </div>
        )}
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-3 border border-border rounded-lg p-3 bg-card hover:border-border/80"
            >
              <div className="w-8 h-8 rounded bg-emerald-500/10 flex items-center justify-center shrink-0">
                <Library className="h-4 w-4 text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-foreground truncate">{item.label}</div>
                {item.description && (
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {item.description}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {item.fileCount} file{item.fileCount !== 1 ? "s" : ""} ·{" "}
                  {new Date(item.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void importItem(item)}
                  disabled={importing === item.id}
                >
                  {importing === item.id ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <Plus className="h-3 w-3 mr-1" /> Import
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                  onClick={() => void deleteItem(item.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A/B Test panel — create and manage live traffic-split tests.
 */
function AbTestsPanel({ projectId, variants }: { projectId: number; variants: CanvasVariant[] }) {
  const [tests, setTests] = useState<CanvasAbTest[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formVarA, setFormVarA] = useState<number | "">("");
  const [formVarB, setFormVarB] = useState<number | "">("");
  const [formSplit, setFormSplit] = useState(50);
  const [formMetric, setFormMetric] = useState("clicks");
  const [copiedTestId, setCopiedTestId] = useState<number | null>(null);

  const readyVariants = variants.filter((v) => v.status === "ready");

  const loadTests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/ab-tests`);
      if (!res.ok) return;
      const json = (await res.json()) as { tests: CanvasAbTest[] };
      setTests(json.tests ?? []);
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

  const createTest = async () => {
    if (!formVarA || !formVarB) return;
    setCreating(true);
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/ab-tests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variantAId: formVarA,
          variantBId: formVarB,
          trafficSplitPct: formSplit,
          metric: formMetric,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Failed to create test (${res.status})`);
      }
      const test = (await res.json()) as CanvasAbTest;
      setTests((prev) => [test, ...prev]);
      setFormOpen(false);
      setFormVarA("");
      setFormVarB("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const stopTest = async (testId: number, winnerId?: number) => {
    try {
      await authFetch(`/api/projects/${projectId}/canvas/ab-tests/${testId}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ winnerId: winnerId ?? null }),
      });
      setTests((prev) =>
        prev.map((t) => (t.id === testId ? { ...t, status: "ended" as const } : t)),
      );
    } catch {
      /* non-fatal */
    }
  };

  const copyTestUrl = async (test: CanvasAbTest) => {
    const url = `${window.location.origin}${test.testUrl}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    setCopiedTestId(test.id);
    setTimeout(() => setCopiedTestId(null), 2000);
  };

  const getVariantLabel = (id: number) => variants.find((v) => v.id === id)?.label ?? `#${id}`;

  const winRate = (conversions: number, views: number) =>
    views > 0 ? `${Math.round((conversions / views) * 1000) / 10}%` : "—";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 border-b border-border bg-card px-4 py-2 flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-medium text-foreground">Live A/B Tests</span>
        <span className="text-xs text-muted-foreground ml-1">
          — traffic-split between two variants
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void loadTests()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFormOpen((v) => !v)}
            disabled={readyVariants.length < 2}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> New Test
          </Button>
        </div>
      </div>

      {formOpen && (
        <div className="shrink-0 border-b border-border bg-card/50 p-4 space-y-3">
          <div className="text-xs font-semibold text-foreground">Create A/B Test</div>
          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded px-2 py-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                Variant A
              </label>
              <select
                className="w-full h-8 rounded border border-border bg-background text-xs px-2"
                value={formVarA}
                onChange={(e) => setFormVarA(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Select…</option>
                {readyVariants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                Variant B
              </label>
              <select
                className="w-full h-8 rounded border border-border bg-background text-xs px-2"
                value={formVarB}
                onChange={(e) => setFormVarB(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Select…</option>
                {readyVariants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                Traffic split — {formSplit}% A / {100 - formSplit}% B
              </label>
              <input
                type="range"
                min={10}
                max={90}
                step={5}
                value={formSplit}
                onChange={(e) => setFormSplit(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                Metric
              </label>
              <select
                className="w-full h-8 rounded border border-border bg-background text-xs px-2"
                value={formMetric}
                onChange={(e) => setFormMetric(e.target.value)}
              >
                <option value="clicks">Clicks</option>
                <option value="conversions">Conversions</option>
                <option value="time_on_page">Time on page</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7"
              onClick={() => void createTest()}
              disabled={!formVarA || !formVarB || formVarA === formVarB || creating}
            >
              {creating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : "Start Test"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {loading && (
          <div className="text-xs text-muted-foreground text-center py-8">Loading tests…</div>
        )}
        {!loading && tests.length === 0 && (
          <div className="text-center py-12 space-y-3">
            <div className="w-12 h-12 mx-auto rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <FlaskConical className="h-6 w-6 text-amber-400/50" />
            </div>
            <div className="text-sm font-medium text-foreground">No A/B tests yet</div>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto leading-relaxed">
              Create a test to traffic-split between two ready variants. Share the test URL —
              visitors are randomly assigned and tracked.
            </p>
            {readyVariants.length < 2 && (
              <p className="text-xs text-amber-400">
                You need at least 2 ready variants to start a test.
              </p>
            )}
          </div>
        )}
        {tests.map((test) => {
          const totalViews = test.viewsA + test.viewsB;
          const totalConversions = test.conversionsA + test.conversionsB;
          const pctA = totalViews > 0 ? Math.round((test.viewsA / totalViews) * 100) : 0;
          const isRunning = test.status === "running";
          return (
            <div key={test.id} className="border border-border rounded-lg bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide",
                    isRunning ? "bg-green-500/10 text-green-400" : "bg-muted text-muted-foreground",
                  )}
                >
                  {test.status}
                </span>
                <span className="text-xs font-semibold text-foreground flex-1 truncate">
                  {getVariantLabel(test.variantAId)} vs {getVariantLabel(test.variantBId)}
                </span>
                <span className="text-[10px] text-muted-foreground">{test.metric}</span>
              </div>
              <div className="p-3 space-y-2">
                {/* Visual split bar */}
                <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                  <div
                    className="bg-violet-500 h-full transition-all"
                    style={{ width: `${pctA || test.trafficSplitPct}%` }}
                  />
                  <div className="bg-blue-500 h-full flex-1" />
                </div>
                {/* Stats row */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-semibold text-violet-400">
                      {getVariantLabel(test.variantAId)}{" "}
                      {test.winnerId === test.variantAId && "✓ WINNER"}
                    </div>
                    <div className="text-muted-foreground flex gap-2">
                      <span>
                        <Eye className="inline h-3 w-3 mr-0.5" />
                        {test.viewsA}
                      </span>
                      <span>
                        <BarChart2 className="inline h-3 w-3 mr-0.5" />
                        {winRate(test.conversionsA, test.viewsA)}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-[10px] font-semibold text-blue-400">
                      {getVariantLabel(test.variantBId)}{" "}
                      {test.winnerId === test.variantBId && "✓ WINNER"}
                    </div>
                    <div className="text-muted-foreground flex gap-2">
                      <span>
                        <Eye className="inline h-3 w-3 mr-0.5" />
                        {test.viewsB}
                      </span>
                      <span>
                        <BarChart2 className="inline h-3 w-3 mr-0.5" />
                        {winRate(test.conversionsB, test.viewsB)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {totalViews} total view{totalViews !== 1 ? "s" : ""} · {totalConversions}{" "}
                  conversion{totalConversions !== 1 ? "s" : ""}
                </div>
                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] flex-1"
                    onClick={() => void copyTestUrl(test)}
                  >
                    {copiedTestId === test.id ? (
                      <>
                        <Check className="h-3 w-3 mr-1" /> Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 mr-1" /> Copy test URL
                      </>
                    )}
                  </Button>
                  {isRunning && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] text-violet-400"
                        onClick={() => void stopTest(test.id, test.variantAId)}
                        title="Declare A the winner and stop test"
                      >
                        A wins
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] text-blue-400"
                        onClick={() => void stopTest(test.id, test.variantBId)}
                        title="Declare B the winner and stop test"
                      >
                        B wins
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Lineage tree sidebar — shows the fork hierarchy of variants.
 */
function LineageTree({
  variants,
  onSelect,
}: {
  variants: CanvasVariant[];
  onSelect: (id: number) => void;
}) {
  const roots = variants.filter((v) => !v.variantParentId);
  const childrenOf = (id: number) => variants.filter((v) => v.variantParentId === id);

  function renderNode(v: CanvasVariant, depth: number): React.ReactNode {
    const children = childrenOf(v.id);
    return (
      <div key={v.id} style={{ paddingLeft: depth * 12 }}>
        <button
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground py-0.5 w-full text-left"
          onClick={() => onSelect(v.id)}
        >
          {depth > 0 ? (
            <GitBranch className="h-3 w-3 text-violet-400 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{v.label}</span>
          <span
            className={cn(
              "text-[9px] px-1 rounded-full ml-auto shrink-0",
              v.status === "ready" && "bg-green-500/10 text-green-400",
              v.status !== "ready" && "bg-muted text-muted-foreground",
            )}
          >
            {v.status}
          </span>
        </button>
        {children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  if (variants.every((v) => !v.variantParentId)) return null;

  return (
    <div className="shrink-0 border-r border-border bg-card w-44 overflow-y-auto py-2 px-2">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-2">
        Lineage
      </div>
      {roots.map((v) => renderNode(v, 0))}
    </div>
  );
}

function VariantsMode({ projectId }: { projectId: number }) {
  const { data: files } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });
  const [variants, setVariants] = useState<CanvasVariant[]>([]);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [variantCount, setVariantCount] = useState(3);
  const [exploring, setExploring] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractPaths, setExtractPaths] = useState<Set<string>>(new Set());
  const [extractLabel, setExtractLabel] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [subMode, setSubMode] = useState<VariantsSubMode>("grid");
  const [diffSelection, setDiffSelection] = useState<number[]>([]);
  const [showLineage, setShowLineage] = useState(false);

  const loadVariants = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/variants`);
      if (!res.ok) return;
      const json = (await res.json()) as { variants: CanvasVariant[] };
      setVariants(json.variants ?? []);
    } catch {
      /* non-fatal */
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    loadVariants().finally(() => setLoading(false));
  }, [loadVariants]);

  useEffect(() => {
    const pending = variants.some((v) => v.status === "pending" || v.status === "generating");
    if (!pending) return;
    const t = setInterval(() => {
      loadVariants().then(() => setRefreshKey((k) => k + 1));
    }, 3000);
    return () => clearInterval(t);
  }, [variants, loadVariants]);

  const explore = async () => {
    if (!prompt.trim() || exploring) return;
    setExploring(true);
    setErrorMsg(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/explore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), variantCount }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Explore failed (${res.status})`);
      }
      const json = (await res.json()) as { variants: CanvasVariant[] };
      setVariants((prev) => [...json.variants, ...prev]);
      setPrompt("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExploring(false);
    }
  };

  const graduate = async (v: CanvasVariant) => {
    if (
      !confirm(
        `Merge "${v.label}" into the main app? A pre-graduation snapshot will be saved so you can roll back.`,
      )
    )
      return;
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/variants/${v.id}/graduate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Graduate failed (${res.status})`);
      }
      const json = (await res.json()) as { inserted: number; updated: number };
      alert(
        `Merged ${json.inserted + json.updated} file(s) into the main app. Open the Preview tab to see the result.`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteVariant = async (v: CanvasVariant) => {
    if (!confirm(`Delete variant "${v.label}"? This cannot be undone.`)) return;
    try {
      await authFetch(`/api/projects/${projectId}/canvas/variants/${v.id}`, { method: "DELETE" });
      setVariants((prev) => prev.filter((x) => x.id !== v.id));
    } catch {
      /* non-fatal */
    }
  };

  const forkVariant = async (v: CanvasVariant) => {
    const label = window.prompt(`Fork label (leave blank to use "Fork of ${v.label}"):`) ?? "";
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/variants/${v.id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Fork failed (${res.status})`);
      }
      const forked = (await res.json()) as CanvasVariant;
      setVariants((prev) => [forked, ...prev]);
      if (variants.some((x) => x.variantParentId)) setShowLineage(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const shareVariant = async (v: CanvasVariant) => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/variants/${v.id}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Share failed (${res.status})`);
      }
      const json = (await res.json()) as { shareUrl: string };
      const fullUrl = `${window.location.origin}${json.shareUrl}`;
      await navigator.clipboard.writeText(fullUrl).catch(() => {});
      alert(`Share link copied to clipboard:\n${fullUrl}`);
      setVariants((prev) =>
        prev.map((x) =>
          x.id === v.id ? { ...x, hasShareToken: true, shareUrl: json.shareUrl } : x,
        ),
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const saveToLibrary = async (v: CanvasVariant) => {
    const labelInput =
      window.prompt(`Library label for "${v.label}" (or press OK to keep same label):`) ?? "";
    try {
      const res = await authFetch(
        `/api/projects/${projectId}/canvas/variants/${v.id}/save-to-library`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: labelInput.trim() || undefined }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      alert(`"${v.label}" saved to your Variant Library and is now importable in any project.`);
      setVariants((prev) => prev.map((x) => (x.id === v.id ? { ...x, savedToLibrary: true } : x)));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectForDiff = (v: CanvasVariant) => {
    setDiffSelection((prev) => {
      if (prev.includes(v.id)) return prev.filter((id) => id !== v.id);
      if (prev.length >= 2) return [prev[1]!, v.id];
      return [...prev, v.id];
    });
    if (diffSelection.length >= 1 && !diffSelection.includes(v.id)) {
      setSubMode("diff");
    }
  };

  const runExtract = async () => {
    const paths = Array.from(extractPaths);
    if (paths.length === 0) return;
    setExtracting(true);
    setErrorMsg(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/canvas/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths, label: extractLabel.trim() || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Extract failed (${res.status})`);
      }
      const v = (await res.json()) as CanvasVariant;
      setVariants((prev) => [v, ...prev]);
      setExtractOpen(false);
      setExtractPaths(new Set());
      setExtractLabel("");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  const togglePath = (path: string) => {
    setExtractPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const hasLineage = variants.some((v) => v.variantParentId);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Sub-mode toolbar */}
      <div className="shrink-0 border-b border-border bg-card px-3 pt-2 pb-0 flex items-end gap-0">
        {(
          [
            { key: "grid", label: "Grid", icon: Grid3x3 },
            { key: "diff", label: "Diff", icon: Diff },
            { key: "library", label: "Library", icon: Library },
            { key: "ab-tests", label: "A/B Tests", icon: FlaskConical },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSubMode(key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
              subMode === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
            {key === "diff" && diffSelection.length > 0 && (
              <span className="bg-primary text-primary-foreground text-[9px] px-1 rounded-full ml-0.5">
                {diffSelection.length}
              </span>
            )}
          </button>
        ))}
        {hasLineage && (
          <button
            onClick={() => setShowLineage((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ml-auto mb-0",
              showLineage
                ? "border-violet-500 text-violet-400"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <GitBranch className="h-3.5 w-3.5" /> Tree
          </button>
        )}
      </div>

      {/* Grid sub-mode: toolbar */}
      {subMode === "grid" && (
        <div className="shrink-0 border-b border-border bg-card p-3 space-y-2">
          <div className="flex gap-2 items-center">
            <Input
              placeholder="Describe what to explore (e.g. Redesign the hero with a bolder layout)…"
              className="flex-1 h-8 text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  explore();
                }
              }}
              disabled={exploring}
            />
            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <span>Variants</span>
              <select
                className="h-8 rounded-md border border-border bg-background text-sm px-2"
                value={variantCount}
                onChange={(e) => setVariantCount(Number(e.target.value))}
                disabled={exploring}
              >
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={explore}
              disabled={exploring || !prompt.trim()}
            >
              {exploring ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Exploring…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Explore
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={() => setExtractOpen((v) => !v)}
              title="Pull an existing component from the main app into the sandbox"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" /> Extract
            </Button>
          </div>
          {errorMsg && (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span className="flex-1">{errorMsg}</span>
              <button
                onClick={() => setErrorMsg(null)}
                className="text-red-400 hover:text-red-300 text-[11px]"
              >
                dismiss
              </button>
            </div>
          )}
          {diffSelection.length > 0 && (
            <div className="flex items-center gap-2 text-xs bg-violet-500/10 border border-violet-500/20 rounded-md px-2 py-1.5">
              <Diff className="h-3.5 w-3.5 text-violet-400 shrink-0" />
              <span className="text-violet-300">
                {diffSelection.length === 1
                  ? "Select one more variant to compare"
                  : `Comparing ${diffSelection.length} variants`}
              </span>
              {diffSelection.length === 2 && (
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-xs ml-2 bg-violet-600 hover:bg-violet-500"
                  onClick={() => setSubMode("diff")}
                >
                  View diff
                </Button>
              )}
              <button
                onClick={() => setDiffSelection([])}
                className="ml-auto text-violet-400 hover:text-violet-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {extractOpen && (
            <div className="rounded-md border border-border bg-muted/30 p-2 space-y-2">
              <div className="text-[11px] font-semibold text-foreground">
                Extract files from main app
              </div>
              <Input
                placeholder="Label (optional)"
                className="h-7 text-xs"
                value={extractLabel}
                onChange={(e) => setExtractLabel(e.target.value)}
              />
              <div className="max-h-40 overflow-y-auto border border-border rounded-md bg-background">
                {(files ?? []).map((f) => (
                  <label
                    key={f.id}
                    className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted cursor-pointer border-b border-border last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={extractPaths.has(f.path)}
                      onChange={() => togglePath(f.path)}
                    />
                    <span className="font-mono truncate">{f.path}</span>
                  </label>
                ))}
                {(files?.length ?? 0) === 0 && (
                  <div className="text-xs text-muted-foreground italic p-2">
                    No files in this project yet.
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => {
                    setExtractOpen(false);
                    setExtractPaths(new Set());
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7"
                  onClick={runExtract}
                  disabled={extracting || extractPaths.size === 0}
                >
                  {extracting ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>Extract {extractPaths.size > 0 ? `(${extractPaths.size})` : ""}</>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Lineage tree sidebar */}
        {showLineage && subMode === "grid" && (
          <LineageTree
            variants={variants}
            onSelect={(id) => {
              const v = variants.find((x) => x.id === id);
              if (v)
                document
                  .getElementById(`variant-tile-${id}`)
                  ?.scrollIntoView({ behavior: "smooth" });
            }}
          />
        )}

        {/* Grid */}
        {subMode === "grid" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-muted/10">
            {loading ? (
              <div className="text-xs text-muted-foreground text-center py-12">
                Loading variants…
              </div>
            ) : variants.length === 0 ? (
              <div className="max-w-md mx-auto text-center py-12 space-y-3">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Grid3x3 className="h-7 w-7 text-primary/60" />
                </div>
                <div className="text-sm font-semibold text-foreground">No variants yet</div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Type a design exploration above and click Explore. The AI will generate up to 8
                  self-contained variants in parallel — each with a distinct visual direction — so
                  you can compare side-by-side. Select any two and click Diff to see exactly what
                  changed.
                </p>
              </div>
            ) : (
              <div
                className={cn(
                  "grid gap-4",
                  gridColsClass(variants.length),
                  gridRowHeightClass(variants.length),
                )}
              >
                {variants.map((v) => (
                  <div key={v.id} id={`variant-tile-${v.id}`}>
                    <VariantTile
                      variant={v}
                      onGraduate={graduate}
                      onDelete={deleteVariant}
                      onFork={forkVariant}
                      onShare={shareVariant}
                      onSaveToLibrary={saveToLibrary}
                      onSelectForDiff={handleSelectForDiff}
                      selectedForDiff={diffSelection.includes(v.id)}
                      refreshKey={refreshKey}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Diff sub-mode */}
        {subMode === "diff" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            {diffSelection.length < 2 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
                <Diff className="h-10 w-10 text-violet-400/50" />
                <div className="text-sm font-medium text-foreground">
                  No variants selected for comparison
                </div>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Switch to the Grid tab and click the diff icon on two ready variants to compare
                  them here.
                </p>
                <Button size="sm" variant="outline" onClick={() => setSubMode("grid")}>
                  Go to Grid
                </Button>
              </div>
            ) : (
              <DiffPanel
                projectId={projectId}
                selectedIds={[diffSelection[0]!, diffSelection[1]!]}
                variants={variants}
                onClear={() => {
                  setDiffSelection([]);
                  setSubMode("grid");
                }}
              />
            )}
          </div>
        )}

        {/* Library sub-mode */}
        {subMode === "library" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <LibraryPanel
              projectId={projectId}
              onImport={(importedItem) => {
                void loadVariants();
                setSubMode("grid");
                void importedItem;
              }}
            />
          </div>
        )}

        {/* A/B Tests sub-mode */}
        {subMode === "ab-tests" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <AbTestsPanel projectId={projectId} variants={variants} />
          </div>
        )}
      </div>
    </div>
  );
}

export function CanvasTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const sendMessage = useSendMessage();
  const { data: files } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });

  const [mode, setMode] = useState<TabMode>("design");
  const [designPrompt, setDesignPrompt] = useState("");

  const [brandName, setBrandName] = useState("");
  const [tagline, setTagline] = useState("");
  const [industry, setIndustry] = useState("");
  const [style, setStyle] = useState<StyleOption>("modern");
  const [colorHint, setColorHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [brandIframeKey, setBrandIframeKey] = useState(0);

  const hasBrandFiles = files?.some((f) => f.path.startsWith("brand/"));

  const generateBrandKit = () => {
    if (!brandName.trim()) return;
    setGenerating(true);
    const brandPrompt = [
      `Generate a complete professional brand kit for this project.`,
      `Brand name: ${brandName}`,
      tagline ? `Tagline: ${tagline}` : null,
      industry ? `Industry: ${industry}` : null,
      `Style direction: ${style} — ${STYLE_OPTIONS.find((s) => s.value === style)?.desc}`,
      colorHint ? `Primary color inspiration: ${colorHint}` : null,
      ``,
      `Create these files in the brand/ directory:`,
      `- brand/logo.svg (horizontal wordmark with icon, viewBox="0 0 240 60")`,
      `- brand/icon.svg (square icon mark, viewBox="0 0 60 60")`,
      `- brand/logo-reversed.svg (white/light version for dark backgrounds)`,
      `- brand/favicon.svg (minimal 32x32 favicon version)`,
      `- brand/brand.css (CSS custom properties for colors and typography)`,
      `- brand/preview.html (brand board showing all assets, colors, and typography using Tailwind CDN)`,
      `Use only SVG primitives (rect, circle, path, text) — no external images or fonts.`,
      `Make it professional, scalable, and distinctive for the ${industry || "tech"} industry.`,
    ]
      .filter(Boolean)
      .join("\n");
    sendMessage.mutate(
      {
        id: projectId,
        data: { content: brandPrompt, agentMode: "power", planMode: false, background: false },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          setBrandIframeKey((k) => k + 1);
          setGenerating(false);
        },
        onError: () => setGenerating(false),
      },
    );
  };

  const applyBrandToApp = () => {
    if (!hasBrandFiles) return;
    setApplying(true);
    const applyPrompt = `Apply the brand kit from brand/brand.css to the main app.
Update index.html to import brand/brand.css and use the CSS custom properties (--brand-primary, --brand-secondary, etc.) throughout the design.
Ensure headings use --brand-font-heading, body text uses --brand-font-body, and primary actions use --brand-primary color.
The app should feel visually consistent with the brand identity shown in brand/preview.html.`;
    sendMessage.mutate(
      {
        id: projectId,
        data: { content: applyPrompt, agentMode: "power", planMode: false, background: false },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          setApplying(false);
        },
        onError: () => setApplying(false),
      },
    );
  };

  const generateDesignVariant = () => {
    if (!designPrompt.trim()) return;
    sendMessage.mutate(
      {
        id: projectId,
        data: {
          content: `Design change request: ${designPrompt}`,
          agentMode: "power",
          planMode: false,
          background: false,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          setDesignPrompt("");
        },
      },
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Mode switcher */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-2 flex items-center gap-3">
        <div className="flex bg-muted rounded-lg p-0.5">
          <button
            onClick={() => setMode("design")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              mode === "design"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Monitor className="h-3.5 w-3.5" /> Design
          </button>
          <button
            onClick={() => setMode("variants")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              mode === "variants"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Grid3x3 className="h-3.5 w-3.5" /> Variants
          </button>
          <button
            onClick={() => setMode("brand-studio")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              mode === "brand-studio"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Sparkles className="h-3.5 w-3.5" /> Brand Studio
          </button>
        </div>
        {mode === "brand-studio" && hasBrandFiles && (
          <span className="text-[11px] text-green-400 flex items-center gap-1">
            <Check className="h-3 w-3" /> Brand kit generated
          </span>
        )}
        {mode === "variants" && (
          <span className="text-[11px] text-muted-foreground ml-auto flex items-center gap-1">
            <GitMerge className="h-3 w-3" /> Up to 8 variants · Diff · A/B · Library
          </span>
        )}
      </div>

      {/* ── DESIGN MODE ── */}
      {mode === "design" && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="w-44 border-r border-border bg-card p-3 space-y-3 shrink-0">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Screens
            </div>
            <div className="space-y-0.5">
              {(files?.filter((f) => f.path.endsWith(".html")).slice(0, 8) ?? []).map((f) => (
                <div
                  key={f.id}
                  className="px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted rounded-md cursor-pointer truncate"
                >
                  {f.path.replace(".html", "")}
                </div>
              ))}
              {(files?.filter((f) => f.path.endsWith(".html")).length ?? 0) === 0 && (
                <div className="text-xs text-muted-foreground/50 italic px-2">No screens yet</div>
              )}
            </div>
          </div>
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="p-3 border-b border-border bg-card flex gap-2 shrink-0">
              <Input
                placeholder="Describe a design change (e.g. Make the hero darker, add a sticky nav...)"
                className="flex-1 h-8 text-sm"
                value={designPrompt}
                onChange={(e) => setDesignPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") generateDesignVariant();
                }}
              />
              <Button
                size="sm"
                className="h-8 shrink-0"
                onClick={generateDesignVariant}
                disabled={sendMessage.isPending || !designPrompt.trim()}
              >
                {sendMessage.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Paintbrush className="h-3.5 w-3.5 mr-1.5" /> Generate
                  </>
                )}
              </Button>
            </div>
            <div className="flex-1 p-4 bg-muted/20 overflow-y-auto">
              <div className="text-xs text-muted-foreground text-center py-12">
                Describe a design change above to generate variants of your app. The AI will modify
                your files and show changes in the Preview tab.
              </div>
            </div>
            <div className="p-3 border-t border-border bg-card flex justify-end shrink-0">
              <Button size="sm" variant="outline" disabled>
                <Save className="h-3.5 w-3.5 mr-1.5" /> Save as Version
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── VARIANTS MODE ── */}
      {mode === "variants" && <VariantsMode projectId={projectId} />}

      {/* ── BRAND STUDIO MODE ── */}
      {mode === "brand-studio" && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="w-64 border-r border-border bg-card flex flex-col shrink-0 overflow-y-auto">
            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs font-semibold text-foreground mb-3">Brand Details</div>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Brand Name *
                    </label>
                    <Input
                      placeholder="e.g. SwiftRide"
                      className="h-8 text-sm"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Tagline
                    </label>
                    <Input
                      placeholder="e.g. Get there faster"
                      className="h-8 text-sm"
                      value={tagline}
                      onChange={(e) => setTagline(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Industry
                    </label>
                    <Input
                      placeholder="e.g. Ride-hailing, Healthcare..."
                      className="h-8 text-sm"
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">
                      Color Hint
                    </label>
                    <Input
                      placeholder="e.g. Deep purple, Electric blue..."
                      className="h-8 text-sm"
                      value={colorHint}
                      onChange={(e) => setColorHint(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Style Direction
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {STYLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setStyle(opt.value)}
                      className={cn(
                        "text-left px-2 py-1.5 rounded-md text-[11px] border transition-colors",
                        style === opt.value
                          ? "bg-primary/10 border-primary/30 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-border",
                      )}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-[10px] opacity-60">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2 pt-1">
                <Button
                  className="w-full h-9"
                  onClick={generateBrandKit}
                  disabled={!brandName.trim() || generating || sendMessage.isPending}
                >
                  {generating || sendMessage.isPending ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5 mr-1.5" /> Generate Brand Kit
                    </>
                  )}
                </Button>
                {hasBrandFiles && (
                  <Button
                    variant="secondary"
                    className="w-full h-9"
                    onClick={applyBrandToApp}
                    disabled={applying || sendMessage.isPending}
                  >
                    {applying ? (
                      <>
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Applying…
                      </>
                    ) : (
                      <>
                        <Paintbrush className="h-3.5 w-3.5 mr-1.5" /> Apply Brand to App
                      </>
                    )}
                  </Button>
                )}
                {hasBrandFiles && (
                  <Button
                    variant="outline"
                    className="w-full h-9"
                    onClick={() => setBrandIframeKey((k) => k + 1)}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh Preview
                  </Button>
                )}
              </div>
              {hasBrandFiles && (
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Generated Assets
                  </div>
                  {[
                    "brand/logo.svg",
                    "brand/icon.svg",
                    "brand/logo-reversed.svg",
                    "brand/favicon.svg",
                    "brand/brand.css",
                    "brand/preview.html",
                  ]
                    .filter((path) => files?.some((f) => f.path === path))
                    .map((path) => (
                      <div
                        key={path}
                        className="flex items-center gap-1.5 text-[11px] text-green-400"
                      >
                        <Check className="h-3 w-3 shrink-0" />
                        <span className="font-mono">{path}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 flex flex-col min-h-0 p-4 bg-muted/20">
            {hasBrandFiles ? (
              <BrandPreview projectId={projectId} iframeKey={brandIframeKey} />
            ) : (
              <BrandEmptyState />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
