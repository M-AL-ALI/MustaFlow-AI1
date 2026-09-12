import { useId, type ReactNode } from "react";
export function WorkspaceHomeLayout({
  workspaceName,
  onChooseWorkspace,
  composer,
  projects,
}: {
  workspaceName: string;
  onChooseWorkspace: () => void;
  composer: ReactNode;
  projects: ReactNode;
}) {
  const projectsId = "workspace-projects-" + useId();
  return (
    <section className="nf-dashboard nf-workspace-home-shell" aria-label="Workspace home">
      <header className="nf-workspace-home-header">
        <div className="nf-workspace-home-identity">
          <p className="nf-eyebrow">Workspace</p>
          <p className="nf-workspace-home-name" dir="auto">
            {workspaceName}
          </p>
        </div>
        <nav aria-label="Workspace actions" className="nf-workspace-home-actions">
          <a href={"#" + projectsId} className="nf-quiet-link">
            Browse projects
          </a>
          <button type="button" className="nf-secondary-button" onClick={onChooseWorkspace}>
            Switch workspace
          </button>
        </nav>
      </header>
      <div className="nf-workspace-home">
        <div className="nf-workspace-create">{composer}</div>
        <div className="nf-workspace-projects" id={projectsId} tabIndex={-1}>
          {projects}
        </div>
      </div>
    </section>
  );
}
