import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { builderCreditCost } from "@/lib/builder-followup-submit";
import {
  BuilderDeepReasoningIcon,
  BuilderModeIcon,
  type BuilderAgentMode,
} from "@/components/builder-mode-icon";

export type { BuilderAgentMode } from "@/components/builder-mode-icon";

export const BUILDER_MODE_OPTIONS: ReadonlyArray<{
  mode: BuilderAgentMode;
  label: string;
  description: string;
}> = [
  { mode: "lite", label: "Lite", description: "Quick, minimal changes" },
  { mode: "eco", label: "Eco", description: "Balanced planning and clean typed code" },
  { mode: "power", label: "Power", description: "Deeper planning for production-ready work" },
  { mode: "pro", label: "Pro", description: "Deepest planning with strict review" },
];

function creditLabel(credits: number): string {
  return `${credits} ${credits === 1 ? "credit" : "credits"}`;
}

export function BuilderModeControl({
  mode,
  deepReasoning,
  disabled,
  onModeChange,
  onDeepReasoningChange,
}: {
  mode: BuilderAgentMode;
  deepReasoning: boolean;
  disabled: boolean;
  onModeChange: (mode: BuilderAgentMode) => void;
  onDeepReasoningChange: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = BUILDER_MODE_OPTIONS.find((option) => option.mode === mode)!;
  const selectedCost = builderCreditCost(mode, deepReasoning);
  const deepDisabled = mode === "lite" || disabled;

  return (
    <div data-testid="builder-mode-picker" className="mt-2 px-3 min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-testid="builder-mode-trigger"
            aria-label={`Mode: ${selected.label}, ${creditLabel(selectedCost)}`}
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-[10px] font-medium text-foreground transition-colors",
              "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <span className="text-muted-foreground">Mode</span>
            <BuilderModeIcon mode={mode} className="h-3 w-3" />
            <span className="truncate">
              {selected.label} · {creditLabel(selectedCost)}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-[min(22rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-2"
          data-testid="builder-mode-panel"
        >
          <div className="px-1 pb-2">
            <p className="text-xs font-semibold text-foreground">Choose a mode</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Every mode can build a complete app. Higher modes spend more time planning and
              checking.
            </p>
          </div>

          <div className="space-y-1">
            {BUILDER_MODE_OPTIONS.map((option) => {
              const selectedMode = option.mode === mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onModeChange(option.mode);
                    if (option.mode === "lite") onDeepReasoningChange(false);
                  }}
                  aria-pressed={selectedMode}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                    selectedMode
                      ? "border-primary/50 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-muted/60",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <BuilderModeIcon mode={option.mode} className="mt-0.5 h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-foreground">
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-[10px] font-medium text-foreground">
                    {creditLabel(builderCreditCost(option.mode))}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              data-testid="deep-reasoning-toggle"
              disabled={deepDisabled}
              onClick={() => onDeepReasoningChange(!deepReasoning)}
              aria-pressed={deepReasoning}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                deepReasoning
                  ? "border-primary/50 bg-primary/10"
                  : "border-border hover:bg-muted/60",
                deepDisabled && "cursor-not-allowed opacity-40",
              )}
            >
              <BuilderDeepReasoningIcon className="h-4 w-4" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-foreground">Deep Reasoning</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                  {mode === "lite"
                    ? "Available in Eco, Power, and Pro"
                    : `Use the deepest planning pass · ${selected.label} becomes ${creditLabel(
                        builderCreditCost(mode, true),
                      )}`}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
                  deepReasoning ? "border-primary bg-primary" : "border-border bg-muted",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform",
                    deepReasoning ? "translate-x-[17px]" : "translate-x-0.5",
                  )}
                />
              </span>
            </button>
            <p className="px-3 pt-1.5 text-[9px] text-muted-foreground">
              Deep prices:{" "}
              {BUILDER_MODE_OPTIONS.filter((option) => option.mode !== "lite")
                .map(
                  (option) =>
                    `${option.label} ${creditLabel(builderCreditCost(option.mode, true))}`,
                )
                .join(" · ")}
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
