import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectDashboard, type DashboardProject } from "@/components/projects/project-dashboard";
import "@/index.css";

if (!import.meta.env.DEV) {
  throw new Error("Dashboard collection review is available in development only.");
}

const projects: DashboardProject[] = Array.from({ length: 25 }, (_, index) => ({
  id: 900 + index,
  name: "Project " + String(index + 1).padStart(2, "0"),
  description:
    index === 24
      ? "Older searchable project"
      : "Synthetic workspace project for local component verification.",
  status: index === 24 ? "paused" : index === 23 ? "ready" : "draft",
  updatedAt: new Date(Date.UTC(2026, 8, 25 - index)).toISOString(),
}));

function DashboardCollectionReview() {
  const [scenario, setScenario] = useState("ready");
  const [notice, setNotice] = useState("");
  const rows = scenario === "empty" ? [] : projects;
  return (
    <main
      className="nf-dashboard"
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("a")) {
          event.preventDefault();
          setNotice("Navigation is disabled in this synthetic local review.");
        }
      }}
    >
      <header className="mb-8 border-b border-border pb-6">
        <p className="nf-eyebrow">Development-only component proof</p>
        <h1 className="my-3 text-3xl font-semibold tracking-tight">Workspace collection</h1>
        <p className="nf-supporting">
          Real dashboard component, 25 synthetic projects. No production API, build, publication or
          deletion is performed.
        </p>
        <label className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          Review state
          <select
            className="rounded-md border border-border bg-background p-2"
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
          >
            <option value="ready">Ready collection</option>
            <option value="partial">Partial collection</option>
            <option value="empty">Empty collection</option>
            <option value="loading">Loading</option>
            <option value="error">Error</option>
          </select>
        </label>
        {notice && (
          <p role="status" className="mt-3 text-sm">
            {notice}
          </p>
        )}
      </header>
      <ProjectDashboard
        key={scenario}
        heading="Projects"
        collectionScope="workspace"
        projects={rows}
        total={scenario === "partial" ? 100 : rows.length}
        state={scenario === "loading" || scenario === "error" ? scenario : "ready"}
        onRetry={() => setNotice("Retry callback exercised. This fixture keeps the error visible.")}
        onTrash={() => setNotice("Trash callback exercised. No project was changed.")}
        snapshotIdentity={null}
        renderPreview={() => (
          <p className="p-6 text-sm">Local preview fixture. No runtime or iframe is started.</p>
        )}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Dashboard review root is missing.");
createRoot(root).render(<DashboardCollectionReview />);
