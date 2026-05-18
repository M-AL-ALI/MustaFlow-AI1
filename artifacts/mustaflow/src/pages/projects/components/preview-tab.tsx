import {
  Monitor,
  Smartphone,
  Tablet,
  RefreshCw,
  ExternalLink,
  Globe,
  LayoutTemplate,
  Clock,
  Zap,
  BrainCircuit,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useListProjectFiles, getListProjectFilesQueryKey } from "@workspace/api-client-react";

type Platform = "web" | "ios" | "android";
type DeviceFrame = "desktop" | "tablet" | "mobile";

const DEVICE_ICONS: Record<DeviceFrame, React.ElementType> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

const DEVICE_SIZES: Record<Platform, Record<DeviceFrame, { w: number | string; h: number | string }>> = {
  web: {
    desktop: { w: "100%", h: "100%" },
    tablet: { w: 768, h: 1024 },
    mobile: { w: 390, h: 844 },
  },
  ios: {
    desktop: { w: "100%", h: "100%" },
    tablet: { w: 820, h: 1180 },
    mobile: { w: 390, h: 844 },
  },
  android: {
    desktop: { w: "100%", h: "100%" },
    tablet: { w: 800, h: 1280 },
    mobile: { w: 360, h: 800 },
  },
};

type Project = {
  id: number;
  status: string;
  updatedAt: string;
  name?: string;
};

export function PreviewTab({ project }: { project: Project }) {
  const [platform, setPlatform] = useState<Platform>("web");
  const [device, setDevice] = useState<DeviceFrame>("desktop");
  const [iframeKey, setIframeKey] = useState(0);

  const { data: files } = useListProjectFiles(project.id, {
    query: {
      enabled: !!project.id,
      queryKey: getListProjectFilesQueryKey(project.id),
    },
  });

  const hasFiles = (files?.length ?? 0) > 0;
  const previewSrc = `/api/projects/${project.id}/preview/?t=${iframeKey}`;
  const refresh = () => setIframeKey((k) => k + 1);

  const sizes = DEVICE_SIZES[platform][device];
  const isFullWidth = sizes.w === "100%";

  const lastUpdated = project.updatedAt
    ? new Date(project.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="flex flex-col h-full bg-background">

      {/* Preview toolbar */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-border bg-card">

        {/* Platform selector */}
        <div className="flex bg-muted rounded-lg p-0.5 shrink-0">
          {(["web", "ios", "android"] as Platform[]).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                "px-3 py-1 text-[11px] font-semibold rounded-md transition-colors uppercase tracking-wide",
                platform === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Device selector */}
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5 shrink-0">
          {(["desktop", "tablet", "mobile"] as DeviceFrame[]).map((d) => {
            const Icon = DEVICE_ICONS[d];
            return (
              <button
                key={d}
                onClick={() => setDevice(d)}
                title={d}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  device === d
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>

        {/* Divider */}
        <div className="w-px h-4 bg-border" />

        {/* Status badge */}
        <div className={cn(
          "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0",
          project.status === "building"
            ? "bg-primary/15 text-primary"
            : project.status === "published"
            ? "bg-green-500/15 text-green-500"
            : project.status === "testing"
            ? "bg-yellow-500/15 text-yellow-500"
            : project.status === "failed"
            ? "bg-destructive/15 text-destructive"
            : "bg-muted text-muted-foreground",
        )}>
          <span className={cn(
            "w-1.5 h-1.5 rounded-full",
            project.status === "building" ? "bg-primary animate-pulse" :
            project.status === "published" ? "bg-green-500" :
            project.status === "testing" ? "bg-yellow-500" :
            project.status === "failed" ? "bg-destructive" : "bg-muted-foreground",
          )} />
          {project.status}
        </div>

        {lastUpdated && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
            <Clock className="h-3 w-3" />
            {lastUpdated}
          </div>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={refresh}
            title="Refresh preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            asChild
            title="Open preview in new tab"
          >
            <a href={previewSrc} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </div>

      {/* Preview area */}
      <div className="flex-1 min-h-0 bg-muted/20 overflow-auto flex items-start justify-center p-4">
        {hasFiles ? (
          <div
            className={cn(
              "border border-border rounded-lg shadow-xl overflow-hidden bg-white flex flex-col",
              isFullWidth ? "w-full h-full" : "",
            )}
            style={
              !isFullWidth
                ? { width: sizes.w, minHeight: sizes.h, maxWidth: "100%" }
                : undefined
            }
          >
            {/* Browser / device chrome */}
            <div className="h-8 bg-zinc-100 border-b border-zinc-200/80 flex items-center px-3 gap-1.5 shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
              <div className="flex-1 mx-2 max-w-xs">
                <div className="bg-white border border-zinc-200 rounded px-2 py-0.5 text-[10px] text-zinc-500 font-mono text-center truncate">
                  {platform === "web" ? `preview/${project.id}/` : `${platform} preview/${project.id}/`}
                </div>
              </div>
              <Globe className="h-3 w-3 text-zinc-400" />
            </div>
            <iframe
              key={iframeKey}
              src={previewSrc}
              title="Project preview"
              className="flex-1 w-full border-0"
              style={{ minHeight: isFullWidth ? "100%" : sizes.h }}
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
            />
          </div>
        ) : (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full max-w-md text-center gap-6 py-16">
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <LayoutTemplate className="h-10 w-10 text-primary/60" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-muted border border-border flex items-center justify-center">
                <Zap className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2">No preview yet</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Use the AI Builder below to describe what you want to build. MustaFlow will generate your app and show a live preview here.
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/60 border border-border text-sm text-left">
                <BrainCircuit className="h-5 w-5 text-secondary shrink-0" />
                <div>
                  <div className="font-medium text-foreground text-xs">Plan Mode</div>
                  <div className="text-muted-foreground text-[11px]">Generate a detailed plan before building</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/60 border border-border text-sm text-left">
                <Zap className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium text-foreground text-xs">Build First Draft</div>
                  <div className="text-muted-foreground text-[11px]">Generate your app immediately from a prompt</div>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground/60">
              Type your idea in the AI Builder below and press Enter or click Send
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
