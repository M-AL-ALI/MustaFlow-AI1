import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SecretEntry } from "@workspace/api-client-react";
import { ProjectSecretsView } from "@/pages/projects/components/project-secrets-panel";
import "@/index.css";
if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))
  throw new Error("Secret setup review is local development only.");
const sample = (id: number, name: string, changes: Partial<SecretEntry> = {}): SecretEntry => ({
  id,
  name,
  projectId: 101,
  masked: "[synthetic masked value]",
  createdAt: "2026-09-11T00:00:00.000Z",
  environment: "development",
  minRole: "viewer",
  isPreviewSafe: true,
  ...changes,
});
const examples = [
  sample(1, "DEV_PUBLIC_KEY"),
  sample(2, "TEST_PREVIEW_KEY", { environment: "testing" }),
  sample(3, "LIVE_ONLY_KEY", { environment: "production" }),
  sample(4, "RESTRICTED_KEY", { minRole: "owner" }),
  sample(5, "PREVIEW_DISABLED_KEY", { isPreviewSafe: false }),
];
function Review() {
  const [projectId, setProjectId] = useState(101);
  const [records, setRecords] = useState<Record<number, SecretEntry[]>>({ 101: examples, 102: [] });
  const [phase, setPhase] = useState<"ready" | "loading" | "error">("ready");
  const [failure, setFailure] = useState<"none" | "save" | "refresh" | "after-save">("none");
  const [saves, setSaves] = useState(0);
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="space-y-3 border-b border-border p-5">
        <p className="nf-eyebrow">NabuFlow / Local component review</p>
        <h1 className="text-xl font-semibold tracking-tight">
          Clear setup. No hidden assumptions.
        </h1>
        <p className="text-sm text-muted-foreground">
          Synthetic metadata only. No API, provider, or production changes.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            className="nf-quiet-button"
            onClick={() => setProjectId((id) => (id === 101 ? 102 : 101))}
          >
            Switch project
          </button>
          <span>Project {projectId}</span>
          <label htmlFor="review-query-state">Key query</label>
          <select
            id="review-query-state"
            value={phase}
            onChange={(event) => setPhase(event.target.value as typeof phase)}
          >
            <option value="ready">Ready</option>
            <option value="loading">Loading</option>
            <option value="error">Error</option>
          </select>
          <label htmlFor="review-failure">Simulate failure</label>
          <select
            id="review-failure"
            value={failure}
            onChange={(event) => setFailure(event.target.value as typeof failure)}
          >
            <option value="none">None</option>
            <option value="save">Save</option>
            <option value="refresh">Refresh</option>
            <option value="after-save">After save</option>
          </select>
          <output aria-label="Save count">Saves: {saves}</output>
        </div>
      </header>
      <div className="mx-auto max-w-5xl p-4 sm:p-8">
        <ProjectSecretsView
          projectId={projectId}
          secrets={phase === "loading" ? undefined : (records[projectId] ?? [])}
          phase={phase}
          renderGuide={(select) => (
            <button className="nf-quiet-button" onClick={() => select("GUIDED_KEY")}>
              Use guided key name
            </button>
          )}
          renderSecret={(secret) => (
            <div className="flex flex-wrap justify-between gap-2 p-3 text-xs">
              <code className="break-all">{secret.name}</code>
              <span className="text-muted-foreground">Value hidden</span>
            </div>
          )}
          onRefresh={async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (failure === "refresh") throw new Error("Synthetic refresh failure");
            setPhase("ready");
          }}
          onSaveSecret={async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (failure === "save") throw new Error("Synthetic save failure");
            setSaves((count) => count + 1);
            setRecords((previous) => ({
              ...previous,
              [projectId]: [
                ...(previous[projectId] ?? []),
                sample(Date.now(), input.name, {
                  projectId,
                  environment: input.environment,
                  isPreviewSafe: input.isPreviewSafe,
                }),
              ],
            }));
            return failure === "after-save" ? "saved-refresh-failed" : "saved";
          }}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Review />);
