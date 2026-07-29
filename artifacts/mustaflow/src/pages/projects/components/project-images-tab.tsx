import { useState } from "react";
import {
  AlertCircle,
  Check,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  RefreshCw,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GenerateProjectImageOptions } from "./use-project-images";
import type { ProjectImageItem } from "./project-image-model";

const QUALITY_OPTIONS = [
  { value: "draft", label: "Draft", credits: 1 },
  { value: "standard", label: "Standard", credits: 3 },
  { value: "high", label: "High", credits: 6 },
] as const;

const ASPECT_OPTIONS = [
  { value: "1:1", label: "Square" },
  { value: "16:9", label: "Wide" },
  { value: "9:16", label: "Tall" },
] as const;

export function ProjectImagesTab({
  images,
  loading,
  generating,
  error,
  onGenerate,
  onRegenerate,
  onInsert,
  hasMoreHistory,
  onLoadMoreHistory,
}: {
  images: ProjectImageItem[];
  loading: boolean;
  generating: boolean;
  error: string | null;
  onGenerate: (prompt: string, options: GenerateProjectImageOptions) => Promise<void>;
  onRegenerate: (image: ProjectImageItem) => Promise<void>;
  onInsert: (image: ProjectImageItem) => Promise<void>;
  hasMoreHistory: boolean;
  onLoadMoreHistory: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<GenerateProjectImageOptions["quality"]>("standard");
  const [aspectRatio, setAspectRatio] = useState<GenerateProjectImageOptions["aspectRatio"]>("1:1");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [insertedKey, setInsertedKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const selectedQuality = QUALITY_OPTIONS.find((option) => option.value === quality)!;

  const handleGenerate = async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || generating) return;
    try {
      await onGenerate(nextPrompt, {
        quality,
        aspectRatio,
        style: "vivid",
        purpose: "general",
      });
      setPrompt("");
    } catch {
      // The project image hook exposes a plain-language error beside the form.
    }
  };

  const runCardAction = async (key: string, action: () => Promise<void>, markInserted = false) => {
    setBusyKey(key);
    setActionError(null);
    try {
      await action();
      if (markInserted) setInsertedKey(key);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "That action could not finish");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background px-5 py-6 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ImagePlus className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Images</h2>
                <p className="text-xs text-muted-foreground">
                  Make, reuse, and place images without leaving your project.
                </p>
              </div>
            </div>
          </div>
          {generating && (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-[11px] font-medium text-primary"
              aria-live="polite"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Creating images for your app...
            </div>
          )}
        </div>

        <div className="mt-6 rounded-2xl border border-border bg-card/45 p-4 shadow-sm">
          <label htmlFor="project-image-prompt" className="text-xs font-semibold text-foreground">
            Describe the image
          </label>
          <div className="mt-2 flex flex-col gap-2 lg:flex-row">
            <textarea
              id="project-image-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="A warm, hand-drawn hero illustration of a neighborhood garden"
              rows={3}
              className="min-h-20 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50"
            />
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={!prompt.trim() || generating}
              className="inline-flex min-w-36 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Create image
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Quality</span>
            {QUALITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setQuality(option.value)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  quality === option.value
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label} · {option.credits}
              </button>
            ))}
            <span className="ml-2 text-[11px] text-muted-foreground">Shape</span>
            {ASPECT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setAspectRatio(option.value)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  aspectRatio === option.value
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-muted-foreground">
              {selectedQuality.credits} credit{selectedQuality.credits === 1 ? "" : "s"}
            </span>
          </div>

          {(error || actionError) && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error || actionError}
            </div>
          )}
        </div>

        <div className="mt-7 flex items-end justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Project gallery</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Images made here and images Zero created while building appear together.
            </p>
          </div>
          {!loading && images.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {images.length} {images.length === 1 ? "image" : "images"}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex min-h-56 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : images.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-border bg-card/25 px-6 py-14 text-center">
            <ImageIcon className="mx-auto h-8 w-8 text-primary/60" />
            <h3 className="mt-4 text-sm font-semibold text-foreground">
              Images for your app will appear here
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
              Describe one above, or ask Zero to create an image while building.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {images.map((image) => {
              const imageSrc = image.thumbnailUrl ?? image.imageUrl;
              const isPending = image.status === "pending" || image.status === "generating";
              const cardBusy = busyKey === image.key;
              return (
                <article
                  key={image.key}
                  data-testid={`project-image-${image.key}`}
                  className="overflow-hidden rounded-2xl border border-border bg-card/45 shadow-sm"
                >
                  <div className="flex aspect-[4/3] items-center justify-center bg-muted/40">
                    {isPending ? (
                      <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                        Creating image...
                      </div>
                    ) : image.status === "failed" ? (
                      <div className="px-5 text-center text-xs text-destructive">
                        <AlertCircle className="mx-auto mb-2 h-5 w-5" />
                        {image.error || "This image could not be created."}
                      </div>
                    ) : imageSrc ? (
                      <img
                        src={imageSrc}
                        alt={image.prompt}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <ImageIcon className="h-7 w-7 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="line-clamp-2 min-h-8 text-xs leading-relaxed text-foreground">
                        {image.prompt}
                      </p>
                      <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                        {image.source === "studio"
                          ? "Image Studio"
                          : image.source === "zero"
                            ? "Made by Zero"
                            : "In app"}
                      </span>
                    </div>
                    {image.path && (
                      <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
                        {image.path}
                      </p>
                    )}
                    <div className="mt-3 flex gap-2 border-t border-border/50 pt-3">
                      <button
                        type="button"
                        disabled={isPending || cardBusy}
                        onClick={() => void runCardAction(image.key, () => onRegenerate(image))}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {cardBusy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Regenerate
                      </button>
                      <button
                        type="button"
                        disabled={isPending || image.status === "failed" || cardBusy}
                        onClick={() => void runCardAction(image.key, () => onInsert(image), true)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-2 py-1.5 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {insertedKey === image.key ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <ImagePlus className="h-3 w-3" />
                        )}
                        {insertedKey === image.key ? "Added" : "Insert into app"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!loading && hasMoreHistory && (
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              onClick={onLoadMoreHistory}
              className="rounded-lg border border-border bg-card/40 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Load more image history
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
