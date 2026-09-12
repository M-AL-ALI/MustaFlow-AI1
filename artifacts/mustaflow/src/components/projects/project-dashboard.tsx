import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ProjectCardSnapshot } from "./project-card-snapshot";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  FolderOpen,
  Grid2X2,
  List,
  Loader2,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";

export interface DashboardProject {
  id: number;
  name: string;
  description?: string | null;
  status: string;
  updatedAt: string;
  kind?: string;
  healthScore?: number | null;
}

export function projectStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    published: "Published",
    failed: "Needs attention",
    building: "Building",
    testing: "Testing",
    ready: "Ready",
    draft: "Draft",
    paused: "Paused",
  };
  return labels[status] ?? "Status unavailable";
}

export function projectDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function selectRecentProjects(
  projects: readonly DashboardProject[],
  query: string,
  filter: string,
  sort: string,
): DashboardProject[] {
  const needle = query.trim().toLocaleLowerCase();
  return projects
    .filter(
      (project) =>
        filter === "all" ||
        (filter === "attention" ? project.status === "failed" : project.status === filter),
    )
    .filter((project) =>
      [project.name, project.description ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
}

type ProjectDashboardProps = {
  heading?: string;
  newProjectHref?: string;
  collectionScope?: "recent" | "workspace";
  projects: readonly DashboardProject[];
  total: number;
  state: "loading" | "error" | "ready";
  onRetry: () => void;
  retrying?: boolean;
  onTrash: (project: DashboardProject) => void;
  removingId?: number | null;
  securityCounts?: Record<string, number>;
  snapshotIdentity?: string | null;
  /** Only the local design harness overrides this. Production uses the isolated preview URL. */
  renderPreview?: (project: DashboardProject) => ReactNode;
  /** Local component reviews supply synthetic snapshots without account reads. */
  renderSnapshot?: (project: DashboardProject) => ReactNode;
};

export function ProjectDashboard({
  heading = "Recent projects",
  newProjectHref = "/projects/new",
  collectionScope = "recent",
  projects,
  total,
  state,
  onRetry,
  retrying = false,
  onTrash,
  removingId,
  securityCounts,
  snapshotIdentity,
  renderPreview,
  renderSnapshot,
}: ProjectDashboardProps) {
  const searchId = useId();
  const resultsId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const matches = useMemo(
    () => selectRecentProjects(projects, query, filter, sort),
    [projects, query, filter, sort],
  );
  // Search the entire supplied collection before bounding rendered cards.
  // Query changes immediately return to the first page without an effect race.
  const selectionKey = JSON.stringify([collectionScope, query, filter, sort]);
  const [page, setPage] = useState({ key: selectionKey, limit: 12 });
  if (page.key !== selectionKey) {
    // Remember every transition, not only Show more. Returning to a previous
    // query must not revive that query's old expanded batch.
    setPage({ key: selectionKey, limit: 12 });
  }
  const limit = page.key === selectionKey ? page.limit : 12;
  const visible = matches.slice(0, limit);
  const completeWorkspace = collectionScope === "workspace" && total === projects.length;
  const searchLabel = completeWorkspace
    ? "Search all workspace projects"
    : "Search recent projects";
  const collectionLabel = completeWorkspace ? "workspace projects" : "recent projects";

  return (
    <section className="nf-projects" aria-labelledby="nf-projects-heading">
      <div className="nf-section-heading">
        <div>
          <p className="nf-eyebrow">Your workspace</p>
          <h2 id="nf-projects-heading">{heading}</h2>
          <p className="nf-supporting">
            {state === "ready"
              ? total > projects.length
                ? "Showing " +
                  projects.length +
                  " recent projects of " +
                  total +
                  ". Filters apply to these projects."
                : completeWorkspace
                  ? "All projects in this workspace. Pick up where you left off."
                  : "Pick up where you left off."
              : "Your work, in one place."}
          </p>
        </div>
        <Link href="/trash" className="nf-quiet-link">
          <Trash2 size={15} aria-hidden="true" /> Open Trash
        </Link>
      </div>

      {state === "loading" ? (
        <div role="status" aria-label="Loading projects" className="nf-project-grid">
          {[0, 1, 2].map((id) => (
            <div key={id} className="nf-project-skeleton" aria-hidden="true" />
          ))}
          <span className="sr-only">Loading your projects</span>
        </div>
      ) : state === "error" ? (
        <div role="alert" className="nf-empty">
          <CircleAlert aria-hidden="true" size={25} />
          <h3>We could not load your projects</h3>
          <p>Your projects have not been changed. Try loading them again.</p>
          <button className="nf-primary-button" onClick={onRetry} disabled={retrying}>
            {retrying && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
            {retrying ? "Retrying" : "Retry"}
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="nf-empty">
          <FolderOpen aria-hidden="true" size={28} />
          <h3>A place for your next idea</h3>
          <p>Describe your app, or start with project details. Projects in Trash stay separate.</p>
          <Link href={newProjectHref} className="nf-primary-button">
            Create a project <ArrowUpRight size={15} />
          </Link>
        </div>
      ) : (
        <>
          <div className="nf-project-toolbar">
            <div className="nf-search">
              <Search size={16} aria-hidden="true" />
              <label htmlFor={searchId} className="sr-only">
                {searchLabel}
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchLabel}
              />
              {query && (
                <button aria-label="Clear project search" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
            <label className="nf-select-label">
              <span className="sr-only">Filter projects by status</span>
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="all">All statuses</option>
                <option value="published">Published</option>
                <option value="attention">Needs attention</option>
                <option value="draft">Draft</option>
                <option value="building">Building</option>
                <option value="testing">Testing</option>
                <option value="ready">Ready</option>
                <option value="paused">Paused</option>
              </select>
            </label>
            <label className="nf-select-label">
              <span className="sr-only">Sort projects</span>
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="recent">Recently updated</option>
                <option value="name">Name</option>
              </select>
            </label>
            <div className="nf-view-switch" role="group" aria-label="Project layout">
              <button
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                <Grid2X2 size={16} />
              </button>
              <button
                aria-label="List view"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <List size={17} />
              </button>
            </div>
          </div>
          <p className="nf-result-count" role="status">
            {"Showing " + visible.length + " of " + matches.length + " matching " + collectionLabel}
            {matches.length !== projects.length && " (" + projects.length + " in this collection)"}
          </p>
          {visible.length === 0 ? (
            <div className="nf-empty">
              <Search size={25} aria-hidden="true" />
              <h3>No matching projects</h3>
              <p>Try another name or clear the current filters.</p>
              <button
                className="nf-secondary-button"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div id={resultsId} className="nf-project-grid" data-view={view}>
              {visible.map((project) => {
                const previewOpen = previewId === project.id;
                const findings = securityCounts?.[String(project.id)];
                const hasHealth =
                  typeof project.healthScore === "number" && Number.isFinite(project.healthScore);
                return (
                  <article key={project.id} className="nf-project-card" aria-label={project.name}>
                    <div className="nf-project-preview">
                      {previewOpen ? (
                        <>
                          {renderPreview ? (
                            renderPreview(project)
                          ) : (
                            <iframe
                              src={"/api/projects/" + project.id + "/preview/index.html"}
                              title={"Project preview: " + project.name}
                              sandbox="allow-scripts"
                              referrerPolicy="no-referrer"
                            />
                          )}
                          <button
                            className="nf-preview-close"
                            aria-label={"Close preview: " + project.name}
                            onClick={() => setPreviewId(null)}
                          >
                            <X size={15} />
                          </button>
                        </>
                      ) : (
                        <button
                          className="nf-preview-request"
                          onClick={() => setPreviewId(project.id)}
                          aria-label={"Preview " + project.name}
                        >
                          {renderSnapshot ? (
                            renderSnapshot(project)
                          ) : (
                            <ProjectCardSnapshot
                              projectId={project.id}
                              projectName={project.name}
                              identity={snapshotIdentity}
                              revision={project.updatedAt}
                            />
                          )}
                        </button>
                      )}
                    </div>
                    <div className="nf-project-body">
                      <div className="nf-project-title-row">
                        <Link href={"/projects/" + project.id} className="nf-project-open">
                          <h3>{project.name}</h3>
                          <ArrowUpRight size={16} aria-hidden="true" />
                        </Link>
                        <details className="nf-project-actions">
                          <summary aria-label={"Actions for " + project.name}>
                            <ChevronDown size={15} />
                          </summary>
                          <div>
                            <button
                              disabled={removingId === project.id}
                              onClick={() => onTrash(project)}
                            >
                              <Trash2 size={14} aria-hidden="true" /> Move to Trash
                            </button>
                          </div>
                        </details>
                      </div>
                      <p className="nf-project-description">
                        {project.description || "Add a description in your project workspace."}
                      </p>
                      <div className="nf-project-meta">
                        <span
                          className="nf-project-status"
                          data-attention={project.status === "failed"}
                        >
                          {project.status === "published" ? (
                            <Check size={13} aria-hidden="true" />
                          ) : project.status === "failed" ? (
                            <CircleAlert size={13} aria-hidden="true" />
                          ) : (
                            <Clock3 size={13} aria-hidden="true" />
                          )}
                          {projectStatusLabel(project.status)}
                        </span>
                        <time
                          dateTime={
                            Number.isNaN(Date.parse(project.updatedAt))
                              ? undefined
                              : project.updatedAt
                          }
                        >
                          {projectDate(project.updatedAt)}
                        </time>
                      </div>
                      {(hasHealth || (findings ?? 0) > 0) && (
                        <div className="nf-project-diagnostics">
                          {hasHealth && <span>Health {project.healthScore}/100</span>}
                          {(findings ?? 0) > 0 && (
                            <span className="nf-security-count">
                              <ShieldAlert size={13} aria-hidden="true" />
                              {findings} critical/high findings
                            </span>
                          )}
                        </div>
                      )}
                      {previewOpen && (
                        <p className="nf-preview-note">
                          Isolated preview. App sign-in may be required; this is not a deployment
                          health check.
                        </p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {matches.length > 12 && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                className="nf-secondary-button"
                aria-controls={resultsId}
                disabled={visible.length >= matches.length}
                onClick={() => setPage({ key: selectionKey, limit: limit + 12 })}
              >
                {visible.length < matches.length
                  ? "Show more projects"
                  : "All matching projects shown"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
