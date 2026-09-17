import {
  WORKSPACE_READINESS_UNBLOCK_LABELS,
  type WorkspaceReadinessReceipt,
} from "@/lib/workspace-readiness";

export function WorkspaceReadinessStatus({
  receipt,
  pending,
  onRecheck,
}: {
  receipt: WorkspaceReadinessReceipt | null;
  pending: boolean;
  onRecheck: () => void;
}) {
  if (!receipt && !pending) return null;
  const presentation = receipt?.presentation;
  return (
    <div
      role="status"
      aria-label="Workspace readiness"
      aria-busy={pending}
      className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs text-foreground"
      data-testid="preview-workspace-readiness"
    >
      <p className="mb-1 text-[10px] font-medium text-muted-foreground">Workspace readiness</p>
      <p className="font-semibold">{pending ? "Checking saved results" : presentation?.title}</p>
      <p className="mt-0.5">
        {pending
          ? "Reading this version's saved review and validation evidence."
          : presentation?.message}
      </p>
      {pending || presentation?.unblock === "recheck" ? (
        <button
          type="button"
          onClick={onRecheck}
          disabled={pending}
          className="mt-2 rounded-md border border-border px-2 py-1 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "Checking..." : "Check again"}
        </button>
      ) : presentation?.unblock ? (
        <p className="mt-1 text-muted-foreground">
          Next step: {WORKSPACE_READINESS_UNBLOCK_LABELS[presentation.unblock]}
        </p>
      ) : null}
    </div>
  );
}
