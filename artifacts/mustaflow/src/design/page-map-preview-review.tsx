import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PageDetailPanel,
  type PageMapNodeState,
} from "@/pages/projects/components/page-detail-panel";
import "@/index.css";

if (!import.meta.env.DEV) throw new Error("Page Map review is development-only.");
const pages: PageMapNodeState[] = [
  {
    id: "note",
    label: "Note detail",
    pageType: "detail",
    filePath: "src/pages/notes/[id].tsx",
    notes: "Route: /notes/:id",
    position: { x: 0, y: 0 },
    isNew: false,
    hasError: false,
    aiGenerated: true,
  },
  {
    id: "team",
    label: "Team notes",
    pageType: "list",
    filePath: "src/pages/teams/[team]/notes/[id].tsx",
    notes: "Route: /teams/:team/notes/:id",
    position: { x: 0, y: 0 },
    isNew: false,
    hasError: false,
    aiGenerated: true,
  },
  {
    id: "planned",
    label: "Planned page",
    pageType: "other",
    filePath: "",
    notes: "",
    planned: true,
    position: { x: 0, y: 0 },
    isNew: false,
    hasError: false,
    aiGenerated: false,
  },
];

function Review() {
  const [index, setIndex] = useState(0);
  const [projectId, setProjectId] = useState(901);
  const [message, setMessage] = useState("No preview requested.");
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            NabuFlow / local component review
          </p>
          <h1 className="text-2xl font-semibold">Open the page you want to inspect.</h1>
          <p className="text-sm text-muted-foreground">
            Real Page Map details, synthetic pages. Callbacks are recorded below; no app, record,
            map, or preview is created.
          </p>
        </header>
        <div className="flex flex-wrap gap-3">
          <label className="text-xs">
            Page
            <select
              aria-label="Review page"
              value={index}
              onChange={(event) => setIndex(Number(event.target.value))}
              className="ml-2 rounded border border-border bg-background p-2"
            >
              {pages.map((page, i) => (
                <option key={page.id} value={i}>
                  {page.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Project
            <select
              aria-label="Review project"
              value={projectId}
              onChange={(event) => setProjectId(Number(event.target.value))}
              className="ml-2 rounded border border-border bg-background p-2"
            >
              <option value={901}>Review A</option>
              <option value={902}>Review B</option>
            </select>
          </label>
        </div>
        <div
          role="status"
          className="break-all rounded-lg border border-border bg-muted/20 p-3 text-sm"
        >
          {message}
        </div>
        <div className="relative h-[720px] overflow-hidden rounded-xl border border-border bg-muted/10">
          <PageDetailPanel
            node={pages[index]}
            projectId={projectId}
            onOpenPreview={(route) =>
              setMessage(
                "Preview callback for project " +
                  projectId +
                  ": " +
                  route +
                  ". No navigation performed in this review.",
              )
            }
            onClose={() => setMessage("Close callback recorded.")}
            onSave={() => setMessage("Save callback recorded. No data saved.")}
            onFileOpen={(path) => setMessage("File callback: " + path)}
            onModifyPage={() => setMessage("Modify callback recorded. No agent request sent.")}
            onDelete={() => setMessage("Remove callback recorded. No data removed.")}
          />
        </div>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing review root");
createRoot(root).render(<Review />);
