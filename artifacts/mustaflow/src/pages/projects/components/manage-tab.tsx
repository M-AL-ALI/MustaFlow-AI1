import { useState } from "react";
import {
  Trash2,
  Download,
  Copy,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProject,
  useUpdateProject,
  useDeleteProject,
  getGetProjectQueryKey,
  getListProjectsQueryKey,
  getGetProjectsSummaryQueryKey,
} from "@workspace/api-client-react";

export function ManageTab({ projectId }: { projectId: number }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  // ── Project data ─────────────────────────────────────────────────────────
  const { data: project } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId) },
  });

  // ── Duplicate ─────────────────────────────────────────────────────────────
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicateSuccess, setDuplicateSuccess] = useState<{ id: number; name: string } | null>(null);

  // ── Rename ────────────────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSuccess, setRenameSuccess] = useState(false);
  const updateProject = useUpdateProject();

  function openRename() {
    setEditName(project?.name ?? "");
    setEditDesc(project?.description ?? "");
    setRenameError(null);
    setRenameSuccess(false);
    setRenaming(true);
  }

  async function handleRename() {
    if (!editName.trim()) {
      setRenameError("Project name cannot be empty.");
      return;
    }
    setRenameError(null);
    try {
      await updateProject.mutateAsync({
        id: projectId,
        data: { name: editName.trim(), description: editDesc.trim() || undefined },
      });
      await queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      await queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      setRenameSuccess(true);
      setRenaming(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  const [deleteStage, setDeleteStage] = useState<"idle" | "confirm">("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteProject = useDeleteProject();

  async function handleDelete() {
    setDeleteError(null);
    try {
      await deleteProject.mutateAsync({ id: projectId });
      await queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetProjectsSummaryQueryKey() });
      setLocation("/projects");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleteStage("idle");
    }
  }

  async function handleDuplicate() {
    setDuplicating(true);
    setDuplicateError(null);
    setDuplicateSuccess(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { id: number; name: string; filesCount: number };
      setDuplicateSuccess({ id: data.id, name: data.name });
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : "Duplicate failed");
    } finally {
      setDuplicating(false);
    }
  }

  const exportUrl = `/api/projects/${projectId}/export`;

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-bold mb-1">Manage Project</h2>
          <p className="text-sm text-muted-foreground">Project settings, exports, and danger zone.</p>
        </div>

        {/* Rename */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Project Details</h3>
            {!renaming && (
              <Button variant="ghost" size="sm" onClick={openRename}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit
              </Button>
            )}
          </div>

          {renaming ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-name" className="text-xs">Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Project name"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-desc" className="text-xs">Description</Label>
                <Textarea
                  id="edit-desc"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Optional short description"
                  className="text-sm min-h-[60px] resize-none"
                  rows={2}
                />
              </div>
              {renameError && (
                <p className="text-xs text-destructive">{renameError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleRename}
                  disabled={updateProject.isPending}
                >
                  {updateProject.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : null}
                  {updateProject.isPending ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRenaming(false)}
                  disabled={updateProject.isPending}
                >
                  <X className="h-3.5 w-3.5 mr-1.5" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-sm font-medium">{project?.name ?? "—"}</p>
              {project?.description && (
                <p className="text-xs text-muted-foreground">{project.description}</p>
              )}
              {renameSuccess && (
                <div className="flex items-center gap-1.5 text-xs text-green-500 mt-1">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  Saved
                </div>
              )}
            </div>
          )}
        </div>

        {/* Export */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold">Export Files</h3>
          <p className="text-xs text-muted-foreground">
            Download all generated files as a zip archive. Includes a README, folder structure, and a
            <code className="mx-1 px-1 bg-muted rounded text-[11px]">.env.example</code>
            listing required environment variable names — secret values are never included.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={exportUrl} download>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export Files
              </a>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href={exportUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Preview
              </a>
            </Button>
          </div>
        </div>

        {/* Duplicate */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold">Duplicate Project</h3>
          <p className="text-xs text-muted-foreground">
            Create an independent copy with all files. Secrets are not copied for security — add them
            separately in the Tools tab of the new project.
          </p>

          {duplicateSuccess ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-green-500">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Duplicated as <strong>{duplicateSuccess.name}</strong>
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => setLocation(`/projects/${duplicateSuccess.id}`)}
                >
                  Open Duplicate
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDuplicateSuccess(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {duplicateError && (
                <p className="text-xs text-destructive">{duplicateError}</p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDuplicate}
                disabled={duplicating}
              >
                {duplicating ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {duplicating ? "Duplicating…" : "Duplicate Project"}
              </Button>
            </div>
          )}
        </div>

        {/* Danger zone — Delete */}
        <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Danger Zone</h3>
          </div>

          {deleteStage === "idle" ? (
            <>
              <p className="text-xs text-muted-foreground">
                Deleting a project removes it from your dashboard. All files, versions, tasks, and
                secrets are archived and cannot be recovered from the UI.
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteStage("confirm")}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete Project
              </Button>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-destructive font-medium">
                Are you sure? This cannot be undone from the UI.
              </p>
              {deleteError && (
                <p className="text-xs text-destructive">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleteProject.isPending}
                >
                  {deleteProject.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {deleteProject.isPending ? "Deleting…" : "Yes, delete it"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setDeleteStage("idle"); setDeleteError(null); }}
                  disabled={deleteProject.isPending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
