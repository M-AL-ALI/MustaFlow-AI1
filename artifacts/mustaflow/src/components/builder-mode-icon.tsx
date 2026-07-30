import { Brain, Feather, Gem, Leaf, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
export type BuilderAgentMode = "lite" | "eco" | "power" | "pro";

export const BUILDER_AGENT_MODES: readonly BuilderAgentMode[] = ["lite", "eco", "power", "pro"];

const MODE_LABELS: Record<BuilderAgentMode, string> = {
  lite: "Lite",
  eco: "Eco",
  power: "Power",
  pro: "Pro",
};

const MODE_ICONS = {
  lite: Feather,
  eco: Leaf,
  power: Zap,
  pro: Gem,
} satisfies Record<BuilderAgentMode, typeof Feather>;

export function isBuilderAgentMode(value: string): value is BuilderAgentMode {
  return value in MODE_ICONS;
}

export function normalizeBuilderAgentMode(value: string | null | undefined): BuilderAgentMode {
  return value && isBuilderAgentMode(value) ? value : "power";
}

export function builderModeLabel(mode: BuilderAgentMode): string {
  return MODE_LABELS[mode];
}

export function BuilderModeIcon({
  mode,
  className,
}: {
  mode: BuilderAgentMode;
  className?: string;
}) {
  const Icon = MODE_ICONS[mode];
  return <Icon aria-hidden="true" className={cn("shrink-0", className)} />;
}

export function BuilderDeepReasoningIcon({ className }: { className?: string }) {
  return <Brain aria-hidden="true" className={cn("shrink-0", className)} />;
}
