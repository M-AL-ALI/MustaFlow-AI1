import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ");

describe("ORAX product-surface wiring", () => {
  const app = read("../../App.tsx");
  const modeSelect = read("../../pages/mode-select.tsx");
  const oraxPage = read("../../pages/orax.tsx");
  const routesIndex = read("../../../../api-server/src/routes/index.ts");

  it("registers /orax as a protected route outside AI Builder guard", () => {
    expect(app).toContain('path="/orax"');
    expect(collapse(app)).toContain("<Protected> <OraxPage /> </Protected>");
    expect(collapse(app)).not.toContain("<BuilderGuard> <OraxPage />");
  });

  it("exposes ORAX from mode select without saving it as the normal Ora preference", () => {
    expect(modeSelect).toContain('title="ORAX"');
    expect(modeSelect).toContain('setLocation("/orax")');
    expect(modeSelect).not.toContain('preferredMode: "orax"');
  });

  it("uses ORAX-owned API routes rather than Ora or AI Builder endpoints", () => {
    expect(oraxPage).toContain("/api/orax/capabilities");
    expect(oraxPage).toContain("/api/orax/repositories");
    expect(oraxPage).toContain("/api/orax/repositories/${repositoryId}/scans");
    expect(oraxPage).toContain("/api/orax/repositories/${selectedRepository.id}/scan");
    expect(oraxPage).toContain("/api/orax/tasks");
    expect(oraxPage).toContain("/api/orax/tasks/${taskId}/messages");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/messages");
    expect(oraxPage).toContain("/api/orax/tasks/${taskId}/approvals");
    expect(oraxPage).toContain("/api/orax/tasks/${taskId}/artifacts");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/draft-patch");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/sandbox-approvals");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/command-approvals");
    expect(oraxPage).toContain('"pnpm-typecheck"');
    expect(oraxPage).toContain('"pnpm-lint"');
    expect(oraxPage).toContain('"pnpm-test"');
    expect(oraxPage).toContain('"pnpm-build"');
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/github-pr-approvals");
    expect(oraxPage).toContain('confirmationText: "CREATE PR"');
    expect(oraxPage).toContain("Type CREATE PR to enable approval");
    expect(oraxPage).toContain("ArtifactTrace");
    expect(oraxPage).toContain("FailureNotice");
    expect(oraxPage).toContain("GitHub PR creation failed");
    expect(oraxPage).toContain("/api/orax/approvals/${approvalId}");
    expect(oraxPage).toContain("/api/orax/approvals/${approvalId}/read-files");
    expect(oraxPage).toContain("/api/orax/approvals/${approvalId}/run-sandbox");
    expect(oraxPage).toContain("/api/orax/approvals/${approvalId}/run-commands");
    expect(oraxPage).toContain("/api/orax/approvals/${approvalId}/create-github-pr");
    expect(oraxPage).toContain("Task conversation");
    expect(oraxPage).toContain("stored separately from Ora chat and");
    expect(oraxPage).toContain('message.role === "system" || message.role === "tool"');
    expect(oraxPage).toContain("Timeline");
    expect(oraxPage).toContain("Current checkpoint");
    expect(oraxPage).toContain("currentCheckpoint");
    expect(oraxPage).toContain("orax-task-checkpoint");
    expect(oraxPage).toContain("metadata?.checkpoint");
    expect(oraxPage).toContain("not Ora");
    expect(oraxPage).toContain("not AI Builder");
    expect(oraxPage).toContain("Resume");
    expect(oraxPage).toContain("Where are we right now, and what is the next approved step?");
    expect(oraxPage).toContain("actionSuggestions");
    expect(oraxPage).toContain("applyTaskActionSuggestion");
    expect(oraxPage).toContain("pendingSuggestionConfirmation");
    expect(oraxPage).toContain("confirmTaskActionSuggestion");
    expect(oraxPage).toContain("Create approval request");
    expect(oraxPage).toContain('suggestionPrConfirmationText.trim() !== "CREATE PR"');
    expect(oraxPage).toContain("requestGithubPrApproval(");
    expect(oraxPage).toContain("suggestionPrConfirmationText");
    expect(oraxPage).toContain("setApprovalPaths(suggestion.paths.join");
    expect(oraxPage).toContain("setDraftInstructions");
    expect(oraxPage).toContain("setSelectedCommandIds");
    expect(oraxPage).not.toContain("/api/public-ai/chat");
    expect(oraxPage).not.toContain("/api/projects/");
    expect(oraxPage).not.toContain("/api/credits");
    expect(oraxPage).not.toContain("useOraChat");
    expect(oraxPage).not.toContain('setPrConfirmationText("CREATE PR")');
  });

  it("mounts the authenticated /orax API prefix", () => {
    expect(routesIndex).toContain('"/orax"');
    expect(routesIndex).toContain("router.use(oraxRouter)");
  });
});
