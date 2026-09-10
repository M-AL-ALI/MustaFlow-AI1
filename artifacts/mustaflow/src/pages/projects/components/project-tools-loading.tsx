export function ProjectToolsLoading({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="fixed inset-x-4 top-20 z-50 mx-auto flex max-w-sm items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3 text-sm shadow-lg">
      <span role="status" aria-live="polite">
        Opening project tools...
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="min-h-11 rounded-lg px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Cancel
      </button>
    </div>
  );
}
