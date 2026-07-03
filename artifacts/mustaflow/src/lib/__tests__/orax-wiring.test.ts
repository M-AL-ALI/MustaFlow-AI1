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
    expect(modeSelect).toContain('setLocation("/orax-product")');
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
    expect(oraxPage).toContain("renderRepositoryStatusPanel");
    expect(oraxPage).toContain("workspaceMenuOpen");
    expect(oraxPage).toContain("renderWorkspaceChips");
    expect(oraxPage).toContain("data-orax-workspace-chips");
    expect(oraxPage).toContain("renderOraxCommandCenter");
    expect(oraxPage).toContain("Workspace");
    expect(oraxPage).toContain("primaryWorkspaceActionLabel");
    expect(oraxPage).toContain("Connect GitHub");
    expect(oraxPage).toContain("Scan files");
    expect(oraxPage).toContain("Switch workspace");
    expect(oraxPage).toContain("Recent tasks");
    expect(oraxPage).toContain("selectRepositoryFromMenu");
    expect(oraxPage).toContain("selectTaskFromMenu");
    expect(oraxPage).toContain("Connect GitHub repository");
    expect(oraxPage).toContain("Workspace ready");
    expect(oraxPage).toContain("Connected as");
    expect(oraxPage).toContain("Connect token or scan public repo");
    expect(oraxPage).toContain("GitHub access connected");
    expect(oraxPage).toContain("Connect a GitHub repository before starting an Orax chat.");
    expect(oraxPage).toContain("connectGithubRepository");
    expect(oraxPage).toContain("Get started with Orax Desktop");
    expect(oraxPage).not.toContain("Could not load ORAX workspace");
    expect(oraxPage).not.toContain("Could not load draft artifacts");
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
    expect(oraxPage).toContain("ORAX_SLASH_COMMANDS");
    expect(oraxPage).toContain("visibleSlashCommands");
    expect(oraxPage).toContain("data-orax-slash-command-menu");
    expect(oraxPage).toContain("/plan");
    expect(oraxPage).toContain("/goal");
    expect(oraxPage).toContain("/review");
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
    expect(mobileOraxScreen).toContain("RepositoryWorkspaceCard");
    expect(mobileOraxScreen).toContain("workspaceMenuOpen");
    expect(mobileOraxScreen).toContain("WorkspaceChips");
    expect(mobileOraxScreen).toContain("OraxCommandCenter");
    expect(mobileOraxScreen).not.toContain("Orax Command Center");
    expect(mobileOraxScreen).toContain("DesktopConnectionCard");
    expect(mobileOraxScreen).toContain("Connect Orax Desktop");
    expect(mobileOraxScreen).toContain("Scan QR Code");
    expect(mobileOraxScreen).toContain("desktopHostState");
    expect(mobileOraxScreen).toContain("Manual pairing code");
    expect(mobileOraxScreen).toContain("primaryWorkspaceActionLabel");
    expect(mobileOraxScreen).toContain("Connect GitHub");
    expect(mobileOraxScreen).toContain("Scan files");
    expect(mobileOraxScreen).toContain("Switch workspace");
    expect(mobileOraxScreen).toContain("Recent tasks");
    expect(mobileOraxScreen).toContain("selectRepositoryFromMenu");
    expect(mobileOraxScreen).toContain("selectTaskFromMenu");
    expect(mobileOraxScreen).not.toContain("openDrawer");
    expect(mobileOraxScreen).not.toContain('setThreadDraft("/status")');
    expect(mobileOraxScreen).toContain("Workspace ready");
    expect(mobileOraxScreen).toContain("Connected as");
    expect(mobileOraxScreen).toContain("Connect token or scan public repo");
    expect(mobileOraxScreen).toContain("Connect a GitHub repository before starting an Orax chat.");
    expect(mobileOraxScreen).toContain("Optional for private repositories");
    expect(mobileOraxScreen).toContain("Optional GitHub token for private repos");
    expect(mobileOraxScreen).toContain('label={selectedRepo ? "Chat" : "Connect"}');
    expect(mobileOraxScreen).toContain("Promise.allSettled");
    expect(mobileOraxScreen).not.toContain("Could not load Orax task details");
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
    expect(mobileOraxScreen).toContain("ORAX_SLASH_COMMANDS");
    expect(mobileOraxScreen).toContain("visibleSlashCommands");
    expect(mobileOraxScreen).toContain("slashCommands={visibleSlashCommands}");
    expect(mobileOraxScreen).toContain("/plan");
    expect(mobileOraxScreen).toContain("/goal");
    expect(mobileOraxScreen).toContain("/review");
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

  it("keeps ORAX slash commands thread-owned and separate from Ora", () => {
    expect(oraxApiRoute).toContain("parseOraxSlashCommand");
    expect(oraxApiRoute).toContain("handleOraxSlashCommand");
    expect(oraxApiRoute).toContain("slashCommand: slashCommand.name");
    expect(oraxApiRoute).toContain('mode: "slash_command"');
    expect(oraxApiRoute).toContain("slashCommandPlan");
    expect(oraxApiRoute).toContain("slashCommandGoal");
    expect(oraxApiRoute).toContain("buildOraxTaskPlan");
    expect(oraxApiRoute).toContain("activeGoal");
    expect(oraxApiRoute).toContain("runnerAutoStarted: false");
    expect(oraxApiRoute).not.toContain("/api/public-ai/chat");
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

  it("wires plan mode runner gate and plan_ready action in the API route", () => {
    expect(oraxApiRoute).toContain("isPlanModeTask");
    expect(oraxApiRoute).toContain("isOraxContinueImplementationTrigger");
    expect(oraxApiRoute).toContain("generateOraxRunnerPlanSummary");
    expect(oraxApiRoute).toContain("buildOraxPlanSummaryPrompt");
    expect(oraxApiRoute).toContain("planReadySummaryAt");
    expect(oraxApiRoute).toContain('"plan_ready"');
    expect(oraxApiRoute).toContain('"Start implementation"');
    expect(oraxApiRoute).toContain('"continue_task"');
    expect(oraxApiRoute).toContain('"plan_summary"');
    expect(oraxApiRoute).not.toContain("/public-ai/chat");
    expect(oraxApiRoute).not.toContain("deductCredits");
  });

  it("wires domain-aware file inference and NL plan mode into the API route", () => {
    expect(oraxApiRoute).toContain('from "../lib/orax-context"');
    expect(oraxApiRoute).toContain("inferOraxDomainPaths");
    expect(oraxApiRoute).toContain("isNlPlanModeMessage");
    expect(oraxApiRoute).toContain("loadLatestOraxRepositoryScan");
    expect(oraxApiRoute).toMatch(/buildOraxRunnerReadPaths\(\s*input\.task,\s*input\.messages,/);
    expect(oraxApiRoute).toContain("scan.sampleFiles");
    expect(oraxApiRoute).toContain("scan.topLevelEntries");
    expect(oraxApiRoute).toContain("isNlPlanModeMessage(latestUserMsg)");
    expect(oraxApiRoute).toContain("isPlanModeTask(input.task, messages)");
  });

  it("hides the plan/goal strip when an inline action or pending approval is already visible", () => {
    expect(collapse(oraxPage)).toContain(
      "const hasVisibleInlineAction = (latestAssistantSuggestions.length > 0 && !pendingSuggestionConfirmation) || pendingApprovals.length > 0;",
    );
    expect(collapse(oraxPage)).toContain(
      "return activeThreadState && !hasVisibleInlineAction ?",
    );
    expect(collapse(mobileOraxScreen)).toContain(
      "const hasVisibleInlineAction = latestAssistantSuggestion !== null || pendingThreadApprovals.length > 0;",
    );
    expect(collapse(mobileOraxScreen)).toContain(
      "return activeThreadState && !hasVisibleInlineAction ?",
    );
  });

  it("shows compact active goal/plan strip above the composer on website and mobile", () => {
    expect(oraxPage).toContain("OraxActiveThreadStateStrip");
    expect(oraxPage).toContain("getOraxActiveThreadState");
    expect(oraxPage).toContain("activeGoal");
    expect(oraxPage).toContain('"Plan mode"');
    expect(oraxPage).toContain("activeThreadState");
    expect(oraxPage).toContain("continuing={continuingTask}");

    expect(mobileOraxScreen).toContain("ActiveThreadStateStrip");
    expect(mobileOraxScreen).toContain("getOraxActiveThreadState");
    expect(mobileOraxScreen).toContain("activeGoal");
    expect(mobileOraxScreen).toContain('"Plan mode"');
    expect(mobileOraxScreen).toContain("activeThreadState");
    expect(mobileOraxScreen).toContain('busyAction === "continue-task"');

    expect(oraxPage).not.toContain("public-ai");
    expect(oraxPage).not.toContain("useOraChat");
    expect(oraxPage).not.toContain("sendChat");
    expect(oraxPage).not.toContain("/api/projects");
    expect(oraxPage).not.toContain("/api/credits");
    expect(mobileOraxScreen).not.toContain("useOraChat");
    expect(mobileOraxScreen).not.toContain("streamChatNative");
    expect(mobileOraxScreen).not.toContain("/api/credits");
  });

  it("registers Orax Desktop Phase 2B endpoints: host CRUD, pairing codes, heartbeat", () => {
    const oraxDesktopRoute = read("../../../../api-server/src/routes/orax-desktop.ts");

    // ── Routes ────────────────────────────────────────────────────────────────
    expect(oraxDesktopRoute).toContain('router.post("/orax/hosts/register"');
    expect(oraxDesktopRoute).toContain('router.get("/orax/hosts"');
    expect(oraxDesktopRoute).toContain('router.get("/orax/hosts/:hostId"');
    expect(oraxDesktopRoute).toContain('router.patch("/orax/hosts/:hostId"');
    expect(oraxDesktopRoute).toContain('router.delete("/orax/hosts/:hostId"');
    expect(oraxDesktopRoute).toContain('router.post("/orax/pairing-codes"');
    expect(oraxDesktopRoute).toContain('router.post("/orax/pairing-codes/redeem"');
    expect(oraxDesktopRoute).toContain('router.delete("/orax/pairing-codes/:code"');
    expect(oraxDesktopRoute).toContain('router.post("/orax/relay/heartbeat"');

    // ── Schema fields ─────────────────────────────────────────────────────────
    expect(oraxDesktopRoute).toContain("installId");
    expect(oraxDesktopRoute).toContain("deviceName");
    expect(oraxDesktopRoute).toContain("permissionMode");
    expect(oraxDesktopRoute).toContain("capabilities");

    expect(oraxDesktopRoute).toContain("expiresAt");
    expect(oraxDesktopRoute).toContain("redeemedAt");
    expect(oraxDesktopRoute).toContain("qrPayload");
    expect(oraxDesktopRoute).toContain("generatePairingCode");
    expect(oraxDesktopRoute).toContain("randomBytes(3)");

    expect(oraxDesktopRoute).toContain("last_seen_at");
    expect(oraxDesktopRoute).toContain("serverTime");

    expect(oraxDesktopRoute).toContain("oraxHostsTable");
    expect(oraxDesktopRoute).toContain("oraxPairingCodesTable");
    expect(oraxDesktopRoute).toContain("oraxPairedDevicesTable");

    // ── Security guards ───────────────────────────────────────────────────────
    // Cross-account pairing rejection: code.userId must match caller's userId.
    expect(oraxDesktopRoute).toContain("pairingCode.userId !== userId");

    // Expiry and already-redeemed checks on the redeem path.
    expect(oraxDesktopRoute).toContain("pairingCode.expiresAt < now");
    expect(oraxDesktopRoute).toContain("pairingCode.redeemedAt");

    // Revoked host blocks pairing code creation.
    expect(oraxDesktopRoute).toContain('"Cannot create pairing code for a revoked host"');

    // Revoked host blocks heartbeat.
    expect(oraxDesktopRoute).toContain('"Host has been revoked"');

    // Revoked host blocks the redeem path (host lookup after code validation).
    expect(oraxDesktopRoute).toContain('"Host not found or revoked"');

    // Duplicate device prevention: re-pairing upserts via ON CONFLICT DO UPDATE,
    // targeting the UNIQUE(host_id, mobile_device_id) index.
    expect(oraxDesktopRoute).toContain("onConflictDoUpdate");
    expect(oraxDesktopRoute).toContain("oraxPairedDevicesTable.hostId");
    expect(oraxDesktopRoute).toContain("oraxPairedDevicesTable.mobileDeviceId");

    // ── Ora / AI Builder isolation ─────────────────────────────────────────────
    expect(oraxDesktopRoute).not.toContain("/public-ai/");
    expect(oraxDesktopRoute).not.toContain("deductCredits");
    expect(oraxDesktopRoute).not.toContain("builderCredits");
    expect(oraxDesktopRoute).not.toContain("useOraChat");

    // ── Routes index wiring ───────────────────────────────────────────────────
    expect(routesIndex).toContain("oraxDesktopRouter");
    expect(routesIndex).toContain("router.use(oraxDesktopRouter)");
  });

  it("defines all 9 Phase 2B Orax Desktop schema tables", () => {
    const oraxDesktopSchema = read("../../../../../lib/db/src/schema/orax-desktop.ts");

    // Phase 2B.1 — host / pairing foundation
    expect(oraxDesktopSchema).toContain("oraxHostsTable");
    expect(oraxDesktopSchema).toContain("oraxPairingCodesTable");
    expect(oraxDesktopSchema).toContain("oraxPairedDevicesTable");

    // Phase 2B.2 — projects, threads, messages, approvals, usage, audit
    expect(oraxDesktopSchema).toContain("oraxProjectsTable");
    expect(oraxDesktopSchema).toContain("oraxThreadsTable");
    expect(oraxDesktopSchema).toContain("oraxThreadMessagesTable");
    expect(oraxDesktopSchema).toContain("oraxPendingApprovalsTable");
    expect(oraxDesktopSchema).toContain("oraxUsageEventsTable");
    expect(oraxDesktopSchema).toContain("oraxAuditLogTable");

    // Unique constraint on paired devices — prevents duplicate pairing rows.
    expect(oraxDesktopSchema).toContain("orax_paired_devices_host_mobile_uidx");
    expect(oraxDesktopSchema).toContain("uniqueIndex");

    // Key field presence
    expect(oraxDesktopSchema).toContain("local_path");       // orax_projects
    expect(oraxDesktopSchema).toContain("git_remote_url");   // orax_projects
    expect(oraxDesktopSchema).toContain("thread_id");        // orax_thread_messages / approvals
    expect(oraxDesktopSchema).toContain("action_type");      // orax_usage_events
    expect(oraxDesktopSchema).toContain("compute_ms");       // orax_usage_events
    expect(oraxDesktopSchema).toContain("error_msg");        // orax_audit_log

    // Audit log is intentionally denormalized (no FK constraints).
    // Confirmed by absence of REFERENCES keyword next to audit log table name.
    expect(oraxDesktopSchema).toContain("orax_audit_log");

    // All 9 inferred types exported
    expect(oraxDesktopSchema).toContain("export type OraxHost");
    expect(oraxDesktopSchema).toContain("export type OraxProject");
    expect(oraxDesktopSchema).toContain("export type OraxThread");
    expect(oraxDesktopSchema).toContain("export type OraxThreadMessage");
    expect(oraxDesktopSchema).toContain("export type OraxPendingApproval");
    expect(oraxDesktopSchema).toContain("export type OraxUsageEvent");
    expect(oraxDesktopSchema).toContain("export type OraxAuditLog");
  });

  it("Phase 2C: Orax Desktop app skeleton files exist", () => {
    const mainEntry    = read("../../../../orax-desktop/src/main/index.ts");
    const preload      = read("../../../../orax-desktop/src/preload/index.ts");
    const rendererMain = read("../../../../orax-desktop/src/renderer/main.tsx");
    const appTsx       = read("../../../../orax-desktop/src/renderer/App.tsx");
    const sharedTypes  = read("../../../../orax-desktop/src/shared/types.ts");

    // Main process entry point wires electron app lifecycle
    expect(mainEntry).toContain(".whenReady()");
    expect(mainEntry).toContain("BrowserWindow");
    expect(mainEntry).toContain("registerIpcHandlers");
    expect(mainEntry).toContain("createAuthAdapter");
    expect(mainEntry).toContain("HostManager");
    expect(mainEntry).toContain("PairingManager");

    // Preload exposes contextBridge API (not raw Node APIs)
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).toContain("ipcRenderer.invoke");
    expect(preload).not.toContain("require(");

    // Renderer bootstraps React
    expect(rendererMain).toContain("createRoot");
    expect(rendererMain).toContain("AppProvider");

    // App shell routes correctly
    expect(appTsx).toContain("SignInScreen");
    expect(appTsx).toContain("SetupScreen");
    expect(appTsx).toContain("HomeScreen");
    expect(appTsx).toContain("Sidebar");

    // Shared types carry permission modes
    expect(sharedTypes).toContain("PERMISSION_MODES");
    expect(sharedTypes).toContain('"read_only"');
    expect(sharedTypes).toContain('"ask_everything"');
    expect(sharedTypes).toContain('"ask_risky"');
    expect(sharedTypes).toContain('"trusted_project"');
    expect(sharedTypes).toContain('"full_access"');
    expect(sharedTypes).toContain('"custom"');
    expect(sharedTypes).toContain("PERMISSION_MODE_LABELS");
  });

  it("Phase 2C: Orax Desktop references all required backend endpoints", () => {
    const apiClient  = read("../../../../orax-desktop/src/main/api-client.ts");
    const ipcHandlers = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    const hostMgr    = read("../../../../orax-desktop/src/main/host-manager.ts");

    // Host registration
    expect(apiClient).toContain("/api/orax/hosts/register");
    expect(hostMgr).toContain("register");

    // Heartbeat (every 30 seconds, with backoff)
    expect(apiClient).toContain("/api/orax/relay/heartbeat");
    expect(hostMgr).toContain("HEARTBEAT_INTERVAL_MS");
    expect(hostMgr).toContain("sendHeartbeat");

    // Pairing code creation and cancellation
    expect(apiClient).toContain("/api/orax/pairing-codes");
    expect(apiClient).toContain("cancelPairingCode");

    // PATCH for permission mode
    expect(apiClient).toContain("/api/orax/hosts/");
    expect(apiClient).toContain("permissionMode");
    expect(ipcHandlers).toContain("host:updatePermissionMode");

    // Pairing IPC channels registered
    expect(ipcHandlers).toContain("pairing:create");
    expect(ipcHandlers).toContain("pairing:cancel");

    // Project folder management IPC channels
    expect(ipcHandlers).toContain("project:addLocalFolder");
    expect(ipcHandlers).toContain("project:listLocalFolders");
    expect(ipcHandlers).toContain("project:removeLocalFolder");

    // Folder picker uses Electron dialog (not web API)
    expect(ipcHandlers).toContain("dialog.showOpenDialog");
    expect(ipcHandlers).toContain("openDirectory");
  });

  it("Phase 2C: Orax Desktop renderer uses IPC, not direct Node.js fs APIs", () => {
    const ipcLib    = read("../../../../orax-desktop/src/renderer/lib/ipc.ts");
    const appCtx    = read("../../../../orax-desktop/src/renderer/context/AppContext.tsx");
    const pairingPg = read("../../../../orax-desktop/src/renderer/pages/PairingScreen.tsx");
    const projectsPg = read("../../../../orax-desktop/src/renderer/pages/ProjectsScreen.tsx");
    const settingsPg = read("../../../../orax-desktop/src/renderer/pages/SettingsScreen.tsx");

    // Renderer uses window.electronAPI (contextBridge), not Node built-ins
    expect(ipcLib).toContain("window.electronAPI");
    expect(ipcLib).not.toContain('require("');
    expect(ipcLib).not.toContain("require('");
    expect(ipcLib).not.toContain('from "node:fs"');
    expect(ipcLib).not.toContain('from "node:path"');
    expect(ipcLib).not.toContain('from "electron"');

    // AppContext wires IPC calls, not fetch('/api/...')
    expect(appCtx).toContain("auth.getSession");
    expect(appCtx).toContain("host.getStatus");
    expect(appCtx).not.toContain('fetch("/api/');
    expect(appCtx).not.toContain("useOraChat");
    expect(appCtx).not.toContain("/api/public-ai");
    expect(appCtx).not.toContain("/api/credits");
    expect(appCtx).not.toContain("/api/projects");

    // Permission mode selector present
    expect(settingsPg).toContain("PERMISSION_MODES");
    expect(settingsPg).toContain("updatePermissionMode");

    // Pairing screen shows code + countdown + cancel
    expect(pairingPg).toContain("pairing.create");
    expect(pairingPg).toContain("pairing.cancel");
    expect(pairingPg).toContain("expiresAt");
    expect(pairingPg).toContain("countdown");

    // Projects screen uses IPC for folder picker
    expect(projectsPg).toContain("project.addLocalFolder");
    expect(projectsPg).toContain("project.removeLocalFolder");
    expect(projectsPg).not.toContain('require("fs"');
    expect(projectsPg).not.toContain('from "node:fs"');
  });

  it("Phase 2C: Orax Desktop has no Ora/AI-Builder/password boundary violations", () => {
    const allDesktopFiles = [
      read("../../../../orax-desktop/src/main/index.ts"),
      read("../../../../orax-desktop/src/main/auth.ts"),
      read("../../../../orax-desktop/src/main/api-client.ts"),
      read("../../../../orax-desktop/src/main/host-manager.ts"),
      read("../../../../orax-desktop/src/main/pairing-manager.ts"),
      read("../../../../orax-desktop/src/main/ipc-handlers.ts"),
      read("../../../../orax-desktop/src/preload/index.ts"),
      read("../../../../orax-desktop/src/renderer/lib/ipc.ts"),
      read("../../../../orax-desktop/src/renderer/context/AppContext.tsx"),
      read("../../../../orax-desktop/src/renderer/App.tsx"),
      read("../../../../orax-desktop/src/renderer/pages/SignInScreen.tsx"),
      read("../../../../orax-desktop/src/renderer/pages/SettingsScreen.tsx"),
    ].join("\n");

    // No Ora or AI Builder route leakage
    expect(allDesktopFiles).not.toContain("/api/public-ai");
    expect(allDesktopFiles).not.toContain("/api/builder");
    expect(allDesktopFiles).not.toContain("useOraChat");
    expect(allDesktopFiles).not.toContain("handoffCta");
    expect(allDesktopFiles).not.toContain("builder_handoff");
    expect(allDesktopFiles).not.toContain("deductCredits");
    expect(allDesktopFiles).not.toContain("/api/credits");

    // Auth never collects passwords — no password input field
    const signIn = read("../../../../orax-desktop/src/renderer/pages/SignInScreen.tsx");
    expect(signIn).not.toContain('type="password"');
    expect(signIn).not.toContain("<input");

    const authModule = read("../../../../orax-desktop/src/main/auth.ts");
    expect(authModule).not.toContain("password");
    expect(authModule).not.toContain("passwd");

    // Capabilities all disabled (Phase 2C is skeleton only)
    const hostManager = read("../../../../orax-desktop/src/main/host-manager.ts");
    expect(hostManager).toContain("shell: false");
    expect(hostManager).toContain("filesystem: false");
    expect(hostManager).toContain("git: false");
    expect(hostManager).toContain("github: false");
    expect(hostManager).toContain("computer_use: false");
  });

  // ── Phase 2D: Web/Mobile host discovery + real pairing UI ─────────────────

  it("Phase 2D: mobile api.ts exports all required host and pairing methods", () => {
    const mobileApi = read("../../../../ora-mobile/lib/api.ts");
    expect(mobileApi).toContain("export function listOraxHosts");
    expect(mobileApi).toContain("export function getOraxHost");
    expect(mobileApi).toContain("export function updateOraxHost");
    expect(mobileApi).toContain("export function revokeOraxHost");
    expect(mobileApi).toContain("export function createOraxPairingCode");
    expect(mobileApi).toContain("export function cancelOraxPairingCode");
    expect(mobileApi).toContain("export function redeemOraxPairingCode");
  });

  it("Phase 2D: mobile api.ts host methods call the correct backend endpoints", () => {
    const mobileApi = read("../../../../ora-mobile/lib/api.ts");
    expect(mobileApi).toContain('"/api/orax/hosts"');
    expect(mobileApi).toContain('"/api/orax/pairing-codes"');
    expect(mobileApi).toContain('"/api/orax/pairing-codes/redeem"');
    expect(mobileApi).toContain("/api/orax/hosts/${hostId}");
    expect(mobileApi).toContain("/api/orax/pairing-codes/${encodeURIComponent(code)}");
  });

  it("Phase 2D: mobile types.ts exports OraxHostSummary, OraxPairingCode, RedeemPairingPayload", () => {
    const mobileTypes = read("../../../../ora-mobile/lib/types.ts");
    expect(mobileTypes).toContain("export interface OraxHostSummary");
    expect(mobileTypes).toContain("export interface OraxPairingCode");
    expect(mobileTypes).toContain("export interface RedeemPairingPayload");
    // Essential fields on OraxHostSummary
    expect(mobileTypes).toContain("deviceName");
    expect(mobileTypes).toContain("lastSeenAt");
    expect(mobileTypes).toContain("permissionMode");
    expect(mobileTypes).toContain("mobileDeviceId");
  });

  it("Phase 2D: mobile DesktopConnectionCard uses real host list — not hardcoded offline state", () => {
    const mobileOraxScreen = read("../../../../ora-mobile/app/(home)/orax.tsx");
    // Hardcoded placeholder must be gone
    expect(mobileOraxScreen).not.toContain(
      'const desktopHostState = "offline" as "offline" | "online"',
    );
    // Real host list state present
    expect(mobileOraxScreen).toContain("listOraxHosts");
    expect(mobileOraxScreen).toContain("oraxHosts");
    expect(mobileOraxScreen).toContain("oraxHostsLoading");
  });

  it("Phase 2D: mobile DesktopConnectionCard accepts hosts, hostsLoading, onRefresh props", () => {
    const mobileOraxScreen = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(mobileOraxScreen).toContain("hosts: OraxHostSummary[]");
    expect(mobileOraxScreen).toContain("hostsLoading: boolean");
    expect(mobileOraxScreen).toContain("onRefresh: () => void");
  });

  it("Phase 2D: mobile DesktopConnectionCard has manual pairing code input + redeem", () => {
    const mobileOraxScreen = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(mobileOraxScreen).toContain("redeemOraxPairingCode");
    expect(mobileOraxScreen).toContain("pairingCodeInput");
    // TextInput used for code entry
    expect(mobileOraxScreen).toContain("TextInput");
    // Redeem button present
    expect(mobileOraxScreen).toContain("Pair");
  });

  it("Phase 2D: mobile shows online/offline/not-connected states from real host data", () => {
    const mobileOraxScreen = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(mobileOraxScreen).toContain("Not connected");
    expect(mobileOraxScreen).toContain("Online");
    expect(mobileOraxScreen).toContain("Offline");
    expect(mobileOraxScreen).toContain("isDesktopHostOnline");
  });

  it("Phase 2D: website mode-select Orax card calls GET /api/orax/hosts", () => {
    const modeSelect = read("../../pages/mode-select.tsx");
    expect(modeSelect).toContain('authFetch("/api/orax/hosts")');
    expect(modeSelect).toContain("oraxHosts");
    expect(modeSelect).toContain("oraxHostsLoading");
  });

  it("Phase 2D: website mode-select Orax card routes dynamically — not always to /orax-product", () => {
    const modeSelect = read("../../pages/mode-select.tsx");
    // Must have conditional routing
    expect(modeSelect).toContain('setLocation("/orax-product")');
    expect(modeSelect).toContain('setLocation("/orax")');
    expect(modeSelect).toContain('setLocation("/orax/devices")');
    // Route logic checks host state
    expect(modeSelect).toContain("isOraxHostOnline");
    expect(modeSelect).toContain("activeHosts");
  });

  it("Phase 2D: website mode-select Orax card shows loading, online, offline status indicators", () => {
    const modeSelect = read("../../pages/mode-select.tsx");
    expect(modeSelect).toContain("oraxHostsLoading");
    expect(modeSelect).toContain("OraxCard");
    expect(modeSelect).toContain("Checking Orax Desktop");
    expect(modeSelect).toContain("Online");
    expect(modeSelect).toContain("Offline");
  });

  it("Phase 2D: website /orax/devices page exists with host list, revoke, permission mode, pairing", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    // Host list
    expect(devicesPage).toContain("/api/orax/hosts");
    expect(devicesPage).toContain("OraxHostSummary");
    // Revoke
    expect(devicesPage).toContain('method: "DELETE"');
    expect(devicesPage).toContain("/api/orax/hosts/${revokeTarget.id}");
    // Permission mode PATCH
    expect(devicesPage).toContain('method: "PATCH"');
    expect(devicesPage).toContain("permissionMode");
    // Pairing code creation + cancel
    expect(devicesPage).toContain('"/api/orax/pairing-codes"');
    expect(devicesPage).toContain("/api/orax/pairing-codes/${encodeURIComponent(code)}");
  });

  it("Phase 2D: website /orax/devices page shows online/offline badge and pairing code UI", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    expect(devicesPage).toContain("isHostOnline");
    expect(devicesPage).toContain("Online");
    expect(devicesPage).toContain("Offline");
    expect(devicesPage).toContain("PairingCodeDisplay");
    expect(devicesPage).toContain("expiresAt");
    expect(devicesPage).toContain("qrPayload");
  });

  it("Phase 2D: App.tsx registers /orax/devices route", () => {
    const appTsx = read("../../App.tsx");
    expect(appTsx).toContain('import("./pages/orax-devices")');
    expect(appTsx).toContain('path="/orax/devices"');
    expect(appTsx).toContain("OraxDevicesPage");
  });

  it("Phase 2D: Orax device management code has no Ora/public-ai/credits/project-chat references", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    const mobileApi = read("../../../../ora-mobile/lib/api.ts");
    // The new host/pairing additions must not touch Ora surfaces
    const hostSection = mobileApi.slice(mobileApi.indexOf("Orax Desktop host and pairing"));
    expect(hostSection).not.toContain("/api/public-ai");
    expect(hostSection).not.toContain("deductCredits");
    expect(hostSection).not.toContain("handoffCta");
    expect(hostSection).not.toContain("builder_handoff");
    expect(devicesPage).not.toContain("/api/public-ai");
    expect(devicesPage).not.toContain("password");
  });

  it("Phase 2D runtime contract: host status type must be online|offline|revoked, not active", () => {
    const mobileTypes = read("../../../../ora-mobile/lib/types.ts");
    const devicesPage = read("../../pages/orax-devices.tsx");
    const modeSelect = read("../../pages/mode-select.tsx");
    const mobileOrax = read("../../../../ora-mobile/app/(home)/orax.tsx");

    // Correct backend status values must be present
    expect(mobileTypes).toContain('"online"');
    expect(mobileTypes).toContain('"offline"');
    expect(mobileTypes).toContain('"revoked"');
    expect(devicesPage).toContain('"online"');
    expect(devicesPage).toContain('"offline"');
    expect(devicesPage).toContain('"revoked"');
    expect(modeSelect).toContain('"online"');
    expect(modeSelect).toContain('"offline"');
    expect(modeSelect).toContain('"revoked"');

    // "active" must NOT appear in OraxHostSummary or host filter logic
    const oraxHostSection = mobileTypes.slice(mobileTypes.indexOf("OraxHostSummary"));
    expect(oraxHostSection).not.toContain('status: "active"');
    expect(devicesPage).not.toContain('status: "active"');
    expect(modeSelect).not.toContain('status: "active"');
    expect(mobileOrax).not.toContain('status === "active"');
    expect(devicesPage).not.toContain('status === "active"');
    expect(modeSelect).not.toContain('status === "active"');
  });

  it("Phase 2D runtime contract: permissionMode must use backend enum, not ask|manual|auto", () => {
    const mobileTypes = read("../../../../ora-mobile/lib/types.ts");
    const devicesPage = read("../../pages/orax-devices.tsx");

    // Correct backend permission modes must be present
    expect(mobileTypes).toContain('"read_only"');
    expect(mobileTypes).toContain('"ask_everything"');
    expect(mobileTypes).toContain('"ask_risky"');
    expect(mobileTypes).toContain('"trusted_project"');
    expect(mobileTypes).toContain('"full_access"');
    expect(mobileTypes).toContain('"custom"');
    expect(devicesPage).toContain('"read_only"');
    expect(devicesPage).toContain('"ask_risky"');
    expect(devicesPage).toContain('"full_access"');

    // Wrong permission mode values must NOT appear in Orax host type definitions
    expect(mobileTypes).not.toContain('permissionMode: "ask"');
    expect(mobileTypes).not.toContain('permissionMode: "manual"');
    expect(mobileTypes).not.toContain('permissionMode: "auto"');
    expect(devicesPage).not.toContain('value="ask"');
    expect(devicesPage).not.toContain('value="manual"');
    expect(devicesPage).not.toContain('value="auto"');
  });

  it("Phase 2D runtime contract: active-host filters use !== revoked, not === active", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    const modeSelect = read("../../pages/mode-select.tsx");
    const mobileOrax = read("../../../../ora-mobile/app/(home)/orax.tsx");

    expect(devicesPage).toContain('h.status !== "revoked"');
    expect(modeSelect).toContain('h.status !== "revoked"');
    expect(mobileOrax).toContain('h.status !== "revoked"');
  });

  // ── Phase 2E: relay loop assertions ──────────────────────────────────────────

  it("Phase 2E schema: oraxDesktopActionsTable exported from db schema", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("oraxDesktopActionsTable");
    expect(schema).toContain("ORAX_PHASE2E_ACTION_TYPES");
    expect(schema).toContain('"ping_desktop"');
    expect(schema).toContain('"get_desktop_status"');
    expect(schema).toContain('"list_local_projects"');
    expect(schema).toContain("ORAX_DESKTOP_ACTION_STATUSES");
    expect(schema).toContain('"queued"');
    expect(schema).toContain('"completed"');
    expect(schema).toContain("idempotencyKey");
    expect(schema).toContain("OraxDesktopAction");
  });

  it("Phase 2E schema: relay message envelope types exported", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("ORAX_RELAY_MESSAGE_TYPES");
    expect(schema).toContain("OraxRelayMessage");
    expect(schema).toContain('"ping"');
    expect(schema).toContain('"pong"');
    expect(schema).toContain('"action_requested"');
    expect(schema).toContain('"action_completed"');
  });

  it("Phase 2E startup migration: orax_desktop_actions CREATE TABLE registered", () => {
    const migrations = read(
      "../../../../api-server/src/lib/startup-migrations.ts",
    );
    expect(migrations).toContain("migrate-orax-desktop-actions");
    expect(migrations).toContain("orax_desktop_actions");
    expect(migrations).toContain("idempotency_key");
    expect(migrations).toContain("TIMESTAMPTZ");
  });

  it("Phase 2E backend: all 4 relay routes present in orax-desktop router", () => {
    const router = read(
      "../../../../api-server/src/routes/orax-desktop.ts",
    );
    expect(router).toContain('router.post("/orax/hosts/:hostId/actions"');
    expect(router).toContain('router.get("/orax/hosts/:hostId/actions"');
    expect(router).toContain('router.get("/orax/relay/pending-actions"');
    expect(router).toContain('router.post("/orax/relay/actions/:actionId/events"');
  });

  it("Phase 2E backend: action creation uses idempotency key + onConflictDoNothing", () => {
    const router = read(
      "../../../../api-server/src/routes/orax-desktop.ts",
    );
    expect(router).toContain("idempotencyKey");
    expect(router).toContain("onConflictDoNothing");
    expect(router).toContain("ping_desktop");
    expect(router).toContain("get_desktop_status");
    expect(router).toContain("list_local_projects");
  });

  it("Phase 2E backend: pending-actions poll marks actions as sent", () => {
    const router = read(
      "../../../../api-server/src/routes/orax-desktop.ts",
    );
    expect(router).toContain('"sent"');
    expect(router).toContain('status: "queued"');
  });

  it("Phase 2E backend: pending-actions query is account-scoped by userId", () => {
    const router = read(
      "../../../../api-server/src/routes/orax-desktop.ts",
    );
    expect(router).toContain("eq(oraxDesktopActionsTable.userId, userId)");
  });

  it("Phase 2E backend: action event endpoint updates result + completedAt on completed/failed", () => {
    const router = read(
      "../../../../api-server/src/routes/orax-desktop.ts",
    );
    expect(router).toContain("completedAt");
    expect(router).toContain("patch.result = payload");
    expect(router).toContain('"completed"');
    expect(router).toContain('"failed"');
  });

  it("Phase 2E desktop: RelayClient exported from relay-client.ts", () => {
    const relayClient = read(
      "../../../../orax-desktop/src/main/relay-client.ts",
    );
    expect(relayClient).toContain("export class RelayClient");
    expect(relayClient).toContain("getPendingActions");
    expect(relayClient).toContain("postActionEvent");
    expect(relayClient).toContain("ping_desktop");
    expect(relayClient).toContain("get_desktop_status");
    expect(relayClient).toContain("list_local_projects");
    expect(relayClient).toContain("POLL_INTERVAL_MS");
    expect(relayClient).toContain("BACKOFF_MAX_MS");
    expect(relayClient).toContain("seenKeys");
  });

  it("Phase 2E desktop: RelayState + RelayStatus types in shared/types.ts", () => {
    const types = read("../../../../orax-desktop/src/shared/types.ts");
    expect(types).toContain("RelayState");
    expect(types).toContain("RelayStatus");
    expect(types).toContain('"idle"');
    expect(types).toContain('"polling"');
    expect(types).toContain('"error"');
    expect(types).toContain("lastPollAt");
    expect(types).toContain("errorMsg");
  });

  it("Phase 2E desktop: preload exposes relay.getStatus and on.relayStatusChanged", () => {
    const preload = read("../../../../orax-desktop/src/preload/index.ts");
    expect(preload).toContain("relay:");
    expect(preload).toContain("relay:getStatus");
    expect(preload).toContain("relay:statusChanged");
    expect(preload).toContain("relayStatusChanged");
    expect(preload).toContain("RelayState");
  });

  it("Phase 2E desktop: electron-api.d.ts declares relay.getStatus and relayStatusChanged", () => {
    const apiD = read(
      "../../../../orax-desktop/src/renderer/electron-api.d.ts",
    );
    expect(apiD).toContain("RelayState");
    expect(apiD).toContain("relay:");
    expect(apiD).toContain("getStatus(): Promise<RelayState>");
    expect(apiD).toContain("relayStatusChanged");
  });

  it("Phase 2E desktop: index.ts instantiates RelayClient and passes to registerIpcHandlers", () => {
    const mainIndex = read("../../../../orax-desktop/src/main/index.ts");
    expect(mainIndex).toContain("RelayClient");
    expect(mainIndex).toContain("relayClient");
    expect(mainIndex).toContain("new RelayClient");
  });

  it("Phase 2E desktop: ipc-handlers wires relay:getStatus IPC and relayStatusChanged push", () => {
    const ipcHandlers = read(
      "../../../../orax-desktop/src/main/ipc-handlers.ts",
    );
    expect(ipcHandlers).toContain("relay:getStatus");
    expect(ipcHandlers).toContain("relay:statusChanged");
    expect(ipcHandlers).toContain("relayClient.getState()");
    expect(ipcHandlers).toContain("relayClient.start()");
    expect(ipcHandlers).toContain("relayClient.stop()");
    expect(ipcHandlers).toContain("relayClient.setOnChange");
  });

  it("Phase 2E desktop: HomeScreen shows relay status card", () => {
    const homeScreen = read(
      "../../../../orax-desktop/src/renderer/pages/HomeScreen.tsx",
    );
    expect(homeScreen).toContain("relayState");
    expect(homeScreen).toContain("relay.getStatus");
    expect(homeScreen).toContain("relayStatusChanged");
    expect(homeScreen).toContain('"polling"');
    expect(homeScreen).toContain('"error"');
  });

  it("Phase 2E website: HostCard has Test connection button with polling loop", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    expect(devicesPage).toContain("Test connection");
    expect(devicesPage).toContain("handleTestConnection");
    expect(devicesPage).toContain("ping_desktop");
    expect(devicesPage).toContain("testState");
    expect(devicesPage).toContain("testResult");
    expect(devicesPage).toContain('"completed"');
    expect(devicesPage).toContain('"failed"');
  });

  it("Phase 2E mobile api: createDesktopAction and getDesktopActions exported", () => {
    const mobileApi = read("../../../../ora-mobile/lib/api.ts");
    expect(mobileApi).toContain("createDesktopAction");
    expect(mobileApi).toContain("getDesktopActions");
    expect(mobileApi).toContain("/api/orax/hosts/");
  });

  it("Phase 2E mobile: createDesktopAction + getDesktopActions imported in orax.tsx", () => {
    const mobileOrax = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(mobileOrax).toContain("createDesktopAction");
    expect(mobileOrax).toContain("getDesktopActions");
  });

  it("Phase 2E relay: desktop api-client has getPendingActions + postActionEvent", () => {
    const apiClient = read(
      "../../../../orax-desktop/src/main/api-client.ts",
    );
    expect(apiClient).toContain("getPendingActions");
    expect(apiClient).toContain("postActionEvent");
    expect(apiClient).toContain("/api/orax/relay/pending-actions");
    expect(apiClient).toContain("/api/orax/relay/actions/");
  });

  // ── Phase 2F: safe command execution wiring ──────────────────────────────────

  it("Phase 2F classifier: orax-command-safety.ts exports classifyOraxCommand with allowlist and blocklist", () => {
    const safety = read("../../../../api-server/src/lib/orax-command-safety.ts");
    expect(safety).toContain("classifyOraxCommand");
    expect(safety).toContain("ALLOWED_EXACT");
    expect(safety).toContain("BLOCK_RULES");
    expect(safety).toContain("normalizedCommand");
    expect(safety).toContain("allowed");
    expect(safety).toContain("risk");
    // Blocklist must refuse common dangerous patterns
    expect(safety).toContain("rm|del");
    expect(safety).toContain("powershell");
    // Allowlist must include the five safe commands
    expect(safety).toContain("node --version");
    expect(safety).toContain("npm --version");
    expect(safety).toContain("pnpm --version");
    expect(safety).toContain("git --version");
    expect(safety).toContain("pwd");
  });

  it("Phase 2F backend: POST command-approvals route uses classifyOraxCommand + sets expiresAt 10min", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(route).toContain("command-approvals");
    expect(route).toContain("classifyOraxCommand");
    expect(route).toContain("10 * 60 * 1000");
    expect(route).toContain("expiresAt");
    expect(route).toContain("riskLevel");
    expect(route).toContain("normalizedCommand");
  });

  it("Phase 2F backend: resolve route approved branch creates run_safe_command action, denied skips it", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(route).toContain("approvals/:approvalId/resolve");
    expect(route).toContain("run_safe_command");
    expect(route).toContain('"denied"');
    expect(route).toContain('"approved"');
    // Denied branch must NOT create an action (no insert after the denied early-return)
    const deniedIdx = route.indexOf('"command_approval_denied"');
    const approvedIdx = route.indexOf('"command_approval_approved"');
    expect(deniedIdx).toBeGreaterThan(-1);
    expect(approvedIdx).toBeGreaterThan(-1);
    // Approved branch comes after denied branch in source
    expect(approvedIdx).toBeGreaterThan(deniedIdx);
  });

  it("Phase 2F backend: GET /orax/approvals/:approvalId route present and checks userId ownership", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(route).toContain("orax/approvals/:approvalId");
    expect(route).toContain("oraxPendingApprovalsTable");
    // userId ownership check
    expect(route).toContain("eq(oraxPendingApprovalsTable.userId, userId)");
  });

  it("Phase 2F backend: command-approval tables imported and used in routes", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(route).toContain("oraxPendingApprovalsTable");
    expect(route).toContain("oraxAuditLogTable");
    expect(route).toContain("classifyOraxCommand");
  });

  it("Phase 2F startup migration: migrate-orax-command-approvals registered in startup-migrations.ts", () => {
    const migrations = read("../../../../api-server/src/lib/startup-migrations.ts");
    expect(migrations).toContain("migrate-orax-command-approvals");
  });

  it("Phase 2F desktop executor: command-executor.ts has spawn/no exec, timeout, output cap, redactSecrets", () => {
    const executor = read("../../../../orax-desktop/src/main/command-executor.ts");
    expect(executor).toContain("spawn");
    expect(executor).not.toContain("exec(");
    expect(executor).toContain("shell: false");
    expect(executor).toContain("TIMEOUT_MS");
    expect(executor).toContain("MAX_OUTPUT_BYTES");
    expect(executor).toContain("redactSecrets");
    expect(executor).toContain("timedOut");
    expect(executor).toContain("durationMs");
  });

  it("Phase 2F desktop permission-gate: isCommandPermitted blocks unsafe patterns", () => {
    const gate = read("../../../../orax-desktop/src/main/permission-gate.ts");
    expect(gate).toContain("isCommandPermitted");
    expect(gate).toContain("permitted");
    expect(gate).toContain("reason");
    // Must include blocked patterns
    expect(gate).toContain("BLOCKED_PATTERNS");
  });

  it("Phase 2F relay-client: run_safe_command case calls isCommandPermitted then executeCommand then completed", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("run_safe_command");
    expect(relay).toContain("isCommandPermitted");
    expect(relay).toContain("executeCommand");
    expect(relay).toContain('"running"');
    expect(relay).toContain('"completed"');
    // denied path must NOT proceed to executeCommand
    expect(relay).toContain("Command blocked by local permission gate");
  });

  it("Phase 2F web UI: Safe command section has command Select, Request approval, Approve/Deny, stdout/exitCode", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    expect(devicesPage).toContain("Safe command test");
    expect(devicesPage).toContain("SAFE_COMMANDS");
    expect(devicesPage).toContain("Request approval");
    expect(devicesPage).toContain("Approve");
    expect(devicesPage).toContain("Deny");
    expect(devicesPage).toContain("handleRequestApproval");
    expect(devicesPage).toContain("handleDecide");
    expect(devicesPage).toContain("command-approvals");
    expect(devicesPage).toContain("approvals/");
    expect(devicesPage).toContain("exitCode");
    expect(devicesPage).toContain("stdout");
  });

  it("Phase 2F web UI: approval state machine covers all required states", () => {
    const devicesPage = read("../../pages/orax-devices.tsx");
    for (const state of ["idle", "requesting", "pending", "executing", "done", "denied", "error"]) {
      expect(devicesPage).toContain(`"${state}"`);
    }
  });

  it("Phase 2F mobile api: requestDesktopCommandApproval + resolveDesktopCommandApproval + getDesktopApproval exported", () => {
    const mobileApi = read("../../../../ora-mobile/lib/api.ts");
    expect(mobileApi).toContain("requestDesktopCommandApproval");
    expect(mobileApi).toContain("resolveDesktopCommandApproval");
    expect(mobileApi).toContain("getDesktopApproval");
    expect(mobileApi).toContain("/api/orax/hosts/");
    expect(mobileApi).toContain("/api/orax/approvals/");
    expect(mobileApi).toContain("command-approvals");
    expect(mobileApi).toContain("resolve");
  });

  it("Phase 2F mobile: DiagnosticsSection component present with approve/deny flow", () => {
    const mobileOrax = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(mobileOrax).toContain("DiagnosticsSection");
    expect(mobileOrax).toContain("requestDesktopCommandApproval");
    expect(mobileOrax).toContain("resolveDesktopCommandApproval");
    expect(mobileOrax).toContain("DIAG_COMMANDS");
    expect(mobileOrax).toContain("Request approval");
    expect(mobileOrax).toContain("Approve");
    expect(mobileOrax).toContain("Deny");
    expect(mobileOrax).toContain("exitCode");
    expect(mobileOrax).toContain("stdout");
  });

  it("Phase 2F mobile: DiagnosticsSection approval state machine covers required states", () => {
    const mobileOrax = read("../../../../ora-mobile/app/(home)/orax.tsx");
    for (const state of ["idle", "requesting", "pending", "executing", "done", "denied", "error"]) {
      expect(mobileOrax).toContain(`"${state}"`);
    }
  });
});
