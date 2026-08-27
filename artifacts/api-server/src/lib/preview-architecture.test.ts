import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ListTasksResponseItem } from "@workspace/api-zod";
import { buildProjectFilesChangedPayload } from "./preview-events";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const readSource = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

const jobsSource = readSource("artifacts/api-server/src/lib/jobs.ts");
const versionsSource = readSource("artifacts/api-server/src/routes/versions.ts");
const filesSource = readSource("artifacts/api-server/src/routes/files.ts");
const eventsSource = readSource("artifacts/api-server/src/routes/events.ts");
const previewEnvSource = readSource("artifacts/api-server/src/routes/preview-env.ts");
const tasksSource = readSource("artifacts/api-server/src/routes/tasks.ts");
const livePreviewProxySource = readSource("artifacts/api-server/src/lib/livePreviewProxy.ts");
const flyRuntimeProviderSource = readSource("artifacts/api-server/src/lib/fly-runtime-provider.ts");
const projectFilesPreviewSource = readSource(
  "artifacts/api-server/src/lib/project-files-preview.ts",
);
const containerSource = readSource("artifacts/api-server/src/lib/container.ts");
const previewTabSource = readSource(
  "artifacts/mustaflow/src/pages/projects/components/preview-tab.tsx",
);
const projectPageSource = readSource("artifacts/mustaflow/src/pages/projects/[id].tsx");
const containerRoutesSource = readSource("artifacts/api-server/src/routes/containers.ts");
const builderSource = readSource("artifacts/api-server/src/lib/builder.ts");
const agentLoopSource = readSource("artifacts/api-server/src/lib/agent-loop.ts");

describe("Preview Architecture Fix regression coverage", () => {
  it("builds the project_files_changed payload shape consumed by the frontend", () => {
    const payload = buildProjectFilesChangedPayload(
      1,
      75,
      [{ path: "src/App.tsx", content: "export default null;" }],
      ["src/Old.tsx"],
      "apply",
    );

    expect(payload).toMatchObject({
      projectId: 1,
      revision: 75,
      operationType: "apply",
      changedPaths: ["src/App.tsx"],
      removedPaths: ["src/Old.tsx"],
      files: { "src/App.tsx": "export default null;" },
      requiresInstall: false,
      requiresRestart: false,
    });
    expect(payload.generatedAt).toEqual(expect.any(String));
  });

  it("exposes monotonic preview metadata and blocks staged review reconciliation", () => {
    expect(eventsSource).toContain('"/projects/:id/preview-state"');
    expect(eventsSource).toContain("projectVersionsTable.id");
    expect(eventsSource).toContain("STAGED_PREVIEW_STATUSES");
    expect(eventsSource).toContain("reconciliationAllowed: !stagedTask");
    expect(eventsSource).toContain('res.setHeader("Cache-Control", "no-store")');
  });

  it("marks volatile task and preview observations as non-cacheable", () => {
    expect(tasksSource).toMatch(
      /router\.get\("\/projects\/:id\/tasks"[\s\S]*?Cache-Control", "no-store"/u,
    );
    expect(eventsSource).toMatch(
      /"\/projects\/:id\/tasks\/:taskId\/events"[\s\S]*?Cache-Control", "no-store"/u,
    );
    expect(previewEnvSource).toMatch(
      /router\.get\("\/projects\/:id\/preview-env\/status"[\s\S]*?Cache-Control", "no-store"/u,
    );
  });

  it("manual editor save publishes project_files_changed", () => {
    expect(filesSource).toContain("publishProjectFilesChanged");
    expect(filesSource).toContain('"manual-save"');
  });

  it("main-agent file writes publish through the safe project_files_changed helper", () => {
    expect(jobsSource).toContain("const payload = publishProjectFilesChanged(");
    expect(jobsSource).not.toContain("const filesMap: Record<string, string>");
  });

  it("task-agent staged output is isolated until Apply", () => {
    expect(jobsSource).toContain('agentIdentity !== "task"');
    expect(jobsSource).toContain("works entirely against task.stagingSnapshot");
  });

  it("Apply computes removedPaths before replacing project files", () => {
    expect(jobsSource).toContain("const currentFileRows = await db");
    expect(jobsSource).toContain("const appliedPathSet = new Set(builderFiles.map((f) => f.path))");
    expect(jobsSource).toContain(
      'emitFilesChangedEvent(taskId, projectId, version.id, builderFiles, removedPaths, "apply")',
    );
  });

  it("Rollback sends removedPaths on the project-level channel", () => {
    expect(versionsSource).toContain("const rollbackRemovedPaths = currentFileRows");
    expect(versionsSource).toContain("publishProjectFilesChanged(");
    expect(versionsSource).toContain("rollbackRemovedPaths");
  });

  it("Apply payloads keep removed files out of files and in removedPaths", () => {
    const payload = buildProjectFilesChangedPayload(
      1,
      76,
      [{ path: "src/App.tsx", content: "new" }],
      ["src/Deleted.tsx"],
      "apply",
    );
    expect(payload.files).not.toHaveProperty("src/Deleted.tsx");
    expect(payload.removedPaths).toEqual(["src/Deleted.tsx"]);
  });

  it("Rollback payloads keep removed files out of files and in removedPaths", () => {
    const payload = buildProjectFilesChangedPayload(
      1,
      77,
      [{ path: "src/App.tsx", content: "restored" }],
      ["src/Newer.tsx"],
      "rollback",
    );
    expect(payload.files).not.toHaveProperty("src/Newer.tsx");
    expect(payload.removedPaths).toEqual(["src/Newer.tsx"]);
  });

  it("safe payload builder strips secret, binary, and oversized content", () => {
    const payload = buildProjectFilesChangedPayload(
      1,
      78,
      [
        { path: ".env", content: "SECRET=value" },
        { path: "public/logo.png", content: "png\0bytes" },
        { path: "src/huge.txt", content: "x".repeat(512 * 1024 + 1) },
        { path: "src/App.tsx", content: "ok" },
      ],
      [],
      "refine",
    );

    expect(payload.changedPaths).toEqual([
      ".env",
      "public/logo.png",
      "src/huge.txt",
      "src/App.tsx",
    ]);
    expect(payload.files).toEqual({ "src/App.tsx": "ok" });
  });

  it("rollback kind is accepted by typed task-list parsing", () => {
    expect(() =>
      ListTasksResponseItem.parse({
        id: 1,
        projectId: 1,
        title: "Rollback to checkpoint",
        kind: "rollback",
        status: "completed",
        createdAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  it("agentic previewUpdated only flips true after healthz passes", () => {
    expect(jobsSource).toContain("pollPreviewReachability");
    expect(jobsSource).toContain("if (previewCheck.reachable)");
    expect(jobsSource).toContain("Agentic confirmation: /healthz returned 200");
  });

  it("builder and agent-loop reports do not mark previewUpdated true before runtime confirmation", () => {
    expect(builderSource).not.toMatch(/previewUpdated:\s*true/);
    expect(builderSource).not.toMatch(/previewUpdated:\s*changedFiles/);
    expect(agentLoopSource).not.toMatch(/previewUpdated:\s*result\.changedFiles/);
  });

  it("static previewUpdated is documented as DB-snapshot confirmation", () => {
    expect(jobsSource).toContain(
      "Static confirmation: the atomic project-file transaction has committed the",
    );
    expect(jobsSource).toContain("mutable rows that back the iframe");
  });

  it("draft edits mark test/full preview candidates stale instead of overwriting them", () => {
    expect(jobsSource).toContain("staleDraftCandidate(projectId");
    expect(filesSource).toContain('staleDraftCandidate(projectId, "manual-save")');
  });

  it("task-scoped and project-level events both use the canonical safe payload", () => {
    expect(jobsSource).toContain("data: payload");
    expect(versionsSource).toContain("data: filesChangedPayload");
    expect(jobsSource).not.toContain("filesMap[f.path] = f.content");
    expect(versionsSource).not.toContain("filesMap[f.path] = f.content");
  });

  it("preview proxy distinguishes proxy and app-server failures", () => {
    expect(livePreviewProxySource).toContain("X-MustaFlow-Preview-State");
    expect(livePreviewProxySource).toContain('"proxy-unavailable"');
    expect(livePreviewProxySource).toContain('"server-unreachable"');
    expect(livePreviewProxySource).toContain("tenantRuntimeProvider.isGatewayReachable");
    expect(flyRuntimeProviderSource).toContain("isGatewayReachable(): Promise<boolean>");
    expect(livePreviewProxySource).not.toContain(
      "Deploy to production to test agentic app previews",
    );
  });

  it("falls back to project_files without clearing runtime identity during a read", () => {
    expect(containerSource).toContain("export async function isContainerLayerConfigured");
    expect(livePreviewProxySource).toContain("serveProjectFilesPreview");
    const loadStart = livePreviewProxySource.indexOf("export async function loadPreviewProject");
    const loadEnd = livePreviewProxySource.indexOf(
      "/** Confirm the requester is allowed to preview an unpublished project. */",
      loadStart,
    );
    const loadPreviewProjectSource = livePreviewProxySource.slice(loadStart, loadEnd);
    expect(loadPreviewProjectSource).not.toContain(".update(");
    expect(livePreviewProxySource).not.toContain("Cleared stale preview container");
    expect(projectFilesPreviewSource).toContain("Static preview — live server starting soon");
    expect(projectFilesPreviewSource).toContain("showStaticBanner");
  });

  it("prefers WebContainer for React/Vite unless the server reports preview access", () => {
    expect(previewTabSource).toContain("isReactVite && !serverPreviewLive");
    expect(previewTabSource).toContain("hasServerPreviewAccess(previewAccess)");
    expect(previewTabSource).not.toContain("Boolean(containerUrl)");
    expect(previewTabSource).toContain(
      "const src = webContainerLive ? wc.previewUrl! : previewSrc",
    );
  });

  it("does not render a raw agentic preview response before provider liveness is proven", () => {
    expect(projectPageSource).toContain(
      'if (st === "running" || st === "starting") void refreshContainerStatus()',
    );
    const fallback = previewTabSource.indexOf("if (agenticPreviewUnavailable)");
    const iframe = previewTabSource.indexOf("<iframe", fallback);
    expect(fallback).toBeGreaterThan(-1);
    expect(iframe).toBeGreaterThan(fallback);
    expect(previewTabSource).toContain('data-testid="agentic-preview-unavailable"');
  });

  it("replays the sealed release before a provider-running wake claim", () => {
    const liveCheck = containerRoutesSource.indexOf(
      "const liveStatus = await getContainerStatus(project.containerId)",
    );
    const runningClaim = containerRoutesSource.indexOf('containerStatus: "running"', liveCheck);
    const sealedResume = containerRoutesSource.indexOf("resumeAcceptedProjectPreview({");
    expect(sealedResume).toBeGreaterThan(-1);
    expect(liveCheck).toBeGreaterThan(-1);
    expect(runningClaim).toBeGreaterThan(liveCheck);
    expect(sealedResume).toBeLessThan(liveCheck);
  });

  it("test preview uses bounded background installs instead of direct npm install", () => {
    expect(previewEnvSource).toContain("npmInstallInBackground");
    expect(previewEnvSource).toContain("wallClockCapMs: 6 * 60 * 1000");
    expect(previewEnvSource).not.toContain('["npm", "install", "--prefer-offline", "--no-audit"]');
  });

  it("Task Agent Apply syncs agentic containers and confirms health", () => {
    expect(jobsSource).toContain("syncAgenticPreviewRuntime");
    expect(jobsSource).toContain("Syncing project files to preview container");
    expect(jobsSource).toContain("pollPreviewReachability");
    expect(jobsSource).toContain("publishPreviewReady(opts.projectId, opts.revision)");
  });

  it("Agent Zero build/refine syncs and restarts the live preview runtime", () => {
    expect(jobsSource).toContain("const runtimePreviewResult = await syncAgenticPreviewRuntime");
    expect(jobsSource).toContain(
      "const allRuntimeFileRows = await loadPrimaryArtifactFiles(projectId)",
    );
    expect(jobsSource).toContain("files: allRuntimeFileRows.map");
    expect(jobsSource).toContain("Restarting container app server");
    expect(jobsSource).toContain("report.previewUpdated = runtimePreviewResult.previewUpdated");
    expect(jobsSource).not.toContain("Running npm install in container");
    expect(jobsSource).not.toContain('["npm", "install", "--prefer-offline", "--no-audit"]');
  });

  it("container preview startup uses the project service port and stack-specific health probes", () => {
    expect(jobsSource).toContain("healthPath: healthCheckPathForStack(opts.stack)");
    expect(jobsSource).toContain("npm run dev -- --host 0.0.0.0 --port ${servicePort}");
    expect(jobsSource).toContain("npm run dev -- -H 0.0.0.0 -p ${servicePort}");
    expect(jobsSource).toContain("uvicorn main:app --host 0.0.0.0 --port ${servicePort}");
  });
});
