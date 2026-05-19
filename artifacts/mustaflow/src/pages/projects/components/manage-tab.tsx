import { useState, useEffect, useRef } from "react";
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
  Smartphone,
  Upload,
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
  useGetMobileAppSettings,
  useSaveMobileAppSettings,
  getGetMobileAppSettingsQueryKey,
} from "@workspace/api-client-react";

const MOBILE_KINDS = new Set(["mobile-ios", "mobile-android", "mobile-cross"]);

const BUNDLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){1,}$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function validateBundleId(value: string): string | null {
  if (!value.trim()) return null;
  if (!BUNDLE_ID_RE.test(value.trim())) {
    return "Must be reverse-domain format — e.g. com.company.appname";
  }
  return null;
}

function validateHex(value: string): string | null {
  if (!value.trim()) return null;
  if (!HEX_RE.test(value.trim())) {
    return "Must be a valid hex color — e.g. #ffffff or #fff";
  }
  return null;
}

export function ManageTab({ projectId }: { projectId: number }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  // ── Project data ─────────────────────────────────────────────────────────
  const { data: project } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId) },
  });

  const isMobile = MOBILE_KINDS.has(project?.kind ?? "");

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

        {/* Mobile App Settings — only shown for mobile projects */}
        {isMobile && (
          <MobileAppSettingsSection projectId={projectId} />
        )}

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

// ── Mobile App Settings sub-component ────────────────────────────────────────

function MobileAppSettingsSection({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: current, isLoading } = useGetMobileAppSettings(projectId, {
    query: { queryKey: getGetMobileAppSettingsQueryKey(projectId) },
  });

  const [appName, setAppName] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [splashColor, setSplashColor] = useState("#ffffff");

  // Icon state
  const [iconBase64, setIconBase64] = useState<string | null>(null);
  const [iconPreviewUrl, setIconPreviewUrl] = useState<string | null>(null);

  const [bundleIdError, setBundleIdError] = useState<string | null>(null);
  const [packageNameError, setPackageNameError] = useState<string | null>(null);
  const [splashColorError, setSplashColorError] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (current) {
      setAppName(current.appName ?? "");
      setBundleId(current.bundleId ?? "");
      setPackageName(current.packageName ?? "");
      setVersion(current.version ?? "");
      setSplashColor(current.splashBackgroundColor ?? "#ffffff");
    }
  }, [current]);

  const saveMutation = useSaveMobileAppSettings();

  function handleIconFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIconError(null);

    if (file.type !== "image/png") {
      setIconError("Please upload a PNG file. JPEG and WebP are not supported for app icons.");
      return;
    }

    const MAX_SIZE_MB = 5;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      setIconError(`File is too large. Maximum size is ${MAX_SIZE_MB} MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      // Strip the data URL prefix — backend stores raw base64
      const base64 = dataUrl.split(",")[1] ?? "";
      setIconBase64(base64);
      setIconPreviewUrl(dataUrl);
      setSaveSuccess(false);
    };
    reader.readAsDataURL(file);
  }

  function validate(): boolean {
    const bErr = validateBundleId(bundleId);
    const pErr = validateBundleId(packageName);
    const sErr = validateHex(splashColor);
    setBundleIdError(bErr);
    setPackageNameError(pErr);
    setSplashColorError(sErr);
    return !bErr && !pErr && !sErr;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await saveMutation.mutateAsync({
        id: projectId,
        data: {
          appName: appName.trim() || undefined,
          bundleId: bundleId.trim() || undefined,
          packageName: packageName.trim() || undefined,
          version: version.trim() || undefined,
          splashBackgroundColor: splashColor.trim() || undefined,
          iconBase64: iconBase64 ?? undefined,
        },
      });
      await queryClient.invalidateQueries({
        queryKey: getGetMobileAppSettingsQueryKey(projectId),
      });
      setSaveSuccess(true);
      // Clear the pending upload indicator after saving
      setIconBase64(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    }
  }

  // The icon to display: newly uploaded preview takes priority, then saved icon from server
  const displayIconUrl = iconPreviewUrl ?? current?.iconUrl ?? null;

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">App Settings</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Configure app store metadata. Changes are saved directly to{" "}
        <code className="px-1 bg-muted rounded text-[11px]">app.json</code> with a rollback
        snapshot — build the project first if app.json does not yet exist.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading current settings…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* App Name */}
            <div className="space-y-1.5">
              <Label htmlFor="ms-app-name" className="text-xs">App Name</Label>
              <Input
                id="ms-app-name"
                value={appName}
                onChange={(e) => { setAppName(e.target.value); setSaveSuccess(false); }}
                placeholder="My Awesome App"
                className="h-8 text-sm"
              />
            </div>

            {/* Version */}
            <div className="space-y-1.5">
              <Label htmlFor="ms-version" className="text-xs">Version</Label>
              <Input
                id="ms-version"
                value={version}
                onChange={(e) => { setVersion(e.target.value); setSaveSuccess(false); }}
                placeholder="1.0.0"
                className="h-8 text-sm"
              />
            </div>

            {/* Bundle ID (iOS) */}
            <div className="space-y-1.5">
              <Label htmlFor="ms-bundle-id" className="text-xs">
                Bundle ID{" "}
                <span className="text-muted-foreground font-normal">(iOS)</span>
              </Label>
              <Input
                id="ms-bundle-id"
                value={bundleId}
                onChange={(e) => {
                  setBundleId(e.target.value);
                  setBundleIdError(null);
                  setSaveSuccess(false);
                }}
                placeholder="com.company.appname"
                className={`h-8 text-sm font-mono ${bundleIdError ? "border-destructive" : ""}`}
              />
              {bundleIdError && (
                <p className="text-[11px] text-destructive">{bundleIdError}</p>
              )}
            </div>

            {/* Package Name (Android) */}
            <div className="space-y-1.5">
              <Label htmlFor="ms-package-name" className="text-xs">
                Package Name{" "}
                <span className="text-muted-foreground font-normal">(Android)</span>
              </Label>
              <Input
                id="ms-package-name"
                value={packageName}
                onChange={(e) => {
                  setPackageName(e.target.value);
                  setPackageNameError(null);
                  setSaveSuccess(false);
                }}
                placeholder="com.company.appname"
                className={`h-8 text-sm font-mono ${packageNameError ? "border-destructive" : ""}`}
              />
              {packageNameError && (
                <p className="text-[11px] text-destructive">{packageNameError}</p>
              )}
            </div>
          </div>

          {/* Splash Screen Color */}
          <div className="space-y-1.5">
            <Label htmlFor="ms-splash-color" className="text-xs">Splash Screen Background Color</Label>
            <div className="flex items-center gap-2">
              <div
                className="h-8 w-8 rounded border border-border shrink-0"
                style={{ backgroundColor: HEX_RE.test(splashColor) ? splashColor : "#ffffff" }}
              />
              <Input
                id="ms-splash-color"
                value={splashColor}
                onChange={(e) => {
                  setSplashColor(e.target.value);
                  setSplashColorError(null);
                  setSaveSuccess(false);
                }}
                placeholder="#ffffff"
                className={`h-8 text-sm font-mono max-w-[140px] ${splashColorError ? "border-destructive" : ""}`}
              />
              {splashColorError && (
                <p className="text-[11px] text-destructive ml-1">{splashColorError}</p>
              )}
            </div>
          </div>

          {/* App Icon Upload */}
          <div className="space-y-2">
            <Label className="text-xs">App Icon</Label>
            <div className="flex items-start gap-3">
              {/* Icon preview */}
              <div
                className="h-16 w-16 rounded-xl border border-border shrink-0 overflow-hidden bg-muted flex items-center justify-center cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
                title="Click to upload icon"
              >
                {displayIconUrl ? (
                  <img
                    src={displayIconUrl}
                    alt="App icon"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Smartphone className="h-6 w-6 text-muted-foreground/40" />
                )}
              </div>

              <div className="flex-1 space-y-1.5">
                <p className="text-[11px] text-muted-foreground">
                  1024×1024 PNG recommended. Stored as{" "}
                  <code className="bg-muted px-1 rounded text-[10px]">assets/icon.png</code>{" "}
                  and referenced in app.json.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-7 text-xs"
                >
                  <Upload className="h-3 w-3 mr-1.5" />
                  {displayIconUrl ? "Replace Icon" : "Upload Icon"}
                </Button>
                {iconBase64 && (
                  <p className="text-[11px] text-amber-500">
                    New icon selected — click Save to apply.
                  </p>
                )}
                {iconError && (
                  <p className="text-[11px] text-destructive">{iconError}</p>
                )}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png"
              className="hidden"
              onChange={handleIconFileChange}
            />
          </div>

          {saveError && (
            <p className="text-xs text-destructive">{saveError}</p>
          )}

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {saveMutation.isPending ? "Saving…" : "Save App Settings"}
            </Button>
            {saveSuccess && (
              <div className="flex items-center gap-1.5 text-xs text-green-500">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Saved to app.json
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
