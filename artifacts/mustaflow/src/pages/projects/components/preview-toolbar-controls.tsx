import {
  Camera,
  ChevronDown,
  Crosshair,
  Globe,
  ImagePlus,
  ListTree,
  Maximize2,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type PreviewActionsMenuProps = {
  referenceActive: boolean;
  onAddReference: () => void;
  onObserve?: () => void;
  observing: boolean;
  onSelectRegion?: () => void;
  onRefreshRuntime?: () => void;
  onRestartBrowserPreview?: () => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
};

export function PreviewActionsMenu(props: PreviewActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          aria-label="Preview tools"
        >
          Tools <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Preview tools</DropdownMenuLabel>
        {props.onObserve && (
          <DropdownMenuItem onSelect={props.onObserve} disabled={props.observing}>
            <Camera aria-hidden="true" /> Ask Zero to observe this preview
          </DropdownMenuItem>
        )}
        {props.onSelectRegion && (
          <DropdownMenuItem onSelect={props.onSelectRegion} disabled={props.observing}>
            <Crosshair aria-hidden="true" /> Point to a region for Zero
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={props.onAddReference}>
          <ImagePlus aria-hidden="true" />
          {props.referenceActive ? "Replace reference overlay" : "Add reference overlay"}
        </DropdownMenuItem>
        {(props.onRefreshRuntime || props.onRestartBrowserPreview) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recovery</DropdownMenuLabel>
            {props.onRefreshRuntime && (
              <DropdownMenuItem onSelect={props.onRefreshRuntime}>
                <RefreshCw aria-hidden="true" /> Refresh runtime status
              </DropdownMenuItem>
            )}
            {props.onRestartBrowserPreview && (
              <DropdownMenuItem onSelect={props.onRestartBrowserPreview}>
                <RefreshCw aria-hidden="true" /> Retry browser preview
              </DropdownMenuItem>
            )}
          </>
        )}
        {props.onToggleFocusMode && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={Boolean(props.focusMode)}
              onCheckedChange={props.onToggleFocusMode}
            >
              <Maximize2 className="mr-2 h-4 w-4" aria-hidden="true" /> Focus mode
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type PreviewRoute = {
  path: string;
  label: string;
  kind: "web" | "expo";
  fileId?: number;
};

export function PreviewRoutesMenu(props: {
  routes: PreviewRoute[];
  currentPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  onOpenFile?: (fileId: number) => void;
}) {
  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          aria-label="Browse preview routes"
        >
          <ListTree className="h-3 w-3" aria-hidden="true" />
          Routes <span className="text-muted-foreground">{props.routes.length}</span>
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {(["web", "expo"] as const).map((kind) => {
          const routes = props.routes.filter((route) => route.kind === kind);
          if (routes.length === 0) return null;
          const Icon = kind === "web" ? Globe : Smartphone;
          return (
            <div key={kind}>
              <DropdownMenuLabel>
                {kind === "web" ? "Preview pages" : "Native source files"}
              </DropdownMenuLabel>
              {routes.map((route) => (
                <DropdownMenuItem
                  key={route.kind + ":" + route.path}
                  disabled={kind === "expo" && (route.fileId == null || !props.onOpenFile)}
                  aria-label={
                    kind === "web"
                      ? "Navigate to " + route.label
                      : "Open source file for " + route.label
                  }
                  aria-current={
                    kind === "web" && route.path === props.currentPath ? "page" : undefined
                  }
                  onSelect={() => {
                    props.onOpenChange(false);
                    if (kind === "web") props.onNavigate(route.path);
                    else if (route.fileId != null) props.onOpenFile?.(route.fileId);
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span className="truncate font-mono text-xs">{route.label}</span>
                </DropdownMenuItem>
              ))}
            </div>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
          Listed from project files. Preview pages navigate the app; native entries open source
          files.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PreviewStatusSummary(props: {
  hasRuntime: boolean;
  runtimeStatus?: "stopped" | "starting" | "running" | "hibernated" | "error";
  hasFiles: boolean;
  serverPreviewLive: boolean;
  webContainerLive: boolean;
  agenticPreviewUnavailable: boolean;
}) {
  const runtimeLabel: Record<NonNullable<typeof props.runtimeStatus>, string> = {
    stopped: "Runtime stopped",
    starting: "Runtime starting",
    running: "Runtime running",
    hibernated: "Runtime hibernated",
    error: "Runtime error",
  };
  // Source and lifecycle are independent: publishing does not select a preview snapshot.
  const previewLabel = !props.hasFiles
    ? "No preview files loaded"
    : props.agenticPreviewUnavailable
      ? "Server preview unavailable"
      : props.webContainerLive
        ? "Browser preview"
        : props.serverPreviewLive
          ? "Server preview"
          : "File preview";

  return (
    <div
      role="status"
      aria-label="Runtime and preview status"
      className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground"
    >
      {(props.hasRuntime || props.runtimeStatus) && (
        <span
          className="rounded-full border border-border px-2 py-0.5"
          title="Runtime status is independent of build results and preview availability."
        >
          {props.runtimeStatus ? runtimeLabel[props.runtimeStatus] : "Runtime status unknown"}
        </span>
      )}
      <span
        className="px-1"
        title="Preview source only. Build, runtime, and testing states are tracked separately."
      >
        {previewLabel}
      </span>
    </div>
  );
}
