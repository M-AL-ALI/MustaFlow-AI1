import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getEditorWorkStatus } from "../lib/builder-calm-status";

const source = readFileSync(path.join(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");

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
});
