import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { ProjectComposer } from "@/components/projects/project-composer";
import { ProjectDashboard } from "@/components/projects/project-dashboard";
import { WorkspaceHomeLayout } from "@/components/projects/workspace-home-layout";
import "@/index.css";
if (
  !import.meta.env.DEV ||
  !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
) {
  throw new Error("Workspace home review is local development only.");
}
const projects = [
  {
    id: 901,
    name: "Cedar bookings",
    description: "Appointments, availability and customer notes.",
    status: "published",
    updatedAt: "2026-09-11T09:00:00Z",
  },
  {
    id: 902,
    name: "Studio notebook",
    description: "A shared place for ideas and decisions.",
    status: "draft",
    updatedAt: "2026-09-10T09:00:00Z",
  },
  {
    id: 903,
    name: "Client portal",
    description: "Project updates and handover documents.",
    status: "ready",
    updatedAt: "2026-09-09T09:00:00Z",
  },
];
function Review() {
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState("Product studio");
  const [location, setLocation] = useState("/projects");
  const [message, setMessage] = useState("No project was created. All rows below are synthetic.");
  const route = useCallback(
    (): [string, (to: string) => void] => [location, setLocation],
    [location],
  );
  return (
    <Router hook={route}>
      <div className="nabuflow-shell min-h-screen">
        <p className="border-b border-border px-6 py-3 text-xs text-muted-foreground">
          LOCAL COMPONENT REVIEW. Shared production components with synthetic data; no real account,
          build, billing or provider operations.
        </p>
        <WorkspaceHomeLayout
          workspaceName={workspace}
          onChooseWorkspace={() =>
            setWorkspace(workspace === "Product studio" ? "Client work" : "Product studio")
          }
          composer={
            <ProjectComposer
              firstName="Alex"
              prompt={prompt}
              onPromptChange={setPrompt}
              onContinue={() =>
                setMessage("Review handoff requested; no project or build created.")
              }
              onBrainstorm={() => setMessage("Brainstorm requested; no agent request sent.")}
            />
          }
          projects={
            <>
              <ProjectDashboard
                projects={workspace === "Product studio" ? projects : []}
                total={workspace === "Product studio" ? projects.length : 0}
                heading="Projects"
                collectionScope="workspace"
                state="ready"
                onRetry={() => {}}
                onTrash={() => setMessage("Trash dialog requested; no data removed.")}
                renderSnapshot={(project) => (
                  <span className="p-6 text-sm">{project.name}: synthetic snapshot only.</span>
                )}
                renderPreview={(project) => (
                  <div className="p-6 text-sm">{project.name}: synthetic preview only.</div>
                )}
              />
              <p role="status" className="mt-6 text-xs text-muted-foreground">
                {message} Route: {location}
              </p>
            </>
          }
        />
      </div>
    </Router>
  );
}
createRoot(document.getElementById("root")!).render(<Review />);
