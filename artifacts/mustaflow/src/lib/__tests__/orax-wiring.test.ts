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
  const oraxApiRoute = read("../../../../api-server/src/routes/orax.ts");
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
      "/api/orax/tasks/${taskId}/events",
      "/api/orax/tasks/${taskId}/continue",
      "/api/orax/tasks/${taskId}/approvals",
      "/api/orax/tasks/${taskId}/artifacts",
      "/api/orax/approvals/${approvalId}",
      "/api/orax/approvals/${approvalId}/create-github-pr",
    ]) {
      expect(oraxPage).toContain(route);
    }

    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/draft-patch");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/sandbox-approvals");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/command-approvals");
    expect(oraxPage).toContain("/api/orax/tasks/${selectedTask.id}/github-pr-approvals");
    expect(oraxPage).toContain("await createTask({");
    expect(oraxPage).toContain("startThread: true");
    expect(oraxPage).toContain("firstMessage: content");
    expect(oraxPage).toContain("firstMessageMetadata: metadata");
    expect(oraxPage).toContain("appendTaskMessage(targetTaskId, content, metadata)");
    expect(oraxPage).toContain("Task created, but the first message did not attach");
    expect(oraxPage).toContain("normalizeOraxUiError");
    expect(oraxPage).toContain("Start a new Orax chat, then send the message again.");
    expect(oraxPage).toContain("latestAssistantSuggestionMessageId");
    expect(oraxPage).toContain("connectOraxTaskEventStream");
    expect(oraxPage).toContain("continueSelectedTask");
    expect(oraxPage).toContain("isOraxVisibleThreadMessage");
    expect(oraxPage).toContain("formatOraxVisibleThreadContent");
    expect(oraxPage).toContain('"checkpoint_updated"');
    expect(oraxPage).toContain('"execution_session_started"');
    expect(oraxPage).toContain('"execution_step"');
    expect(oraxPage).toContain('artifact.type === "execution_session"');
    expect(oraxPage).toContain('artifact.type === "workspace_change_set"');
    expect(oraxPage).toContain("latestWorkspaceChangeSet");
    expect(oraxPage).toContain("Workspace change set");
    expect(oraxPage).toContain("Workspace change-set details");
    expect(oraxPage).toContain("WorkspaceChangeSetDiffReview");
    expect(oraxPage).toContain("parseOraxUnifiedDiffFiles");
    expect(oraxPage).toContain("Diff preview unavailable for this file.");
    expect(oraxPage).toContain("/api/orax/tasks/${taskId}/events");
    expect(oraxPage).toContain("/api/orax/tasks/${taskId}/continue");
    expect(oraxPage).toContain('headers: { Accept: "text/event-stream" }');
    expect(oraxPage).toContain("new TextDecoder()");
    expect(oraxPage).toContain("mergeOraxTaskMessages");
    expect(oraxApiRoute).toContain('router.post("/orax/approvals/:id/read-files"');
    expect(oraxApiRoute).toContain('router.post("/orax/approvals/:id/run-sandbox"');
    expect(oraxApiRoute).toContain('router.post("/orax/approvals/:id/run-commands"');
    expect(oraxPage).not.toContain("/api/orax/approvals/${approvalId}/read-files");
    expect(oraxPage).not.toContain("/api/orax/approvals/${approvalId}/run-sandbox");
    expect(oraxPage).not.toContain("/api/orax/approvals/${approvalId}/run-commands");

    expect(oraxPage).not.toContain("/api/public-ai/chat");
    expect(oraxPage).not.toContain("/api/projects/");
    expect(oraxPage).not.toContain("/api/credits");
    expect(oraxPage).not.toContain("useOraChat");
    expect(mobileOraxScreen).not.toContain("sendChat");
    expect(mobileOraxScreen).not.toContain("streamChatNative");
    expect(mobileOraxScreen).not.toContain("useOraChat");
    expect(mobileOraxScreen).not.toContain("/api/public-ai/chat");
  });

  it("keeps ORAX MustaFlow-branded, thread-first, and list-first on website and mobile", () => {
    expect(oraxPage).toContain("const [mobileTaskOpen, setMobileTaskOpen] = useState(false)");
    expect(oraxPage).toContain('const [taskSearch, setTaskSearch] = useState("")');
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
    expect(oraxPage).toContain("renderRepositoryConnectionPanel");
    expect(oraxPage).toContain("Connect GitHub repository");
    expect(oraxPage).toContain("Connect a GitHub repository before starting an Orax chat.");
    expect(oraxPage).toContain("connectGithubRepository");
    expect(oraxPage).toContain("Public GitHub repositories can be scanned from the URL");
    expect(oraxPage).not.toContain("Could not load ORAX workspace");
    expect(oraxPage).toContain('placeholder="Ask Orax"');
    expect(oraxPage).toContain("5.5");
    expect(oraxPage).toContain("Extra High");
    expect(oraxPage).toContain("ArrowUp");
    expect(oraxPage).toContain("ShieldAlert");
    expect(oraxPage).toContain("Mic");
    expect(oraxPage).toContain("fileInputRef");
    expect(oraxPage).toContain('type="file"');
    expect(oraxPage).toContain("addComposerFiles");
    expect(oraxPage).toContain("readOraxWebAttachment");
    expect(oraxPage).toContain("readFileAsText");
    expect(oraxPage).toContain("readFileAsDataUrl");
    expect(oraxPage).toContain("contentText");
    expect(oraxPage).toContain("dataUrl");
    expect(oraxPage).toContain("ingestionStatus");
    expect(oraxPage).toContain("SpeechRecognition");
    expect(oraxPage).toContain("buildComposerMetadata");
    expect(oraxPage).toContain("permissionMode: composerPermissionMode");
    expect(oraxPage).toContain("attachments: composerAttachments");
    expect(oraxPage).toContain("metadata ? { content, metadata } : { content }");
    expect(oraxPage).not.toContain(">Send</button>");
    expect(oraxPage).toContain('mobileTaskOpen ? "hidden lg:flex" : "flex"');
    expect(oraxPage).toContain('mobileTaskOpen ? "flex" : "hidden"');
    expect(oraxPage).not.toContain("setMobileComposeOpen((value) => !value)");
    expect(oraxPage).not.toContain("Codex workspace for repository tasks");
    expect(oraxPage).not.toContain("ORAX task thread");
    expect(oraxPage).not.toContain("Start ORAX chat");

    expect(mobileOraxScreen).toContain("const [threadOpen, setThreadOpen] = useState(false)");
    expect(mobileOraxScreen).toContain("const startNewThread = useCallback(() =>");
    expect(mobileOraxScreen).toContain("setSelectedTaskId(null)");
    expect(mobileOraxScreen).toContain("Start a new Orax chat, then send the message again.");
    expect(mobileOraxScreen).toContain("!latestAssistantSuggestion");
    expect(mobileOraxScreen).toContain('const [taskSearch, setTaskSearch] = useState("")');
    expect(mobileOraxScreen).toContain("visibleTasks");
    expect(mobileOraxScreen).toContain("chatPreview");
    expect(mobileOraxScreen).toContain(
      'const ORAX_TAGLINE = "MustaFlow AI coding agent for repositories"',
    );
    expect(mobileOraxScreen).not.toContain("Codex-style");
    expect(mobileOraxScreen).toContain("Projects");
    expect(mobileOraxScreen).toContain("Chats");
    expect(mobileOraxScreen).toContain("Search Chats");
    expect(mobileOraxScreen).toContain("Connect GitHub repository");
    expect(mobileOraxScreen).toContain("Connect a GitHub repository before starting an Orax chat.");
    expect(mobileOraxScreen).toContain("Optional for private repositories");
    expect(mobileOraxScreen).toContain('label={selectedRepo ? "Chat" : "Connect"}');
    expect(mobileOraxScreen).not.toContain("Ask Orax what to work on.");
    expect(mobileOraxScreen).toContain("function OraxComposer");
    expect(mobileOraxScreen).toContain('placeholder="Ask Orax"');
    expect(mobileOraxScreen).toContain("5.5");
    expect(mobileOraxScreen).toContain("Extra High");
    expect(mobileOraxScreen).toContain("ArrowUp");
    expect(mobileOraxScreen).toContain("ShieldAlert");
    expect(mobileOraxScreen).toContain("Mic");
    expect(mobileOraxScreen).toContain("DocumentPicker.getDocumentAsync");
    expect(mobileOraxScreen).toContain('import * as FileSystem from "expo-file-system/legacy"');
    expect(mobileOraxScreen).toContain("readOraxMobileAttachment");
    expect(mobileOraxScreen).toContain("FileSystem.readAsStringAsync");
    expect(mobileOraxScreen).toContain("FileSystem.EncodingType.Base64");
    expect(mobileOraxScreen).toContain("contentText");
    expect(mobileOraxScreen).toContain("dataUrl");
    expect(mobileOraxScreen).toContain("ingestionStatus");
    expect(mobileOraxScreen).toContain("AudioModule.requestRecordingPermissionsAsync");
    expect(mobileOraxScreen).toContain('transcribeAudio(uri, "m4a")');
    expect(mobileOraxScreen).toContain("buildComposerMetadata");
    expect(mobileOraxScreen).toContain("permissionMode: composerPermissionMode");
    expect(mobileOraxScreen).toContain("attachments={composerAttachments}");
    expect(mobileOraxScreen).toContain("onAddAttachment={() => void pickComposerAttachments()}");
    expect(mobileOraxScreen).toContain("refreshTaskTimeline");
    expect(mobileOraxScreen).toContain("setInterval(() =>");
    expect(mobileOraxScreen).toContain("listTaskMessages(taskId)");
    expect(mobileOraxScreen).toContain("mergeOraxTaskMessages");
    expect(mobileOraxScreen).toContain("continueCurrentTask");
    expect(mobileOraxScreen).toContain("isOraxVisibleThreadMessage");
    expect(mobileOraxScreen).toContain("formatOraxVisibleThreadContent");
    expect(mobileOraxScreen).toContain('"checkpoint_updated"');
    expect(mobileOraxScreen).toContain('"execution_session_started"');
    expect(mobileOraxScreen).toContain('"execution_step"');
    expect(mobileOraxScreen).toContain('artifact.type === "execution_session"');
    expect(mobileOraxScreen).toContain("Waiting for your approval");
    expect(mobileOraxScreen).not.toContain("Approval #{approval.id} - {approval.status}");
    expect(mobileApi).toContain("continueTask(taskId: number)");
    expect(mobileApi).toContain("/api/orax/tasks/${taskId}/continue");
    expect(mobileOraxScreen).not.toContain('label="Send"');
    expect(mobileOraxScreen).not.toContain("setHomeComposeOpen((value) => !value)");
    expect(mobileOraxScreen).not.toContain("{homeComposeOpen ? (");
    expect(mobileOraxScreen).not.toContain("ScreenHeader");
    expect(mobileOraxScreen).not.toContain('label="Start ORAX chat"');
  });

  it("keeps ORAX actions inline in the thread instead of visible workflow panels", () => {
    expect(oraxPage).toContain("Confirm action");
    expect(oraxPage).toContain("pendingSuggestionConfirmation");
    expect(oraxPage).toContain("confirmTaskActionSuggestion");
    expect(oraxPage).toContain(
      'if (suggestion.requiresManualConfirmation || suggestion.type === "github_pr")',
    );
    expect(oraxPage).toContain("void continueSelectedTask()");
    expect(oraxPage).toContain("continueTaskById(body.approval.taskId)");
    expect(oraxPage).toContain("void continueTaskById(approval.taskId)");
    expect(oraxPage).toContain("void createGithubPr(approval.id)");
    expect(oraxPage).toContain("pendingApprovals.length === 0");
    expect(oraxPage).toContain("getOraxRunnerActivity");
    expect(oraxPage).toContain("OraxRunnerActivityRow");
    expect(oraxPage).toContain('event !== "runner_continue"');
    expect(oraxPage).not.toContain("void readApprovedFiles(approval.id)");
    expect(oraxPage).not.toContain("void runSandboxValidation(approval.id)");
    expect(oraxPage).not.toContain("void runControlledChecks(approval.id)");
    expect(oraxPage).toContain('className="hidden"');
    expect(oraxPage).toContain('aria-hidden="true"');
    expect(oraxPage).not.toContain('showInspector ? "flex"');
    expect(oraxPage).not.toContain("setShowInspector((value) => !value)");
    expect(oraxPage).not.toContain('label="Details"');

    expect(mobileOraxScreen).toContain('if (suggestion.type !== "github_pr")');
    expect(mobileOraxScreen).toContain("void continueCurrentTask();");
    expect(mobileOraxScreen).toContain("await continueTask(approval.taskId)");
    expect(mobileOraxScreen).toContain("pendingThreadApprovals.length === 0");
    expect(mobileOraxScreen).toContain("getOraxRunnerActivity");
    expect(mobileOraxScreen).toContain("RunnerActivityRow");
    expect(mobileOraxScreen).toContain('event !== "runner_continue"');
    expect(mobileOraxScreen).not.toContain("runApprovedFileRead");
    expect(mobileOraxScreen).not.toContain("runApprovedSandbox");
    expect(mobileOraxScreen).not.toContain("runApprovedCommands");
    expect(mobileOraxScreen).toContain('void runAction("pr-approval"');
    expect(mobileOraxScreen).toContain('runAction("continue-task"');
    expect(mobileOraxScreen).toContain(
      'approval.status === "pending" || approval.status === "approved"',
    );
    expect(mobileOraxScreen).toContain("{false ? (");
    expect(mobileOraxScreen).not.toContain('label="Details"');
  });

  it("keeps normal assistant replies conversational instead of bookkeeping reports", () => {
    expect(oraxApiRoute).toContain('"I\'ll work from here."');
    expect(oraxApiRoute).toContain('"Inspect files"');
    expect(oraxApiRoute).toContain('"Inspect related files"');
    expect(oraxApiRoute).toContain('"Make changes"');
    expect(oraxApiRoute).toContain('"Check changes"');
    expect(oraxApiRoute).toContain("formatOraxLatestResultForChat");
    expect(oraxApiRoute).toContain('"I prepared the change. I can check it next."');
    expect(oraxApiRoute).not.toContain("Latest result is ready:");
    expect(oraxApiRoute).not.toContain("Run the draft patch in an isolated sandbox.");
    expect(oraxPage).toContain("title={suggestion.description}");
    expect(oraxPage).toContain(
      '"inline-flex h-9 items-center rounded-full bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90"',
    );
    expect(oraxPage).not.toContain(
      '"rounded-md border border-border bg-background px-3 py-2 text-left hover:bg-muted"',
    );
    expect(mobileOraxScreen).toContain("backgroundColor: c.foreground");
    expect(mobileOraxScreen).not.toContain('label={suggestion.buttonLabel ?? "Prepare action"}');
    expect(mobileOraxScreen).not.toContain("Approval #{approval.id}");
    expect(oraxPage).toContain("mergeRunnerResultCollections");
    expect(oraxPage).toContain("runnerResult?: OraxTaskRunnerResult");
    expect(oraxPage).toContain("result.approvals ?? []");
    expect(oraxPage).toContain("result.artifacts ?? []");
    expect(mobileTypes).toContain("runnerResults?: Array");
    expect(mobileTypes).toContain("approvals?: OraxTaskApproval[]");
    expect(mobileTypes).toContain("artifacts?: OraxTaskArtifact[]");
    expect(oraxApiRoute).toContain('router.get("/orax/tasks/:id/events"');
    expect(oraxApiRoute).toContain('"Content-Type": "text/event-stream"');
    expect(oraxApiRoute).toContain("loadOraxTaskMessagesAfter");
    expect(oraxApiRoute).toContain('router.post("/orax/tasks/:id/continue"');
    expect(oraxApiRoute).toContain("continueOraxTaskRunnerUntilStop");
    expect(oraxApiRoute).toContain("ORAX_RUNNER_AUTOPILOT_MAX_STEPS");
    expect(oraxApiRoute).toContain("shouldAutoRunOraxTaskFromMessage");
    expect(oraxApiRoute).toContain("runnerResult");
    expect(oraxApiRoute).toContain("runnerResults");
    expect(oraxApiRoute).toContain("runnerAutoStarted");
    expect(oraxApiRoute).toContain("continueOraxTaskRunner");
    expect(oraxApiRoute).toContain('type: "execution_session"');
    expect(oraxApiRoute).toContain("ensureOraxExecutionSession");
    expect(oraxApiRoute).toContain("appendOraxExecutionSessionStep");
    expect(oraxApiRoute).toContain("persistOraxExecutionProgress");
    expect(oraxApiRoute).toContain('type: "workspace_change_set"');
    expect(oraxApiRoute).toContain("createOraxRunnerWorkspaceChangeSet");
    expect(oraxApiRoute).toContain("findOraxWorkspaceChangeSetForSandbox");
    expect(oraxApiRoute).toContain("buildOraxWorkspacePatchContext");
    expect(oraxApiRoute).toContain("workspaceChangeSetArtifactId");
    expect(oraxApiRoute).toContain("rollback");
    expect(oraxApiRoute).toContain("executionSessionId");
    expect(oraxApiRoute).toContain("executionStep");
    expect(oraxApiRoute).toContain("retry_failed_patch");
    expect(oraxApiRoute).toContain("findLatestOraxRetryableFailure");
    expect(oraxApiRoute).toContain("generateOraxRunnerRetryDraftPatch");
    expect(oraxApiRoute).toContain("retryOfArtifactId");
    expect(oraxApiRoute).toContain("failureSummary");
    expect(oraxApiRoute).toContain("runner_continue");
    expect(oraxApiRoute).toContain("runOraxRunnerApprovedFileRead");
    expect(oraxApiRoute).toContain("requestOraxRunnerCommandApproval");
    expect(oraxApiRoute).toContain("composerMetadataSchema");
    expect(oraxApiRoute).toContain('permissionMode: z.enum(["ask", "auto", "read_only"])');
    expect(oraxApiRoute).toContain(
      "attachments: z.array(composerAttachmentSchema).max(6).optional()",
    );
    expect(oraxApiRoute).toContain("contentText: z.string().max(120_000).optional()");
    expect(oraxApiRoute).toContain("dataUrl: z.string().max(1_500_000).optional()");
    expect(oraxApiRoute).toContain('ingestionStatus: z.enum(["ready", "unsupported", "error"])');
    expect(oraxApiRoute).toContain("normalizeOraxComposerAttachments");
    expect(oraxApiRoute).toContain("buildOraxComposerAttachmentContext");
    expect(oraxApiRoute).toContain("buildOraxComposerAttachmentAnalysis");
    expect(oraxApiRoute).toContain("enhanceOraxComposerAttachmentAnalysisWithAi");
    expect(oraxApiRoute).toContain("runOraxAiAttachmentAnalysis");
    expect(oraxApiRoute).toContain("resolveStageProvider");
    expect(oraxApiRoute).toContain("VISION_MODEL");
    expect(oraxApiRoute).toContain('type: "image_url"');
    expect(oraxApiRoute).toContain("aiSummary");
    expect(oraxApiRoute).toContain("aiStatus");
    expect(oraxApiRoute).toContain("buildOraxAttachmentAnalysisContext");
    expect(oraxApiRoute).toContain("extractOraxAttachmentErrorSignals");
    expect(oraxApiRoute).toContain("parseOraxImageDimensions");
    expect(oraxApiRoute).toContain("attachmentAnalysis");
    expect(oraxApiRoute).toContain("suggestedFocus");
    expect(oraxApiRoute).toContain("const attachmentAnalysisContext = attachmentAnalysis");
    expect(oraxApiRoute).toContain("const effectiveUserMessage = [");
    expect(oraxApiRoute).toContain("attachmentContext: userMessageContext");
    expect(oraxApiRoute).toContain("...(parsed.data.metadata ?? {})");
    expect(oraxApiRoute).toContain("composer: composerMetadata ?? null");
    expect(oraxApiRoute).not.toContain("I saved this in the ORAX task thread");
    expect(oraxApiRoute).not.toContain("Current task status:");
    expect(oraxApiRoute).not.toContain("Here is where this task stands.");
    expect(oraxApiRoute).not.toContain("Approvals: 0. Artifacts: 0. Completed artifacts: 0.");
    expect(oraxApiRoute).not.toContain("Phase 4B is planning-only");
    expect(oraxApiRoute).not.toContain("Prepare file-read approval");
    expect(oraxApiRoute).not.toContain("Invalid ORAX task");
    expect(oraxApiRoute).not.toContain("Checkpoint updated:");
    expect(oraxApiRoute).toContain("prompt: z.string().trim().min(1).max(8000)");
    expect(oraxApiRoute).toContain("Updated ORAX checkpoint");
    expect(oraxApiRoute).toContain("Next, I need to");
    expect(oraxApiRoute).toContain("what happened");
  });

  it("clears task-scoped state immediately on ORAX task switches", () => {
    expect(oraxPage).toContain("const activeTaskIdRef = useRef<number | null>(null)");
    expect(oraxPage).toContain("const switchedTasks = activeTaskIdRef.current !== selectedTask.id");
    expect(oraxPage).toContain("activeTaskIdRef.current = selectedTask.id");
    expect(collapse(oraxPage)).toContain(
      'if (switchedTasks) { setApprovals([]); setArtifacts([]); setTaskMessages([]); setPendingSuggestionConfirmation(null); setSuggestionPrConfirmationText(""); setPrConfirmationText(""); setTaskMessageDraft(""); setComposerAttachments([]); setComposerInputMode("text"); setComposerSettingsOpen(false); }',
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
    expect(mobileTypes).toContain("export interface OraxComposerMetadata");
    expect(mobileTypes).toContain("export interface OraxExecutionStep");
    expect(mobileTypes).toContain("executionStep?: OraxExecutionStep");
    expect(mobileTypes).toContain("steps?: OraxExecutionStep[]");
    expect(mobileTypes).toContain("workspaceChangeSetArtifactId?: number");
    expect(mobileTypes).toContain("patchedFiles?: Array");
    expect(mobileTypes).toContain("rollback?:");
    expect(mobileTypes).toContain("retryOfArtifactId?: number");
    expect(mobileTypes).toContain("failureSummary?: string");
    expect(mobileTypes).toContain("permissionMode: OraxComposerPermissionMode");
    expect(mobileTypes).toContain("attachments: OraxComposerAttachment[]");
    expect(mobileTypes).toContain("contentText?: string");
    expect(mobileTypes).toContain("dataUrl?: string");
    expect(mobileTypes).toContain('ingestionStatus?: "ready" | "unsupported" | "error"');
    expect(mobileTypes).not.toContain('"coding"');

    for (const route of [
      "/api/orax/capabilities",
      "/api/orax/repositories",
      "/api/orax/repositories/${repositoryId}/github/connect",
      "/api/orax/repositories/${repositoryId}/scan",
      "/api/orax/tasks",
      "/api/orax/tasks/${taskId}/messages",
      "/api/orax/tasks/${taskId}/continue",
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
    expect(mobileApi).toContain("metadata?: OraxComposerMetadata");
    expect(mobileApi).toContain("metadata ? { content, metadata } : { content }");
    expect(mobileOraxScreen).toContain('artifact.type === "workspace_change_set"');
    expect(mobileOraxScreen).toContain("latestWorkspaceChangeSet");
    expect(mobileOraxScreen).toContain("Workspace change set");
    expect(mobileOraxScreen).toContain("WorkspaceChangeSetDiffReview");
    expect(mobileOraxScreen).toContain("WorkspaceDiffFileRow");
    expect(mobileOraxScreen).toContain("parseOraxUnifiedDiffFiles");
  });
});
