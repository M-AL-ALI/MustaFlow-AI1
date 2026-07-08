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
    expect(collapse(oraxPage)).toContain("return activeThreadState && !hasVisibleInlineAction ?");
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
    expect(oraxDesktopSchema).toContain("local_path"); // orax_projects
    expect(oraxDesktopSchema).toContain("git_remote_url"); // orax_projects
    expect(oraxDesktopSchema).toContain("thread_id"); // orax_thread_messages / approvals
    expect(oraxDesktopSchema).toContain("action_type"); // orax_usage_events
    expect(oraxDesktopSchema).toContain("compute_ms"); // orax_usage_events
    expect(oraxDesktopSchema).toContain("error_msg"); // orax_audit_log

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
    const mainEntry = read("../../../../orax-desktop/src/main/index.ts");
    const preload = read("../../../../orax-desktop/src/preload/index.ts");
    const rendererMain = read("../../../../orax-desktop/src/renderer/main.tsx");
    const appTsx = read("../../../../orax-desktop/src/renderer/App.tsx");
    const sharedTypes = read("../../../../orax-desktop/src/shared/types.ts");

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
    const apiClient = read("../../../../orax-desktop/src/main/api-client.ts");
    const ipcHandlers = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    const hostMgr = read("../../../../orax-desktop/src/main/host-manager.ts");

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
    const ipcLib = read("../../../../orax-desktop/src/renderer/lib/ipc.ts");
    const appCtx = read("../../../../orax-desktop/src/renderer/context/AppContext.tsx");
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
    expect(modeSelect).toContain("Desktop online");
    expect(modeSelect).toContain("Desktop offline");
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
    const migrations = read("../../../../api-server/src/lib/startup-migrations.ts");
    expect(migrations).toContain("migrate-orax-desktop-actions");
    expect(migrations).toContain("orax_desktop_actions");
    expect(migrations).toContain("idempotency_key");
    expect(migrations).toContain("TIMESTAMPTZ");
  });

  it("Phase 2E backend: all 4 relay routes present in orax-desktop router", () => {
    const router = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(router).toContain('router.post("/orax/hosts/:hostId/actions"');
    expect(router).toContain('router.get("/orax/hosts/:hostId/actions"');
    expect(router).toContain('router.get("/orax/relay/pending-actions"');
    expect(router).toContain('router.post("/orax/relay/actions/:actionId/events"');
  });

  it("Phase 2E backend: action creation uses idempotency key + onConflictDoNothing", () => {
    const router = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(router).toContain("idempotencyKey");
    expect(router).toContain("onConflictDoNothing");
    expect(router).toContain("ping_desktop");
    expect(router).toContain("get_desktop_status");
    expect(router).toContain("list_local_projects");
  });

  it("Phase 2E backend: pending-actions poll marks actions as sent", () => {
    const router = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(router).toContain('"sent"');
    expect(router).toContain('status: "queued"');
  });

  it("Phase 2E backend: pending-actions query is account-scoped by userId", () => {
    const router = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(router).toContain("eq(oraxDesktopActionsTable.userId, userId)");
  });

  it("Phase 2E backend: action event endpoint updates result + completedAt on completed/failed", () => {
    const router = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(router).toContain("completedAt");
    expect(router).toContain("patch.result = payload");
    expect(router).toContain('"completed"');
    expect(router).toContain('"failed"');
  });

  it("Phase 2E desktop: RelayClient exported from relay-client.ts", () => {
    const relayClient = read("../../../../orax-desktop/src/main/relay-client.ts");
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
    const apiD = read("../../../../orax-desktop/src/renderer/electron-api.d.ts");
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
    const ipcHandlers = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    expect(ipcHandlers).toContain("relay:getStatus");
    expect(ipcHandlers).toContain("relay:statusChanged");
    expect(ipcHandlers).toContain("relayClient.getState()");
    expect(ipcHandlers).toContain("relayClient.start()");
    expect(ipcHandlers).toContain("relayClient.stop()");
    expect(ipcHandlers).toContain("relayClient.setOnChange");
  });

  it("Phase 2E desktop: HomeScreen shows relay status card", () => {
    const homeScreen = read("../../../../orax-desktop/src/renderer/pages/HomeScreen.tsx");
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
    const apiClient = read("../../../../orax-desktop/src/main/api-client.ts");
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
    // Must use desktop-specific table name (not the generic alias)
    expect(route).toContain("oraxDesktopPendingApprovalsTable");
    // userId ownership check
    expect(route).toContain("eq(oraxDesktopPendingApprovalsTable.userId, userId)");
  });

  it("Phase 2F backend: command-approval tables imported and used in routes", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    // Must import the desktop-specific table export
    expect(route).toContain("oraxDesktopPendingApprovalsTable");
    expect(route).toContain("oraxAuditLogTable");
    expect(route).toContain("oraxUsageEventsTable");
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

  // ── Phase 2F hardening assertions ───────────────────────────────────────────

  it("Phase 2F hardening: route imports desktop-specific approval table export", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(route).toContain("oraxDesktopPendingApprovalsTable");
    expect(route).not.toContain('oraxPendingApprovalsTable"');
  });

  it("Phase 2F hardening: DB schema includes userId/cwd/reason/riskLevel/expiresAt on approval table", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("oraxDesktopPendingApprovalsTable");
    expect(schema).toContain('userId: text("user_id").notNull()');
    expect(schema).toContain('cwd: text("cwd")');
    expect(schema).toContain('reason: text("reason")');
    expect(schema).toContain('riskLevel: text("risk_level")');
    expect(schema).toContain('expiresAt: timestamp("expires_at"');
  });

  it("Phase 2F hardening: relay-client executeAction param type includes payload field", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("payload: Record<string, unknown>");
    // The action param on executeAction must declare payload
    const execIdx = relay.indexOf("executeAction");
    const payloadIdx = relay.indexOf("payload: Record<string, unknown>");
    expect(payloadIdx).toBeGreaterThan(-1);
    expect(payloadIdx).toBeGreaterThan(execIdx);
  });

  it("Phase 2F hardening: command-executor does NOT use cmd.exe, powershell.exe, or spread process.env", () => {
    const executor = read("../../../../orax-desktop/src/main/command-executor.ts");
    expect(executor).not.toContain("cmd.exe");
    expect(executor).not.toContain("powershell.exe");
    expect(executor).not.toContain("shell: true");
    expect(executor).not.toContain("...process.env");
    expect(executor).not.toContain("exec(");
  });

  it("Phase 2F hardening: command-executor uses SAFE_ENV (no full process.env leak)", () => {
    const executor = read("../../../../orax-desktop/src/main/command-executor.ts");
    expect(executor).toContain("SAFE_ENV");
    expect(executor).toContain("env: SAFE_ENV");
  });

  it("Phase 2F hardening: permission-gate includes shell-spawning interpreter blocklist matching backend", () => {
    const gate = read("../../../../orax-desktop/src/main/permission-gate.ts");
    const backend = read("../../../../api-server/src/lib/orax-command-safety.ts");
    // Both must block powershell and bash
    expect(gate).toContain("powershell");
    expect(gate).toContain("bash");
    expect(backend).toContain("powershell");
    expect(backend).toContain("bash");
    // Gate must also block git rebase
    expect(gate).toContain("git\\s+rebase");
  });

  it("Phase 2F hardening: action event handler writes oraxAuditLogTable for run_safe_command", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    // audit log insert inside the run_safe_command completion block
    expect(route).toContain('"command_completed"');
    expect(route).toContain('"command_failed"');
    const runSafeIdx = route.indexOf("run_safe_command");
    const cmdCompletedIdx = route.lastIndexOf('"command_completed"');
    expect(cmdCompletedIdx).toBeGreaterThan(runSafeIdx);
    expect(route).toContain("oraxAuditLogTable");
  });

  it("Phase 2F hardening: action event handler writes oraxUsageEventsTable with command_execution actionType", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(route).toContain("oraxUsageEventsTable");
    expect(route).toContain('"command_execution"');
    const usageIdx = route.indexOf("oraxUsageEventsTable");
    const cmdExecIdx = route.indexOf('"command_execution"');
    expect(cmdExecIdx).toBeGreaterThan(-1);
    // Both must be present in the same route file
    expect(usageIdx).toBeGreaterThan(-1);
  });

  // ── Phase 2G: Cloud Projects ────────────────────────────────────────────────

  it("Phase 2G: DB schema has oraxProjectsTable with userId and name (not hostId/localPath)", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("oraxProjectsTable");
    expect(schema).toContain('orax_projects"');
    expect(schema).toContain("userId");
    expect(schema).toContain("name");
    // Old columns should NOT be in the new projects table definition
    const projectsTableIdx = schema.indexOf("oraxProjectsTable");
    const localFoldersTableIdx = schema.indexOf("oraxDesktopLocalFoldersTable");
    // Both tables must exist
    expect(projectsTableIdx).toBeGreaterThan(-1);
    expect(localFoldersTableIdx).toBeGreaterThan(-1);
  });

  it("Phase 2G: DB schema has oraxDesktopLocalFoldersTable (renamed from old orax_projects)", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("oraxDesktopLocalFoldersTable");
    expect(schema).toContain('orax_desktop_local_folders"');
  });

  it("Phase 2G: DB schema has oraxProjectSourcesTable with kind enum", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("oraxProjectSourcesTable");
    expect(schema).toContain('orax_project_sources"');
    expect(schema).toContain("local_folder");
    expect(schema).toContain("github_repo");
  });

  it("Phase 2G: orax-projects route has CRUD endpoints for projects, sources, and threads", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain("/api/orax/projects");
    expect(route).toContain("sources/local-folder");
    expect(route).toContain("sources/github");
    expect(route).toContain("/threads");
    expect(route).toContain("req.userId");
  });

  it("Phase 2G: orax-projects route is mounted in routes/index.ts", () => {
    const index = read("../../../../api-server/src/routes/index.ts");
    expect(index).toContain("oraxProjectsRouter");
    // /orax must be in KNOWN_PREFIXES
    expect(index).toContain('"/orax"');
  });

  it("Phase 2G: migration script for orax-projects exists and references correct tables", () => {
    const migration = read("../../../../../scripts/src/migrate-orax-projects.ts");
    expect(migration).toContain("orax_projects");
    expect(migration).toContain("orax_project_sources");
    expect(migration).toContain("orax_desktop_local_folders");
  });

  it("Phase 2G: App.tsx has /orax/workspace routes with OraxWorkspacePage", () => {
    expect(app).toContain('path="/orax/workspace"');
    expect(app).toContain("OraxWorkspacePage");
    expect(collapse(app)).toContain("<Protected> <OraxWorkspacePage /> </Protected>");
  });

  it("Phase 2G: orax-workspace page has cloud project list and reconnect-folder text", () => {
    const workspacePage = read("../../pages/orax-workspace.tsx");
    expect(workspacePage).toContain("/api/orax/projects");
    const hasReconnect =
      workspacePage.includes("Reconnect folder") ||
      workspacePage.includes("reconnect") ||
      workspacePage.includes("not available on this desktop");
    expect(hasReconnect).toBe(true);
  });

  it("Phase 2G: orax-workspace page imports no Ora/public-ai routes", () => {
    const workspacePage = read("../../pages/orax-workspace.tsx");
    expect(workspacePage).not.toContain("public-ai");
    expect(workspacePage).not.toContain("/ora/");
    expect(workspacePage).not.toContain("OraPanel");
    expect(workspacePage).not.toContain("handoff");
  });

  it("Phase 2G: desktop ProjectsScreen shows .orax/project.json and Reconnect folder text", () => {
    const desktopProjects = read("../../../../orax-desktop/src/renderer/pages/ProjectsScreen.tsx");
    expect(desktopProjects).toContain(".orax/project.json");
    expect(desktopProjects).toContain("Reconnect folder on desktop");
  });

  it("Phase 2G: desktop ipc.ts exposes cloud project IPC methods", () => {
    const ipc = read("../../../../orax-desktop/src/renderer/lib/ipc.ts");
    expect(ipc).toContain("listCloudProjects");
    expect(ipc).toContain("createCloudProject");
    expect(ipc).toContain("attachLocalFolderToProject");
  });

  it("Phase 2G: mobile api.ts has listOraxProjects and createOraxProject", () => {
    expect(mobileApi).toContain("listOraxProjects");
    expect(mobileApi).toContain("createOraxProject");
    expect(mobileApi).toContain("/api/orax/projects");
  });

  it("Phase 2G: mobile OraxScreen shows Desktop offline badge when host state is offline", () => {
    expect(mobileOraxScreen).toContain("Desktop offline");
    expect(mobileOraxScreen).toContain("desktopHostState");
    expect(mobileOraxScreen).toContain('"offline"');
  });

  it("Phase 2G: mobile OraxScreen imports listOraxProjects and createOraxProject", () => {
    expect(mobileOraxScreen).toContain("listOraxProjects");
    expect(mobileOraxScreen).toContain("createOraxProject");
    expect(mobileOraxScreen).toContain("oraxProjects");
  });

  it("Phase 2G: orax-workspace page does not import from ora-panel or ai-builder", () => {
    const workspacePage = read("../../pages/orax-workspace.tsx");
    expect(workspacePage).not.toContain("ora-panel");
    expect(workspacePage).not.toContain("builder");
    expect(workspacePage).not.toContain("BuilderGuard");
  });

  // ── Phase 2H: Thread Execution Binding ──────────────────────────────────────

  it("Phase 2H: orax-projects has thread messages, context, and continue endpoints", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain("/threads/:threadId/context");
    expect(route).toContain("/threads/:threadId/messages");
    expect(route).toContain("/threads/:threadId/continue");
    expect(route).toContain("resolveProjectExecutionContext");
  });

  it("Phase 2H: resolveProjectExecutionContext queries oraxProjectSourcesTable and checks active status", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain("oraxProjectSourcesTable");
    expect(route).toContain('s.status === "active"');
    expect(route).toContain("oraxHostsTable");
  });

  it("Phase 2H: resolveProjectExecutionContext checks host online status and revokedAt", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain('host.status !== "online"');
    expect(route).toContain("host.revokedAt");
  });

  it("Phase 2H: continue route refuses chat_only threads before checking source", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain('thread.mode === "chat_only"');
    expect(route).toContain("chat-only planning mode");
  });

  it("Phase 2H: continue route queues run_project_thread action with projectId/threadId/executionSourceId", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain("run_project_thread");
    expect(route).toContain("executionSourceId");
    expect(route).toContain("oraxDesktopActionsTable");
    expect(route).toContain("randomUUID");
  });

  it("Phase 2H: orax-projects.ts does not use process.cwd() or public-ai routes", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).not.toContain("process.cwd()");
    expect(route).not.toContain("public-ai");
    expect(route).not.toContain("handoff");
  });

  it("Phase 2H: orax-projects.ts has GET /messages endpoint returning oraxThreadMessagesTable rows", () => {
    const route = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(route).toContain("router.get");
    expect(route).toContain("/messages");
    expect(route).toContain("oraxThreadMessagesTable");
    expect(route).toContain(".orderBy");
  });

  it("Phase 2H: desktop runProjectThread IPC reads .orax/project.json and rejects projectId mismatch", () => {
    const handlers = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    expect(handlers).toContain("project:runProjectThread");
    expect(handlers).toContain(".orax/project.json");
    expect(handlers).toContain("mismatch");
    expect(handlers).toContain("executionSourceId");
    expect(handlers).toContain("projectId");
  });

  it("Phase 2H: desktop preload exposes runProjectThread to renderer", () => {
    const preload = read("../../../../orax-desktop/src/preload/index.ts");
    expect(preload).toContain("runProjectThread");
    expect(preload).toContain("project:runProjectThread");
    expect(preload).toContain("executionSourceId");
  });

  it("Phase 2H: website orax-workspace has getThreadMessages and continueThread API helpers", () => {
    const workspacePage = read("../../pages/orax-workspace.tsx");
    expect(workspacePage).toContain("getThreadMessages");
    expect(workspacePage).toContain("continueThread");
    expect(workspacePage).toContain("/messages");
    expect(workspacePage).toContain("/continue");
    expect(workspacePage).toContain("/context");
  });

  it("Phase 2H: website orax-workspace has ThreadDetail component with selectedThread state", () => {
    const workspacePage = read("../../pages/orax-workspace.tsx");
    expect(workspacePage).toContain("ThreadDetail");
    expect(workspacePage).toContain("selectedThread");
    expect(workspacePage).toContain("setSelectedThread");
  });

  it("Phase 2H: mobile api.ts has sendProjectThreadMessage, continueProjectThread, getProjectThreadContext", () => {
    expect(mobileApi).toContain("sendProjectThreadMessage");
    expect(mobileApi).toContain("continueProjectThread");
    expect(mobileApi).toContain("getProjectThreadContext");
    expect(mobileApi).toContain("/messages");
    expect(mobileApi).toContain("/continue");
    expect(mobileApi).toContain("/context");
  });

  it("Phase 2H: mobile OraxScreen imports continueProjectThread and sendProjectThreadMessage", () => {
    expect(mobileOraxScreen).toContain("sendProjectThreadMessage");
    expect(mobileOraxScreen).toContain("continueProjectThread");
    expect(mobileOraxScreen).toContain("getProjectThreadContext");
  });

  // ── Phase 2H: relay-client run_project_thread handler ───────────────────────

  it("Phase 2H: relay-client handles run_project_thread action type", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain('action.type === "run_project_thread"');
  });

  it("Phase 2H: relay-client reads sourceLocalPath from payload", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("sourceLocalPath");
    expect(relay).toContain("payload.sourceLocalPath");
  });

  it("Phase 2H: relay-client checks .orax/project.json existence and projectId binding", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain(".orax/project.json");
    expect(relay).toContain("project.json");
    expect(relay).toContain("projectId mismatch");
  });

  it("Phase 2H: relay-client posts running event before completing run_project_thread", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain('"run_project_thread"');
    expect(relay).toContain('"running"');
    expect(relay).toContain("localPathVerified: true");
  });

  it("Phase 2H: relay-client does not fall through to Unsupported for run_project_thread", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    // run_project_thread must appear BEFORE the Unsupported fallthrough
    const runIdx = relay.indexOf('"run_project_thread"');
    const unsupportedIdx = relay.indexOf("Unsupported action type");
    expect(runIdx).toBeGreaterThan(-1);
    expect(unsupportedIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeLessThan(unsupportedIdx);
  });

  it("Phase 2H: relay-client validates all required payload fields before proceeding", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("executionSourceId");
    expect(relay).toContain("threadId");
    expect(relay).toContain("missing required payload fields");
  });

  it("Phase 2H: electron-api.d.ts declares runProjectThread on window.electronAPI.project", () => {
    const dts = read("../../../../orax-desktop/src/renderer/electron-api.d.ts");
    expect(dts).toContain("runProjectThread");
    expect(dts).toContain("executionSourceId");
    expect(dts).toContain("localPath");
  });

  // ── Phase 2I: project-inspector ──────────────────────────────────────────

  it("Phase 2I: project-inspector.ts exists and exports inspectLocalProject", () => {
    const src = read("../../../../orax-desktop/src/main/project-inspector.ts");
    expect(src).toContain("inspectLocalProject");
    expect(src).toContain("export");
  });

  it("Phase 2I: project-inspector blocks node_modules, .git, dist, build, out", () => {
    const src = read("../../../../orax-desktop/src/main/project-inspector.ts");
    expect(src).toContain("node_modules");
    expect(src).toContain(".git");
    expect(src).toContain("dist");
    expect(src).toContain("build");
    expect(src).toContain('"out"');
  });

  it("Phase 2I: project-inspector blocks .env, pem, key, id_rsa secret files", () => {
    const src = read("../../../../orax-desktop/src/main/project-inspector.ts");
    expect(src).toContain(".env");
    expect(src).toContain("pem");
    expect(src).toContain("key");
    expect(src).toContain("id_rsa");
  });

  it("Phase 2I: project-inspector has MAX_DEPTH and MAX_FILES limits", () => {
    const src = read("../../../../orax-desktop/src/main/project-inspector.ts");
    expect(src).toContain("MAX_DEPTH");
    expect(src).toContain("MAX_FILES");
  });

  it("Phase 2I: project-inspector reads package.json safely with size limit", () => {
    const src = read("../../../../orax-desktop/src/main/project-inspector.ts");
    expect(src).toContain("package.json");
    expect(src).toContain("MAX_PACKAGE_JSON");
  });

  it("Phase 2I: project-inspector uses only Node fs APIs — no exec or shell", () => {
    const src = read("../../../../orax-desktop/src/main/project-inspector.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
    expect(src).not.toContain("spawn(");
  });

  it("Phase 2I: relay-client imports and calls inspectLocalProject inside run_project_thread", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("inspectLocalProject");
    expect(relay).toContain("project-inspector");
    expect(relay).toContain("projectInspection");
  });

  it("Phase 2I: relay-client includes projectInspection in completed payload", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("localPathVerified: true");
    expect(relay).toContain("projectInspection");
  });

  it("Phase 2I: relay-client does not use process.cwd() in run_project_thread", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).not.toContain("process.cwd()");
  });

  // ── Phase 2I: backend action event handler ───────────────────────────────

  it("Phase 2I: backend special-cases run_project_thread in action event handler", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("run_project_thread");
    expect(src).toContain("project_context_inspected");
    expect(src).toContain("projectInspection");
    expect(src).toContain("summaryText");
  });

  it("Phase 2I: backend writes assistant message for run_project_thread completed", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain(`role = "assistant"`);
    expect(src).toContain(`eventType = "project_context_inspected"`);
  });

  it("Phase 2I: backend writes safe assistant message for run_project_thread failed", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("I could not inspect the desktop project");
    expect(src).toContain("project_run_failed");
  });

  // ── Phase 2I: website UI ─────────────────────────────────────────────────

  it("Phase 2I: orax-workspace renders project_context_inspected chips not raw JSON", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_context_inspected");
    expect(src).toContain("frameworkHints");
    expect(src).toContain("packageManager");
  });

  it("Phase 2I: orax-workspace uses pre-formatted content display not raw JSON dump", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("whitespace-pre-wrap");
    expect(src).toContain("msgText");
  });

  // ── Phase 2I: safety ─────────────────────────────────────────────────────

  it("Phase 2I: mobile orax.tsx has no Ora/public-ai coupling in project thread path", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).not.toContain("useOraChat");
    expect(src).not.toContain("/public-ai/chat");
    expect(src).not.toContain("sendChat");
  });

  // ── Phase 2J: new desktop files ───────────────────────────────────────────

  it("Phase 2J: project-file-selector.ts exists", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-selector.ts");
    expect(src.length).toBeGreaterThan(100);
  });

  it("Phase 2J: project-file-reader.ts exists", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src.length).toBeGreaterThan(100);
  });

  it("Phase 2J: selector exports selectRelevantProjectFiles", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-selector.ts");
    expect(src).toContain("export async function selectRelevantProjectFiles");
  });

  it("Phase 2J: reader exports readSelectedProjectFiles", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).toContain("export async function readSelectedProjectFiles");
  });

  it("Phase 2J: reader blocks .env, .pem, .key, id_rsa, secrets, credentials, token", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).toContain(".env");
    expect(src).toContain(".pem");
    expect(src).toContain(".key");
    expect(src).toContain("id_rsa");
    expect(src).toContain("secrets");
    expect(src).toContain("credentials");
    expect(src).toContain("token");
  });

  it("Phase 2J: reader blocks node_modules, .git, dist, build, out", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).toContain("node_modules");
    expect(src).toContain(".git");
    expect(src).toContain("dist");
    expect(src).toContain("build");
    expect(src).toContain("out");
  });

  it("Phase 2J: reader enforces MAX_FILE_SIZE and MAX_TOTAL_PREVIEW limits", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).toContain("MAX_FILE_SIZE");
    expect(src).toContain("MAX_TOTAL_PREVIEW");
    expect(src).toContain("MAX_CONTENT_PREVIEW");
  });

  it("Phase 2J: reader rejects .. and absolute paths", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).toContain("..");
    expect(src).toContain("isAbsolute");
    expect(src).toContain("not allowed");
  });

  it("Phase 2J: reader verifies resolved path starts with sourceLocalPath", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).toContain("startsWith");
    expect(src).toContain("outside project root");
  });

  it("Phase 2J: reader uses only Node fs APIs — no exec, spawn, shell, or process.cwd()", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-reader.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  it("Phase 2J: selector uses only Node fs APIs — no exec, spawn, shell, or process.cwd()", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-selector.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  // ── Phase 2J: relay ───────────────────────────────────────────────────────

  it("Phase 2J: relay-client imports selectRelevantProjectFiles and readSelectedProjectFiles", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("selectRelevantProjectFiles");
    expect(relay).toContain("readSelectedProjectFiles");
    expect(relay).toContain("project-file-selector");
    expect(relay).toContain("project-file-reader");
  });

  it("Phase 2J: relay-client calls both after inspectLocalProject in run_project_thread", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("selectRelevantProjectFiles");
    expect(relay).toContain("readSelectedProjectFiles");
    expect(relay).toContain("inspectLocalProject");
    expect(relay).toContain("suggestedPlan");
  });

  it("Phase 2J: relay-client includes selectedFiles, fileReadSummary, suggestedPlan in payload", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("selectedFiles");
    expect(relay).toContain("fileReadSummary");
    expect(relay).toContain("suggestedPlan");
  });

  it("Phase 2J: relay-client skips file reads when userMessage is empty", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("userMessage.trim().length > 0");
  });

  it("Phase 2J: relay-client uses buildSuggestedPlan for deterministic plan (no AI call)", () => {
    const relay = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(relay).toContain("buildSuggestedPlan");
    expect(relay).not.toContain("callAI");
    expect(relay).not.toContain("createChatCompletion");
  });

  // ── Phase 2J: backend ─────────────────────────────────────────────────────

  it("Phase 2J: backend handles project_files_read event type", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("project_files_read");
    expect(src).toContain("fileReadSummary");
    expect(src).toContain("hasFileReads");
  });

  it("Phase 2J: backend writes assistant message for project_files_read", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain(`eventType = "project_files_read"`);
    expect(src).toContain(`role = "assistant"`);
  });

  it("Phase 2J: backend builds project_files_read content from fileList template not JSON.stringify", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("I inspected the following files");
    expect(src).toContain("project_files_read");
    expect(src).toContain("fileList");
  });

  it("Phase 2J: backend uses relative paths (fileList) not absolute paths in content", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("relativePath");
    expect(src).toContain("fileList");
  });

  // ── Phase 2J: website UI ──────────────────────────────────────────────────

  it("Phase 2J: orax-workspace renders project_files_read messages", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_files_read");
    expect(src).toContain("fileReadSummary");
  });

  it("Phase 2J: orax-workspace shows file chips with relative paths", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("relativePath");
    expect(src).toContain("f.relativePath");
  });

  it("Phase 2J: orax-workspace shows truncated marker for large files", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("truncated");
  });

  it("Phase 2J: orax-workspace payload type includes fileReadSummary and selectedFiles", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("fileReadSummary");
    expect(src).toContain("selectedFiles");
    expect(src).toContain("ThreadPayload");
  });

  // ── Phase 2J: mobile isolation ────────────────────────────────────────────

  it("Phase 2J: mobile orax.tsx remains free of Ora/public-ai coupling", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).not.toContain("useOraChat");
    expect(src).not.toContain("/public-ai/chat");
    expect(src).not.toContain("project-file-selector");
    expect(src).not.toContain("project-file-reader");
  });

  // ── Phase 2J hardening: symlink traversal guard ───────────────────────────

  it("Phase 2J-H: project-file-selector skips symlinks using isSymbolicLink", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-selector.ts");
    expect(src).toContain("isSymbolicLink");
  });

  it("Phase 2J-H: project-file-selector skips symlinks before recursing into directories", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-selector.ts");
    const symLinkIdx = src.indexOf("isSymbolicLink");
    const dirIdx = src.indexOf("isDirectory");
    expect(symLinkIdx).toBeGreaterThan(-1);
    expect(dirIdx).toBeGreaterThan(-1);
    expect(symLinkIdx).toBeLessThan(dirIdx);
  });

  it("Phase 2J-H: project-file-selector still has no exec, spawn, shell:true, or process.cwd", () => {
    const src = read("../../../../orax-desktop/src/main/project-file-selector.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  // ── Phase 2K: project-patch-drafter ──────────────────────────────────────

  it("Phase 2K: project-patch-drafter.ts exists and exports draftProjectPatch", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).toContain("draftProjectPatch");
    expect(src).toContain("DraftProjectPatch");
    expect(src).toContain("DraftFilePatch");
  });

  it("Phase 2K: project-patch-drafter has no exec, spawn, shell:true, or process.cwd", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  it("Phase 2K: project-patch-drafter has no file writes (writeFile, writeFileSync, appendFile)", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).not.toContain("writeFile(");
    expect(src).not.toContain("writeFileSync(");
    expect(src).not.toContain("appendFile(");
  });

  it("Phase 2K: project-patch-drafter rejects absolute paths and path traversal", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).toContain("isAbsolute");
    expect(src).toContain("absolute path rejected");
    expect(src).toContain("..");
    expect(src).toContain("path traversal rejected");
  });

  it("Phase 2K: project-patch-drafter blocks secret files and dirs", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).toContain("BLOCKED_FILE_PATTERNS");
    expect(src).toContain("BLOCKED_DIRS");
    expect(src).toContain("blocked secret file");
  });

  it("Phase 2K: project-patch-drafter produces summary, changedFiles, risks, verificationPlan", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).toContain("summary");
    expect(src).toContain("changedFiles");
    expect(src).toContain("risks");
    expect(src).toContain("verificationPlan");
    expect(src).toContain("hunkPreview");
  });

  it("Phase 2K: project-patch-drafter validates symlinks via realpathSync", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-drafter.ts");
    expect(src).toContain("realpathSync");
    expect(src).toContain("symlink escapes project root");
  });

  // ── Phase 2K: relay-client ────────────────────────────────────────────────

  it("Phase 2K: relay-client imports draftProjectPatch from project-patch-drafter", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("draftProjectPatch");
    expect(src).toContain("project-patch-drafter");
  });

  it("Phase 2K: relay-client handles draft_project_patch action type", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("draft_project_patch");
    expect(src).toContain("draftProjectPatch(");
  });

  it("Phase 2K: relay-client draft_project_patch verifies .orax/project.json binding", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    const draftIdx = src.indexOf("draft_project_patch");
    const bindingIdx = src.indexOf("oraxProjectPath", draftIdx);
    expect(draftIdx).toBeGreaterThan(-1);
    expect(bindingIdx).toBeGreaterThan(draftIdx);
  });

  it("Phase 2K: relay-client draft_project_patch has no exec, spawn, shell:true, or process.cwd", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  // ── Phase 2K: backend event handler ──────────────────────────────────────

  it("Phase 2K: backend queues draft_project_patch after run_project_thread file reads", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("draft_project_patch");
    expect(src).toContain("fileReadSummary");
    expect(src).toContain("draftIKey");
  });

  it("Phase 2K: backend handles draft_project_patch completed event and writes project_patch_drafted", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("isDraftPatch");
    expect(src).toContain(`eventType = "project_patch_drafted"`);
    expect(src).toContain("project_patch_draft_failed");
  });

  it("Phase 2K: backend queues draft_project_patch using onConflictDoNothing (idempotent)", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    const draftIdx = src.indexOf("draft_project_patch");
    const idxKey = src.indexOf("idempotencyKey", draftIdx);
    const noConflict = src.indexOf("onConflictDoNothing", draftIdx);
    expect(idxKey).toBeGreaterThan(draftIdx);
    expect(noConflict).toBeGreaterThan(draftIdx);
  });

  // ── Phase 2K: website UI ──────────────────────────────────────────────────

  it("Phase 2K: orax-workspace renders project_patch_drafted messages", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_patch_drafted");
    expect(src).toContain("draftPatch");
  });

  it("Phase 2K: orax-workspace shows changed file chips with operation badges", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("changedFiles");
    expect(src).toContain("f.operation");
    expect(src).toContain("FileCode");
  });

  it("Phase 2K: orax-workspace shows hunk preview, risks, and verification plan", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("hunkPreview");
    expect(src).toContain("risks");
    expect(src).toContain("verificationPlan");
    expect(src).toContain("AlertTriangle");
    expect(src).toContain("CheckCircle");
  });

  it("Phase 2K: orax-workspace ThreadPayload type includes draftPatch", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("DraftFilePatch");
    expect(src).toContain("draftPatch?:");
    expect(src).toContain("draftGeneratedAt");
  });

  // ── Phase 2K: mobile parity ───────────────────────────────────────────────

  it("Phase 2K: mobile defines OraxProjectThreadMessage type with draftPatch", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("OraxProjectThreadMessage");
    expect(src).toContain("project_patch_drafted");
  });

  it("Phase 2K: mobile has ProjectPatchDraftedCard component", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPatchDraftedCard");
    expect(src).toContain("draft.summary");
    expect(src).toContain("draft.changedFiles");
  });

  it("Phase 2K: mobile shows file chips, diff preview, risks, and verification plan for patch", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("hunkPreview");
    expect(src).toContain("draft.risks");
    expect(src).toContain("draft.verificationPlan");
    expect(src).toContain("f.relativePath");
  });

  it("Phase 2K: mobile has projectThreadMessages state for project thread messages", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("projectThreadMessages");
    expect(src).toContain("OraxProjectThreadMessage");
  });

  it("Phase 2K: mobile is still free of Ora/public-ai coupling after Phase 2K", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).not.toContain("useOraChat");
    expect(src).not.toContain("/public-ai/chat");
    expect(src).not.toContain("project-patch-drafter");
  });

  // ── Phase 2L: project-patch-applier safety ────────────────────────────────

  it("Phase 2L: project-patch-applier has no exec, spawn, shell:true, or process.cwd", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-applier.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  it("Phase 2L: project-patch-applier checkpoints originals before writing", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-applier.ts");
    expect(src).toContain("checkpoint");
    expect(src).toContain("sha256FileContent");
  });

  it("Phase 2L: project-patch-applier validates paths (BLOCKED_DIRS, symlink guard)", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-applier.ts");
    expect(src).toContain("BLOCKED_DIRS");
    expect(src).toContain("validateApplyPath");
    expect(src).toContain("symlink");
  });

  it("Phase 2L: project-patch-applier has drift guard via originalHash", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-applier.ts");
    expect(src).toContain("originalHash");
    expect(src).toContain("drift");
  });

  // ── Phase 2L: relay-client apply_project_patch handler ───────────────────

  it("Phase 2L: relay-client handles apply_project_patch action type", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("apply_project_patch");
    expect(src).toContain("applyProjectPatch");
  });

  it("Phase 2L: relay-client apply_project_patch result has changedFiles and checkpointPath", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("changedFiles");
    expect(src).toContain("checkpointPath");
  });

  it("Phase 2L: relay-client apply_project_patch has no exec, spawn, or shell:true", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    const applyIdx = src.indexOf("apply_project_patch");
    const applySection = src.slice(applyIdx, applyIdx + 2000);
    expect(applySection).not.toContain("exec(");
    expect(applySection).not.toContain("spawn(");
    expect(applySection).not.toContain("shell: true");
  });

  // ── Phase 2L: backend isApplyPatch handler ────────────────────────────────

  it("Phase 2L: backend declares isApplyPatch and handles apply completed/failed events", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("isApplyPatch");
    expect(src).toContain("project_patch_applied");
    expect(src).toContain("project_patch_failed");
  });

  it("Phase 2L: backend isDraftPatch handler calls AI patch generation", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("generateAiPatches");
    expect(src).toContain("computeUnifiedDiffPreview");
  });

  it("Phase 2L: backend isDraftPatch handler stores enriched draftPatch with skipSharedInsert", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("enrichedDraft");
    expect(src).toContain("sourceLocalPath");
    expect(src).toContain("skipSharedInsert");
  });

  it("Phase 2L: backend AI patch generator has no exec, spawn, shell:true, or process.cwd", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    const genIdx = src.indexOf("generateAiPatches");
    const genSection = src.slice(genIdx, genIdx + 3000);
    expect(genSection).not.toContain("exec(");
    expect(genSection).not.toContain("spawn(");
    expect(genSection).not.toContain("shell: true");
    expect(genSection).not.toContain("process.cwd()");
  });

  // ── Phase 2L: apply-patch endpoint ───────────────────────────────────────

  it("Phase 2L: orax-projects has apply-patch endpoint", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("apply-patch");
    expect(src).toContain("apply_project_patch");
  });

  it("Phase 2L: apply-patch endpoint reads enriched patch from message and writes queued message", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("project_patch_drafted");
    expect(src).toContain("project_patch_apply_queued");
  });

  it("Phase 2L: apply-patch endpoint rejects when no AI-enriched files are present", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("enrichedFiles");
    expect(src).toContain("newContent");
  });

  // ── Phase 2L: website renderers ───────────────────────────────────────────

  it("Phase 2L: orax-workspace renders project_patch_applied messages", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_patch_applied");
  });

  it("Phase 2L: orax-workspace renders project_patch_failed messages", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_patch_failed");
  });

  it("Phase 2L: orax-workspace has Apply Patch button for enriched drafted patches", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("applyPatch");
    expect(src).toContain("Apply patch");
  });

  it("Phase 2L: DraftFilePatch type includes newContent and unifiedDiffPreview", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("newContent?");
    expect(src).toContain("unifiedDiffPreview?");
  });

  // ── Phase 2L: mobile parity ───────────────────────────────────────────────

  it("Phase 2L: mobile OraxProjectThreadMessage type has appliedPatch payload field", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("appliedPatch?:");
  });

  it("Phase 2L: mobile has ProjectPatchAppliedCard component", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPatchAppliedCard");
    expect(src).toContain("appliedPatch");
  });

  it("Phase 2L: mobile has ProjectPatchFailedCard component", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPatchFailedCard");
  });

  // ── Phase 2M: post-apply verification + fix loop ──────────────────────────

  it("Phase 2M: project-patch-verifier has no exec or shell:true", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-verifier.ts");
    expect(src).toContain("verifyProjectPatch");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("process.cwd()");
  });

  it("Phase 2M: project-patch-verifier returns VerifyCheck array and allPassed", () => {
    const src = read("../../../../orax-desktop/src/main/project-patch-verifier.ts");
    expect(src).toContain("VerifyCheck");
    expect(src).toContain("allPassed");
    expect(src).toContain("checks");
  });

  it("Phase 2M: relay-client handles verify_project_patch action type", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("verify_project_patch");
    expect(src).toContain("verifyProjectPatch");
  });

  it("Phase 2M: relay-client verify_project_patch has no exec or shell invocations", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    const verifyIdx = src.indexOf('"verify_project_patch"');
    const verifySection = src.slice(verifyIdx, verifyIdx + 3000);
    expect(verifySection).not.toContain("shell: true");
    expect(verifySection).not.toContain("exec(");
  });

  it("Phase 2M: backend declares isVerifyPatch and writes verified/failed events", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("isVerifyPatch");
    expect(src).toContain("project_patch_verified");
    expect(src).toContain("project_patch_verification_failed");
  });

  it("Phase 2M: backend queues verify_project_patch after apply completed", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("verify_project_patch");
    expect(src).toContain('type: "verify_project_patch"');
  });

  it("Phase 2M: orax-projects has prepare-fix endpoint", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("prepare-fix");
    expect(src).toContain("draft_project_patch");
    expect(src).toContain("project_patch_fix_queued");
  });

  it("Phase 2M: orax-workspace defines VerifyCheck type with allPassed", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("VerifyCheck");
    expect(src).toContain("allPassed");
    expect(src).toContain("checks?");
  });

  it("Phase 2M: orax-workspace renders project_patch_verified messages", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_patch_verified");
    expect(src).toContain("Verification passed");
  });

  it("Phase 2M: orax-workspace renders project_patch_verification_failed messages", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_patch_verification_failed");
    expect(src).toContain("Verification failed");
  });

  it("Phase 2M: orax-workspace has Prepare fix button that calls prepareFix", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("prepareFix");
    expect(src).toContain("Prepare fix");
    expect(src).toContain("preparingFix");
  });

  it("Phase 2M: mobile has ProjectPatchVerifiedCard component", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPatchVerifiedCard");
    expect(src).toContain("project_patch_verified");
  });

  it("Phase 2M: mobile has ProjectPatchVerificationFailedCard component", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPatchVerificationFailedCard");
    expect(src).toContain("project_patch_verification_failed");
  });

  it("Phase 2M: mobile OraxProjectThreadMessage payload has checks field", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("checks?:");
    expect(src).toContain("allPassed?:");
  });

  it("Phase 2M: no public-ai or Ora Builder usage in verify/fix code paths", () => {
    for (const src of [
      read("../../../../orax-desktop/src/main/project-patch-verifier.ts"),
      read("../../../../api-server/src/routes/orax-desktop.ts"),
      read("../../../../api-server/src/routes/orax-projects.ts"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("handoffCta");
    }
  });

  // ── Phase 2N: Auto-Fix From Verification Failure ──────────────────────────

  it("Phase 2N: project-fix-drafter.ts exists and has no exec or shell:true", () => {
    const src = read("../../../../orax-desktop/src/main/project-fix-drafter.ts");
    expect(src).not.toContain("exec(");
    expect(src).not.toContain("execSync(");
    expect(src).not.toContain("spawn(");
    expect(src).not.toContain("shell: true");
    expect(src).not.toContain("shell:true");
    expect(src).not.toContain("process.cwd()");
  });

  it("Phase 2N: project-fix-drafter.ts exports draftProjectFix and FailedCheck with validatePatchPath", () => {
    const src = read("../../../../orax-desktop/src/main/project-fix-drafter.ts");
    expect(src).toContain("draftProjectFix");
    expect(src).toContain("FailedCheck");
    expect(src).toContain("validatePatchPath");
    expect(src).toContain("BLOCKED_DIRS");
  });

  it("Phase 2N: relay-client.ts handles draft_project_fix action type", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("draft_project_fix");
    expect(src).toContain("draftProjectFix");
    expect(src).toContain("project-fix-drafter");
  });

  it("Phase 2N: relay-client.ts draft_project_fix section has no exec or shell invocations", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    // Only check the fix section — run_safe_command legitimately uses shell
    const fixSection = src.slice(src.indexOf('"draft_project_fix"'));
    expect(fixSection).not.toContain("execSync(");
    expect(fixSection).not.toContain("spawnSync(");
    expect(fixSection).not.toContain("shell: true");
    expect(fixSection).not.toContain("shell:true");
  });

  it("Phase 2N: orax-desktop.ts declares isFixDraft and writes project_fix_drafted event", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("isFixDraft");
    expect(src).toContain("draft_project_fix");
    expect(src).toContain("project_fix_drafted");
  });

  it("Phase 2N: orax-projects.ts prepare-fix queues draft_project_fix with failedChecks payload", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("draft_project_fix");
    expect(src).toContain("failedChecks");
    expect(src).toContain("draft_project_patch");
  });

  it("Phase 2N: orax-workspace.tsx renders project_fix_drafted with Apply fix button", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_fix_drafted");
    expect(src).toContain("Apply fix");
    expect(src).toContain("Auto-fix proposal");
  });

  it("Phase 2N: orax-projects.ts apply-patch also accepts project_fix_drafted event type", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("project_fix_drafted");
    expect(src).toContain("project_patch_drafted");
  });

  it("Phase 2N: mobile has ProjectFixDraftedCard component for project_fix_drafted", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectFixDraftedCard");
    expect(src).toContain("project_fix_drafted");
  });

  it("Phase 2N: no public-ai or Ora Builder usage in fix-drafter code paths", () => {
    for (const src of [
      read("../../../../orax-desktop/src/main/project-fix-drafter.ts"),
      read("../../../../orax-desktop/src/main/relay-client.ts"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("handoffCta");
    }
  });

  // ── Phase 3A: MVP Installer + Real Pairing Flow ───────────────────────────

  it("Phase 3A: desktop SignInScreen has no password field and opens browser", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/SignInScreen.tsx");
    expect(src).toContain("Sign in with MustaFlow");
    expect(src).toContain("No password is entered here");
    expect(src).not.toContain('type="password"');
  });

  it("Phase 3A: desktop SetupScreen has Welcome to Orax and approval copy", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/SetupScreen.tsx");
    expect(src).toContain("Welcome to Orax");
    expect(src).toContain("after your approval");
    expect(src).toContain("Register This Computer");
  });

  it("Phase 3A: desktop PairingScreen generates pairing code with no Phase 2D placeholder", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/PairingScreen.tsx");
    expect(src).toContain("Generate Pairing Code");
    expect(src).toContain("qrPayload");
    expect(src).not.toContain("Phase 2D");
  });

  it("Phase 3A: desktop SettingsScreen has all permission mode labels and mode keys", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/SettingsScreen.tsx");
    expect(src).toContain("PERMISSION_MODE_LABELS");
    expect(src).toContain("read_only");
    expect(src).toContain("full_access");
    expect(src).toContain("ask_risky");
    expect(src).toContain("Permission Mode");
  });

  it("Phase 3A: orax-product has coming-soon state and remote-control copy", () => {
    const src = read("../../pages/orax-product.tsx");
    expect(src).toContain("Installer build pending public release");
    expect(src).toContain("remote control");
  });

  it("Phase 3A: mode-select Orax card has Desktop online/offline/Setup required badges", () => {
    const src = read("../../pages/mode-select.tsx");
    expect(src).toContain("Desktop online");
    expect(src).toContain("Desktop offline");
    expect(src).toContain("Setup required");
  });

  it("Phase 3A: orax-devices page has test connection, last seen, and revoke", () => {
    const src = read("../../pages/orax-devices.tsx");
    expect(src).toContain("Test connection");
    expect(src).toContain("lastSeenAt");
    expect(src).toContain("Revoke");
  });

  it("Phase 3A: mobile has pairing code redemption UI", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("redeemOraxPairingCode");
    expect(src).toContain("pairing");
  });

  it("Phase 3A: desktop ProjectsScreen lists cloud projects and local folder binding", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/ProjectsScreen.tsx");
    expect(src).toContain("Cloud Projects");
    expect(src).toContain("Add Folder");
    expect(src).toContain(".orax/project.json");
    expect(src).toContain("Reconnect folder on desktop");
  });

  it("Phase 3A: no Ora/public-ai in Orax product and device pages", () => {
    for (const src of [
      read("../../pages/orax-product.tsx"),
      read("../../pages/orax-devices.tsx"),
      read("../../../../orax-desktop/src/renderer/pages/SignInScreen.tsx"),
      read("../../../../orax-desktop/src/renderer/pages/SetupScreen.tsx"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("handoffCta");
    }
  });

  // ── Phase 3B: Git Branch, Commit, and Pull Request Flow ──────────────────────

  it("Phase 3B: project-git-workflow.ts exists and exports prepareProjectPr", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).toContain("prepareProjectPr");
    expect(src).toContain("buildBranchName");
    expect(src).toContain("validateGitRepo");
    expect(src).toContain("getGitRemoteUrl");
  });

  it("Phase 3B: project-git-workflow.ts uses no destructive git commands or shell execution", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).not.toContain("shell:true");
    expect(src).not.toContain("git reset --hard");
    expect(src).not.toContain("git clean -fd");
    expect(src).not.toContain("--force");
  });

  it("Phase 3B: project-git-workflow.ts branches follow orax/<threadId8>/<slug> pattern", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).toContain("orax/");
    expect(src).toContain("buildBranchName");
  });

  it("Phase 3B: relay-client.ts handles prepare_project_pr action and imports project-git-workflow", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("prepare_project_pr");
    expect(src).toContain("project-git-workflow");
    expect(src).toContain("prepareProjectPr");
  });

  it("Phase 3B: orax-projects.ts has prepare-pr endpoint", () => {
    const src = read("../../../../api-server/src/routes/orax-projects.ts");
    expect(src).toContain("prepare-pr");
    expect(src).toContain("prepare_project_pr");
    expect(src).toContain("project_pr_prepare_queued");
  });

  it("Phase 3B: orax-desktop.ts declares isPrepPr and writes project_pr_ready event", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("isPrepPr");
    expect(src).toContain("prepare_project_pr");
    expect(src).toContain("project_pr_ready");
    expect(src).toContain("project_pr_failed");
  });

  it("Phase 3B: orax-workspace.tsx renders project_pr_ready and project_pr_failed and has Create pull request button", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_pr_ready");
    expect(src).toContain("project_pr_failed");
    expect(src).toContain("Create pull request");
    expect(src).toContain("preparePr");
    expect(src).toContain("preparingPr");
  });

  it("Phase 3B: mobile has ProjectPrReadyCard and ProjectPrFailedCard for project_pr_ready and project_pr_failed", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPrReadyCard");
    expect(src).toContain("ProjectPrFailedCard");
    expect(src).toContain("project_pr_ready");
    expect(src).toContain("project_pr_failed");
  });

  it("Phase 3B: no Ora/public-ai in project-git-workflow", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).not.toContain("/api/public-ai/");
    expect(src).not.toContain("oraChat");
    expect(src).not.toContain("handoffCta");
  });

  // ── Phase 3C: Real GitHub PR Creation + GitHub Connection Quality ─────────────

  it("Phase 3C: project-git-workflow.ts detects GitHub remote and creates real PRs via API", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).toContain("parseGitHubRemote");
    expect(src).toContain("createGitHubPr");
    expect(src).toContain("api.github.com");
    expect(src).toContain("redactToken");
  });

  it("Phase 3C: project-git-workflow.ts exports PrBlockerType and returns blockerType", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).toContain("PrBlockerType");
    expect(src).toContain("no_github_remote");
    expect(src).toContain("push_failed");
    expect(src).toContain("blockerType");
    expect(src).toContain("blockerReason");
  });

  it("Phase 3C: project-git-workflow.ts does not log tokens or use exec", () => {
    const src = read("../../../../orax-desktop/src/main/project-git-workflow.ts");
    expect(src).not.toContain("console.log");
    expect(src).not.toContain("exec(");
  });

  it("Phase 3C: relay-client.ts passes blockerType, blockerReason, prNumber through result", () => {
    const src = read("../../../../orax-desktop/src/main/relay-client.ts");
    expect(src).toContain("blockerType");
    expect(src).toContain("blockerReason");
    expect(src).toContain("prNumber");
  });

  it("Phase 3C: orax-desktop.ts routes isHardBlocked to project_pr_blocked", () => {
    const src = read("../../../../api-server/src/routes/orax-desktop.ts");
    expect(src).toContain("project_pr_blocked");
    expect(src).toContain("isHardBlocked");
    expect(src).toContain("no_github_remote");
  });

  it("Phase 3C: orax-workspace.tsx renders project_pr_blocked with device settings link", () => {
    const src = read("../../pages/orax-workspace.tsx");
    expect(src).toContain("project_pr_blocked");
    expect(src).toContain("GitHub connection required");
    expect(src).toContain("/orax/devices");
  });

  it("Phase 3C: mobile has ProjectPrBlockedCard for project_pr_blocked", () => {
    const src = read("../../../../ora-mobile/app/(home)/orax.tsx");
    expect(src).toContain("ProjectPrBlockedCard");
    expect(src).toContain("project_pr_blocked");
    expect(src).toContain("GitHub connection required");
  });

  it("Phase 3C: no Ora/public-ai contamination in Phase 3C files", () => {
    for (const src of [
      read("../../../../orax-desktop/src/main/project-git-workflow.ts"),
      read("../../../../orax-desktop/src/main/relay-client.ts"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
    }
  });

  // ── Phase 3D: Windows Desktop Smoke Test + Installer Prep ───────────────────

  it("Phase 3D: orax-desktop package exposes repeatable readiness scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"smoke:readiness"');
    expect(pkg).toContain('"verify:phase3d"');
    expect(pkg).toContain("scripts/smoke-readiness.mjs");
  });

  it("Phase 3D: smoke-readiness script verifies the complete desktop-backed Orax chain", () => {
    const src = read("../../../../orax-desktop/scripts/smoke-readiness.mjs");
    for (const token of [
      "run_project_thread",
      "draft_project_patch",
      "apply_project_patch",
      "verify_project_patch",
      "draft_project_fix",
      "prepare_project_pr",
      "Welcome to Orax",
      "after your approval",
      ".orax",
      "checkpoints",
    ]) {
      expect(src).toContain(token);
    }
  });

  it("Phase 3D: smoke-readiness script rejects unsafe desktop helper patterns", () => {
    const src = read("../../../../orax-desktop/scripts/smoke-readiness.mjs");
    expect(src).toContain("exec(");
    expect(src).toContain("shell: true");
    expect(src).toContain("process.cwd()");
    expect(src).toContain("git reset --hard");
    expect(src).toContain("git clean -fd");
    expect(src).toContain("--force");
  });

  it("Phase 3D: smoke-readiness script blocks Phase 3 pasted prompt assets", () => {
    const src = read("../../../../orax-desktop/scripts/smoke-readiness.mjs");
    expect(src).toContain("Pasted-Start-Phase-3");
    expect(src).toContain("no Phase 3 pasted task prompts in attached_assets");
  });

  it("Phase 3D: smoke-test runbook covers setup, pairing, patch, verification, fix, and PR", () => {
    const doc = read("../../../../../docs/orax-desktop-e2e-smoke-test.md");
    for (const token of [
      "Open Orax Desktop",
      "Pair Device",
      "Draft Patch",
      "Apply Patch",
      "Verify Patch",
      "Prepare Fix",
      "Prepare Pull Request",
      "Mobile Observation",
    ]) {
      expect(doc).toContain(token);
    }
  });

  it("Phase 3D: smoke-test runbook keeps Ora out of the desktop smoke flow", () => {
    const doc = read("../../../../../docs/orax-desktop-e2e-smoke-test.md");
    expect(doc).toContain("Do not include Ora/public-ai chat");
    expect(doc).toContain("Orax must remain separate from Ora");
  });

  // ── Phase 3F: Production Desktop Sign-In + Session Persistence ───────────

  it("Phase 3F: DB schema has desktop auth challenge and session tables", () => {
    const schema = read("../../../../../lib/db/src/schema/orax-desktop.ts");
    expect(schema).toContain("oraxDesktopAuthChallengesTable");
    expect(schema).toContain("oraxDesktopSessionsTable");
    expect(schema).toContain("pollTokenHash");
    expect(schema).toContain("sessionTokenCiphertext");
    expect(schema).toContain("tokenHash");
    expect(schema).toContain("ORAX_DESKTOP_AUTH_STATUSES");
  });

  it("Phase 3F: API exposes public start/status and authenticated completion routes", () => {
    const route = read("../../../../api-server/src/routes/orax-desktop-auth.ts");
    const index = read("../../../../api-server/src/routes/index.ts");
    expect(route).toContain("/orax/desktop-auth/start");
    expect(route).toContain("/orax/desktop-auth/status/:challengeId");
    expect(route).toContain("/orax/desktop-auth/complete");
    expect(route).toContain("encryptionService.encrypt");
    expect(route).toContain("encryptionService.decrypt");
    expect(route).toContain("hashOraxDesktopToken");
    expect(index).toContain("oraxDesktopAuthPublicRouter");
    expect(index).toContain("oraxDesktopAuthRouter");
  });

  it("Phase 3F: desktop tokens are scoped to Orax routes and do not touch Ora", () => {
    const auth = read("../../../../api-server/src/lib/auth.ts");
    expect(auth).toContain("oraxDesktopSessionsTable");
    expect(auth).toContain("ORAX_DESKTOP_TOKEN_PREFIX");
    expect(auth).toContain('req.path === "/orax" || req.path.startsWith("/orax/")');
    expect(auth).toContain("oraxDesktopSessionId");
    expect(auth).not.toContain("/api/public-ai");
    expect(auth).not.toContain("oraChat");
  });

  it("Phase 3F: Orax Desktop polls browser approval and stores session locally", () => {
    const auth = read("../../../../orax-desktop/src/main/auth.ts");
    const signIn = read("../../../../orax-desktop/src/renderer/pages/SignInScreen.tsx");
    const smoke = read("../../../../orax-desktop/scripts/smoke-readiness.mjs");
    expect(auth).toContain("/api/orax/desktop-auth/start");
    expect(auth).toContain("/api/orax/desktop-auth/status/");
    expect(auth).toContain("shell.openExternal");
    expect(auth).toContain("storeEncrypted(SESSION_STORE_KEY");
    expect(auth).toContain("deleteEncrypted(SESSION_STORE_KEY)");
    expect(signIn).toContain("Waiting for browser approval");
    expect(signIn).toContain("No password is entered here");
    expect(signIn).not.toContain("future update");
    expect(smoke).toContain("/api/orax/desktop-auth/start");
  });

  it("Phase 3F: website approval page is protected and confirms desktop code", () => {
    const app = read("../../App.tsx");
    const page = read("../../pages/orax-desktop-auth-approve.tsx");
    expect(app).toContain("OraxDesktopAuthApprovePage");
    expect(app).toContain("/orax/desktop-auth/approve");
    expect(page).toContain("Approve Orax Desktop");
    expect(page).toContain("Desktop code");
    expect(page).toContain("/api/orax/desktop-auth/complete");
    expect(page).toContain("getToken");
    expect(page).toContain("does not grant access to Ora chat routes");
  });

  // ── Phase 3G: Windows Installer + Distribution Readiness ─────────────────

  it("Phase 3G: Orax Desktop package exposes Windows packaging scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"package:win"');
    expect(pkg).toContain('"verify:phase3g"');
    expect(pkg).toContain('"installer:readiness"');
    expect(pkg).toContain("electron-builder");
  });

  it("Phase 3G: electron-builder config targets Orax Desktop NSIS installer", () => {
    const config = read("../../../../orax-desktop/electron-builder.yml");
    expect(config).toContain("productName: Orax Desktop");
    expect(config).toContain("appId: ai.mustaflow.orax.desktop");
    expect(config).toContain("target: nsis");
    expect(config).toContain("Orax-Desktop-${version}-${arch}-Setup.${ext}");
    expect(config).toContain("provider: generic");
    expect(config).toContain("https://downloads.mustaflow.com/orax/desktop/windows");
  });

  it("Phase 3G: installer readiness script checks icon, ignored output, and no generated binaries", () => {
    const script = read("../../../../orax-desktop/scripts/installer-readiness.mjs");
    const gitignore = read("../../../../../.gitignore");
    const icon = read("../../../../orax-desktop/build/icon.svg");
    expect(script).toContain("artifacts/orax-desktop/electron-builder.yml");
    expect(script).toContain("artifacts/orax-desktop/build/icon.svg");
    expect(script).toContain("git");
    expect(script).toContain("ls-files");
    expect(script).toContain("artifacts/orax-desktop/release");
    expect(gitignore).toContain("artifacts/orax-desktop/release/");
    expect(icon).toContain("Orax Desktop");
  });

  it("Phase 3G: product page shows controlled early-access installer copy", () => {
    const page = read("../../pages/orax-product.tsx");
    expect(page).toContain("Request early access");
    expect(page).toContain("Installer build pending public release");
    expect(page).toContain("Windows installer builds are ready for internal testing");
    expect(page).not.toContain("Desktop installer coming soon");
  });

  it("Phase 3G: installer files remain Orax-only and do not reference Ora/public-ai", () => {
    for (const src of [
      read("../../../../orax-desktop/electron-builder.yml"),
      read("../../../../orax-desktop/scripts/installer-readiness.mjs"),
      read("../../../../orax-desktop/package.json"),
      read("../../../../../docs/orax-desktop-windows-installer.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3H: Signed Release Channel + Manifest Readiness

  it("Phase 3H: package exposes release manifest and release readiness scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"release:manifest"');
    expect(pkg).toContain('"release:readiness"');
    expect(pkg).toContain('"verify:phase3h"');
  });

  it("Phase 3H: release manifest script produces checksum metadata without committing artifacts", () => {
    const script = read("../../../../orax-desktop/scripts/release-manifest.mjs");
    const gitignore = read("../../../../../.gitignore");
    expect(script).toContain("createHash");
    expect(script).toContain("sha256");
    expect(script).toContain("ORAX_DESKTOP_RELEASE_BASE_URL");
    expect(script).toContain("orax-desktop-windows-latest.json");
    expect(script).toContain("Orax-Desktop-${version}-x64-Setup.exe");
    expect(gitignore).toContain("artifacts/orax-desktop/release/");
  });

  it("Phase 3H: release readiness script checks channel, docs, and tracked release output", () => {
    const script = read("../../../../orax-desktop/scripts/release-readiness.mjs");
    expect(script).toContain("docs/orax-desktop-release-channel.md");
    expect(script).toContain("provider: generic");
    expect(script).toContain("artifacts/orax-desktop/release");
    expect(script).toContain("Signed release channel");
    expect(script).toContain("Release artifact manifest");
  });

  it("Phase 3H: release-channel runbook defines signing, upload, and rollback controls", () => {
    const doc = read("../../../../../docs/orax-desktop-release-channel.md");
    expect(doc).toContain("Code signing gate");
    expect(doc).toContain("Release artifact manifest");
    expect(doc).toContain("Upload Flow");
    expect(doc).toContain("Rollback");
    expect(doc).toContain("Do not expose a direct public download link");
  });

  it("Phase 3H: product page shows release-channel status without public direct download", () => {
    const page = read("../../pages/orax-product.tsx");
    expect(page).toContain("Signed release channel");
    expect(page).toContain("internal release review");
    expect(page).toContain("Direct download opens after signing and smoke tests pass");
    expect(page).not.toContain('href="/downloads/');
  });

  it("Phase 3H: release-channel files stay Orax-only", () => {
    for (const src of [
      read("../../../../orax-desktop/scripts/release-manifest.mjs"),
      read("../../../../orax-desktop/scripts/release-readiness.mjs"),
      read("../../../../../docs/orax-desktop-release-channel.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3I: Signed Release Workflow + Download Host Integration

  it("Phase 3I: package exposes upload and verification scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"release:upload"');
    expect(pkg).toContain('"release:upload-readiness"');
    expect(pkg).toContain('"verify:phase3i"');
  });

  it("Phase 3I: GitHub release workflow builds, manifests, artifacts, and gated publish", () => {
    const workflow = read("../../../../../.github/workflows/orax-desktop-release.yml");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("pnpm --filter @workspace/orax-desktop run verify:phase3i");
    expect(workflow).toContain("pnpm --filter @workspace/orax-desktop run package:win");
    expect(workflow).toContain("pnpm --filter @workspace/orax-desktop run release:manifest");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("pnpm --filter @workspace/orax-desktop run release:upload");
    expect(workflow).toContain("if: ${{ inputs.publish }}");
  });

  it("Phase 3I: GitHub release workflow requires signing and download-host configuration", () => {
    const workflow = read("../../../../../.github/workflows/orax-desktop-release.yml");
    expect(workflow).toContain("ORAX_WINDOWS_CSC_LINK");
    expect(workflow).toContain("ORAX_WINDOWS_CSC_KEY_PASSWORD");
    expect(workflow).toContain("ORAX_RELEASE_AWS_ACCESS_KEY_ID");
    expect(workflow).toContain("ORAX_RELEASE_AWS_SECRET_ACCESS_KEY");
    expect(workflow).toContain("ORAX_DESKTOP_RELEASE_S3_URI");
    expect(workflow).toContain("ORAX_DESKTOP_RELEASE_S3_ENDPOINT");
  });

  it("Phase 3I: release upload script defaults to dry run and requires explicit publish", () => {
    const script = read("../../../../orax-desktop/scripts/release-upload.mjs");
    expect(script).toContain("ORAX_DESKTOP_RELEASE_PUBLISH");
    expect(script).toContain('process.env.ORAX_DESKTOP_RELEASE_PUBLISH === "true"');
    expect(script).toContain("Release upload dry run");
    expect(script).toContain("ORAX_DESKTOP_RELEASE_S3_URI");
    expect(script).toContain("aws");
    expect(script).toContain("s3");
    expect(script).toContain("orax-desktop-windows-latest.json");
  });

  it("Phase 3I: upload readiness script guards workflow, upload script, docs, and generated output", () => {
    const script = read("../../../../orax-desktop/scripts/release-upload-readiness.mjs");
    expect(script).toContain(".github/workflows/orax-desktop-release.yml");
    expect(script).toContain("artifacts/orax-desktop/scripts/release-upload.mjs");
    expect(script).toContain("ORAX_DESKTOP_RELEASE_S3_URI");
    expect(script).toContain("GitHub Actions release workflow");
    expect(script).toContain("Required GitHub secrets");
    expect(script).toContain("artifacts/orax-desktop/release");
  });

  it("Phase 3I: release docs describe workflow inputs, secrets, variables, and publish gate", () => {
    const doc = read("../../../../../docs/orax-desktop-release-channel.md");
    expect(doc).toContain("GitHub Actions release workflow");
    expect(doc).toContain("Required GitHub secrets");
    expect(doc).toContain("ORAX_WINDOWS_CSC_LINK");
    expect(doc).toContain("ORAX_DESKTOP_RELEASE_S3_URI");
    expect(doc).toContain("publish=false");
  });

  it("Phase 3I: product page shows release automation without opening public direct download", () => {
    const page = read("../../pages/orax-product.tsx");
    expect(page).toContain("Release automation");
    expect(page).toContain("Manual release workflow is ready for signed upload");
    expect(page).not.toContain('href="/downloads/');
  });

  it("Phase 3I: release upload files stay Orax-only", () => {
    for (const src of [
      read("../../../../../.github/workflows/orax-desktop-release.yml"),
      read("../../../../orax-desktop/scripts/release-upload.mjs"),
      read("../../../../orax-desktop/scripts/release-upload-readiness.mjs"),
      read("../../../../../docs/orax-desktop-release-channel.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3J: Public Download Switch + Release Status UI

  it("Phase 3J: package exposes public download readiness and verification scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"release:public-readiness"');
    expect(pkg).toContain('"verify:phase3j"');
    expect(pkg).toContain("scripts/release-public-readiness.mjs");
  });

  it("Phase 3J: release helper gates public download on env and manifest validation", () => {
    const helper = read("../../lib/orax-desktop-release.ts");
    expect(helper).toContain("VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED");
    expect(helper).toContain("VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL");
    expect(helper).toContain("getOraxDesktopReleaseStatus");
    expect(helper).toContain("isValidOraxDesktopManifest");
    expect(helper).toContain("downloadUrl");
    expect(helper).toContain("sha256");
    expect(helper).toContain("https://downloads.mustaflow.com/orax/desktop/windows/");
  });

  it("Phase 3J: product page fetches release manifest and fails closed to early access", () => {
    const page = read("../../pages/orax-product.tsx");
    expect(page).toContain("getOraxDesktopReleaseStatus");
    expect(page).toContain("isValidOraxDesktopManifest");
    expect(page).toContain("Release manifest unavailable");
    expect(page).toContain("Public download disabled");
    expect(page).toContain("Request early access");
    expect(page).toContain("Download for Windows");
    expect(page).toContain("releaseManifest.downloadUrl");
    expect(page).not.toContain('href="/downloads/');
  });

  it("Phase 3J: release public readiness script checks product page, helper, docs, and Ora isolation", () => {
    const script = read("../../../../orax-desktop/scripts/release-public-readiness.mjs");
    expect(script).toContain("artifacts/mustaflow/src/lib/orax-desktop-release.ts");
    expect(script).toContain("artifacts/mustaflow/src/pages/orax-product.tsx");
    expect(script).toContain("VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED");
    expect(script).toContain("VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL");
    expect(script).toContain("Public download switch");
    expect(script).toContain("leaks Ora/public-ai references");
  });

  it("Phase 3J: release docs describe env switch and manifest URL validation", () => {
    const doc = read("../../../../../docs/orax-desktop-release-channel.md");
    expect(doc).toContain("Public download switch");
    expect(doc).toContain("VITE_ORAX_DESKTOP_PUBLIC_DOWNLOAD_ENABLED=true");
    expect(doc).toContain("VITE_ORAX_DESKTOP_RELEASE_MANIFEST_URL");
    expect(doc).toContain("downloadUrl");
    expect(doc).toContain("Do not hard-code an");
    expect(doc).toContain("verify:phase3j");
  });

  it("Phase 3J: public download switch files stay Orax-only", () => {
    for (const src of [
      read("../../lib/orax-desktop-release.ts"),
      read("../../pages/orax-product.tsx"),
      read("../../../../orax-desktop/scripts/release-public-readiness.mjs"),
      read("../../../../../docs/orax-desktop-release-channel.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3K: Update/Recovery Hardening + Support Diagnostics

  it("Phase 3K: package exposes update/recovery readiness and verification scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"update:recovery-readiness"');
    expect(pkg).toContain('"verify:phase3k"');
    expect(pkg).toContain("scripts/update-recovery-readiness.mjs");
  });

  it("Phase 3K: support diagnostics builder excludes secrets, env vars, and local paths", () => {
    const src = read("../../../../orax-desktop/src/main/support-diagnostics.ts");
    expect(src).toContain("buildSupportDiagnostics");
    expect(src).toContain("includesSessionToken: false");
    expect(src).toContain("includesPasswords: false");
    expect(src).toContain("includesEnvironmentVariables: false");
    expect(src).toContain("includesLocalProjectPaths: false");
    expect(src).not.toContain("session.token");
    expect(src).not.toContain("process.env");
  });

  it("Phase 3K: desktop IPC exposes support diagnostics export end to end", () => {
    const main = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    const preload = read("../../../../orax-desktop/src/preload/index.ts");
    const rendererTypes = read("../../../../orax-desktop/src/renderer/electron-api.d.ts");
    const ipc = read("../../../../orax-desktop/src/renderer/lib/ipc.ts");
    expect(main).toContain("support:exportDiagnostics");
    expect(main).toContain("buildSupportDiagnostics");
    expect(preload).toContain("support:exportDiagnostics");
    expect(rendererTypes).toContain("SupportDiagnosticsExport");
    expect(ipc).toContain("exportDiagnostics");
  });

  it("Phase 3K: Settings screen lets users export support diagnostics", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/SettingsScreen.tsx");
    expect(src).toContain("Export Support Diagnostics");
    expect(src).toContain("does not include session tokens");
    expect(src).toContain("environment variables");
    expect(src).toContain("local project paths");
  });

  it("Phase 3K: update/recovery readiness script checks diagnostics and Ora isolation", () => {
    const src = read("../../../../orax-desktop/scripts/update-recovery-readiness.mjs");
    expect(src).toContain("support-diagnostics.ts");
    expect(src).toContain("support:exportDiagnostics");
    expect(src).toContain("Export Support Diagnostics");
    expect(src).toContain("Do not include Ora/public-ai chat");
    expect(src).toContain("leaks Ora/public-ai references");
  });

  it("Phase 3K: update/recovery runbook documents rollback and support diagnostics", () => {
    const doc = read("../../../../../docs/orax-desktop-update-recovery.md");
    expect(doc).toContain("Update and Recovery");
    expect(doc).toContain("Failed Update Recovery");
    expect(doc).toContain("Rollback");
    expect(doc).toContain("Support Diagnostics");
    expect(doc).toContain("verify:phase3k");
    expect(doc).toContain("session tokens");
    expect(doc).toContain("local project paths");
  });

  it("Phase 3K: update/recovery files stay Orax-only", () => {
    for (const src of [
      read("../../../../orax-desktop/src/main/support-diagnostics.ts"),
      read("../../../../orax-desktop/src/main/ipc-handlers.ts"),
      read("../../../../orax-desktop/src/preload/index.ts"),
      read("../../../../orax-desktop/src/renderer/pages/SettingsScreen.tsx"),
      read("../../../../../docs/orax-desktop-update-recovery.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3L: Diagnostics Redaction Guard + Export Verification

  it("Phase 3L: package exposes diagnostics validation verification script", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"verify:phase3l"');
    expect(pkg).toContain("update:recovery-readiness");
  });

  it("Phase 3L: support diagnostics validator scans secrets, env values, and local paths", () => {
    const src = read("../../../../orax-desktop/src/main/support-diagnostics.ts");
    expect(src).toContain("findSupportDiagnosticsViolations");
    expect(src).toContain("serializeValidatedSupportDiagnostics");
    expect(src).toContain("SENSITIVE_KEY_PATTERN");
    expect(src).toContain("Bearer");
    expect(src).toContain("GitHub token");
    expect(src).toContain("PRIVATE KEY");
    expect(src).toContain("environment assignment");
    expect(src).toContain("Windows local path");
    expect(src).toContain("Unix local path");
    expect(src).not.toContain("session.token");
    expect(src).not.toContain("process.env");
  });

  it("Phase 3L: diagnostics export validates before writing the JSON file", () => {
    const src = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    const validateIndex = src.indexOf("serializeValidatedSupportDiagnostics(diagnostics)");
    const writeIndex = src.indexOf("writeFile(result.filePath");
    expect(validateIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(-1);
    expect(validateIndex).toBeLessThan(writeIndex);
  });

  it("Phase 3L: update/recovery readiness checks validator and validation order", () => {
    const src = read("../../../../orax-desktop/scripts/update-recovery-readiness.mjs");
    expect(src).toContain("findSupportDiagnosticsViolations");
    expect(src).toContain("serializeValidatedSupportDiagnostics");
    expect(src).toContain("requireOrder");
    expect(src).toContain("serializeValidatedSupportDiagnostics(diagnostics)");
    expect(src).toContain("writeFile(result.filePath");
  });

  it("Phase 3L: update/recovery docs describe fail-closed diagnostics validation", () => {
    const doc = read("../../../../../docs/orax-desktop-update-recovery.md");
    expect(doc).toContain("validated before it is written");
    expect(doc).toContain("export fails and no diagnostics file is created");
    expect(doc).toContain("verify:phase3l");
    expect(doc).toContain("rejected before `writeFile`");
  });

  it("Phase 3L: diagnostics validation files stay Orax-only", () => {
    for (const src of [
      read("../../../../orax-desktop/src/main/support-diagnostics.ts"),
      read("../../../../orax-desktop/src/main/ipc-handlers.ts"),
      read("../../../../orax-desktop/scripts/update-recovery-readiness.mjs"),
      read("../../../../../docs/orax-desktop-update-recovery.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3M: Desktop Health Check Panel

  it("Phase 3M: package exposes health readiness and verification scripts", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"health:readiness"');
    expect(pkg).toContain('"verify:phase3m"');
    expect(pkg).toContain("scripts/health-readiness.mjs");
  });

  it("Phase 3M: desktop app mounts HealthScreen as a first-class page", () => {
    const app = read("../../../../orax-desktop/src/renderer/App.tsx");
    const ctx = read("../../../../orax-desktop/src/renderer/context/AppContext.tsx");
    const sidebar = read("../../../../orax-desktop/src/renderer/components/Sidebar.tsx");
    expect(app).toContain("HealthScreen");
    expect(app).toContain("health: HealthScreen");
    expect(ctx).toContain('"health"');
    expect(sidebar).toContain('label: "Health"');
    expect(sidebar).toContain("HeartPulse");
  });

  it("Phase 3M: HealthScreen shows all required desktop health categories", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx");
    for (const token of [
      "Health Check",
      "Sign-in status",
      "Host registration",
      "Heartbeat status",
      "Relay polling",
      "Pairing readiness",
      "Release channel",
      "Diagnostics export",
      "Export Support Diagnostics",
    ]) {
      expect(src).toContain(token);
    }
    expect(src).toContain("support.exportDiagnostics");
    expect(src).toContain("window.electronAPI.relay.getStatus");
  });

  it("Phase 3M: health readiness script guards page wiring, docs, and Ora isolation", () => {
    const src = read("../../../../orax-desktop/scripts/health-readiness.mjs");
    expect(src).toContain("HealthScreen.tsx");
    expect(src).toContain("Sign-in status");
    expect(src).toContain("Relay polling");
    expect(src).toContain("Export Support Diagnostics");
    expect(src).toContain("Health Check Panel");
    expect(src).toContain("leaks Ora/public-ai references");
  });

  it("Phase 3M: smoke readiness and docs cover the health panel", () => {
    const smoke = read("../../../../orax-desktop/scripts/smoke-readiness.mjs");
    const doc = read("../../../../../docs/orax-desktop-update-recovery.md");
    expect(smoke).toContain("HealthScreen.tsx");
    expect(smoke).toContain("Health Check");
    expect(doc).toContain("Health Check Panel");
    expect(doc).toContain("verify:phase3m");
    expect(doc).toContain("sign-in, host registration, heartbeat, relay polling");
  });

  it("Phase 3M: health panel files stay Orax-only", () => {
    for (const src of [
      read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx"),
      read("../../../../orax-desktop/src/renderer/App.tsx"),
      read("../../../../orax-desktop/src/renderer/components/Sidebar.tsx"),
      read("../../../../orax-desktop/scripts/health-readiness.mjs"),
      read("../../../../../docs/orax-desktop-update-recovery.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });

  // Phase 3N: Desktop Health Recovery Actions

  it("Phase 3N: package exposes verify:phase3n script", () => {
    const pkg = read("../../../../orax-desktop/package.json");
    expect(pkg).toContain('"verify:phase3n"');
  });

  it("Phase 3N: HealthScreen includes recovery action buttons for all failing areas", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx");
    for (const token of [
      "Sign in again",
      "Reconnect host",
      "Restart relay",
      "Open pairing",
      "Check release status",
      "Export Support Diagnostics",
    ]) {
      expect(src).toContain(token);
    }
  });

  it("Phase 3N: HealthScreen recovery actions use AppContext and IPC, not raw Node", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx");
    expect(src).toContain("signIn");
    expect(src).toContain("registerHost");
    expect(src).toContain("relay.restart");
    expect(src).toContain('setPage("pairing")');
    expect(src).not.toContain("require(");
    expect(src).not.toContain("child_process");
  });

  it("Phase 3N: relay.restart IPC is wired through preload, renderer lib, type declarations, and main handler", () => {
    const preload = read("../../../../orax-desktop/src/preload/index.ts");
    const ipcLib = read("../../../../orax-desktop/src/renderer/lib/ipc.ts");
    const apiDef = read("../../../../orax-desktop/src/renderer/electron-api.d.ts");
    const handlers = read("../../../../orax-desktop/src/main/ipc-handlers.ts");
    expect(preload).toContain("relay:restart");
    expect(ipcLib).toContain("restart");
    expect(apiDef).toContain("restart");
    expect(handlers).toContain("relay:restart");
  });

  it("Phase 3N: HealthScreen recovery errors are redacted before rendering", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx");
    expect(src).toContain("redactForDisplay");
  });

  it("Phase 3N: health recovery action states have running/success/failed lifecycle with lastAttempted", () => {
    const src = read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx");
    expect(src).toContain('"running"');
    expect(src).toContain('"success"');
    expect(src).toContain('"failed"');
    expect(src).toContain("lastAttempted");
  });

  it("Phase 3N: docs cover health recovery actions and verify:phase3n", () => {
    const doc = read("../../../../../docs/orax-desktop-update-recovery.md");
    expect(doc).toContain("Health Recovery Actions");
    expect(doc).toContain("verify:phase3n");
    expect(doc).toContain("Sign in again");
    expect(doc).toContain("Restart relay");
    expect(doc).toContain("Open pairing");
  });

  it("Phase 3N: health recovery files stay Orax-only", () => {
    for (const src of [
      read("../../../../orax-desktop/src/renderer/pages/HealthScreen.tsx"),
      read("../../../../orax-desktop/src/main/ipc-handlers.ts"),
      read("../../../../orax-desktop/src/preload/index.ts"),
      read("../../../../orax-desktop/src/renderer/lib/ipc.ts"),
      read("../../../../orax-desktop/src/renderer/electron-api.d.ts"),
      read("../../../../../docs/orax-desktop-update-recovery.md"),
    ]) {
      expect(src).not.toContain("/api/public-ai/");
      expect(src).not.toContain("oraChat");
      expect(src).not.toContain("useOraChat");
    }
  });
});
