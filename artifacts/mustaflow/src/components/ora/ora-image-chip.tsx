import { Loader2, AlertCircle, X, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UploadState } from "@/hooks/use-ora-chat";

interface OraImageChipProps {
  uploadState: UploadState;
  uploadError: string | null;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  previewObjectUrl?: string | null;
  onClear: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function OraImageChip({
  uploadState,
  uploadError,
  filename,
  sizeBytes,
  width,
  height,
  previewObjectUrl,
  onClear,
}: OraImageChipProps) {
  if (uploadState === "idle") return null;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs mb-2",
        uploadState === "attached" &&
          "border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.07)] text-foreground",
        uploadState === "uploading" && "border-border bg-muted/30 text-muted-foreground",
        uploadState === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {/* Thumbnail or icon */}
      <div className="shrink-0 mt-0.5">
        {uploadState === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {uploadState === "error" && <AlertCircle className="h-3.5 w-3.5" />}
        {uploadState === "attached" &&
          (previewObjectUrl ? (
            <img
              src={previewObjectUrl}
              alt="Preview"
              className="h-8 w-8 rounded object-cover border border-[hsl(265_85%_65%/0.25)]"
            />
          ) : (
            <ImageIcon className="h-3.5 w-3.5 text-[hsl(265_85%_65%)]" />
          ))}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <span className="truncate block">
          {uploadState === "uploading" && `Uploading ${filename ?? "image"}…`}
          {uploadState === "attached" && (filename ?? "Image attached")}
          {uploadState === "error" && (uploadError ?? "Upload failed")}
        </span>

        {uploadState === "attached" && (sizeBytes != null || (width != null && height != null)) && (
          <div className="flex flex-wrap gap-1 mt-1">
            {width != null && height != null && (
              <span className="inline-flex items-center rounded-full bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(265_85%_65%)]">
                {width} × {height}
              </span>
            )}
            {sizeBytes != null && (
              <span className="inline-flex items-center rounded-full bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(265_85%_65%)]">
                {formatBytes(sizeBytes)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Clear button */}
      {(uploadState === "attached" || uploadState === "error") && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove image"
          className="shrink-0 mt-0.5 opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
