import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  projectsTable: {},
  projectFilesTable: {},
  chatMessagesTable: {},
}));
vi.mock("./ai-providers", () => ({
  createChatCompletion: vi.fn(),
}));
import {
  buildBrainstormChatSystemPrompt,
  buildBrainstormResolveSystemPrompt,
  formatBrainstormProjectContext,
  type BrainstormProjectContext,
} from "./brainstorm";

const projectContext: BrainstormProjectContext = {
  projectId: 43,
  projectName: "Daily Inspiration",
  projectKind: "web",
  projectSummary: "A quote card app",
  files: [
    {
      path: "src/App.tsx",
      mimeType: "application/typescript",
      content: "export default function App() { return <main>Quotes</main>; }",
    },
  ],
  currentPlan: { kind: "plan", steps: ["Add favorites"] },
  pageMap: { web: { nodes: [{ id: "home", label: "Home" }], edges: [] } },
};

describe("project-aware Builder brainstorm", () => {
  it("injects the current file snapshot, plan, and page map while preserving no-code behavior", () => {
    const context = formatBrainstormProjectContext(projectContext);
    const prompt = buildBrainstormChatSystemPrompt(projectContext, true);

    expect(context).toContain("src/App.tsx");
    expect(context).toContain("Add favorites");
    expect(context).toContain('"label": "Home"');
    expect(prompt).toContain('Project: "Daily Inspiration" (#43');
    expect(prompt).toContain("THIS existing project");
    expect(prompt).toContain("beginner guided-refinement style");
    expect(prompt).toContain("Never write code");
  });

  it("keeps pre-project ideation behavior and resolves explicit plan/build destinations", () => {
    expect(buildBrainstormChatSystemPrompt(null, false)).toContain(
      "This is a pre-project brainstorm",
    );
    expect(buildBrainstormResolveSystemPrompt(projectContext, "plan")).toContain(
      "Resolve the conversation as a plan request for this existing project",
    );
    expect(buildBrainstormResolveSystemPrompt(projectContext, "build")).toContain(
      "Resolve the conversation as a build request for this existing project",
    );
  });

  it("contains no credit deduction path and replaces the separate Guided Refinement agent", () => {
    const routeSource = readFileSync(new URL("../routes/brainstorm.ts", import.meta.url), "utf8");
    const plansSource = readFileSync(new URL("../routes/plans.ts", import.meta.url), "utf8");
    const builderSource = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");

    expect(routeSource).not.toContain("deductCredits");
    expect(routeSource).not.toContain("creditCostFor");
    expect(plansSource).toContain("runGuidedBrainstormClarification");
    expect(builderSource).not.toContain("runGuidedRefinementPipeline");
    expect(builderSource).not.toContain("GUIDED_REFINEMENT_SYSTEM_PROMPT");
  });
});

describe("brainstorm language and requirement fidelity", () => {
  it("uses the requested language without repetitive questions", () => {
    const prompt = buildBrainstormChatSystemPrompt(null, true);
    expect(prompt).toContain("user's requested language");
    expect(prompt).toContain("including Arabic");
    expect(prompt).toContain("Acknowledge requirements already supplied");
    expect(prompt).not.toContain("Use plain English");
  });
  it("preserves explicit names when resolving a brief", () => {
    const prompt = buildBrainstormResolveSystemPrompt(null, "build");
    expect(prompt).toContain("preserve an explicitly requested project name");
    expect(prompt).toContain("retaining the agreed requirements");
    expect(prompt).not.toContain("no special characters");
  });
});
