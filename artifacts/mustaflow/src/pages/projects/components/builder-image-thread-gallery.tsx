import { AlertCircle, ChevronRight, Image as ImageIcon, Loader2 } from "lucide-react";
import type { ProjectImageItem } from "./project-image-model";

export function BuilderImageThreadGallery({
  images,
  onOpenImages,
}: {
  images: ProjectImageItem[];
  onOpenImages: () => void;
}) {
  if (images.length === 0) return null;
  const visibleImages = images.slice(0, 4);
  const isCreating = visibleImages.some(
    (image) => image.status === "pending" || image.status === "generating",
  );

  return (
    <div
      data-testid="builder-image-thread-gallery"
      className="flex justify-start animate-in fade-in slide-in-from-bottom-1 duration-300"
      aria-live="polite"
    >
      <div className="w-full max-w-[90%] rounded-xl border border-border bg-muted px-3 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          {isCreating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5 text-primary" />
          )}
          <span className="font-medium text-foreground">
            {isCreating ? "Creating images for your app..." : "Images ready"}
          </span>
          <button
            type="button"
            onClick={onOpenImages}
            className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
          >
            View all
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {visibleImages.map((image) => {
            const imageSrc = image.thumbnailUrl ?? image.imageUrl;
            const pending = image.status === "pending" || image.status === "generating";
            return (
              <div
                key={image.key}
                className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border border-border bg-background/60"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : image.status === "failed" ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : imageSrc ? (
                  <img
                    src={imageSrc}
                    alt={image.prompt}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
