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
const builderSource = readSource("artifacts/api-server/src/lib/builder.ts");
const agentLoopSource = readSource("artifacts/api-server/src/lib/agent-loop.ts");

describe("Preview Architecture Fix regression coverage", () => {
  it("builds the project_files_changed payload shape consumed by the frontend", () => {
    const payload = buildProjectFilesChangedPayload(
      1,
      [{ path: "src/App.tsx", content: "export default null;" }],
      ["src/Old.tsx"],
      "apply",
    );

    expect(payload).toMatchObject({
      projectId: 1,
      operationType: "apply",
      changedPaths: ["src/App.tsx"],
      removedPaths: ["src/Old.tsx"],
      files: { "src/App.tsx": "export default null;" },
      requiresInstall: false,
      requiresRestart: false,
    });
    expect(payload.generatedAt).toEqual(expect.any(String));
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
      'emitFilesChangedEvent(taskId, projectId, builderFiles, removedPaths, "apply")',
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
    expect(jobsSource).toContain("if (!previewCheck.reachable)");
    expect(jobsSource).toContain("Agentic confirmation: /healthz returned 200");
  });

  it("builder and agent-loop reports do not mark previewUpdated true before runtime confirmation", () => {
    expect(builderSource).not.toMatch(/previewUpdated:\s*true/);
    expect(builderSource).not.toMatch(/previewUpdated:\s*changedFiles/);
    expect(agentLoopSource).not.toMatch(/previewUpdated:\s*result\.changedFiles/);
  });

  it("static previewUpdated is documented as DB-snapshot confirmation", () => {
    expect(jobsSource).toContain(
      "Static confirmation: writeFiles has durably updated the DB snapshot",
    );
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
});
