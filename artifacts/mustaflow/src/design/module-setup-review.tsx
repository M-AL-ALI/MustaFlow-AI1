import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModuleLibraryView } from "@/pages/projects/components/module-library";
import type { ModuleSecret } from "@/pages/projects/components/module-library-model";
import "@/index.css";
if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))
  throw new Error("Module setup review is local development only.");
function Review() {
  const [projectId, setProjectId] = useState(101);
  const [secrets, setSecrets] = useState<Record<number, ModuleSecret[]>>({});
  const [requests, setRequests] = useState<string[]>([]);
  const [fail, setFail] = useState(false);
  const [reported, setReported] = useState(false);
  const [agent, setAgent] = useState(true);
  const [queryState, setQueryState] = useState<"ready" | "loading" | "error">("ready");
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border px-5 py-5">
        <p className="nf-eyebrow">NabuFlow / Local component review</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Setup should tell the truth.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Synthetic values only. No API, provider, billing, or production calls.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <button
            className="nf-quiet-button"
            onClick={() => setProjectId((id) => (id === 101 ? 102 : 101))}
          >
            Switch project
          </button>
          <span>Project {projectId}</span>
          <label>
            <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />{" "}
            Fail next saves
          </label>
          <label>
            <input
              type="checkbox"
              checked={reported}
              onChange={(e) => setReported(e.target.checked)}
            />{" "}
            Show historical report
          </label>
          <label>
            <input type="checkbox" checked={agent} onChange={(e) => setAgent(e.target.checked)} />{" "}
            Agent available
          </label>
          <label>
            Key query{" "}
            <select
              value={queryState}
              onChange={(e) => setQueryState(e.target.value as typeof queryState)}
            >
              <option value="ready">Ready</option>
              <option value="loading">Loading</option>
              <option value="error">Error</option>
            </select>
          </label>
          <output aria-label="Request count">Requests: {requests.length}</output>
        </div>
      </header>
      <div className="mx-auto max-w-5xl p-4 sm:p-8">
        <ModuleLibraryView
          projectId={projectId}
          secrets={secrets[projectId] ?? []}
          secretState={queryState}
          wiredModuleIds={reported ? ["realtime-db"] : []}
          onSendMessage={
            agent ? (text) => setRequests((previous) => [...previous, text]) : undefined
          }
          onSaveSecret={async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (fail) throw new Error("Synthetic save failure");
            const next = [
              ...(secrets[projectId] ?? []).filter((key) => key.name !== input.name),
              {
                id: Date.now(),
                projectId,
                name: input.name,
                environment: input.environment,
                isPreviewSafe: input.isPreviewSafe,
              },
            ];
            setSecrets((previous) => ({ ...previous, [projectId]: next }));
            return next;
          }}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Review />);
