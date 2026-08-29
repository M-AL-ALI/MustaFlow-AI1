import { authFetch } from "@/lib/api-fetch";
import { formatAssetBytes, uploadAccountAsset } from "@/lib/asset-upload";
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
  Upload,
  Pencil,
  X,
  FileText,
  HardDrive,
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

interface UnifiedAsset {
  id: number;
  kind: string;
  source: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scanState: string;
  contentUrl: string;
  createdAt: string;
}

interface StoragePlan {
  sku: string;
  label: string;
  allowanceBytes: number;
  monthlyCents: number;
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

function ImageCard({
  image,
  onDelete,
  onEditClick,
}: {
  image: GeneratedImage;
  onDelete: (id: number) => void;
  onEditClick: (image: GeneratedImage) => void;
}) {
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
      await authFetch(`/api/images/${image.id}`, { method: "DELETE" });
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
            onClick={() => onEditClick(image)}
            className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
            title="Edit with AI"
          >
            <Pencil className="h-3.5 w-3.5" />
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
  const [assets, setAssets] = useState<UnifiedAsset[]>([]);
  const [quota, setQuota] = useState<{
    usedBytes: number;
    reservedBytes: number;
    limitBytes: number;
  }>();
  const [storagePlans, setStoragePlans] = useState<StoragePlan[]>([]);
  const [storageBusy, setStorageBusy] = useState<string | null>(null);
  const [assetNotice, setAssetNotice] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingJobsRef = useRef<Set<string>>(new Set());

  // Upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Edit modal
  const [editingImage, setEditingImage] = useState<GeneratedImage | null>(null);
  const [editInstruction, setEditInstruction] = useState("");
  const [editQuality, setEditQuality] = useState<"standard" | "high">("standard");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const selectedQuality = QUALITY_OPTIONS.find((q) => q.value === quality)!;
  const totalCost = selectedQuality.cost * variationCount;

  const fetchImages = useCallback(async () => {
    try {
      const res = await authFetch("/api/images?limit=40");
      if (res.ok) {
        const data = (await res.json()) as { images: GeneratedImage[] };
        setImages(data.images);
      }
    } finally {
      setLoadingImages(false);
    }
  }, []);

  const fetchAssets = useCallback(async () => {
    const [assetResponse, storageResponse] = await Promise.all([
      authFetch("/api/assets?limit=100"),
      authFetch("/api/assets/storage-plans"),
    ]);
    if (assetResponse.ok) {
      const body = (await assetResponse.json()) as { assets?: UnifiedAsset[] };
      setAssets(body.assets ?? []);
    }
    if (storageResponse.ok) {
      const body = (await storageResponse.json()) as {
        quota?: { usedBytes: number; reservedBytes: number; limitBytes: number };
        plans?: StoragePlan[];
      };
      setQuota(body.quota);
      setStoragePlans(body.plans ?? []);
    }
  }, []);

  useEffect(() => {
    void fetchImages();
    void fetchAssets();
  }, [fetchAssets, fetchImages]);

  // Polling for pending jobs
  useEffect(() => {
    const poll = async () => {
      if (pendingJobsRef.current.size === 0) return;
      const toCheck = Array.from(pendingJobsRef.current);
      for (const jobId of toCheck) {
        try {
          const res = await authFetch(`/api/images/status/${jobId}`);
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
      const res = await authFetch("/api/images/generate", {
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploadError(null);
    setAssetNotice(null);
    setUploading(true);
    try {
      const uploaded = await uploadAccountAsset({ file, source: "picker" });
      setAssetNotice(
        uploaded.resized
          ? "The image was resized for a faster app while keeping full visual detail."
          : `${uploaded.name} is ready in your private asset library.`,
      );
      await fetchAssets();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Network error — please try again");
    } finally {
      setUploading(false);
    }
  };

  const handleAssetDelete = async (asset: UnifiedAsset) => {
    setUploadError(null);
    const response = await authFetch(`/api/assets/${asset.id}`, { method: "DELETE" });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setUploadError(body.error ?? "This asset could not be deleted.");
      return;
    }
    setAssets((current) => current.filter((entry) => entry.id !== asset.id));
    await fetchAssets();
  };

  const startStorageCheckout = async (sku: string) => {
    setStorageBusy(sku);
    setUploadError(null);
    try {
      const response = await authFetch("/api/assets/storage-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        error?: string;
      };
      if (!response.ok || !body.checkoutUrl) {
        setUploadError(body.error ?? "Storage checkout is temporarily unavailable.");
        return;
      }
      window.location.assign(body.checkoutUrl);
    } catch {
      setUploadError("Storage checkout is temporarily unavailable.");
    } finally {
      setStorageBusy(null);
    }
  };

  const handleEditSubmit = async () => {
    if (!editingImage || !editInstruction.trim() || editSubmitting) return;
    setEditError(null);
    setEditSubmitting(true);
    try {
      const res = await authFetch(`/api/images/${editingImage.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: editInstruction.trim(), quality: editQuality }),
      });
      const body = (await res.json()) as {
        jobId?: string;
        imageId?: number;
        creditCost?: number;
        error?: string;
      };
      if (!res.ok) {
        setEditError(body.error ?? "Edit failed");
        return;
      }
      const placeholder: GeneratedImage = {
        id: body.imageId!,
        prompt: editInstruction.trim(),
        quality: editQuality,
        aspectRatio: editingImage.aspectRatio,
        style: editingImage.style ?? null,
        purpose: editingImage.purpose ?? null,
        status: "pending",
        creditCost: body.creditCost ?? (editQuality === "high" ? 6 : 3),
        createdAt: new Date().toISOString(),
      };
      setImages((prev) => [placeholder, ...prev]);
      if (body.jobId) pendingJobsRef.current.add(body.jobId);
      setEditingImage(null);
      setEditInstruction("");
      setEditQuality("standard");
    } catch {
      setEditError("Network error — please try again");
    } finally {
      setEditSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <div className="p-2 rounded-lg bg-primary/10">
          <ImagePlus className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-semibold">Assets &amp; Image Studio</h1>
          <p className="text-xs text-muted-foreground">
            Upload once, see where assets are used, and generate project-ready images
          </p>
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

          {/* Upload section */}
          <div className="border-t border-border pt-4 space-y-2">
            <p className="text-xs font-medium text-foreground">Upload an asset</p>
            <p className="text-[10px] text-muted-foreground">
              Images, screenshots, documents, spreadsheets and short recordings share one private
              library and one 500 MB allowance.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.webm,.mp4"
              className="hidden"
              onChange={(e) => void handleFileChange(e)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-2 rounded-lg border text-xs font-medium transition-colors",
                "border-border bg-muted text-muted-foreground hover:text-foreground hover:border-border/80",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {uploading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5" />
                  Choose file
                </>
              )}
            </button>
            {uploadError && (
              <p className="text-[10px] text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3 shrink-0" />
                {uploadError}
              </p>
            )}
            {assetNotice && <p className="text-[10px] text-emerald-500">{assetNotice}</p>}
          </div>

          <div className="border-t border-border pt-4 space-y-2" data-testid="asset-quota-panel">
            <div className="flex items-center gap-2">
              <HardDrive className="h-3.5 w-3.5 text-primary" />
              <p className="text-xs font-medium text-foreground">Storage</p>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {quota
                ? `${formatAssetBytes(quota.usedBytes + quota.reservedBytes)} used of ${formatAssetBytes(quota.limitBytes)}`
                : "Reading your private storage allowance…"}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${Math.min(100, quota ? ((quota.usedBytes + quota.reservedBytes) / quota.limitBytes) * 100 : 0)}%`,
                }}
              />
            </div>
            <div className="grid grid-cols-1 gap-1.5 pt-1">
              {storagePlans.map((plan) => (
                <button
                  key={plan.sku}
                  type="button"
                  onClick={() => void startStorageCheckout(plan.sku)}
                  disabled={storageBusy !== null}
                  className="flex items-center justify-between rounded-lg border border-border bg-muted px-2.5 py-2 text-[10px] hover:text-foreground disabled:opacity-50"
                >
                  <span>Add {plan.label}</span>
                  <span className="font-semibold">
                    ${(plan.monthlyCents / 100).toFixed(2)}/month
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right panel — Gallery */}
        <div className="flex-1 overflow-y-auto p-4">
          <section className="mb-6" data-testid="unified-asset-library">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Private asset library</h2>
                <p className="text-[10px] text-muted-foreground">
                  Every stored asset has a tenant-scoped receipt. Referenced assets cannot be
                  deleted.
                </p>
              </div>
              <span className="text-[10px] text-muted-foreground">{assets.length} recent</span>
            </div>
            {assets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                Upload an asset or ask Zero to observe a preview. It will appear here.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {assets.map((asset) => (
                  <article
                    key={asset.id}
                    className="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    {asset.mimeType.startsWith("image/") ? (
                      <img
                        src={asset.contentUrl}
                        alt={asset.filename}
                        className="aspect-square w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex aspect-square items-center justify-center bg-muted">
                        <FileText className="h-8 w-8 text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="space-y-1 p-2">
                      <p className="truncate text-[11px] font-medium" title={asset.filename}>
                        {asset.filename}
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        {formatAssetBytes(asset.sizeBytes)} · {asset.source}
                      </p>
                      <div className="flex gap-1">
                        <a
                          href={asset.contentUrl}
                          className="flex-1 rounded bg-muted px-2 py-1 text-center text-[9px] hover:text-foreground"
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          onClick={() => void handleAssetDelete(asset)}
                          className="rounded bg-muted p-1 text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${asset.filename}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="mb-3 border-t border-border pt-4">
            <h2 className="text-sm font-semibold">Generated images</h2>
          </div>
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
                <ImageCard
                  key={img.id}
                  image={img}
                  onDelete={handleDelete}
                  onEditClick={setEditingImage}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Edit modal */}
      {editingImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-background border border-border rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Pencil className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Edit with AI</span>
              </div>
              <button
                onClick={() => {
                  setEditingImage(null);
                  setEditInstruction("");
                  setEditError(null);
                }}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {editingImage.fileUrl && (
                <img
                  src={editingImage.thumbnailUrl ?? editingImage.fileUrl}
                  alt={editingImage.prompt}
                  className="w-full max-h-40 object-cover rounded-lg border border-border"
                />
              )}
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">
                  Edit instruction
                </label>
                <textarea
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  placeholder="Describe what you want to change…"
                  rows={3}
                  autoFocus
                  className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground mb-1.5">Quality</label>
                <div className="flex gap-1.5">
                  {(["standard", "high"] as const).map((q) => (
                    <button
                      key={q}
                      onClick={() => setEditQuality(q)}
                      className={cn(
                        "flex-1 py-1.5 rounded-lg border text-xs font-medium transition-colors",
                        editQuality === q
                          ? "border-primary/50 bg-primary/8 text-foreground"
                          : "border-border bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {q === "standard" ? "Standard · 3 credits" : "High · 6 credits"}
                    </button>
                  ))}
                </div>
              </div>
              {editError && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {editError}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setEditingImage(null);
                    setEditInstruction("");
                    setEditError(null);
                  }}
                  className="flex-1 py-2 rounded-lg border border-border bg-muted text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleEditSubmit()}
                  disabled={!editInstruction.trim() || editSubmitting}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-colors",
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                  )}
                >
                  {editSubmitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Applying…
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      Apply edit
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
