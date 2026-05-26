import { Wrench, Package, GitBranch, Lock, Bot, Construction } from "lucide-react";

type PanelType = "tools" | "packages" | "git" | "secrets" | "zero-agent";

const PANEL_CONFIG: Record<
  PanelType,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
    phase: string;
  }
> = {
  "zero-agent": {
    icon: Bot,
    title: "Zero Agent",
    description:
      "AI-powered coding assistant with tool call streaming, Plan Mode, and background builds.",
    phase: "Phase 4",
  },
  tools: {
    icon: Wrench,
    title: "Tools",
    description: "Secrets, packages, git, database, object storage, and resource management.",
    phase: "Phase 5",
  },
  packages: {
    icon: Package,
    title: "Package Manager",
    description: "Install, update, and remove npm packages for your project.",
    phase: "Phase 5",
  },
  git: {
    icon: GitBranch,
    title: "Version Control",
    description: "Stage, commit, push, and manage branches directly in the workspace.",
    phase: "Phase 5",
  },
  secrets: {
    icon: Lock,
    title: "Secrets",
    description: "Manage project environment variables and secrets securely.",
    phase: "Phase 5",
  },
};

interface PlaceholderPanelProps {
  type: PanelType;
}

export function PlaceholderPanel({ type }: PlaceholderPanelProps) {
  const config = PANEL_CONFIG[type];
  const Icon = config.icon;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {config.title}
        </span>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-muted/50 border border-border flex items-center justify-center">
          <Icon className="h-6 w-6 text-muted-foreground/50" />
        </div>
        <div>
          <div className="text-sm font-medium text-foreground mb-1">{config.title}</div>
          <div className="text-xs text-muted-foreground max-w-[180px] leading-relaxed">
            {config.description}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground bg-muted/30 border border-border rounded px-2 py-1">
          <Construction className="h-3 w-3" />
          Coming in {config.phase}
        </div>
      </div>
    </div>
  );
}
