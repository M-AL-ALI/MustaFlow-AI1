import { useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useApp } from "../context/AppContext";
import { project } from "../lib/ipc";

export function ProjectsScreen() {
  const { localProjects, refreshProjects } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div style={{ maxWidth: 600, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>Local Projects</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            Folders on this computer that Orax can reference.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => void handleAdd()} disabled={busy}>
          <Plus size={14} /> Add Folder
        </button>
      </div>

      {error && (
        <div style={{ background: "var(--danger-dim)", border: "1px solid var(--danger)", borderRadius: "var(--radius-sm)", padding: "10px 14px", fontSize: 13, color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {localProjects.length === 0 ? (
        <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", padding: 32 }}>
          <FolderOpen size={32} color="var(--text-muted)" />
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>No projects yet</div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
              Add a local folder to get started.
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => void handleAdd()} disabled={busy}>
            <Plus size={13} /> Add Local Folder
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {localProjects.map((proj) => (
            <div
              key={proj.id}
              className="card"
              style={{ display: "flex", alignItems: "center", gap: 12 }}
            >
              <FolderOpen size={16} color="var(--accent)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, overflow: "hidden" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {proj.displayName}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {proj.localPath}
                </div>
              </div>
              <button
                className="btn btn-danger"
                onClick={() => void handleRemove(proj.id)}
                title="Remove"
                style={{ flexShrink: 0, padding: "5px 8px" }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        Project backend sync is added in a future phase. Folders are stored locally only.
      </div>
    </div>
  );
}
