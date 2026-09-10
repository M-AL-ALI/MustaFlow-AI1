import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Folder, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";
import { useClerkUser } from "@/lib/clerk-safe";
import { presentImageFailure } from "@/lib/image-failure-presentation";
import {
  studioImageToItem,
  type ProjectImageItem,
  type StudioImageRecord,
} from "@/pages/projects/components/project-image-model";
import { createProjectImageRequestScope } from "@/pages/projects/components/project-image-request-scope";

export interface ImageStudioProject {
  id: number;
  name: string;
}

export interface ImageStudioCollectionContext {
  projects: ImageStudioProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  retryProjects: () => void;
}

const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function isProject(value: unknown): value is ImageStudioProject {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ImageStudioProject>;
  return Number.isSafeInteger(row.id) && Number(row.id) > 0 && typeof row.name === "string";
}

function isStudioImage(value: unknown): value is StudioImageRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StudioImageRecord>;
  return (
    Number.isSafeInteger(row.id) &&
    Number(row.id) > 0 &&
    typeof row.prompt === "string" &&
    typeof row.quality === "string" &&
    typeof row.aspectRatio === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.status === "string" &&
    ["pending", "generating", "completed", "failed"].includes(row.status) &&
    [row.fileUrl, row.thumbnailUrl, row.errorMessage].every(
      (field) => field == null || typeof field === "string",
    )
  );
}

type ImageStudioCollectionsProps = {
  children: (context: ImageStudioCollectionContext) => ReactNode;
};

export function ImageStudioCollections({ children }: ImageStudioCollectionsProps) {
  const { isLoaded, isSignedIn, user } = useClerkUser();
  if (!isLoaded || !isSignedIn || !user?.id) return null;

  // Remount all account state together, including hidden drafts and reuse
  // dialogs. Collection changes within this account still retain that state.
  return <AccountImageStudioCollections key={user.id}>{children}</AccountImageStudioCollections>;
}

function AccountImageStudioCollections({ children }: ImageStudioCollectionsProps) {
  const [projects, setProjects] = useState<ImageStudioProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [projectId, setProjectId] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setProjectsLoading(true);
    setProjectsError(null);
    void (async () => {
      try {
        const response = await authFetch("/api/projects", { signal: controller.signal });
        if (!response.ok) throw new Error("Projects unavailable");
        const body: unknown = await response.json();
        if (!Array.isArray(body) || !body.every(isProject)) throw new Error("Projects unavailable");
        if (active) setProjects(body.map(({ id, name }) => ({ id, name })));
      } catch {
        if (active)
          setProjectsError(
            "Project collections could not be loaded. Your account library is still available.",
          );
      } finally {
        if (active) setProjectsLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  const retryProjects = () => setAttempt((current) => current + 1);
  const project = projects.find((entry) => entry.id === projectId);
  const context = { projects, projectsLoading, projectsError, retryProjects };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <section
        aria-label="Image collections"
        className="shrink-0 border-b border-border bg-gradient-to-br from-muted/60 via-background to-background px-4 py-4 sm:px-6"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Image workspace
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
              A collection for each project
            </h2>
          </div>
          <div className="w-full sm:max-w-xs">
            <label htmlFor="image-studio-collection" className="mb-1.5 block text-xs font-medium">
              Collection
            </label>
            <select
              id="image-studio-collection"
              value={projectId ?? "account"}
              aria-describedby="image-studio-scope"
              onChange={(event) => {
                const value = event.target.value;
                if (value === "account") setProjectId(null);
                else if (
                  !projectsLoading &&
                  !projectsError &&
                  projects.some((entry) => entry.id === Number(value))
                ) {
                  setProjectId(Number(value));
                }
              }}
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="account">Account library</option>
              <optgroup label="Project collections" disabled={projectsLoading || !!projectsError}>
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} (#{entry.id})
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
        <p
          id="image-studio-scope"
          className="mt-3 max-w-3xl text-xs leading-relaxed text-muted-foreground"
        >
          {projectId === null
            ? "Account library: generate or upload here, then choose Use in project to review a destination. Selecting a collection only changes what you browse."
            : "Project collection: an inline image appears here when its generation is saved with this project's scope. Selecting another collection does not move or reassign images."}
        </p>
        {projectsLoading ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            Loading project collections...
          </p>
        ) : projectsError ? (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-3 text-xs text-destructive"
          >
            <p>{projectsError}</p>
            <button type="button" onClick={retryProjects} className={secondaryButton}>
              Retry project collections
            </button>
          </div>
        ) : projects.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No projects available. Your account library is ready; a project is required to reuse an
            asset.
          </p>
        ) : null}
      </section>

      {/* Retain account drafts and in-flight generation without mixing them into project results. */}
      <div hidden={projectId !== null} className="min-h-0 flex-1">
        {children(context)}
      </div>
      {projectId !== null && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {project && !projectsLoading && !projectsError ? (
            <ProjectCollection key={project.id} project={project} />
          ) : (
            <p
              role="status"
              className="rounded-xl border border-border p-6 text-sm text-muted-foreground"
            >
              {projectsLoading
                ? "Loading the selected project..."
                : "This project collection is unavailable. Retry the project list or choose another collection."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCollection({ project }: { project: ImageStudioProject }) {
  const scope = useMemo(() => createProjectImageRequestScope(project.id), [project.id]);
  const [result, setResult] = useState<{
    scope: typeof scope;
    images: ProjectImageItem[];
    loading: boolean;
    error: string | null;
  }>({ scope, images: [], loading: true, error: null });

  useLayoutEffect(() => {
    scope.activate();
    return () => scope.deactivate();
  }, [scope]);

  const refresh = useCallback(async () => {
    const isCurrent = scope.capture("list");
    if (!isCurrent()) return;
    setResult((current) => ({
      scope,
      images: current.scope === scope ? current.images : [],
      loading: true,
      error: null,
    }));
    try {
      const response = await authFetch(
        `/api/images?projectId=${encodeURIComponent(String(project.id))}&limit=50`,
      );
      if (!response.ok) throw new Error("Project images unavailable");
      const body: unknown = await response.json();
      const rows = body && typeof body === "object" ? (body as { images?: unknown }).images : null;
      if (!Array.isArray(rows) || !rows.every(isStudioImage))
        throw new Error("Project images unavailable");
      if (isCurrent())
        setResult({ scope, images: rows.map(studioImageToItem), loading: false, error: null });
    } catch {
      if (isCurrent())
        setResult((current) => ({
          ...current,
          loading: false,
          error: "This project's generated images could not be loaded. Try again.",
        }));
    }
  }, [project.id, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = result.scope === scope ? result : { images: [], loading: true, error: null };
  const pending = current.images.some(
    (entry) => entry.status === "pending" || entry.status === "generating",
  );
  useEffect(() => {
    if (!pending || current.error) return;
    const interval = setInterval(() => void refresh(), 2000);
    return () => clearInterval(interval);
  }, [pending, current.error, refresh]);

  return (
    <section aria-label={`Images for ${project.name}`} className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Folder className="h-3.5 w-3.5" aria-hidden="true" /> Project collection
          </p>
          <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Generated images linked to project #{project.id}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={current.loading}
          className={secondaryButton}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh collection
        </button>
      </div>
      <div className="my-5 rounded-xl border border-border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
        <p>
          Showing up to 50 generated records for this project. Images saved only as project files
          and older chat history are not included in this view.
        </p>
        <p className="mt-2">
          To reuse a library asset, select Account library, choose Use in project, and confirm the
          destination. Browsing here does not add an image to your app.
        </p>
      </div>
      {current.error && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm"
        >
          <p className="text-destructive">{current.error}</p>
          {current.images.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing the last loaded images for {project.name}.
            </p>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            className={`${secondaryButton} mt-3`}
          >
            Retry project images
          </button>
        </div>
      )}
      {current.loading && (
        <p role="status" className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {current.images.length ? "Refreshing project images..." : "Loading project images..."}
        </p>
      )}
      {!current.loading && !current.error && current.images.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
          <ImageIcon className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 text-base font-semibold">
            No generated images in this collection yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Create an image inside {project.name}, then refresh this collection. Other collections
            keep their own images.
          </p>
        </div>
      )}
      <div
        aria-busy={current.loading}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {current.images.map((entry) => (
          <CollectionImageCard key={entry.key} image={entry} />
        ))}
      </div>
    </section>
  );
}

function CollectionImageCard({ image }: { image: ProjectImageItem }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = image.thumbnailUrl || image.imageUrl;
  const pending = image.status === "pending" || image.status === "generating";
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex aspect-[4/3] items-center justify-center bg-muted/40">
        {pending ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {image.status === "pending" ? "Queued" : "Generating image..."}
          </p>
        ) : image.status === "failed" ? (
          <div className="p-4 text-center">
            <AlertCircle className="mx-auto mb-2 h-5 w-5 text-destructive" aria-hidden="true" />
            <p className="text-sm font-medium">Generation failed</p>
            <p className="mt-1 text-xs text-muted-foreground">{presentImageFailure(image.error)}</p>
          </div>
        ) : source && failedSource !== source ? (
          <img
            src={source}
            alt={image.prompt}
            loading="lazy"
            onError={() => setFailedSource(source)}
            className="h-full w-full object-cover"
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Preview unavailable</p>
        )}
      </div>
      <div className="space-y-3 p-4">
        <p className="line-clamp-3 break-words text-sm leading-relaxed">{image.prompt}</p>
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span className="rounded bg-muted px-2 py-1">{image.quality}</span>
          <span className="rounded bg-muted px-2 py-1">{image.aspectRatio}</span>
        </div>
        {image.status === "completed" && image.imageUrl && (
          <a
            href={image.imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={secondaryButton}
            aria-label={`Open image: ${image.prompt}`}
          >
            Open image
          </a>
        )}
      </div>
    </article>
  );
}
