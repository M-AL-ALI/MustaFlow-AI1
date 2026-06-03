import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectFilesChangedPayloadFromFrame } from "./event-types";

const here = dirname(fileURLToPath(import.meta.url));
const previewTabSource = readFileSync(
  resolve(here, "../pages/projects/components/preview-tab.tsx"),
  "utf8",
);

describe("project_files_changed frontend payload parsing", () => {
  it("reads file sync payload fields from event.data", () => {
    const payload = projectFilesChangedPayloadFromFrame(
      {
        eventType: "project_files_changed",
        projectId: 42,
        data: {
          projectId: 7,
          operationType: "rollback",
          changedPaths: ["src/App.tsx"],
          removedPaths: ["src/Old.tsx"],
          files: { "src/App.tsx": "export default function App() { return null; }" },
          requiresInstall: true,
          requiresRestart: true,
        },
      },
      99,
    );

    expect(payload).toEqual({
      projectId: 7,
      operationType: "rollback",
      changedPaths: ["src/App.tsx"],
      removedPaths: ["src/Old.tsx"],
      files: { "src/App.tsx": "export default function App() { return null; }" },
      requiresInstall: true,
      requiresRestart: true,
    });
  });

  it("does not fall back to top-level file fields when data is absent", () => {
    const payload = projectFilesChangedPayloadFromFrame(
      {
        eventType: "project_files_changed",
        projectId: 42,
        // Old, incorrect wire shape: these fields must be ignored.
        files: { "src/Ghost.tsx": "stale" },
        changedPaths: ["src/Ghost.tsx"],
      } as never,
      99,
    );

    expect(payload).toMatchObject({
      projectId: 42,
      operationType: "manual-save",
      changedPaths: [],
      removedPaths: [],
      files: {},
      requiresInstall: false,
      requiresRestart: false,
    });
  });

  it("keeps the proxy-unavailable state focused on test preview, not production", () => {
    expect(previewTabSource).toContain(
      "Container preview is unavailable in this development environment",
    );
    expect(previewTabSource).toContain("Start test preview");
    expect(previewTabSource).toContain("Retry preview");
    expect(previewTabSource).toContain("View logs");
    expect(previewTabSource).toContain("Fix server startup");
    expect(previewTabSource).toContain('headers.get("X-MustaFlow-Preview-State")');
    expect(previewTabSource).toContain('"server-unreachable"');
    expect(previewTabSource).toContain("Container server is not responding");
    expect(previewTabSource).not.toContain("deploy to production");
    expect(previewTabSource).not.toContain("Go to Publishing tab to publish");
  });
});
