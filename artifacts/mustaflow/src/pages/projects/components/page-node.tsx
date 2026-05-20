import { memo } from "react";
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
  onNodeClick?: (nodeId: string) => void;
  onPreviewClick?: (filePath: string) => void;
};

const PAGE_TYPE_CONFIG: Record<
  PageType,
  { label: string; color: string; bg: string; Icon: React.ElementType }
> = {
  landing: {
    label: "Landing",
    color: "text-purple-400",
    bg: "bg-purple-500/15 border-purple-500/30",
    Icon: Globe,
  },
  auth: {
    label: "Auth",
    color: "text-yellow-400",
    bg: "bg-yellow-500/15 border-yellow-500/30",
    Icon: Lock,
  },
  form: {
    label: "Form",
    color: "text-blue-400",
    bg: "bg-blue-500/15 border-blue-500/30",
    Icon: FileText,
  },
  dashboard: {
    label: "Dashboard",
    color: "text-green-400",
    bg: "bg-green-500/15 border-green-500/30",
    Icon: LayoutDashboard,
  },
  modal: {
    label: "Modal",
    color: "text-pink-400",
    bg: "bg-pink-500/15 border-pink-500/30",
    Icon: Layers,
  },
  settings: {
    label: "Settings",
    color: "text-slate-400",
    bg: "bg-slate-500/15 border-slate-500/30",
    Icon: Settings,
  },
  "404": {
    label: "404",
    color: "text-red-400",
    bg: "bg-red-500/15 border-red-500/30",
    Icon: AlertCircle,
  },
  "tab-bar": {
    label: "Tab Bar",
    color: "text-cyan-400",
    bg: "bg-cyan-500/15 border-cyan-500/30",
    Icon: PanelLeft,
  },
  drawer: {
    label: "Drawer",
    color: "text-orange-400",
    bg: "bg-orange-500/15 border-orange-500/30",
    Icon: ChevronRight,
  },
  sheet: {
    label: "Sheet",
    color: "text-teal-400",
    bg: "bg-teal-500/15 border-teal-500/30",
    Icon: Layers,
  },
  list: {
    label: "List",
    color: "text-indigo-400",
    bg: "bg-indigo-500/15 border-indigo-500/30",
    Icon: List,
  },
  detail: {
    label: "Detail",
    color: "text-sky-400",
    bg: "bg-sky-500/15 border-sky-500/30",
    Icon: Info,
  },
  other: {
    label: "Page",
    color: "text-muted-foreground",
    bg: "bg-muted border-border",
    Icon: Monitor,
  },
};

export const PageNode = memo(function PageNode({
  id,
  data,
  selected,
}: NodeProps & { data: PageNodeData }) {
  const config = PAGE_TYPE_CONFIG[data.pageType] ?? PAGE_TYPE_CONFIG.other;
  const Icon = config.Icon;

  const previewUrl = `/api/projects/${data.projectId}/preview/${data.filePath}`;

  if (data.planned) {
    return (
      <div
        className={cn(
          "relative bg-card/60 border-2 border-dashed rounded-xl shadow-md overflow-hidden cursor-pointer transition-all duration-200",
          "w-52",
          selected
            ? "border-primary shadow-primary/20 ring-2 ring-primary ring-offset-1 ring-offset-background"
            : "border-primary/40 hover:border-primary/70 hover:shadow-lg",
          data.isBuilding && "animate-pulse",
        )}
        onClick={() => data.onNodeClick?.(id)}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
        />

        {/* Card header */}
        <div className="px-3 py-2 border-b border-dashed border-border/60 bg-card/50">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border",
                config.bg,
                config.color,
              )}
            >
              <Icon className="h-2.5 w-2.5 shrink-0" />
              {config.label}
            </div>
            <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-primary/10 text-primary font-bold border border-primary/20">
              PLANNED
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
          <FilePlus className="h-5 w-5 text-primary/40" />
          <span className="text-[9px] text-muted-foreground font-medium">
            No file yet — build to create
          </span>
        </div>

        <Handle
          type="source"
          position={Position.Right}
          className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative bg-card border rounded-xl shadow-lg overflow-hidden cursor-pointer transition-all duration-200",
        "w-52",
        selected
          ? "ring-2 ring-primary shadow-primary/20"
          : "hover:shadow-xl hover:border-primary/40",
        data.isNew &&
          !data.hasError &&
          "ring-2 ring-green-400 ring-offset-1 ring-offset-background",
        data.hasError && "ring-2 ring-red-500 ring-offset-1 ring-offset-background",
        data.isBuilding && "animate-pulse",
      )}
      onClick={() => data.onNodeClick?.(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
      />

      {/* Card header */}
      <div className="px-3 py-2 border-b border-border/60 bg-card/80">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border",
              config.bg,
              config.color,
            )}
          >
            <Icon className="h-2.5 w-2.5 shrink-0" />
            {config.label}
          </div>
          {data.aiGenerated && (
            <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-primary/10 text-primary font-bold border border-primary/20">
              AI
            </span>
          )}
          {data.isNew && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-400 font-bold border border-green-500/20">
              NEW
            </span>
          )}
        </div>
        <div className="mt-1.5 text-xs font-semibold text-foreground truncate">{data.label}</div>
        <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
          {data.filePath}
        </div>
      </div>

      {/* Mini preview thumbnail */}
      <div
        className="relative overflow-hidden bg-muted/40 group"
        style={{ height: 72 }}
        onClick={(e) => {
          e.stopPropagation();
          data.onPreviewClick?.(data.filePath);
        }}
        title="Click to open in Preview tab"
      >
        <iframe
          src={previewUrl}
          className="absolute inset-0 w-full pointer-events-none"
          style={{
            height: 400,
            transform: "scale(0.18)",
            transformOrigin: "top left",
            width: "555%",
          }}
          sandbox="allow-scripts"
          title={`Preview of ${data.label}`}
        />
        <div className="absolute inset-0 bg-transparent group-hover:bg-primary/5 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
          <span className="text-[9px] font-medium text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
            Open preview
          </span>
        </div>
      </div>

      {data.hasError && (
        <div className="px-2 py-1 bg-red-500/10 border-t border-red-500/20 flex items-center gap-1">
          <AlertCircle className="h-2.5 w-2.5 text-red-400 shrink-0" />
          <span className="text-[9px] text-red-400">Build error</span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-border !border-2 !border-background hover:!bg-primary transition-colors"
      />
    </div>
  );
});
