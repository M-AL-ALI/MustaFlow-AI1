import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Editor from "@monaco-editor/react";
import {
  Layers,
  RefreshCw,
  AlertCircle,
  Trash2,
  ArrowDownToLine,
  Code2,
  X,
  Save,
  Wand2,
  Monitor,
  Tablet,
  Smartphone,
  CheckCircle2,
  Minimize2,
  Maximize2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type DeviceWidth = "desktop" | "tablet" | "mobile";
type TileColSpan = 1 | 2;

interface CanvasVariant {
  id: number;
  projectId: number;
  explorationId: string;
  label: string;
  prompt: string;
  status: "pending" | "generating" | "ready" | "failed";
  assistantSummary: string | null;
  errorMessage: string | null;
  previewUrl: string;
}

interface TileState {
  device: DeviceWidth;
  colSpan: TileColSpan;
}

interface CanvasState {
  explorationId: string | null;
  tiles: Record<number, TileState>;
}

const DEVICE_WIDTHS: Record<DeviceWidth, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "390px",
};

const THEME_CHIPS: { label: string; prompt: string }[] = [
  {
    label: "Minimal",
    prompt:
      "Make it more minimal and clean — generous whitespace, restrained colour palette, simple typography",
  },
  {
    label: "Bold",
    prompt:
      "Make it bold and high-impact — strong colours, heavy typography, dense visual hierarchy",
  },
  {
    label: "Dark",
    prompt:
      "Redesign with a dark theme — dark backgrounds, muted tones, subtle glows and high contrast accents",
  },
  {
    label: "Light",
    prompt:
      "Redesign with a clean light theme — white backgrounds, soft shadows, airy and professional",
  },
  {
    label: "Corporate",
    prompt:
      "Give it a polished corporate look — professional blues and greys, clean grid layout, trustworthy feel",
  },
  {
    label: "Playful",
    prompt:
      "Make it playful and friendly — rounded corners, vivid accent colours, warm and approachable",
  },
];

function getDeviceLabel(device: DeviceWidth): string {
  return { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" }[device];
}

function DeviceIcon({ device }: { device: DeviceWidth }) {
  if (device === "tablet") return <Tablet className="h-3 w-3" />;
  if (device === "mobile") return <Smartphone className="h-3 w-3" />;
  return <Monitor className="h-3 w-3" />;
}

function VariantTile({
  variant,
  tileState,
  onDeviceChange,
  onResize,
  onGraduate,
  onDelete,
  onEdit,
  refreshKey,
  graduating,
}: {
  variant: CanvasVariant;
  tileState: TileState;
  onDeviceChange: (id: number, device: DeviceWidth) => void;
  onResize: (id: number, colSpan: TileColSpan) => void;
  onGraduate: (v: CanvasVariant) => void;
  onDelete: (v: CanvasVariant) => void;
  onEdit: (v: CanvasVariant) => void;
  refreshKey: number;
  graduating: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [graduated, setGraduated] = useState(false);

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
    fetch(`/api/projects/${variant.projectId}/canvas/variants/${variant.id}/touch`, {
      method: "POST",
    }).catch(() => {});
  }, [visible, variant.id, variant.projectId, variant.status]);

  useEffect(() => {
    if (graduating) setGraduated(false);
  }, [graduating]);

  const isReady = variant.status === "ready";
  const previewSrc = visible && isReady ? `${variant.previewUrl}?k=${refreshKey}` : "about:blank";
  const device = tileState.device;
  const devices: DeviceWidth[] = ["desktop", "tablet", "mobile"];

  return (
    <div
      ref={containerRef}
      className="flex flex-col rounded-lg border border-border bg-card overflow-hidden min-h-0"
    >
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border shrink-0 gap-2">
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
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {/* Resize toggle */}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
            title={tileState.colSpan === 2 ? "Shrink tile" : "Expand tile"}
            onClick={() => onResize(variant.id, tileState.colSpan === 2 ? 1 : 2)}
          >
            {tileState.colSpan === 2 ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </Button>

          {/* Device selector */}
          <div className="flex items-center border border-border rounded overflow-hidden">
            {devices.map((d) => (
              <button
                key={d}
                onClick={() => onDeviceChange(variant.id, d)}
                title={getDeviceLabel(d)}
                className={cn(
                  "flex items-center justify-center h-5 w-6 transition-colors",
                  device === d
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <DeviceIcon device={d} />
              </button>
            ))}
          </div>

          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() => onEdit(variant)}
            disabled={!isReady}
            title="Edit this variant"
          >
            <Code2 className="h-3 w-3" />
          </Button>

          <Button
            size="sm"
            variant={graduated ? "default" : "ghost"}
            className="h-6 px-1.5 gap-1"
            onClick={() => {
              onGraduate(variant);
              setGraduated(true);
            }}
            disabled={!isReady || graduating}
            title="Apply to Project"
          >
            {graduating ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : graduated ? (
              <CheckCircle2 className="h-3 w-3 text-green-400" />
            ) : (
              <ArrowDownToLine className="h-3 w-3" />
            )}
            <span className="text-[10px] font-medium">Apply</span>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-muted-foreground hover:text-red-400"
            onClick={() => onDelete(variant)}
            title="Delete variant"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="flex-1 bg-muted/10 relative overflow-hidden flex items-center justify-center min-h-0">
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
          <div
            className="h-full transition-all duration-300 flex items-center justify-center"
            style={{ width: DEVICE_WIDTHS[device] }}
          >
            <iframe
              src={previewSrc}
              title={variant.label}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-forms allow-popups"
            />
          </div>
        )}
      </div>

      {variant.assistantSummary && isReady && (
        <div className="shrink-0 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground truncate bg-muted/5">
          {variant.assistantSummary}
        </div>
      )}
    </div>
  );
}

interface VariantFile {
  path: string;
  content: string;
  mimeType: string;
}

function EditOverlay({
  variant,
  onClose,
  onSave,
}: {
  variant: CanvasVariant;
  onClose: () => void;
  onSave: (variantId: number, files: VariantFile[]) => void;
}) {
  const [files, setFiles] = useState<VariantFile[]>([]);
  const [selectedPath, setSelectedPath] = useState("index.html");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filesRef = useRef<VariantFile[]>([]);
  const selectedPathRef = useRef(selectedPath);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/projects/${variant.projectId}/canvas/variants/${variant.id}/files`,
        );
        if (!res.ok) throw new Error(`Failed to load variant files (${res.status})`);
        const json = (await res.json()) as { files: VariantFile[] };
        const variantFiles: VariantFile[] = json.files ?? [];
        if (variantFiles.length === 0) {
          throw new Error("No files in variant");
        }
        setFiles(variantFiles);
        const first = variantFiles[0]!;
        setSelectedPath(first.path);
        setContent(first.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [variant.id, variant.projectId]);

  const doSave = useCallback(
    async (filesToSave: VariantFile[]) => {
      setSaving(true);
      setAutoSaved(false);
      try {
        const res = await fetch(
          `/api/projects/${variant.projectId}/canvas/variants/${variant.id}/files`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ files: filesToSave }),
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `Save failed (${res.status})`);
        }
        setFiles(filesToSave);
        setAutoSaved(true);
        onSave(variant.id, filesToSave);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [variant.id, variant.projectId, onSave],
  );

  const handleFileSelect = (path: string) => {
    const updated = filesRef.current.map((f) =>
      f.path === selectedPathRef.current ? { ...f, content } : f,
    );
    setFiles(updated);
    filesRef.current = updated;
    setSelectedPath(path);
    selectedPathRef.current = path;
    setContent(updated.find((f) => f.path === path)?.content ?? "");
  };

  const handleSave = () => {
    const updated = filesRef.current.map((f) =>
      f.path === selectedPathRef.current ? { ...f, content } : f,
    );
    void doSave(updated);
  };

  const handleContentChange = (val: string | undefined) => {
    const newContent = val ?? "";
    setContent(newContent);
    setAutoSaved(false);
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => {
      const updated = filesRef.current.map((f) =>
        f.path === selectedPathRef.current ? { ...f, content: newContent } : f,
      );
      void doSave(updated);
    }, 1500);
  };

  useEffect(
    () => () => {
      if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    },
    [],
  );

  const getLanguage = (path: string): string => {
    if (path.endsWith(".html")) return "html";
    if (path.endsWith(".css")) return "css";
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "javascript";
    if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
    if (path.endsWith(".json")) return "json";
    if (path.endsWith(".svg")) return "xml";
    return "plaintext";
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 backdrop-blur-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Editing: {variant.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {error}
            </span>
          )}
          {autoSaved && !saving && <span className="text-xs text-emerald-400">Auto-saved</span>}
          {saving && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" /> Saving…
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5"
            onClick={handleSave}
            disabled={saving || loading}
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-44 border-r border-border bg-zinc-900 flex flex-col shrink-0">
          <div className="px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide border-b border-border">
            Files
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => handleFileSelect(f.path)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs font-mono truncate transition-colors",
                    selectedPath === f.path
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {f.path}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading files…</span>
            </div>
          ) : (
            <Editor
              height="100%"
              language={getLanguage(selectedPath)}
              value={content}
              onChange={handleContentChange}
              theme="vs-dark"
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: "on",
                tabSize: 2,
                lineNumbers: "on",
                renderLineHighlight: "all",
                folding: true,
                automaticLayout: true,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const CANVAS_STATE_LS_KEY = (projectId: number) => `mustaflow_canvas_state_${projectId}`;

function lsLoadCanvasState(projectId: number): CanvasState {
  try {
    const raw = localStorage.getItem(CANVAS_STATE_LS_KEY(projectId));
    if (raw) return JSON.parse(raw) as CanvasState;
  } catch {
    /* ignore */
  }
  return { explorationId: null, tiles: {} };
}

function lsSaveCanvasState(projectId: number, state: CanvasState): void {
  try {
    localStorage.setItem(CANVAS_STATE_LS_KEY(projectId), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

interface DevCanvasTabProps {
  projectId: number;
  onProjectFilesChanged?: () => void;
}

export function DevCanvasTab({ projectId, onProjectFilesChanged }: DevCanvasTabProps) {
  const [prompt, setPrompt] = useState("");
  const [variants, setVariants] = useState<CanvasVariant[]>([]);
  const [generating, setGenerating] = useState(false);
  const [graduating, setGraduating] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingVariant, setEditingVariant] = useState<CanvasVariant | null>(null);
  const [canvasState, setCanvasState] = useState<CanvasState>(() => lsLoadCanvasState(projectId));

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasPending = variants.some((v) => v.status === "pending" || v.status === "generating");

  // Load state from server on mount (falls back to localStorage already set in useState init)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/canvas/state`);
        if (!res.ok) return;
        const json = (await res.json()) as { canvasState?: Record<string, unknown> };
        const serverState = json.canvasState;
        if (serverState && Object.keys(serverState).length > 0) {
          const parsed: CanvasState = {
            explorationId: (serverState.explorationId as string | null) ?? null,
            tiles: (serverState.tiles as Record<number, TileState>) ?? {},
          };
          setCanvasState(parsed);
          lsSaveCanvasState(projectId, parsed);
        }
      } catch {
        /* non-fatal — keep localStorage state */
      }
    };
    void load();
  }, [projectId]);

  const fetchVariants = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/canvas/variants`);
      if (!res.ok) return;
      const json = (await res.json()) as { variants: CanvasVariant[] };
      setVariants(json.variants ?? []);
    } catch {
      /* non-fatal */
    }
  }, [projectId]);

  useEffect(() => {
    void fetchVariants();
  }, [fetchVariants]);

  useEffect(() => {
    if (hasPending) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(() => {
          void fetchVariants();
        }, 2500);
      }
    } else {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [hasPending, fetchVariants]);

  // Debounced server save (1 s after last state change)
  const persistState = useCallback(
    (state: CanvasState) => {
      lsSaveCanvasState(projectId, state);
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = setTimeout(() => {
        fetch(`/api/projects/${projectId}/canvas/state`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ canvasState: state }),
        }).catch(() => {});
      }, 1000);
    },
    [projectId],
  );

  const updateCanvasState = useCallback(
    (updater: (prev: CanvasState) => CanvasState) => {
      setCanvasState((prev) => {
        const next = updater(prev);
        persistState(next);
        return next;
      });
    },
    [persistState],
  );

  // Cleanup debounce on unmount
  useEffect(
    () => () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    },
    [],
  );

  // Memoised tile state getter (includes colSpan default)
  const _tiles = canvasState.tiles;
  const getTileState = useMemo(
    () =>
      (variantId: number): TileState =>
        _tiles[variantId] ?? { device: "desktop", colSpan: 1 },
    [_tiles],
  );

  const handleGenerate = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? prompt).trim();
    if (!text) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/canvas/explore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text, variantCount: 3 }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Generation failed (${res.status})`);
      }
      const json = (await res.json()) as {
        explorationId: string;
        variants: CanvasVariant[];
      };
      setVariants((prev) => [...json.variants, ...prev]);
      updateCanvasState((s) => ({ ...s, explorationId: json.explorationId }));
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleThemeChip = (chip: { label: string; prompt: string }) => {
    setPrompt(chip.prompt);
    void handleGenerate(chip.prompt);
  };

  const handleGraduate = async (variant: CanvasVariant) => {
    setGraduating(variant.id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/canvas/variants/${variant.id}/graduate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Apply failed (${res.status})`);
      }
      setRefreshKey((k) => k + 1);
      onProjectFilesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGraduating(null);
    }
  };

  const handleDelete = async (variant: CanvasVariant) => {
    try {
      await fetch(`/api/projects/${projectId}/canvas/variants/${variant.id}`, {
        method: "DELETE",
      });
      setVariants((prev) => prev.filter((v) => v.id !== variant.id));
      updateCanvasState((s) => {
        const tiles = { ...s.tiles };
        delete tiles[variant.id];
        return { ...s, tiles };
      });
    } catch {
      /* non-fatal */
    }
  };

  const handleDeviceChange = (variantId: number, device: DeviceWidth) => {
    updateCanvasState((s) => ({
      ...s,
      tiles: { ...s.tiles, [variantId]: { ...s.tiles[variantId], device } },
    }));
  };

  const handleEditSave = (variantId: number, _files: VariantFile[]) => {
    // Refresh the iframe tile; do NOT close the overlay — user closes it explicitly.
    setRefreshKey((k) => k + 1);
    setVariants((prev) =>
      prev.map((v) => (v.id === variantId ? { ...v, status: "ready" as const } : v)),
    );
  };

  const handleColSpanChange = (variantId: number, colSpan: TileColSpan) => {
    updateCanvasState((s) => ({
      ...s,
      tiles: { ...s.tiles, [variantId]: { ...getTileState(variantId), colSpan } },
    }));
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      {/* Header toolbar */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground">Canvas</span>
          <span className="text-xs text-muted-foreground">— visual UI variant generation</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 ml-auto"
            onClick={() => void fetchVariants()}
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Theme quick-pick chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {THEME_CHIPS.map((chip) => (
            <button
              key={chip.label}
              onClick={() => handleThemeChip(chip)}
              disabled={generating}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-border bg-muted/30 text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* Prompt input */}
        <div className="flex items-center gap-2">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleGenerate();
              }
            }}
            placeholder="Describe a design direction… (e.g. 'make it more minimal and dark')"
            className="h-8 text-xs"
            disabled={generating}
          />
          <Button
            size="sm"
            className="h-8 gap-1.5 shrink-0"
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim() || generating}
          >
            {generating ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Generate
          </Button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}
      </div>

      {/* Variant board */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {variants.length === 0 && !generating && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Layers className="h-8 w-8 text-primary/50" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-1">No variants yet</h3>
              <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                Type a design direction above or pick a quick-start theme chip to generate 3
                parallel UI variants side by side.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-sm">
              {THEME_CHIPS.slice(0, 3).map((chip) => (
                <button
                  key={chip.label}
                  onClick={() => handleThemeChip(chip)}
                  className="text-xs font-medium px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  Try: {chip.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {variants.length > 0 && (
          <div className="grid gap-4 auto-rows-[420px] grid-cols-4">
            {variants.map((variant) => {
              const ts = getTileState(variant.id);
              return (
                <div
                  key={variant.id}
                  style={{ gridColumn: `span ${ts.colSpan}` }}
                  className="min-w-0"
                >
                  <VariantTile
                    variant={variant}
                    tileState={ts}
                    onDeviceChange={handleDeviceChange}
                    onResize={handleColSpanChange}
                    onGraduate={handleGraduate}
                    onDelete={handleDelete}
                    onEdit={setEditingVariant}
                    refreshKey={refreshKey}
                    graduating={graduating === variant.id}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit overlay */}
      {editingVariant && (
        <EditOverlay
          variant={editingVariant}
          onClose={() => setEditingVariant(null)}
          onSave={handleEditSave}
        />
      )}
    </div>
  );
}
