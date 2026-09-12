import { memo } from "react";
import { getPreviewIframeSandbox } from "@/lib/preview-access-ui";
import { pagePreviewUrl, pageRouteFromFilePath } from "./page-map-card-model";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import {
  Globe,
  Lock,
  FileText,
  LayoutDashboard,
  Settings,
  AlertCircle,
  Layers,
  PanelLeft,
  ChevronRight,
  List,
  Info,
  Monitor,
  FilePlus,
  Unlink,
} from "lucide-react";

export type PageType =
  | "landing"
  | "auth"
  | "form"
  | "dashboard"
  | "modal"
  | "settings"
  | "404"
  | "tab-bar"
  | "drawer"
  | "sheet"
  | "list"
  | "detail"
  | "other";

export type PageNodeData = {
  label: string;
  pageType: PageType;
  filePath: string;
  isNew: boolean;
  hasError: boolean;
  aiGenerated: boolean;
  notes: string;
  projectId: number;
  planned?: boolean;
  isBuilding?: boolean;
  previewEnabled?: boolean;
  previewRevision?: string | number;
  // Map coverage only; these counts and legacy flags are not runtime evidence.
  incoming?: number;
  outgoing?: number;
  isOrphan?: boolean;
  isDeadEnd?: boolean;
  dimmed?: boolean;
  onNodeClick?: (nodeId: string) => void;
  onPreviewClick?: (filePath: string, route?: string) => void;
};

const PAGE_TYPE_CONFIG: Record<PageType, { label: string; Icon: React.ElementType }> = {
  landing: {
    label: "Landing",
    Icon: Globe,
  },
  auth: {
    label: "Auth",
    Icon: Lock,
  },
  form: {
    label: "Form",
    Icon: FileText,
  },
  dashboard: {
    label: "Dashboard",
    Icon: LayoutDashboard,
  },
  modal: {
    label: "Modal",
    Icon: Layers,
  },
  settings: {
    label: "Settings",
    Icon: Settings,
  },
  "404": {
    label: "404",
    Icon: AlertCircle,
  },
  "tab-bar": {
    label: "Tab Bar",
    Icon: PanelLeft,
  },
  drawer: {
    label: "Drawer",
    Icon: ChevronRight,
  },
  sheet: {
    label: "Sheet",
    Icon: Layers,
  },
  list: {
    label: "List",
    Icon: List,
  },
  detail: {
    label: "Detail",
    Icon: Info,
  },
  other: {
    label: "Page",
    Icon: Monitor,
  },
};

// Mini-frames always remain opaque, even if the preview endpoint redirects to a
// live runtime. Keep only the existing helper's script capability: no origin,
// form submission or popups are needed for a non-interactive card.
const PAGE_MAP_PREVIEW_SANDBOX = getPreviewIframeSandbox({
  serverPreviewLive: false,
  webContainerLive: false,
})
  .split(/\s+/)
  .filter((permission) => permission === "allow-scripts")
  .join(" ");

export function PageMapLivePreview({
  projectId,
  route,
  label,
  enabled = false,
  revision,
  className,
}: {
  projectId: number;
  route: string;
  label: string;
  enabled?: boolean;
  revision?: string | number;
  className?: string;
}) {
  const src = enabled ? pagePreviewUrl(projectId, route) : null;
  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-muted/40", className)}>
      {src ? (
        <>
          <iframe
            key={`${src}:${revision ?? ""}`}
            src={src}
            className="pointer-events-none absolute left-0 top-0 border-0"
            style={{
              width: "400%",
              height: "400%",
              transform: "scale(0.25)",
              transformOrigin: "top left",
            }}
            sandbox={PAGE_MAP_PREVIEW_SANDBOX}
            tabIndex={-1}
            aria-hidden="true"
            loading="lazy"
            referrerPolicy="no-referrer"
            title={`Preview of ${label}`}
          />
          <span className="absolute bottom-1 right-1 rounded border border-border bg-background/95 px-1.5 py-0.5 text-[9px] text-muted-foreground">
            Preview frame
          </span>
        </>
      ) : (
        <span className="flex h-full items-center justify-center px-3 text-center text-[10px] text-muted-foreground">
          Open Preview to view this page
        </span>
      )}
    </div>
  );
}

export const PageNode = memo(function PageNode({
  id,
  data,
  selected,
}: NodeProps & { data: PageNodeData }) {
  const config = PAGE_TYPE_CONFIG[data.pageType] ?? PAGE_TYPE_CONFIG.other;
  const Icon = config.Icon;

  const route = pageRouteFromFilePath(data.filePath, data.notes);
  const previewUrl = data.filePath ? pagePreviewUrl(data.projectId, route) : null;

  if (data.planned) {
    return (
      <div
        className={cn(
          "relative bg-card border border-dashed rounded-xl shadow-sm overflow-hidden transition-colors duration-200",
          "w-52",
          selected
            ? "border-primary shadow-primary/20 ring-2 ring-primary ring-offset-1 ring-offset-background"
            : "border-border hover:border-primary/40",
          data.isBuilding && "motion-safe:animate-pulse",
          data.dimmed && !selected && "opacity-40 hover:opacity-100",
        )}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
        />

        <button
          type="button"
          className="nodrag nopan block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          aria-label={`View details for ${data.label || "Untitled Page"}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onNodeClick?.(id);
          }}
        >
          {/* Card header */}
          <div className="px-3 py-2 border-b border-dashed border-border/60 bg-card/50">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-border bg-muted text-muted-foreground">
                <Icon className="h-2.5 w-2.5 shrink-0" />
                {config.label}
              </div>
              <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium border border-border">
                Planned
              </span>
            </div>
            <div className="mt-1.5 text-xs font-semibold text-foreground truncate">
              {data.label || "Untitled Page"}
            </div>
            {data.notes && (
              <div className="text-[10px] text-muted-foreground truncate mt-0.5 italic">
                {data.notes}
              </div>
            )}
          </div>

          {/* Placeholder body */}
          <div
            className="flex flex-col items-center justify-center gap-1.5 bg-muted/20"
            style={{ height: 72 }}
          >
            <FilePlus className="h-5 w-5 text-muted-foreground" />
            <span className="text-[9px] text-muted-foreground font-medium">
              {data.filePath ? "Planned page" : "No file mapped yet"}
            </span>
          </div>
        </button>

        <Handle
          type="source"
          position={Position.Right}
          className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
        />
      </div>
    );
  }

  const hasMappingGap = !!data.isOrphan || !!data.isDeadEnd;
  const issueLabel =
    data.isOrphan && data.isDeadEnd
      ? "No connections mapped yet"
      : data.isOrphan
        ? "No incoming connection mapped"
        : data.isDeadEnd
          ? "No outgoing connection mapped"
          : null;

  return (
    <div
      className={cn(
        "relative bg-card border border-border rounded-xl shadow-sm overflow-hidden transition-colors duration-200",
        "w-52",
        selected ? "ring-2 ring-primary shadow-primary/20" : "hover:border-primary/40",
        data.isNew && !data.hasError && "border-primary/40",
        data.isBuilding && "motion-safe:animate-pulse",
        data.dimmed && !selected && "opacity-40 hover:opacity-100",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
      />

      {/* Card header */}
      <button
        type="button"
        className="nodrag nopan block w-full px-3 py-2 text-left border-b border-border/60 bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        aria-label={`View details for ${data.label || "Untitled Page"}`}
        onClick={(event) => {
          event.stopPropagation();
          data.onNodeClick?.(id);
        }}
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-border bg-muted text-muted-foreground">
            <Icon className="h-2.5 w-2.5 shrink-0" />
            {config.label}
          </div>
          {data.aiGenerated && (
            <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-medium border border-border">
              AI
            </span>
          )}
          {data.isNew && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-primary/10 text-primary font-medium border border-primary/20">
              New
            </span>
          )}
        </div>
        <div className="mt-1.5 text-xs font-semibold text-foreground truncate">{data.label}</div>
        <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
          {data.filePath}
        </div>
      </button>

      {/* Sandboxed live preview; loading a frame is not runtime verification. */}
      <div
        className="nodrag nopan relative overflow-hidden bg-muted/40 group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        style={{ height: 72 }}
        onClick={(e) => {
          e.stopPropagation();
          if (previewUrl) data.onPreviewClick?.(data.filePath, route);
          else data.onNodeClick?.(id);
        }}
        role="button"
        tabIndex={0}
        aria-label={previewUrl ? "Open preview: " + data.label : "View page details: " + data.label}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (previewUrl) data.onPreviewClick?.(data.filePath, route);
          else data.onNodeClick?.(id);
        }}
        title={previewUrl ? "Click to open in Preview tab" : "A concrete app route is needed"}
      >
        {previewUrl ? (
          <PageMapLivePreview
            projectId={data.projectId}
            route={route}
            label={data.label}
            enabled={data.previewEnabled === true}
            revision={data.previewRevision}
          />
        ) : (
          <span className="flex h-full items-center justify-center px-3 text-center text-[10px] text-muted-foreground">
            Preview needs a concrete app route
          </span>
        )}
        <div className="absolute inset-0 bg-transparent group-hover:bg-primary/5 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="text-[9px] font-medium text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
            {previewUrl ? "Open preview" : "View details"}
          </span>
        </div>
      </div>

      {data.hasError && (
        <div className="px-2 py-1 bg-muted border-t border-border flex items-center gap-1 text-muted-foreground">
          <AlertCircle className="h-2.5 w-2.5 shrink-0" />
          <span className="text-[9px]">Issue reported</span>
        </div>
      )}

      {hasMappingGap && (
        <div className="px-2 py-1 bg-muted/40 border-t border-border flex items-center gap-1 text-muted-foreground">
          <Unlink className="h-2.5 w-2.5 shrink-0" />
          <span className="text-[9px]">{issueLabel}</span>
        </div>
      )}

      <div className="border-t border-border px-2 py-1 text-[9px] text-muted-foreground">
        Runtime navigation not verified
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
      />
    </div>
  );
});
