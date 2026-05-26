import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  FolderOpen,
  Search,
  Wrench,
  Package,
  GitBranch,
  Lock,
  Gauge,
  Settings,
  Layers,
} from "lucide-react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";

export type PanelId =
  | "files"
  | "search"
  | "zero-agent"
  | "tools"
  | "packages"
  | "git"
  | "secrets"
  | "resources"
  | "canvas"
  | null;

function DynamicAtomIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse
        cx="10"
        cy="10"
        rx="8"
        ry="3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
      <ellipse
        cx="10"
        cy="10"
        rx="8"
        ry="3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        transform="rotate(60 10 10)"
      />
      <ellipse
        cx="10"
        cy="10"
        rx="8"
        ry="3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        transform="rotate(120 10 10)"
      />
      <circle cx="10" cy="10" r="1.6" fill="currentColor" />
    </svg>
  );
}

const RAIL_ITEMS: Array<{
  id: PanelId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isCustom?: boolean;
}> = [
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "zero-agent", label: "Zero Agent", icon: DynamicAtomIcon, isCustom: true },
  { id: "canvas", label: "Canvas", icon: Layers },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "packages", label: "Packages", icon: Package },
  { id: "git", label: "Version Control", icon: GitBranch },
  { id: "secrets", label: "Secrets", icon: Lock },
  { id: "resources", label: "Resources", icon: Gauge },
];

interface IconRailProps {
  activePanel: PanelId;
  onPanelToggle: (panel: PanelId) => void;
}

export function IconRail({ activePanel, onPanelToggle }: IconRailProps) {
  const { user } = useUser();

  return (
    <nav className="flex flex-col items-center w-12 bg-zinc-950 border-r border-border py-2 shrink-0 z-10">
      {RAIL_ITEMS.map(({ id, label, icon: Icon, isCustom }) => {
        const isActive = activePanel === id;
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onPanelToggle(id)}
                className={cn(
                  "flex items-center justify-center h-10 w-10 rounded-lg transition-colors my-0.5",
                  isActive
                    ? isCustom
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Link href="/settings">
            <button className="flex items-center justify-center h-10 w-10 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors my-0.5">
              <Settings className="h-5 w-5" />
            </button>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>

      {user && (
        <div className="mt-1">
          <img
            src={user.imageUrl}
            alt={user.fullName ?? "User"}
            className="h-7 w-7 rounded-full border border-border object-cover"
            title={user.fullName ?? user.primaryEmailAddress?.emailAddress}
          />
        </div>
      )}
    </nav>
  );
}
