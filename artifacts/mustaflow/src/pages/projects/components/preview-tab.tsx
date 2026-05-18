import { Monitor, Smartphone, Tablet, RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { cn } from "@/lib/utils";

type DeviceFrame = "web" | "tablet" | "mobile";

const FRAME_SIZES: Record<DeviceFrame, { w: string; h: string; label: string }> = {
  web: { w: "100%", h: "100%", label: "Web" },
  tablet: { w: "768px", h: "1024px", label: "Tablet" },
  mobile: { w: "390px", h: "780px", label: "Mobile" },
};

export function PreviewTab({ project }: { project: { id: number; status: string; updatedAt: string } }) {
  const [device, setDevice] = useState<DeviceFrame>("web");
  const [iframeKey, setIframeKey] = useState(0);
  const previewSrc = `/api/projects/${project.id}/preview/?t=${iframeKey}`;
  const refresh = () => setIframeKey((k) => k + 1);

  const size = FRAME_SIZES[device];

  return (
    <div className="flex flex-col h-full bg-background relative">
      <div className="flex items-center justify-between p-2 border-b border-border bg-card">
        <div className="flex bg-muted rounded-lg p-1">
          {(Object.keys(FRAME_SIZES) as DeviceFrame[]).map((d) => (
            <Button
              key={d}
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 px-3 text-xs",
                device === d ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
              onClick={() => setDevice(d)}
            >
              {FRAME_SIZES[d].label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <div className="text-xs text-muted-foreground mr-2 hidden sm:block">
            Status: <span className="text-foreground capitalize">{project.status}</span>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={refresh} title="Refresh preview">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            asChild
            title="Open in new tab"
          >
            <a href={previewSrc} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
      <div className="flex-1 p-6 flex items-center justify-center bg-muted/30 overflow-auto">
        <div
          className={cn(
            "border border-border bg-card rounded-lg shadow-lg flex flex-col overflow-hidden",
            device === "web" ? "w-full max-w-5xl h-full" : "",
          )}
          style={
            device !== "web"
              ? { width: size.w, height: size.h, maxHeight: "100%" }
              : undefined
          }
        >
          <div className="h-8 bg-muted border-b border-border flex items-center px-4 gap-2 flex-shrink-0">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-destructive/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
            </div>
            <div className="mx-auto bg-background px-3 py-0.5 rounded text-[10px] text-muted-foreground border border-border flex-1 max-w-md text-center font-mono truncate">
              preview/{project.id}/index.html
            </div>
            <Monitor className="h-3 w-3 text-muted-foreground" />
            <Tablet className="h-3 w-3 text-muted-foreground" />
            <Smartphone className="h-3 w-3 text-muted-foreground" />
          </div>
          <iframe
            key={iframeKey}
            src={previewSrc}
            title="Project preview"
            className="flex-1 w-full h-full bg-white"
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          />
        </div>
      </div>
    </div>
  );
}
