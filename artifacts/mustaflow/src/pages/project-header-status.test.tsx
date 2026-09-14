import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { getCalmBuilderStatus, getEditorWorkStatus } from "../lib/builder-calm-status";

const source = readFileSync(path.join(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");

// Evaluate the actual project-page call so a helper-only fix cannot miss its caller.
const parsed = ts.createSourceFile(
  "project.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const initializers: ts.Expression[] = [];
function visit(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(parsed) === "calmStatusText" &&
    node.initializer
  ) {
    initializers.push(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
if (initializers.length !== 1)
  throw new Error("Expected the actual project calm-status initializer");
const compiled = ts.transpileModule(
  "(function (context) { const { visibleCalmPhase, calmFileCount, previewSyncPending, editorRunContext } = context; return " +
    initializers[0].getText(parsed) +
    "; })",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
);
const projectCalmStatus = new Script(compiled.outputText).runInNewContext(
  { getCalmBuilderStatus },
  { timeout: 1_000 },
) as (context: Record<string, unknown>) => string;

describe("project header status truth", () => {
  it("distinguishes the last build result from the live runtime state", () => {
    expect(source).toContain("const editorWorkStatus = getEditorWorkStatus({");
    expect(source).toContain("projectStatus: project?.status,");
    expect(source).toContain("receipt: editorRunReceipt,");
    expect(source).toContain("{editorWorkStatus.label}");
    expect(source).toContain("editorWorkStatus.previousBuildFailed");
    expect(source).toContain("const data = await getContainerStatus(projectId);");
    expect(source).toContain("containerStatus={containerStatus}");
    expect(source).toContain("previewAccess={previewAccess}");
    expect(source).not.toContain("containerHealthStatus");
    expect(source).not.toMatch(/>\s*\{project\.status\}\s*<\/span>/);
  });

  it("retains historical failure without overriding the matching current run", () => {
    expect(getEditorWorkStatus({ projectId: 61, projectStatus: "failed" })).toEqual({
      label: "Last build failed",
      tone: "error",
      previousBuildFailed: false,
    });
    expect(
      getEditorWorkStatus({
        projectId: 61,
        projectStatus: "failed",
        task: { projectId: 61, id: 316, status: "building" },
        receipt: { projectId: 61, taskId: 316, phase: "building", activityLabel: "Writing code" },
      }),
    ).toEqual({ label: "Writing code", tone: "active", previousBuildFailed: true });
  });

  it("shows the current failure in the actual chat strip instead of stale preview progress", () => {
    const editorRunContext = {
      projectId: 61,
      task: { projectId: 61, id: 329, status: "building" },
      receipt: { projectId: 61, taskId: 329, terminal: "failed" as const },
    };
    expect(
      projectCalmStatus({
        visibleCalmPhase: "building",
        calmFileCount: 4,
        previewSyncPending: true,
        editorRunContext,
      }),
    ).toBe("Request failed");
    expect(getEditorWorkStatus(editorRunContext).label).toBe("Request failed");
  });

  it("accepts persisted failure without a stream receipt and ignores an older run's terminal", () => {
    expect(
      projectCalmStatus({
        visibleCalmPhase: "idle",
        previewSyncPending: true,
        editorRunContext: { projectId: 61, task: { projectId: 61, id: 329, status: "failed" } },
      }),
    ).toBe("Request failed");
    expect(
      projectCalmStatus({
        visibleCalmPhase: "building",
        previewSyncPending: true,
        editorRunContext: {
          projectId: 61,
          task: { projectId: 61, id: 330, status: "building" },
          receipt: { projectId: 61, taskId: 329, terminal: "failed" },
        },
      }),
    ).toBe("Updating preview\u2026");
  });

  it("does not call a successful run's preview ready before reconciliation completes", () => {
    expect(
      projectCalmStatus({
        visibleCalmPhase: "idle",
        previewSyncPending: true,
        editorRunContext: { projectId: 61, task: { projectId: 61, id: 329, status: "completed" } },
      }),
    ).toBe("Updating preview\u2026");
  });
});
