import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceToolOpen } from "@workspace/nabuflow-workspace-tools";
import { EditorToolStrip } from "@/pages/projects/components/editor-tool-strip";
import { CommandPalette } from "@/pages/projects/components/command-palette";
import "@/index.css";

if (
  !import.meta.env.DEV ||
  !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
) {
  throw new Error("Tool navigation review is local development only.");
}
function ToolReview() {
  const [projectId, setProjectId] = useState(101);
  const [target, setTarget] = useState<WorkspaceToolOpen>({
    kind: "workspace-tab",
    tabId: "preview",
  });
  const [open, setOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [published, setPublished] = useState(false);
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const navigate = (next: WorkspaceToolOpen) => {
    setTarget(next);
    setChatOpen(false);
  };
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <p className="nf-eyebrow">NabuFlow / Component review</p>
          <h1 className="mt-2 text-lg font-semibold">Project tools, within reach.</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            className="nf-quiet-button"
            onClick={() => {
              setProjectId((id) => (id === 101 ? 102 : 101));
              navigate({ kind: "workspace-tab", tabId: "preview" });
            }}
          >
            Switch synthetic project
          </button>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={published}
              onChange={(e) => setPublished(e.target.checked)}
            />
            Published availability
          </label>
        </div>
      </header>
      <p className="border-b border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
        LOCAL REVIEW ONLY. Real tool navigation and search; synthetic project and tool content. No
        accounts, resources, or live apps are changed.
      </p>
      <div className="flex min-h-[calc(100dvh-160px)] flex-col md:flex-row">
        {(!mobile || chatOpen) && (
          <aside className="flex w-full shrink-0 flex-col border-r border-border p-5 md:w-80">
            <p className="text-sm font-semibold">Your conversation</p>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Keep the idea in view while you explore the tools. Opening a tab does not send a
              message or change your app.
            </p>
            <label htmlFor="draft-review" className="mb-2 mt-8 text-xs">
              Unsent review draft
            </label>
            <textarea
              id="draft-review"
              className="min-h-32 rounded-lg border border-border bg-card p-3 text-sm"
              placeholder="Describe your next change..."
            />
          </aside>
        )}
        <section className="flex min-w-0 flex-1 flex-col">
          <EditorToolStrip
            projectId={projectId}
            activeTab={target.tabId}
            subview={target.subview}
            isPublished={published}
            isMobile={mobile}
            chatOpen={chatOpen}
            pageMapSyncing={false}
            onNavigate={navigate}
            onOpenTools={() => setOpen(true)}
            onToggleChat={() => setChatOpen((value) => !value)}
          />
          {(!mobile || !chatOpen) && (
            <div className="p-5 pb-24 md:p-10">
              <p className="nf-eyebrow">Synthetic project {projectId}</p>
              <h2 className="mt-3 text-2xl font-semibold">One project. The tools you need.</h2>
              <p role="status" className="mt-6 rounded-lg border border-border bg-card p-4 text-sm">
                Selected tool: {target.tabId}
                {target.subview ? " / " + target.subview : ""}
              </p>
              <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
                Use Add tool to find Database, Terminal, Images, Publishing, and the other
                registered tools. Secondary tabs stay within this project session. Closing a tab
                closes its view, never its data.
              </p>
            </div>
          )}
        </section>
      </div>
      <CommandPalette
        open={open}
        onClose={() => setOpen(false)}
        onNavigate={navigate}
        isPublished={published}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<ToolReview />);
