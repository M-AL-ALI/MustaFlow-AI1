import { AlertTriangle, CreditCard, ExternalLink, RotateCcw, Wrench } from "lucide-react";
import { selectBuildFailureError } from "@/lib/user-visible-errors";

export function InlineBuilderError({
  title = "I couldn't finish this step.",
  message,
  suggestions,
  recoveryAction,
  onTryFix,
}: {
  title?: string;
  message: string;
  suggestions?: string[];
  recoveryAction?: { label: string; prompt: string };
  onTryFix?: (text: string) => void;
}) {
  const visibleMessage = selectBuildFailureError(message);
  const isInsufficientCredits = visibleMessage.startsWith("Insufficient credits");

  return (
    <div
      className="space-y-2.5 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      data-testid="inline-builder-error"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-0.5 leading-relaxed text-muted-foreground">{visibleMessage}</p>
        </div>
      </div>

      {isInsufficientCredits && (
        <div className="flex flex-wrap items-center gap-2 pl-5 pt-1">
          <a
            href="/billing"
            className="inline-flex items-center gap-1.5 rounded-sm text-[10px] font-medium text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <CreditCard className="h-3 w-3" />
            Open Billing & Usage
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="space-y-1.5 pl-5 pt-1">
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Wrench className="h-3 w-3" /> Recovery options
          </div>
          {suggestions.map((suggestion) => (
            <div key={suggestion} className="flex items-start gap-2">
              <RotateCcw className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 leading-relaxed text-foreground/80">
                {suggestion}
              </span>
              {onTryFix && !recoveryAction && (
                <button
                  type="button"
                  onClick={() => onTryFix(suggestion)}
                  className="shrink-0 rounded-sm text-[10px] font-medium text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                >
                  Try this
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {recoveryAction && onTryFix && (
        <div className="pl-5 pt-1">
          <button
            type="button"
            onClick={() => onTryFix(recoveryAction.prompt)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <RotateCcw className="h-3 w-3" />
            {recoveryAction.label}
          </button>
        </div>
      )}
    </div>
  );
}
