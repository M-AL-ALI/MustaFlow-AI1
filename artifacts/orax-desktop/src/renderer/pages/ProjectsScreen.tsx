import { useEffect, useState } from "react";
import {
  AlertCircle,
  Cloud,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { project } from "../lib/ipc";

interface CloudProject {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  sources: CloudProjectSource[];
}

interface CloudProjectSource {
  id: string;
  projectId: string;
  kind: "local_folder" | "github_repo";
  localPath: string | null;
  githubRepoUrl: string | null;
  displayName: string | null;
}

export function ProjectsScreen() {
  const { localProjects, refreshProjects } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([]);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);

  async function loadCloudProjects() {
    setCloudLoading(true);
    try {
      const result = (await project.listCloudProjects()) as { projects: CloudProject[] };
      setCloudProjects(result.projects ?? []);
    } catch {
      // cloud not reachable — show empty state
    } finally {
      setCloudLoading(false);
    }
  }

  useEffect(() => {
    void loadCloudProjects();
  }, []);

  async function handleAdd() {
    setBusy(true);
    setError(null);
    try {
      const added = await project.addLocalFolder();
      if (added) await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add folder.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    try {
      await project.removeLocalFolder(id);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove project.");
    }
  }

  async function handleCreateCloudProject() {
    if (!newProjectName.trim()) return;
    setBusy(true);
    try {
      const result = (await project.createCloudProject(newProjectName.trim())) as {
        project: CloudProject;
      };
      setCloudProjects((prev) => [result.project, ...prev]);
      setNewProjectName("");
      setShowNewProject(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAttachToProject(cloudProjectId: string) {
    setBusy(true);
    setError(null);
    try {
      await project.attachLocalFolderToProject(cloudProjectId);
      await Promise.all([refreshProjects(), loadCloudProjects()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to attach folder.");
    } finally {
      setBusy(false);
    }
  }

  function isMissingLocal(source: CloudProjectSource): boolean {
    if (source.kind !== "local_folder") return false;
    return !localProjects.some((lp) => lp.localPath === source.localPath);
  }

  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
            Orax Projects
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            Cloud workspaces with execution sources, threads, and host bindings.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-secondary"
            onClick={() => void loadCloudProjects()}
            title="Refresh"
            disabled={cloudLoading}
          >
            <RefreshCw size={13} />
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setShowNewProject(true)}
            disabled={busy}
          >
            <Plus size={14} /> New Project
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "var(--danger-dim)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            fontSize: 13,
            color: "var(--danger)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {showNewProject && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            New Cloud Project
          </div>
          <input
            className="input"
            placeholder="Project name"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateCloudProject();
              if (e.key === "Escape") setShowNewProject(false);
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary"
              onClick={() => void handleCreateCloudProject()}
              disabled={busy || !newProjectName.trim()}
            >
              Create
            </button>
            <button className="btn btn-secondary" onClick={() => setShowNewProject(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          <Cloud size={12} />
          Cloud Projects
        </div>

        {cloudLoading ? (
          <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "10px 0" }}>
            Loading projects…
          </div>
        ) : cloudProjects.length === 0 ? (
          <div
            className="card"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              textAlign: "center",
              padding: 28,
            }}
          >
            <Cloud size={28} color="var(--text-muted)" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                No cloud projects yet
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                Create a project to sync execution sources and threads.
              </div>
            </div>
          </div>
        ) : (
          cloudProjects.map((proj) => (
            <div
              key={proj.id}
              className="card"
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Cloud size={15} color="var(--accent)" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {proj.name}
                  </div>
                  {proj.description && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {proj.description}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-primary"
                  style={{ flexShrink: 0, fontSize: 11, padding: "4px 10px" }}
                  onClick={() => void handleAttachToProject(proj.id)}
                  disabled={busy}
                  title="Attach local folder to this project"
                >
                  <FolderOpen size={12} /> Attach local folder
                </button>
              </div>

              {proj.sources.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 25 }}>
                  {proj.sources.map((src) => {
                    const missing = isMissingLocal(src);
                    return (
                      <div
                        key={src.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          fontSize: 12,
                          color: missing ? "var(--danger)" : "var(--text-secondary)",
                        }}
                      >
                        {src.kind === "github_repo" ? (
                          <GitBranch size={11} />
                        ) : (
                          <FolderOpen size={11} />
                        )}
                        <span
                          style={{
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {src.displayName ??
                            src.localPath ??
                            src.githubRepoUrl ??
                            "Unknown source"}
                        </span>
                        {missing && (
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              fontSize: 11,
                              color: "var(--danger)",
                              flexShrink: 0,
                            }}
                            title="This folder is not available on this desktop. Reconnect folder on desktop to re-link it."
                          >
                            <Unlink size={10} />
                            Reconnect folder on desktop
                          </span>
                        )}
                        {src.kind === "local_folder" && src.localPath && (
                          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                            .orax/project.json
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            <FolderOpen size={12} />
            Local Folders
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => void handleAdd()}
            disabled={busy}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            <Plus size={12} /> Add Folder
          </button>
        </div>

        {localProjects.length === 0 ? (
          <div
            className="card"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              textAlign: "center",
              padding: 28,
            }}
          >
            <FolderOpen size={28} color="var(--text-muted)" />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                No local folders linked
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                Add a local folder to attach it to a cloud project.
              </div>
            </div>
            <button className="btn btn-secondary" onClick={() => void handleAdd()} disabled={busy}>
              <Plus size={13} /> Add Local Folder
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {localProjects.map((lp) => (
              <div
                key={lp.id}
                className="card"
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                <FolderOpen size={16} color="var(--accent)" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {lp.displayName}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {lp.localPath}
                  </div>
                </div>
                <button
                  className="btn btn-danger"
                  onClick={() => void handleRemove(lp.id)}
                  title="Remove"
                  style={{ flexShrink: 0, padding: "5px 8px" }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
