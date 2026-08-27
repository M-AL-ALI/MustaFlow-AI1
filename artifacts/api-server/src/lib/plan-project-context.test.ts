import { describe, expect, it } from "vitest";
import { buildPlanProjectContext, planMatchesProjectArchitecture } from "./plan-project-context";

const project52 = {
  projectName: "IRQ TEL",
  projectKind: "web",
  projectFormat: "static-html",
  projectStack: "node-api",
  currentFiles: [
    { path: "nabuflow/runtime/index.ts" },
    { path: "package.json" },
    { path: "src/index.ts" },
    { path: "tsconfig.json" },
  ],
  preserveArchitecture: true,
} as const;

describe("planning project architecture", () => {
  it("describes Project 52 as Node/Express with only its primary-artifact paths", () => {
    const context = buildPlanProjectContext(project52);

    expect(context).toContain('Project format: "static-html"');
    expect(context).toContain('Project stack: "node-api"');
    expect(context).toContain('"src/index.ts"');
    expect(context).toContain("Do not propose React, Vite, JSX, TSX, or a component tree");
    expect(context).not.toContain("src/App.tsx");
  });

  it("rejects the captured Project 52 React proposal under architecture preservation", () => {
    const captured = {
      filesAffected: ["src/App.tsx", "src/components/Footer.tsx"],
      fileTree: [
        { path: "src/App.tsx", description: "React root" },
        { path: "src/components/Footer.tsx", description: "React footer" },
      ],
    };

    expect(planMatchesProjectArchitecture(captured, "node-api", true)).toBe(false);
  });

  it("accepts a Node-compatible Project 52 proposal and leaves explicit migrations unlocked", () => {
    expect(
      planMatchesProjectArchitecture(
        {
          filesAffected: ["src/index.ts"],
          fileTree: [{ path: "src/index.ts", description: "Existing Express server" }],
        },
        "node-api",
        true,
      ),
    ).toBe(true);
    expect(
      planMatchesProjectArchitecture({ filesAffected: ["src/App.tsx"] }, "node-api", false),
    ).toBe(true);
  });

  it("keeps the context bounded and deterministic", () => {
    const files = Array.from({ length: 250 }, (_, index) => ({ path: `src/file-${index}.ts` }));
    const first = buildPlanProjectContext({ ...project52, currentFiles: files });
    const second = buildPlanProjectContext({ ...project52, currentFiles: files });

    expect(second).toBe(first);
    expect(first).toContain("Current primary-artifact paths (200+)");
    expect(first).not.toContain("src/file-249.ts");
  });
});
