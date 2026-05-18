import { Trash2, Download, Copy, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ManageTab({ projectId }: { projectId: number }) {
  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-bold mb-1">Manage Project</h2>
          <p className="text-sm text-muted-foreground">Project settings, exports, and danger zone.</p>
        </div>

        {/* Export */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold">Export</h3>
          <p className="text-xs text-muted-foreground">
            Download all generated files as a zip archive.
          </p>
          <Button variant="outline" size="sm" disabled>
            <Download className="h-3.5 w-3.5 mr-1.5" /> Export Files
          </Button>
        </div>

        {/* Duplicate */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold">Duplicate</h3>
          <p className="text-xs text-muted-foreground">
            Create a copy of this project with all files and settings.
          </p>
          <Button variant="outline" size="sm" disabled>
            <Copy className="h-3.5 w-3.5 mr-1.5" /> Duplicate Project
          </Button>
        </div>

        {/* Danger zone */}
        <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Danger Zone</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Deleting a project is permanent and cannot be undone. All files, versions, tasks, and secrets will be removed.
          </p>
          <Button variant="destructive" size="sm" disabled>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete Project
          </Button>
        </div>
      </div>
    </div>
  );
}
