import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FolderKanban, ImagePlus, BookOpen, Settings } from "lucide-react";
import { ProjectComposer } from "@/components/projects/project-composer";
import { ProjectEntry } from "@/components/projects/project-entry";
import { ProjectDashboard, type DashboardProject } from "@/components/projects/project-dashboard";
import "@/index.css";

if (!import.meta.env.DEV) throw new Error("The redesign preview is development-only.");

const examples: DashboardProject[] = [
  {
    id: 901,
    name: "Cedar appointments",
    description: "A calmer way to manage bookings, customers, and your day.",
    status: "published",
    updatedAt: "2026-09-08T00:00:00Z",
    healthScore: 92,
  },
  {
    id: 902,
    name: "Fieldnotes",
    description: "A shared home for the ideas and decisions behind your team's work.",
    status: "draft",
    updatedAt: "2026-09-07T00:00:00Z",
  },
  {
    id: 903,
    name: "UB Ride / design fixture",
    description:
      "Rider, driver, and operations experiences. This is illustrative data, not the benchmark's production status.",
    status: "failed",
    updatedAt: "2026-09-06T00:00:00Z",
    healthScore: 52,
  },
];
const previewHtml =
  '<!doctype html><html lang="en"><meta charset="utf-8"><style>body{font:18px sans-serif;margin:0;background:#f8f8f5;color:#203633}header{padding:25px 40px;border-bottom:1px solid #dce3df;display:flex;justify-content:space-between}main{padding:50px 60px}small{letter-spacing:3px;color:#698078}h1{font-size:48px;letter-spacing:-2px;margin:20px 0}p{color:#6a7773}.grid{display:flex;gap:20px;margin-top:35px}.card{background:white;border:1px solid #e1e6e2;padding:25px;border-radius:14px;flex:1}b{display:block;font-size:28px;margin:15px 0}.notice{position:fixed;bottom:8px;right:12px;font-size:12px;color:#667}</style><header><strong>Cedar</strong><span>Overview / Appointments / Customers</span></header><main><small>YOUR DAY, AT A GLANCE</small><h1>Make room for good work.</h1><p>Your next appointment is at 10:30. Everything is in place.</p><div class="grid"><div class="card">Today<b>8 appointments</b>A considered pace.</div><div class="card">This week<b>32 bookings</b>Your calendar, connected.</div></div></main><span class="notice">Illustrative UI fixture</span></html>';

function DesignPreview() {
  const [dark, setDark] = useState(false);
  const [entry, setEntry] = useState(
    new URLSearchParams(location.search).get("surface") === "entry",
  );
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<"ready" | "loading" | "error">("ready");
  const [empty, setEmpty] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <div className={dark ? "dark" : ""}>
      <div
        className="nabuflow-shell min-h-screen bg-background text-foreground"
        onClick={(event) => {
          const link = (event.target as Element).closest("a");
          if (link?.getAttribute("href")?.startsWith("/")) {
            event.preventDefault();
            setNotice("Navigation target: " + link.getAttribute("href") + ". Local fixture only.");
          }
        }}
      >
        <div className="nf-rail">
          <strong className="absolute top-7 text-[11px] tracking-tight">NabuFlow</strong>
          {[FolderKanban, ImagePlus, BookOpen, Settings].map((Icon, index) => (
            <span key={index} className="nf-icon-button">
              <Icon size={19} />
            </span>
          ))}
        </div>
        <div className="md:pl-20">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3 text-[11px] text-muted-foreground">
            <strong>LOCAL DESIGN PREVIEW</strong>
            <span>Illustrative data / no production actions</span>
            <button className="nf-secondary-button" onClick={() => setEntry((value) => !value)}>
              {entry ? "Show dashboard" : "Show entry"}
            </button>
            <button
              className="nf-secondary-button ml-auto"
              onClick={() => setDark((value) => !value)}
            >
              {dark ? "Light theme" : "Dark theme"}
            </button>
            <select
              aria-label="Fixture state"
              value={state}
              onChange={(event) => setState(event.target.value as typeof state)}
            >
              <option value="ready">Ready</option>
              <option value="loading">Loading</option>
              <option value="error">Error</option>
            </select>
            <label>
              <input
                type="checkbox"
                checked={empty}
                onChange={(event) => setEmpty(event.target.checked)}
              />{" "}
              Empty account
            </label>
          </div>
          <div className="nf-dashboard">
            {entry ? (
              <ProjectEntry
                prompt={prompt}
                onPromptChange={setPrompt}
                onContinue={(text, platform) =>
                  setNotice(
                    "Review handoff: " +
                      platform +
                      " / " +
                      text +
                      ". Local fixture only; nothing submitted.",
                  )
                }
                onBrainstorm={() =>
                  setNotice("Brainstorm handoff. No agent request is sent by this fixture.")
                }
                onTemplates={() =>
                  setNotice("The landing page opens its template picker. Local fixture only.")
                }
                onGuide={() =>
                  setNotice("The landing page opens its optional guide. Local fixture only.")
                }
              />
            ) : (
              <ProjectComposer
                firstName="Mustafa"
                prompt={prompt}
                onPromptChange={setPrompt}
                onContinue={(text, platform) =>
                  setNotice("Project details would receive: " + platform + " / " + text)
                }
                onBrainstorm={() =>
                  setNotice(
                    "The production dashboard opens the existing brainstorming panel. No agent request is sent by this fixture.",
                  )
                }
              />
            )}
            {notice && (
              <p role="status" className="mb-5 rounded-lg border border-border p-4 text-sm">
                {notice}
              </p>
            )}
            {!entry && (
              <ProjectDashboard
                projects={empty ? [] : examples}
                total={empty ? 0 : examples.length}
                state={state}
                onRetry={() => setState("ready")}
                onTrash={(project) =>
                  setNotice(
                    'The existing Trash confirmation would open for "' +
                      project.name +
                      '". Nothing was deleted.',
                  )
                }
                renderPreview={(project) => (
                  <iframe
                    sandbox=""
                    srcDoc={previewHtml}
                    title={"Project preview: " + project.name}
                  />
                )}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<DesignPreview />);
