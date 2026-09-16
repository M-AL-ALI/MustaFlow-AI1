import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PreviewDeviceFrameProps = {
  device: "desktop" | "tablet" | "mobile";
  platform: "web" | "ios" | "android";
  projectName: string;
  path: string;
  address?: string;
  nativeSimulation: boolean;
  children: ReactNode;
};

/** Keep the document in one stable slot; a viewport change is not navigation. */
export function PreviewDeviceFrame({
  device,
  platform,
  projectName,
  path,
  address,
  nativeSimulation,
  children,
}: PreviewDeviceFrameProps) {
  const desktop = device === "desktop";
  return (
    <div
      className={cn("mx-auto flex max-w-full flex-col", desktop ? "h-full w-full" : "py-4")}
      data-preview-device={device}
    >
      <div
        hidden={!nativeSimulation || device !== "mobile"}
        className="pb-2 text-center text-xs text-muted-foreground"
      >
        Mobile preview (web simulation): {platform === "android" ? "Android" : "iOS"}
      </div>
      <div
        className={cn(
          "flex max-w-full flex-col overflow-hidden border border-border bg-muted/40 shadow-lg",
          desktop ? "h-full rounded-xl" : device === "tablet" ? "rounded-2xl" : "rounded-3xl",
        )}
        style={{
          width: desktop ? "100%" : device === "tablet" ? 768 : 390,
          height: desktop ? "100%" : device === "tablet" ? 1024 : 844,
        }}
      >
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-3 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate font-medium">{projectName}</span>
          <span
            className="max-w-[55%] truncate font-mono"
            title={address ? `${address} ${path}` : path}
          >
            {address ? `${address} ${path}` : path}
          </span>
        </div>
        <div
          className="relative min-h-0 flex-1 overflow-hidden bg-white"
          data-testid="preview-document-slot"
        >
          {children}
        </div>
        <div hidden={desktop} aria-hidden="true" className="shrink-0 py-2">
          <div className="mx-auto h-1 w-16 rounded-full bg-muted-foreground/30" />
        </div>
      </div>
    </div>
  );
}
