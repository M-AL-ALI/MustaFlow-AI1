import { useState, useEffect, useRef, useCallback } from "react";
import {
  ImagePlus,
  Loader2,
  Download,
  Trash2,
  Wand2,
  Info,
  AlertCircle,
  Image,
  ChevronDown,
  ChevronUp,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GeneratedImage {
  id: number;
  prompt: string;
  negativePrompt?: string | null;
  revisedPrompt?: string | null;
  style?: string | null;
  purpose?: string | null;
  quality: string;
  aspectRatio: string;
  transparentBackground?: boolean;
  providerName?: string;
  modelName?: string | null;
  status: string;
  fileUrl?: string | null;
  thumbnailUrl?: string | null;
  creditCost: number;
  errorMessage?: string | null;
  createdAt: string;
}

interface GenerateResponse {
  jobId: string;
  imageId: number;
  creditCost: number;
  status: string;
  jobIds?: string[];
  imageIds?: number[];
}

interface JobStatusResponse {
  jobId: string;
  imageId: number;
  status: string;
  fileUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const QUALITY_OPTIONS = [
  { value: "draft", label: "Draft", description: "Fastest · 1 credit", cost: 1 },
  { value: "standard", label: "Standard", description: "Balanced · 3 credits", cost: 3 },
  { value: "high", label: "High", description: "Best quality · 6 credits", cost: 6 },
] as const;

const ASPECT_RATIO_OPTIONS = [
  { value: "1:1", label: "Square", short: "1:1", icon: "■" },
  { value: "16:9", label: "Landscape", short: "16:9", icon: "▬" },
  { value: "9:16", label: "Portrait", short: "9:16", icon: "▮" },
] as const;

const STYLE_OPTIONS = [
  { value: "vivid", label: "Vivid", description: "Bold, saturated" },
  { value: "natural", label: "Natural", description: "Realistic, muted" },
] as const;

const PURPOSE_OPTIONS = [
  { value: "general", label: "General" },
  { value: "marketing", label: "Marketing" },
  { value: "avatar", label: "Avatar" },
  { value: "illustration", label: "Illustration" },
  { value: "background", label: "Background" },
  { value: "product", label: "Product" },
] as const;

const VARIATION_OPTIONS = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 4, label: "4" },
] as const;

const POLL_INTERVAL_MS = 2000;

// ── Label pill ────────────────────────────────────────────────────────────────

function LabelPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[9px] text-white/60 bg-white/10 px-1.5 py-0.5 rounded leading-none">
      {children}
    </span>
  );
}

// ── Image card ────────────────────────────────────────────────────────────────

function ImageCard({ image, onDelete }: { image: GeneratedImage; onDelete: (id: number) => void }) {
  const [deleting, setDeleting] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const handleDownload = () => {
    if (!image.fileUrl) return;
    const a = document.createElement("a");
    a.href = image.fileUrl;
    a.download = `image-studio-${image.id}.webp`;
    a.click();
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await fetch(`/api/images/${image.id}`, { method: "DELETE" });
      onDelete(image.id);
    } catch {
      setDeleting(false);
    }
  };

  if (image.status === "pending" || image.status === "generating") {
    return (
      <div className="rounded-xl border border-border bg-card overflow-hidden aspect-square flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-xs">
            {image.status === "generating" ? "Generating…" : "Queued…"}
          </span>
        </div>
      </div>
    );
  }

  if (image.status === "failed") {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden aspect-square flex items-center justify-center p-3">
        <div className="flex flex-col items-center gap-2 text-center">
          <AlertCircle className="h-5 w-5 text-destructive/70" />
          <span className="text-[11px] text-destructive/80">Generation failed</span>
          {image.errorMessage && (
            <span className="text-[10px] text-muted-foreground line-clamp-2">
              {image.errorMessage}
            </span>
          )}
          <button
            onClick={() => void handleDelete()}
            className="mt-1 text-[10px] text-muted-foreground hover:text-destructive transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!image.fileUrl) return null;

  return (
    <div className="group rounded-xl border border-border bg-card overflow-hidden relative">
      <img
        src={image.thumbnailUrl ?? image.fileUrl}
        alt={image.prompt}
        className="w-full aspect-square object-cover"
        loading="lazy"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex flex-col justify-end p-3 gap-2">
        <button onClick={() => setShowPrompt((v) => !v)} className="text-left">
          <p className="text-white text-[11px] line-clamp-2 leading-snug">
            {showPrompt ? (image.revisedPrompt ?? image.prompt) : image.prompt}
          </p>
        </button>

        {/* Labels */}
        <div className="flex flex-wrap gap-1">
          <LabelPill>{image.quality}</LabelPill>
          <LabelPill>{image.aspectRatio}</LabelPill>
          {image.style && <LabelPill>{image.style}</LabelPill>}
          {image.purpose && <LabelPill>{image.purpose}</LabelPill>}
          {image.transparentBackground && <LabelPill>transparent</LabelPill>}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex-1" />
          <button
            onClick={handleDownload}
            className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
            title="Download"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-destructive/60 transition-colors disabled:opacity-50"
            title="Delete"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            disabled
            title="Use in Project — Coming soon"
            className="p-1.5 rounded-lg bg-white/10 text-white/40 cursor-not-allowed"
          >
            <Image className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ImageStudioPage() {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [showNegativePrompt, setShowNegativePrompt] = useState(false);
  const [quality, setQuality] = useState<"draft" | "standard" | "high">("standard");
  const [aspectRatio, setAspectRatio] = useState<"1:1" | "16:9" | "9:16">("1:1");
  const [style, setStyle] = useState<"vivid" | "natural">("vivid");
  const [purpose, setPurpose] = useState<string>("general");
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [variationCount, setVariationCount] = useState<1 | 2 | 4>(1);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [loadingImages, setLoadingImages] = useState(true);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingJobsRef = useRef<Set<string>>(new Set());

  const selectedQuality = QUALITY_OPTIONS.find((q) => q.value === quality)!;
  const totalCost = selectedQuality.cost * variationCount;

  const fetchImages = useCallback(async () => {
    try {
      const res = await fetch("/api/images?limit=40");
      if (res.ok) {
        const data = (await res.json()) as { images: GeneratedImage[] };
        setImages(data.images);
      }
    } finally {
      setLoadingImages(false);
    }
  }, []);

  useEffect(() => {
    void fetchImages();
  }, [fetchImages]);

  // Polling for pending jobs
  useEffect(() => {
    const poll = async () => {
      if (pendingJobsRef.current.size === 0) return;
      const toCheck = Array.from(pendingJobsRef.current);
      for (const jobId of toCheck) {
        try {
          const res = await fetch(`/api/images/status/${jobId}`);
          if (!res.ok) {
            pendingJobsRef.current.delete(jobId);
            continue;
          }
          const job = (await res.json()) as JobStatusResponse;
          if (job.status === "completed" || job.status === "failed") {
            pendingJobsRef.current.delete(jobId);
            void fetchImages();
          } else {
            setImages((prev) =>
              prev.map((img) => (img.id === job.imageId ? { ...img, status: job.status } : img)),
            );
          }
        } catch {
          // ignore transient network errors
        }
      }
    };

    pollingRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [fetchImages]);

  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return;
    setError(null);
    setGenerating(true);

    try {
      const res = await fetch("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim() || undefined,
          quality,
          aspectRatio,
          style,
          purpose,
          transparentBackground,
          variationCount,
        }),
      });

      const body = (await res.json()) as GenerateResponse & { error?: string };

      if (!res.ok) {
        setError(body.error ?? "Generation failed");
        return;
      }

      const jobIds = body.jobIds ?? [body.jobId];
      const imageIds = body.imageIds ?? [body.imageId];

      // Add placeholder rows for each variation
      const placeholders: GeneratedImage[] = imageIds.map((id) => ({
        id,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() || null,
        quality,
        aspectRatio,
        style,
        purpose,
        transparentBackground,
        status: "pending",
        creditCost: selectedQuality.cost,
        createdAt: new Date().toISOString(),
      }));
      setImages((prev) => [...placeholders, ...prev]);
      jobIds.forEach((id) => pendingJobsRef.current.add(id));
    } catch {
      setError("Network error — please try again");
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = (id: number) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <div className="p-2 rounded-lg bg-primary/10">
          <ImagePlus className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-semibold">Image Studio</h1>
          <p className="text-xs text-muted-foreground">Generate AI images for your projects</p>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel — Generation form */}
        <div className="w-80 shrink-0 border-r border-border overflow-y-auto p-4 space-y-4">
          {/* Prompt */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the image you want to generate…"
              rows={5}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/50 transition-colors"
            />
            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-muted-foreground">{prompt.length}/4000</span>
            </div>
          </div>

          {/* Negative prompt (collapsible) */}
          <div>
            <button
              onClick={() => setShowNegativePrompt((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
            >
              {showNegativePrompt ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span className="font-medium">Negative prompt</span>
              {negativePrompt && (
                <span className="ml-auto text-[10px] text-primary/70">active</span>
              )}
            </button>
            {showNegativePrompt && (
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="Things to avoid: blurry, low quality, watermark…"
                rows={3}
                className="mt-1.5 w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/50 transition-colors"
              />
            )}
          </div>

          {/* Purpose */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Purpose</label>
            <div className="grid grid-cols-3 gap-1.5">
              {PURPOSE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPurpose(opt.value)}
                  className={cn(
                    "py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-colors",
                    purpose === opt.value
                      ? "border-primary/50 bg-primary/8 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Quality */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Quality</label>
            <div className="space-y-1.5">
              {QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setQuality(opt.value)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-colors text-left",
                    quality === opt.value
                      ? "border-primary/50 bg-primary/8 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:border-border/80 hover:text-foreground",
                  )}
                >
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-[10px]">{opt.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Aspect ratio */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Aspect Ratio</label>
            <div className="flex gap-1.5">
              {ASPECT_RATIO_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setAspectRatio(opt.value as typeof aspectRatio)}
                  title={opt.label}
                  className={cn(
                    "flex-1 py-2 rounded-lg border text-xs font-medium transition-colors",
                    aspectRatio === opt.value
                      ? "border-primary/50 bg-primary/8 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  <div className="flex flex-col items-center gap-0.5">
                    <span>{opt.icon}</span>
                    <span className="text-[10px]">{opt.short}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Style */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Style</label>
            <div className="flex gap-1.5">
              {STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setStyle(opt.value)}
                  className={cn(
                    "flex-1 flex flex-col items-center py-2 rounded-lg border text-xs transition-colors",
                    style === opt.value
                      ? "border-primary/50 bg-primary/8 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-[10px] text-muted-foreground">{opt.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Transparent background */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-foreground">Transparent background</p>
              <p className="text-[10px] text-muted-foreground">PNG with alpha channel</p>
            </div>
            <button
              onClick={() => setTransparentBackground((v) => !v)}
              className={cn(
                "relative w-9 h-5 rounded-full border transition-colors",
                transparentBackground ? "bg-primary border-primary" : "bg-muted border-border",
              )}
              role="switch"
              aria-checked={transparentBackground}
            >
              <span
                className={cn(
                  "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm",
                  transparentBackground ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          {/* Variations */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                Variations
              </span>
            </label>
            <div className="flex gap-1.5">
              {VARIATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setVariationCount(opt.value as 1 | 2 | 4)}
                  className={cn(
                    "flex-1 py-2 rounded-lg border text-xs font-medium transition-colors",
                    variationCount === opt.value
                      ? "border-primary/50 bg-primary/8 text-foreground"
                      : "border-border bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Generate multiple variations of the same prompt
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Generate button + cost preview */}
          <div className="space-y-2">
            <button
              onClick={() => void handleGenerate()}
              disabled={!prompt.trim() || generating}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4" />
                  Generate
                </>
              )}
            </button>

            {/* Cost preview */}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
              <span>
                {variationCount} × {selectedQuality.cost} credit
                {selectedQuality.cost !== 1 ? "s" : ""} ({selectedQuality.label.toLowerCase()})
              </span>
              <span className="font-semibold text-foreground/80">
                = {totalCost} credit{totalCost !== 1 ? "s" : ""}
              </span>
            </div>
          </div>

          {/* Info note */}
          <div className="flex items-start gap-2 text-[10px] text-muted-foreground">
            <Info className="h-3 w-3 shrink-0 mt-0.5" />
            <span>
              Credits are deducted when generation starts. Failed jobs are automatically refunded.
            </span>
          </div>
        </div>

        {/* Right panel — Gallery */}
        <div className="flex-1 overflow-y-auto p-4">
          {loadingImages ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
              <div className="p-5 rounded-2xl bg-muted">
                <ImagePlus className="h-10 w-10 text-muted-foreground/40" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground/70">No images yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Enter a prompt and click Generate to create your first image
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {images.map((img) => (
                <ImageCard key={img.id} image={img} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
