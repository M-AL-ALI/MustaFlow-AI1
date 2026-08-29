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
  assetId?: number | null;
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
  context?: {
    altText?: string;
    brandRole?: "none" | "logo" | "icon" | "palette" | "font" | "reference";
    derivativeOfAssetId?: number;
    derivativePreset?: string;
  } | null;
  createdAt: string;
}

interface StoragePlan {
  sku: string;
  label: string;
  allowanceBytes: number;
  monthlyCents: number;
}

interface AssetUsage {
  id: number;
  projectId: number | null;
  versionId: number | null;
  filePath: string | null;
  consumer: string;
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
  onUseClick,
}: {
  image: GeneratedImage;
  onDelete: (id: number) => void;
  onEditClick: (image: GeneratedImage) => void;
  onUseClick: (image: GeneratedImage) => void;
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
            onClick={() => onUseClick(image)}
            disabled={!image.assetId}
            title={image.assetId ? "Use in Project" : "This image is still being prepared"}
            className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors disabled:text-white/40 disabled:cursor-not-allowed"
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
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([]);
  const [usingAsset, setUsingAsset] = useState<{ assetId: number; label: string } | null>(null);
  const [useProjectId, setUseProjectId] = useState<number | null>(null);
  const [useBusy, setUseBusy] = useState(false);
  const [quota, setQuota] = useState<{
    usedBytes: number;
    reservedBytes: number;
    limitBytes: number;
  }>();
  const [storagePlans, setStoragePlans] = useState<StoragePlan[]>([]);
  const [storageBusy, setStorageBusy] = useState<string | null>(null);
  const [analysisUsage, setAnalysisUsage] = useState<{
    count: number;
    estimatedProviderCostMicros: number;
  }>();
  const [assetNotice, setAssetNotice] = useState<string | null>(null);
  const [assetBusy, setAssetBusy] = useState<number | null>(null);
  const [usageAsset, setUsageAsset] = useState<UnifiedAsset | null>(null);
  const [assetUsages, setAssetUsages] = useState<AssetUsage[]>([]);
  const [usageBusy, setUsageBusy] = useState(false);
  const [replacementAssetId, setReplacementAssetId] = useState<number | null>(null);
  const [assetDrafts, setAssetDrafts] = useState<
    Record<number, { altText: string; brandRole: string }>
  >({});

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
    const [assetResponse, storageResponse, analysisResponse] = await Promise.all([
      authFetch("/api/assets?limit=100"),
      authFetch("/api/assets/storage-plans"),
      authFetch("/api/assets/analysis-usage"),
    ]);
    if (assetResponse.ok) {
      const body = (await assetResponse.json()) as { assets?: UnifiedAsset[] };
      const nextAssets = body.assets ?? [];
      setAssets(nextAssets);
      setAssetDrafts((current) =>
        Object.fromEntries(
          nextAssets.map((asset) => [
            asset.id,
            current[asset.id] ?? {
              altText:
                asset.context?.altText ??
                (asset.mimeType.startsWith("image/")
                  ? asset.filename.replace(/[-_]+/g, " ").replace(/\.[^.]+$/u, "")
                  : ""),
              brandRole: asset.context?.brandRole ?? "none",
            },
          ]),
        ),
      );
    }
    if (storageResponse.ok) {
      const body = (await storageResponse.json()) as {
        quota?: { usedBytes: number; reservedBytes: number; limitBytes: number };
        plans?: StoragePlan[];
      };
      setQuota(body.quota);
      setStoragePlans(body.plans ?? []);
    }
    if (analysisResponse.ok) {
      const body = (await analysisResponse.json()) as {
        total?: { count: number; estimatedProviderCostMicros: number };
      };
      setAnalysisUsage(body.total);
    }
  }, []);

  useEffect(() => {
    void fetchImages();
    void fetchAssets();
    void authFetch("/api/projects")
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : []))
      .then((value) => {
        const rows = Array.isArray(value) ? value : [];
        const available = rows
          .filter(
            (row): row is { id: number; name: string } =>
              Boolean(row) &&
              typeof row === "object" &&
              Number.isSafeInteger((row as { id?: unknown }).id) &&
              typeof (row as { name?: unknown }).name === "string",
          )
          .map((row) => ({ id: row.id, name: row.name }));
        setProjects(available);
        setUseProjectId((current) => current ?? available[0]?.id ?? null);
      })
      .catch(() => setProjects([]));
  }, [fetchAssets, fetchImages]);

  const useAssetInProject = async () => {
    if (!usingAsset || useProjectId === null) return;
    setUseBusy(true);
    setUploadError(null);
    try {
      const response = await authFetch(
        `/api/projects/${useProjectId}/assets/${usingAsset.assetId}/materialize`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        src?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "The asset could not be added.");
      setAssetNotice(`${usingAsset.label} is ready in the selected project at ${body.src}.`);
      setUsingAsset(null);
      await fetchAssets();
    } catch (useError) {
      setUploadError(
        useError instanceof Error ? useError.message : "The asset could not be added.",
      );
    } finally {
      setUseBusy(false);
    }
  };

  const saveAssetDetails = async (assetId: number) => {
    const draft = assetDrafts[assetId];
    if (!draft) return;
    setAssetBusy(assetId);
    setUploadError(null);
    try {
      const response = await authFetch(`/api/assets/${assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Asset details could not be saved.");
      setAssetNotice("Asset details saved for Zero and published-app accessibility checks.");
      await fetchAssets();
    } catch (detailsError) {
      setUploadError(
        detailsError instanceof Error ? detailsError.message : "Asset details could not be saved.",
      );
    } finally {
      setAssetBusy(null);
    }
  };

  const createAppSizes = async (assetId: number) => {
    setAssetBusy(assetId);
    setUploadError(null);
    try {
      const response = await authFetch(`/api/assets/${assetId}/derivatives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        derivatives?: unknown[];
      };
      if (!response.ok) throw new Error(body.error ?? "App-ready sizes could not be created.");
      setAssetNotice(`${body.derivatives?.length ?? 0} app-ready sizes were added to the library.`);
      await fetchAssets();
    } catch (derivativeError) {
      setUploadError(
        derivativeError instanceof Error
          ? derivativeError.message
          : "App-ready sizes could not be created.",
      );
    } finally {
      setAssetBusy(null);
    }
  };

  const openAssetUsage = async (asset: UnifiedAsset) => {
    setUsageAsset(asset);
    setAssetUsages([]);
    setReplacementAssetId(
      assets.find((candidate) => candidate.id !== asset.id && candidate.scanState !== "threat")
        ?.id ?? null,
    );
    setUsageBusy(true);
    setUploadError(null);
    try {
      const response = await authFetch(`/api/assets/${asset.id}/usage`);
      const body = (await response.json().catch(() => ({}))) as {
        usages?: AssetUsage[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Asset use could not be loaded.");
      setAssetUsages(body.usages ?? []);
    } catch (usageError) {
      setUploadError(
        usageError instanceof Error ? usageError.message : "Asset use could not be loaded.",
      );
      setUsageAsset(null);
    } finally {
      setUsageBusy(false);
    }
  };

  const replaceAssetInProject = async (projectId: number) => {
    if (!usageAsset || replacementAssetId === null) return;
    setUsageBusy(true);
    setUploadError(null);
    try {
      const response = await authFetch(
        `/api/projects/${projectId}/assets/${usageAsset.id}/replace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ replacementAssetId }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        replacements?: unknown[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "The asset could not be replaced safely.");
      setAssetNotice(
        `${body.replacements?.length ?? 0} uses were replaced together in ${projects.find((project) => project.id === projectId)?.name ?? "the project"}.`,
      );
      await openAssetUsage(usageAsset);
      await fetchAssets();
    } catch (replaceError) {
      setUploadError(
        replaceError instanceof Error
          ? replaceError.message
          : "The asset could not be replaced safely.",
      );
    } finally {
      setUsageBusy(false);
    }
  };

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
            <div className="rounded-lg border border-border bg-muted px-2.5 py-2 text-[10px] text-muted-foreground">
              <p className="font-medium text-foreground">Image analysis · separate meter</p>
              <p>
                {analysisUsage
                  ? `${analysisUsage.count} analyses · $${(analysisUsage.estimatedProviderCostMicros / 1_000_000).toFixed(4)} estimated provider cost`
                  : "No image analysis usage yet."}
              </p>
              <p>No customer credit price is active while real usage is being measured.</p>
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
                        alt={asset.context?.altText ?? asset.filename}
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
                      {asset.context?.derivativePreset && (
                        <p className="truncate text-[9px] text-emerald-500">
                          {asset.context.derivativePreset}
                        </p>
                      )}
                      <input
                        value={assetDrafts[asset.id]?.altText ?? ""}
                        onChange={(event) =>
                          setAssetDrafts((current) => ({
                            ...current,
                            [asset.id]: {
                              altText: event.target.value,
                              brandRole: current[asset.id]?.brandRole ?? "none",
                            },
                          }))
                        }
                        maxLength={500}
                        placeholder="Describe this image"
                        aria-label={`Alt text for ${asset.filename}`}
                        className="w-full rounded border border-border bg-background px-1.5 py-1 text-[9px]"
                      />
                      <select
                        value={assetDrafts[asset.id]?.brandRole ?? "none"}
                        onChange={(event) =>
                          setAssetDrafts((current) => ({
                            ...current,
                            [asset.id]: {
                              altText: current[asset.id]?.altText ?? "",
                              brandRole: event.target.value,
                            },
                          }))
                        }
                        aria-label={`Brand role for ${asset.filename}`}
                        className="w-full rounded border border-border bg-background px-1 py-1 text-[9px]"
                      >
                        <option value="none">No brand role</option>
                        <option value="logo">Logo</option>
                        <option value="icon">Icon</option>
                        <option value="palette">Colour reference</option>
                        <option value="font">Font reference</option>
                        <option value="reference">Visual reference</option>
                      </select>
                      <div className="flex gap-1">
                        <a
                          href={asset.contentUrl}
                          className="flex-1 rounded bg-muted px-2 py-1 text-center text-[9px] hover:text-foreground"
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            setUsingAsset({ assetId: asset.id, label: asset.filename })
                          }
                          className="rounded bg-muted p-1 text-muted-foreground hover:text-foreground"
                          aria-label={`Use ${asset.filename} in a project`}
                        >
                          <Image className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void openAssetUsage(asset)}
                          className="rounded bg-muted p-1 text-muted-foreground hover:text-foreground"
                          aria-label={`Show where ${asset.filename} is used`}
                        >
                          <Layers className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleAssetDelete(asset)}
                          className="rounded bg-muted p-1 text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${asset.filename}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          onClick={() => void saveAssetDetails(asset.id)}
                          disabled={assetBusy === asset.id}
                          className="rounded bg-muted px-1 py-1 text-[9px] hover:text-foreground disabled:opacity-50"
                        >
                          Save details
                        </button>
                        {asset.mimeType.startsWith("image/") &&
                          !asset.context?.derivativeOfAssetId && (
                            <button
                              type="button"
                              onClick={() => void createAppSizes(asset.id)}
                              disabled={assetBusy === asset.id}
                              className="rounded bg-muted px-1 py-1 text-[9px] hover:text-foreground disabled:opacity-50"
                            >
                              App sizes
                            </button>
                          )}
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
                  onUseClick={(image) =>
                    image.assetId &&
                    setUsingAsset({ assetId: image.assetId, label: `Generated image ${image.id}` })
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {usingAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-background p-4 shadow-xl">
            <div>
              <h2 className="text-sm font-semibold">Use in a project</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                A restorable project file and a where-used receipt will be created.
              </p>
            </div>
            <select
              aria-label="Project for asset"
              value={useProjectId ?? ""}
              onChange={(event) => setUseProjectId(Number(event.target.value))}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setUsingAsset(null)}
                className="rounded px-3 py-2 text-xs text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void useAssetInProject()}
                disabled={useBusy || useProjectId === null}
                className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
              >
                {useBusy ? "Adding…" : "Add to project"}
              </button>
            </div>
          </div>
        </div>
      )}

      {usageAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="max-h-[80vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Where this asset is used</h2>
                <p className="mt-1 text-xs text-muted-foreground">{usageAsset.filename}</p>
              </div>
              <button
                type="button"
                onClick={() => setUsageAsset(null)}
                aria-label="Close asset use"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {usageBusy && assetUsages.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading uses…
              </div>
            ) : assetUsages.length === 0 ? (
              <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                Nothing currently references this asset. It can be deleted without breaking a
                project.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {assetUsages.length} {assetUsages.length === 1 ? "use" : "uses"} found. Deletion
                  stays blocked until every reference is removed or replaced.
                </p>
                {Array.from(
                  new Map(
                    assetUsages
                      .filter((usage) => usage.projectId !== null)
                      .map((usage) => [usage.projectId as number, true]),
                  ).keys(),
                ).map((projectId) => {
                  const projectUses = assetUsages.filter((usage) => usage.projectId === projectId);
                  const project = projects.find((entry) => entry.id === projectId);
                  return (
                    <div key={projectId} className="rounded-lg border border-border p-3">
                      <p className="text-xs font-medium">
                        {project?.name ?? `Project ${projectId}`}
                      </p>
                      <ul className="mt-1 space-y-1 text-[10px] text-muted-foreground">
                        {projectUses.map((usage) => (
                          <li key={usage.id}>{usage.filePath ?? usage.consumer}</li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        onClick={() => void replaceAssetInProject(projectId)}
                        disabled={usageBusy || replacementAssetId === null}
                        className="mt-2 rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground disabled:opacity-50"
                      >
                        Replace every use in this project
                      </button>
                    </div>
                  );
                })}
                {assetUsages.some((usage) => usage.projectId === null) && (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300">
                    A non-project reference needs Zero's review before this asset can be replaced.
                  </p>
                )}
              </div>
            )}
            {assetUsages.some((usage) => usage.projectId !== null) && (
              <div>
                <label className="mb-1 block text-[10px] font-medium">Replacement asset</label>
                <select
                  aria-label="Replacement asset"
                  value={replacementAssetId ?? ""}
                  onChange={(event) => setReplacementAssetId(Number(event.target.value))}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs"
                >
                  {assets
                    .filter((asset) => asset.id !== usageAsset.id)
                    .map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.filename}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
        </div>
      )}

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
