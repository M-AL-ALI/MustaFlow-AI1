import { DatabaseTab } from "@/pages/projects/components/database-tab";

interface DatabasePanelProps {
  projectId: number;
}

export function DatabasePanel({ projectId }: DatabasePanelProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Database
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <DatabaseTab projectId={projectId} />
      </div>
    </div>
  );
}
