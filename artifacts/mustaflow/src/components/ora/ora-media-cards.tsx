import { useState } from "react";
import { ImageIcon, Play, ExternalLink } from "lucide-react";
import type { OraImage, OraVideo } from "@/hooks/use-ora-chat";
import { isSafeHttpUrl, sourceHostname } from "@/components/ora/ora-source-cards";

/**
 * Renders real web images found during a live search as a compact gallery.
 * Each thumbnail links to the page it was found on (when known) so the user can
 * verify context. Broken/unreachable images are hidden on load error so a stale
 * or hot-linked URL never leaves an empty box.
 */
export function OraImageGallery({ images }: { images: OraImage[] }) {
  const safe = images.filter((i) => isSafeHttpUrl(i.url));
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const visible = safe.filter((i) => !broken[i.url]);
  if (safe.length === 0) return null;

  return (
    <div className="mt-2.5" data-testid="ora-image-gallery" hidden={visible.length === 0}>
      <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        <ImageIcon className="h-3 w-3" />
        Images
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {safe.map((img, i) => {
          if (broken[img.url]) return null;
          const linkTarget =
            img.source && isSafeHttpUrl(img.source) ? img.source : img.url;
          return (
            <a
              key={i}
              href={linkTarget}
              target="_blank"
              rel="noopener noreferrer"
              title={img.title ?? sourceHostname(linkTarget)}
              className="group relative block aspect-video overflow-hidden rounded-lg border border-border/60 bg-muted/30 hover:border-border transition-all"
            >
              <img
                src={img.url}
                alt={img.title ?? "Web image result"}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setBroken((b) => ({ ...b, [img.url]: true }))}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
              <span className="absolute bottom-0 right-0 m-1 rounded bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <ExternalLink className="h-3 w-3 text-foreground/70" />
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Renders relevant videos found during a live search as clickable link cards.
 * Each opens the video in a new tab; a derived thumbnail (e.g. YouTube) shows a
 * preview when available. Non-http(s) URLs are defensively dropped.
 */
export function OraVideoCards({ videos }: { videos: OraVideo[] }) {
  const safe = videos.filter((v) => isSafeHttpUrl(v.url));
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  if (safe.length === 0) return null;

  return (
    <div className="mt-2.5" data-testid="ora-video-cards">
      <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        <Play className="h-3 w-3" />
        Videos
      </div>
      <div className="flex flex-col gap-1.5">
        {safe.map((v, i) => {
          const showThumb =
            v.thumbnailUrl && isSafeHttpUrl(v.thumbnailUrl) && !broken[v.thumbnailUrl];
          return (
            <a
              key={i}
              href={v.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/30 hover:bg-muted/60 hover:border-border px-2.5 py-2 transition-all"
            >
              {showThumb ? (
                <span className="relative shrink-0 overflow-hidden rounded-md">
                  <img
                    src={v.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setBroken((b) => ({ ...b, [v.thumbnailUrl as string]: true }))
                    }
                    className="h-10 w-16 object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                    <Play className="h-4 w-4 fill-white text-white" />
                  </span>
                </span>
              ) : (
                <span className="shrink-0 flex h-9 w-9 items-center justify-center rounded-md bg-[hsl(265_85%_65%/0.12)]">
                  <Play className="h-4 w-4 fill-[hsl(265_85%_65%)] text-[hsl(265_85%_65%)]" />
                </span>
              )}
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium truncate text-foreground/90">
                  {v.title ?? "Watch video"}
                </span>
                <span className="block text-[10px] text-muted-foreground/70 truncate">
                  {sourceHostname(v.url)}
                </span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 group-hover:text-foreground/70 transition-colors" />
            </a>
          );
        })}
      </div>
    </div>
  );
}
