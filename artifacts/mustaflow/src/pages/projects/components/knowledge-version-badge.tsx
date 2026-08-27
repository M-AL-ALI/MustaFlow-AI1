import type { ZeroMemoryVersionState } from "@workspace/ora-contracts";
import { cn } from "@/lib/utils";

const badgeStyle: Record<ZeroMemoryVersionState["state"], string> = {
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  historical: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  unbound: "border-border bg-muted text-muted-foreground",
};

const explanation: Record<ZeroMemoryVersionState["state"], string> = {
  active: "Zero may use this memory with the current app version.",
  historical: "This memory belongs to another version and is not used after this rollback.",
  unbound:
    "Zero cannot verify which app version this memory belongs to, so it is not trusted as current.",
};

export function KnowledgeVersionBadge({
  versionState,
}: {
  versionState: ZeroMemoryVersionState | null | undefined;
}) {
  if (!versionState) return null;
  return (
    <span
      data-testid="knowledge-version-state"
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded font-medium border",
        badgeStyle[versionState.state],
      )}
      title={explanation[versionState.state]}
    >
      {versionState.label}
    </span>
  );
}
