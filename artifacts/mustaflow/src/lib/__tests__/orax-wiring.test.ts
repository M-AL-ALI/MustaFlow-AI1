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
  const mobileOraxScreen = read("../../../../ora-mobile/app/(home)/orax.tsx");
  const mobileApi = read("../../../../ora-mobile/lib/api.ts");
  const mobileTypes = read("../../../../ora-mobile/lib/types.ts");

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

  it("uses ORAX-owned APIs and never Ora chat or AI Builder endpoints", () => {
    for (const route of [
      "/api/orax/capabilities",
      "/api/orax/repositories",
      "/api/orax/tasks",
      "/api/orax/tasks/${taskId}/messages",
      "/api/orax/tasks/${taskId}/approvals",
      "/api/orax/tasks/${taskId}/artifacts",
      "/api/orax/approvals/${approvalId}",
      "/api/orax/approvals/${approvalId}/read-files",
      "/api/orax/approvals/${approvalId}/run-sandbox",
      "/api/orax/approvals/${approvalId}/run-commands",
      "/api/orax/approvals/${approvalId}/create-github-pr",
    ]) {
      expect(oraxPage).toContain(route);
    }

    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/draft-patch");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/sandbox-approvals");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/command-approvals");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/github-pr-approvals");
    expect(oraxPage).toContain("createTask({ startThread: true, firstMessage: content })");
    expect(oraxPage).toContain("appendTaskMessage(targetTaskId, content)");
    expect(oraxPage).toContain("Task created, but first message failed to save");

    expect(oraxPage).not.toContain("/api/public-ai/chat");
    expect(oraxPage).not.toContain("/api/projects/");
    expect(oraxPage).not.toContain("/api/credits");
    expect(oraxPage).not.toContain("useOraChat");
    expect(mobileOraxScreen).not.toContain("sendChat");
    expect(mobileOraxScreen).not.toContain("streamChatNative");
    expect(mobileOraxScreen).not.toContain("useOraChat");
    expect(mobileOraxScreen).not.toContain("/api/public-ai/chat");
  });

  it("keeps ORAX Codex-like and list-first on website and mobile", () => {
    expect(oraxPage).toContain("const [mobileTaskOpen, setMobileTaskOpen] = useState(false)");
    expect(oraxPage).toContain("const [taskSearch, setTaskSearch] = useState(\"\")");
    expect(oraxPage).toContain("function startNewThread()");
    expect(oraxPage).toContain("setSelectedTaskId(null)");
    expect(oraxPage).toContain("visibleTasks");
    expect(oraxPage).toContain("chatPreview");
    expect(oraxPage).toContain("Back to Orax tasks");
    expect(oraxPage).toContain("Orax options");
    expect(oraxPage).toContain("Projects");
    expect(oraxPage).toContain("Chats");
    expect(oraxPage).toContain("Search Chats");
    expect(oraxPage).toContain("New chat");
    expect(oraxPage).toContain("Ask Orax to inspect, fix, or explain code...");
    expect(oraxPage).toContain("mobileTaskOpen ? \"hidden lg:flex\" : \"flex\"");
    expect(oraxPage).toContain("mobileTaskOpen ? \"flex\" : \"hidden\"");
    expect(oraxPage).not.toContain("setMobileComposeOpen((value) => !value)");
    expect(oraxPage).not.toContain("Codex workspace for repository tasks");
    expect(oraxPage).not.toContain("ORAX task thread");
    expect(oraxPage).not.toContain("Start ORAX chat");

    expect(mobileOraxScreen).toContain("const [threadOpen, setThreadOpen] = useState(false)");
    expect(mobileOraxScreen).toContain("const startNewThread = useCallback(() =>");
    expect(mobileOraxScreen).toContain("setSelectedTaskId(null)");
    expect(mobileOraxScreen).toContain("const [taskSearch, setTaskSearch] = useState(\"\")");
    expect(mobileOraxScreen).toContain("visibleTasks");
    expect(mobileOraxScreen).toContain("chatPreview");
    expect(mobileOraxScreen).toContain("ORAX_TAGLINE");
    expect(mobileOraxScreen).toContain("Projects");
    expect(mobileOraxScreen).toContain("Chats");
    expect(mobileOraxScreen).toContain("Search Chats");
    expect(mobileOraxScreen).toContain("Ask Orax what to work on.");
    expect(mobileOraxScreen).toContain("Ask Orax to inspect, fix, or explain code...");
    expect(mobileOraxScreen).not.toContain("setHomeComposeOpen((value) => !value)");
    expect(mobileOraxScreen).not.toContain("{homeComposeOpen ? (");
    expect(mobileOraxScreen).not.toContain("ScreenHeader");
    expect(mobileOraxScreen).not.toContain('label="Start ORAX chat"');
  });

  it("keeps ORAX actions inline in the thread instead of visible workflow panels", () => {
    expect(oraxPage).toContain("Confirm action");
    expect(oraxPage).toContain("pendingSuggestionConfirmation");
    expect(oraxPage).toContain("confirmTaskActionSuggestion");
    expect(oraxPage).toContain("void readApprovedFiles(approval.id)");
    expect(oraxPage).toContain("void runSandboxValidation(approval.id)");
    expect(oraxPage).toContain("void runControlledChecks(approval.id)");
    expect(oraxPage).toContain("void createGithubPr(approval.id)");
    expect(oraxPage).toContain('className="hidden"');
    expect(oraxPage).toContain('aria-hidden="true"');
    expect(oraxPage).not.toContain('showInspector ? "flex"');
    expect(oraxPage).not.toContain("setShowInspector((value) => !value)");
    expect(oraxPage).not.toContain("label=\"Details\"");

    expect(mobileOraxScreen).toContain("void runAction(\"request-read\"");
    expect(mobileOraxScreen).toContain("void runAction(\"draft-patch\"");
    expect(mobileOraxScreen).toContain("void runAction(\"sandbox-approval\"");
    expect(mobileOraxScreen).toContain("void runAction(\"command-approval\"");
    expect(mobileOraxScreen).toContain("void runAction(\"pr-approval\"");
    expect(mobileOraxScreen).toContain("approval.status === \"pending\" || approval.status === \"approved\"");
    expect(mobileOraxScreen).toContain("{false ? (");
    expect(mobileOraxScreen).not.toContain('label="Details"');
  });

  it("clears task-scoped state immediately on ORAX task switches", () => {
    expect(oraxPage).toContain("const activeTaskIdRef = useRef<number | null>(null)");
    expect(oraxPage).toContain("const switchedTasks = activeTaskIdRef.current !== selectedTask.id");
    expect(oraxPage).toContain("activeTaskIdRef.current = selectedTask.id");
    expect(collapse(oraxPage)).toContain(
      'if (switchedTasks) { setApprovals([]); setArtifacts([]); setTaskMessages([]); setReadResult(null); setPendingSuggestionConfirmation(null); setSuggestionPrConfirmationText(""); setPrConfirmationText(""); setTaskMessageDraft(""); }',
    );
    expect(oraxPage).toContain("const targetTaskId = body.task.id;");
    expect(oraxPage).toContain("const targetTaskId = selectedTask.id;");
    expect(oraxPage).toContain("if (activeTaskIdRef.current !== taskId) return");
    expect(oraxPage).toContain("if (activeTaskIdRef.current !== targetTaskId) return");
  });

  it("mounts the authenticated /orax API prefix and mirrors workflow APIs on mobile", () => {
    expect(routesIndex).toContain('"/orax"');
    expect(routesIndex).toContain("router.use(oraxRouter)");
    expect(mobileTypes).toContain(
      'export type OraxTaskKind = "analyze" | "plan" | "review" | "fix"',
    );
    expect(mobileTypes).not.toContain('"coding"');

    for (const route of [
      "/api/orax/capabilities",
      "/api/orax/repositories",
      "/api/orax/repositories/${repositoryId}/github/connect",
      "/api/orax/repositories/${repositoryId}/scan",
      "/api/orax/tasks",
      "/api/orax/tasks/${taskId}/messages",
      "/api/orax/tasks/${taskId}/approvals",
      "/api/orax/tasks/${taskId}/artifacts",
      "/api/orax/tasks/${input.taskId}/draft-patch",
      "/api/orax/tasks/${input.taskId}/sandbox-approvals",
      "/api/orax/tasks/${input.taskId}/command-approvals",
      "/api/orax/tasks/${input.taskId}/github-pr-approvals",
      "/api/orax/approvals/${approvalId}",
      "/api/orax/approvals/${approvalId}/read-files",
      "/api/orax/approvals/${approvalId}/run-sandbox",
      "/api/orax/approvals/${approvalId}/run-commands",
      "/api/orax/approvals/${approvalId}/create-github-pr",
    ]) {
      expect(mobileApi).toContain(route);
    }
  });
});
