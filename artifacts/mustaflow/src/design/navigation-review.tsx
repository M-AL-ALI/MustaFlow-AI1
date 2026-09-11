import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, Router } from "wouter";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { WorkspaceNavigation } from "@/components/layout/slide-out-nav";
import "@/index.css";

if (
  !import.meta.env.DEV ||
  !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
) {
  throw new Error("Navigation review is available on the local development server only.");
}

function NavigationReview() {
  const [location, setLocation] = useState("/projects");
  const [workspace, setWorkspace] = useState("Product studio");
  const [isAdmin, setIsAdmin] = useState(false);
  const useReviewLocation = useCallback(
    (): [string, (to: string) => void] => [location, setLocation],
    [location],
  );
  return (
    <Router hook={useReviewLocation}>
      <WorkspaceShell
        location={location}
        renderNavigation={(layout) => (
          <WorkspaceNavigation
            layout={layout}
            location={location}
            isAdmin={isAdmin}
            renderWorkspace={(onNavigate) => (
              <div className="px-4 pb-4">
                <label className="text-xs text-muted-foreground">
                  Review workspace
                  <select
                    aria-label="Choose review workspace"
                    value={workspace}
                    className="mt-2 w-full rounded-lg border border-border bg-sidebar p-3 text-xs text-foreground"
                    onChange={(event) => {
                      setWorkspace(event.target.value);
                      setLocation("/projects");
                      onNavigate();
                    }}
                  >
                    <option>Product studio</option>
                    <option>Client work</option>
                  </select>
                </label>
              </div>
            )}
            account={
              <div className="border-t border-border p-5 text-xs text-muted-foreground">
                Synthetic review account
              </div>
            }
          />
        )}
      >
        <section className="nf-dashboard">
          <p className="mb-8 rounded-lg border border-border p-3 text-xs text-muted-foreground">
            LOCAL COMPONENT REVIEW. Real navigation components; synthetic workspace and route state.
            No accounts, projects, databases, or production services are changed.
          </p>
          <div className="nf-composer-intro">
            <p className="nf-eyebrow">{workspace}</p>
            <h1>
              {location === "/projects"
                ? "Your next idea starts here."
                : "Project tools, within reach."}
            </h1>
            <p>Keep the workspace clear. Open the tools you need, when you need them.</p>
          </div>
          <div className="mt-8">
            <label className="block text-sm" htmlFor="review-draft">
              Unsent review draft
            </label>
            <textarea
              id="review-draft"
              className="mt-3 min-h-32 w-full rounded-xl border border-border bg-card p-4"
              placeholder="A simple place for the team's ideas..."
            />
          </div>
          <div className="mt-6 flex flex-wrap gap-4 text-sm">
            <Link href="/projects" className="nf-quiet-button">
              Workspace home
            </Link>
            <Link href="/projects/101" className="nf-quiet-button">
              Open synthetic project
            </Link>
          </div>
          <p role="status" className="mt-8 text-sm">
            Review route: {location}
          </p>
          <label className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(event) => setIsAdmin(event.target.checked)}
            />
            Simulate staff navigation (UI only, not an authorization test)
          </label>
        </section>
      </WorkspaceShell>
    </Router>
  );
}

createRoot(document.getElementById("root")!).render(<NavigationReview />);
