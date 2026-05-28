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
  Database,
  Boxes,
} from "lucide-react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { DynamicAtom } from "@/components/icons/dynamic-atom";

export type PanelId =
  | "files"
  | "search"
  | "zero-agent"
  | "tools"
  | "packages"
  | "git"
  | "secrets"
  | "database"
  | "storage"
  | "resources"
  | "canvas"
  | null;

/** Wrapper so DynamicAtom matches the icon rail's ComponentType<{className?}> contract */
function DynamicAtomRailIcon({ className }: { className?: string }) {
  return <DynamicAtom size={16} animate={false} className={className} />;
}

const RAIL_ITEMS: Array<{
  id: PanelId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isCustom?: boolean;
}> = [
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "zero-agent", label: "Zero Agent", icon: DynamicAtomRailIcon, isCustom: true },
  { id: "canvas", label: "Canvas", icon: Layers },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "secrets", label: "Secrets", icon: Lock },
  { id: "packages", label: "Packages", icon: Package },
  { id: "git", label: "Version Control", icon: GitBranch },
  { id: "database", label: "Database", icon: Database },
  { id: "storage", label: "Object Storage", icon: Boxes },
  { id: "resources", label: "Resources", icon: Gauge },
];

interface IconRailProps {
  activePanel: PanelId;
  onPanelToggle: (panel: PanelId) => void;
  onOpenSearch?: () => void;
}

export function IconRail({ activePanel, onPanelToggle, onOpenSearch }: IconRailProps) {
  const { user } = useUser();

  return (
    <nav className="flex flex-col items-center w-12 bg-zinc-950 border-r border-border py-2 shrink-0 z-10">
      {RAIL_ITEMS.map(({ id, label, icon: Icon, isCustom }) => {
        const isActive = activePanel === id;
        // Wrench ("tools") opens the search popup if onOpenSearch is wired
        const handleClick = id === "tools" && onOpenSearch ? onOpenSearch : () => onPanelToggle(id);
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                onClick={handleClick}
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
          <Link
            href="/settings"
            className="flex items-center justify-center h-10 w-10 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors my-0.5 no-underline"
          >
            <Settings className="h-5 w-5" />
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
