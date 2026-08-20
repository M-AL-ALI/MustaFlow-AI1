import { AlertTriangle } from "lucide-react";
import { APPLY_FAILURE_FALLBACK_ERROR, selectBuildFailureError } from "@/lib/user-visible-errors";

export function ApplyFailureNotice({ error }: { error: unknown }) {
  const message = selectBuildFailureError(error, APPLY_FAILURE_FALLBACK_ERROR);

  return (
    <div
      className="flex items-start gap-2 border-b border-border/40 px-2.5 py-2 text-[10px] text-muted-foreground"
      data-testid="apply-failure-notice"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
