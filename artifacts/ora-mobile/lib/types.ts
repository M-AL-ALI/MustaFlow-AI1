/**
 * Shared types for the Ora mobile client. These mirror the response
 * shapes of the EXISTING production API (artifacts/api-server) — they are not a
 * new contract. Keep field names in sync with the web Ora experience.
 */

// Canonical Ora wire types live in @workspace/ora-contracts (single source of
// truth, shared with the API server). Imported type-only so the zod runtime is
// never bundled by Metro.
export type {
  OraMode,
  OraRole,
  OraTier,
  OraMessageKind,
  FileFormat,
  OraSource,
  OraImage,
  OraVideo,
  OraMemoryUsed,
  OraAttachmentMeta,
  OraDatasetResult,
  GeneratedFile,
  OraFileEditMode,
  OraFileEditQuality,
  OraMessageData,
  OraAccountConsistency,
  OraAccountConsistencyLatest,
  OraClarificationKind,
  OraPendingClarification,
  OraMultiFileRole,
  OraUsedFile,
  OraFileCitation,
  OraFileCitationKind,
  OraFileAgentPreview,
  OraActivityTool,
  OraActivityPhase,
  OraActivityStep,
  OraRealtimeActiveArtifact,
  OraRealtimeToolBridgeResponse,
  OraRealtimeToolWrittenResult,
} from "@workspace/ora-contracts";

import type {
  OraActivityStep,
  OraClarificationKind,
  OraFileCitation,
  OraFileAgentPreview,
  OraFileEditQuality,
  OraImage,
  OraMemoryUsed,
  OraMessageData,
  OraMode,
  OraPendingClarification,
  OraRole,
  OraSource,
  OraTier,
  OraUsedFile,
  OraVideo,
} from "@workspace/ora-contracts";

/**
 * A chat message in the mobile thread. Extends the shared persisted message
 * model (`OraMessageData`, identical to the web wire shape — sources, images,
 * videos, suggestions, generatedFile, attachment, datasetResult, messageKind,
 * inline image lineage, and the memory fields) with the ephemeral client-only
 * fields the UI needs while a turn is in flight.
 */
export interface OraMessage extends OraMessageData {
  id: string;
  createdAt?: string;
  pending?: boolean;
  error?: boolean;
  /** True while this assistant message is still being streamed token-by-token. */
  isStreaming?: boolean;
  /**
   * True when an SSE stream was interrupted AFTER the first token. The partial
   * reply is kept and a "response was cut off" note is shown beneath it
   * (mirrors the web hook's partial-content error behavior).
   */
  streamCutOff?: boolean;
  /**
   * True when this reply did NOT use real provider-level token streaming —
   * either the SSE stream fell back to /chat or the provider wrapped a single
   * completion in the SSE envelope. Useful for developer monitoring.
   */
  viaFallback?: boolean;
  /**
   * Legacy flag from older transcripts where live web search failed but Ora
   * returned a general-knowledge answer. New search failures render an inline
   * retryable error bubble instead of an uncited fallback answer.
   */
  searchFallback?: boolean;
  /**
   * True when a live-search reply/error can be retried with the search tool
   * pinned instead of re-classifying the message.
   */
  searchRetryable?: boolean;
  /**
   * Local device URI of an uploaded image attachment (client-only, mirrors
   * Attachment.localUri). Lets the user bubble render a tappable thumbnail that
   * opens the full-screen preview. Ephemeral — not persisted, so it is absent
   * after a conversation reload.
   */
  attachmentLocalUri?: string;
}

/**
 * Payload carried by the SSE `done` event from /api/public-ai/chat/stream.
 * Mirrors the shape the backend stream-adapter emits.
 */
export interface StreamDonePayload {
  reply: string;
  suggestions?: string[];
  videos?: OraVideo[];
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  memoriesUsed?: OraMemoryUsed[];
  /** Phase 8: verified uploaded-file citations derived server-side. */
  fileCitations?: OraFileCitation[];
  fileAgentPreview?: OraFileAgentPreview;
  /** Updated rolling summary echoed so the client can advance its pointer. */
  conversationSummary?: string;
  mode?: OraMode;
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  isRealStreaming?: boolean;
  streamingFallback?: boolean;
  /**
   * Present only when the server's false-delivery safety net generated a real
   * file after the streamed reply claimed one was attached.
   */
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  assetId?: number;
  /** Server-measured timing/routing metadata — privacy-safe, no user content. */
  serverDiag?: {
    ttftMs: number | null;
    totalMs?: number;
    provider?: string;
    routeTier?: string;
    fastLane?: boolean;
    /** Phase 3 route diagnostics (static templates/enums only, no user content). */
    routedTool?: string | null;
    searchUsed?: boolean | null;
    classifierSkipped?: boolean | null;
    classifierMs?: number | null;
    routeReason?: string | null;
    inferredFileFormat?: string | null;
    conflictResolution?: string | null;
  } | null;
}

export interface OraSession {
  sessionId: string;
  msgCount: number;
  msgLimit: number;
  imageCount?: number;
  imageLimit?: number;
  fileCount?: number;
  fileLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  tier?: OraTier;
  isPaid?: boolean;
}

export interface OraUsage {
  messageCount: number;
  messageLimit: number;
  imageCount: number;
  imageLimit: number;
  resetsAt: string;
  windowHours: number;
}

/**
 * Context forwarded to the realtime mint endpoint. Mirrors the website's
 * RealtimeStartContext minus `history` (which is seeded client-side over the
 * data channel as lower-authority conversation items, never sent to the mint).
 */
/** Speaker-focus posture; persisted client-side (AsyncStorage). Default "focused". */
export type FocusMode = "normal" | "focused";

/**
 * Product voice for spoken replies, persisted client-side (AsyncStorage).
 * "marine" = female, "mustafa" = male. The server maps this to the underlying
 * provider voice; the raw provider voice id is never sent to the device.
 */
export type VoicePreset = "marine" | "mustafa";

export interface RealtimeSessionContext {
  language?: string;
  languageHint?: string;
  /** IANA timezone resolved from the device; used for the local date/time line. */
  timeZone?: string;
  temporary: boolean;
  referenceSavedMemories: boolean;
  oraProjectId?: number | null;
  conversationId?: number | string | null;
  /** Optional recent utterance used ONLY to rank saved-memory recall. */
  message?: string;
  /**
   * Speaker-focus mode. "focused" (default) makes the server stop auto-responding
   * so the client only replies to transcripts that clear the focus filter
   * (rejecting nearby background speakers). "normal" keeps the legacy behavior.
   */
  focusMode?: FocusMode;
  /**
   * Product voice for this session. When omitted, the server applies the default
   * ("marine"). The raw provider voice id is never sent from the device.
   */
  voicePreset?: VoicePreset;
  /** Uploaded-file refs available to realtime file creation/revision tools. */
  documentRefs?: string[];
  /** Current generated/edited file target for voice revisions. */
  activeArtifact?: import("@workspace/ora-contracts").OraRealtimeActiveArtifact | null;
}

/**
 * Surfaced when the per-plan live-voice MINUTE budget is exhausted (at session
 * start, or mid-call when the budget runs out). The caller shows a graceful
 * "out of voice time" state with the reset time INSTEAD of falling back to the
 * legacy transcribe -> chat -> tts loop, which would bypass the voice cap.
 * Mirrors the website's RealtimeOverLimit.
 */
export interface RealtimeOverLimit {
  /** Short, spoken-budget-safe message (no provider/model naming). */
  message: string;
  /** ISO timestamp when the voice budget refills, when known. */
  resetsAt: string | null;
  /** True when a higher plan would grant more live-voice minutes. */
  upgradeAvailable: boolean;
}

/** Response from POST /public-ai/realtime/session — a short-lived ek_ token. */
export interface RealtimeSessionResult {
  value: string;
  expiresAt: number | null;
  model: string;
  // The server returns the product preset/label, not the raw provider voice id.
  // `voice` is kept optional only for back-compat and is not used by the client.
  voice?: string;
  voicePreset?: VoicePreset | null;
  voiceLabel?: string;
  maxDurationSeconds: number;
  // Echoed back by the server so diagnostics can confirm the negotiated posture.
  focusMode?: FocusMode;
  createResponse?: boolean;
  // Live-voice budget metering. The client stores realtimeSessionId, beats it on
  // heartbeatIntervalSeconds, counts down from maxDurationSeconds, and finalizes
  // at /end. resetsAt is when the per-plan budget refills.
  realtimeSessionId?: string;
  remainingSeconds?: number | null;
  limitSeconds?: number | null;
  resetsAt?: string | null;
  heartbeatIntervalSeconds?: number | null;
  // End-of-turn settle window (ms) for turn coalescing; see SETTLE_WINDOW_MS in
  // useOraRealtimeVoiceNative. Optional for back-compat with older servers.
  settleMs?: number | null;
}

/** Response from POST /public-ai/realtime/heartbeat (charges elapsed seconds). */
export interface RealtimeHeartbeatResult {
  status?: string;
  ended?: boolean;
  remainingSeconds?: number | null;
  limitSeconds?: number | null;
  resetsAt?: string | null;
}

/** Response from GET /public-ai/realtime/diagnostics (non-charging). */
export interface RealtimeDiagnostics {
  enabled: boolean;
  configured: boolean;
  killSwitch: boolean;
  // Product-safe diagnostics: the underlying model and raw provider voice id are
  // never sent to the client. Only the product voice preset/label is exposed.
  defaultVoicePreset: VoicePreset | null;
  defaultVoiceLabel: string;
  voices: Array<{ key: VoicePreset; label: string }>;
  tier: string;
  maxDurationSeconds: number;
  // Per-plan live-voice budget. Privacy-safe: seconds + reset time only, never
  // the underlying model or raw provider voice id.
  limitSeconds?: number | null;
  windowHours?: number | null;
  usedSeconds?: number | null;
  remainingSeconds?: number | null;
  resetsAt?: string | null;
}

export interface ChatRequest {
  message: string;
  messages: Array<{ role: OraRole; content: string }>;
  language?: string;
  /**
   * Device BCP-47 locale (e.g. "en-US"). Used server-side ONLY as a language
   * tiebreaker for short/ambiguous messages. Mirrors the website's
   * `navigator.language` hint so web and mobile route identically.
   */
  languageHint?: string;
  /** IANA timezone resolved from the device; used for the local date/time line. */
  timeZone?: string;
  mode: OraMode;
  referenceSavedMemories: boolean;
  referenceChatHistory: boolean;
  /**
   * When true, the server treats this turn as a temporary chat: it skips saved-
   * memory recall, conversation summaries, and any persistence. The client must
   * also force `referenceSavedMemories`/`referenceChatHistory` off and avoid
   * calling the conversation persistence endpoints for the thread.
   */
  temporary?: boolean;
  /**
   * Server-signed token from a `stream_failed` SSE error event. Present only
   * on the non-streaming /chat fallback after a streaming pre-increment that
   * failed before the first token. Absent means no pre-increment occurred and
   * the server charges the slot normally.
   */
  streamFallbackToken?: string;
  /**
   * When set, the server injects memories scoped to this Ora project into the
   * AI context alongside user-level memories. Must match a project owned by
   * the current user; the server enforces ownership.
   */
  oraProjectId?: number | null;
  /**
   * True for a user-initiated "Retry live search". The server pins this turn to
   * the live web-search tool and runs a harder forced strategy (longer timeout +
   * low-effort secondary attempt). If that still fails, the server returns a
   * retryable 503 without an uncited fallback answer, so the client keeps the
   * user's message and the Retry affordance.
   */
  forceSearch?: boolean;
  /**
   * UUID refs of documents/datasets uploaded earlier this conversation. Must be
   * sent on EVERY chat turn while refs are active (normal send, stream fallback,
   * retry/regenerate) so the server can route uploaded-file edit requests to the
   * layout-preserving file editor instead of answering with plain text. Server
   * caps at 5. Mirrors the website hook's `body.documentRefs`.
   */
  documentRefs?: string[];
  /**
   * The persisted conversation id when this thread has been saved. The server
   * uses it to exclude the CURRENT conversation from cross-conversation memory
   * recall (otherwise recall would echo this thread back at itself). Mirrors
   * the website hook's `body.conversationId`.
   */
  conversationId?: number | null;
  /**
   * Round-tripped task context from a prior clarifying question about an
   * ambiguous uploaded-file edit. Present ONLY on the turn immediately after
   * Ora asked for clarification, so the server merges this message (the
   * answer) with the original ask and executes it. Mirrors the website hook's
   * `body.pendingClarification`.
   */
  pendingClarification?: OraPendingClarification;
}

export interface ChatResponse {
  reply: string;
  sources?: OraSource[];
  images?: OraImage[];
  videos?: OraVideo[];
  suggestions?: string[];
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  assetId?: number;
  /**
   * Edit-quality transparency metadata attached when the file came out of an
   * edit pipeline (Phase A quality card). Small display fields only.
   */
  editQuality?: OraFileEditQuality;
  imageUrl?: string;
  imageId?: number;
  imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  memoriesUsed?: OraMemoryUsed[];
  /** Multi-file turns: which uploads were used in which role ("working from"
   * chips). Names + roles only — never refs or content. */
  usedFiles?: OraUsedFile[];
  /** Phase 8: verified uploaded-file citations (file + slide/sheet locator),
   * derived server-side against the injected content — never model-claimed. */
  fileCitations?: OraFileCitation[];
  fileAgentPreview?: OraFileAgentPreview;
  conversationSummary?: string;
  mode?: OraMode;
  msgCount?: number;
  msgLimit?: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
  /**
   * Legacy flag from older transcripts where live web search failed but Ora
   * returned a general-knowledge answer. New search failures render an inline
   * retryable error bubble instead of an uncited fallback answer.
   */
  searchFallback?: boolean;
  /**
   * True when a live-search reply/error can be retried with the search tool
   * pinned instead of re-classifying the message.
   */
  searchRetryable?: boolean;
  /**
   * True when this reply is a clarifying question about an ambiguous
   * uploaded-file edit instead of an executed edit. The client echoes
   * `pendingTaskContext` back as `pendingClarification` on the next send so
   * the original task continues. Uncharged server-side.
   */
  needsClarification?: boolean;
  /** Which ambiguity triggered the clarifying question. */
  clarificationKind?: OraClarificationKind;
  /** Opaque task context to round-trip on the user's next message. */
  pendingTaskContext?: OraPendingClarification;
  /**
   * Live activity trace terminal steps reported with the response (the
   * non-streaming tool paths have no SSE, so ok/fail rides the JSON).
   * Wording comes from the shared @workspace/ora-contracts copy map.
   */
  activity?: OraActivityStep[];
}

export interface UploadResponse {
  imageRef?: string;
  fileRef?: string;
  filename: string;
  fileType: string;
  kind?: "image" | "file";
  charCount?: number;
  rowCount?: number;
  colCount?: number;
  truncated?: boolean;
  imageCount?: number;
}

export type AttachmentKind = "image" | "dataset" | "document";

export interface Attachment {
  ref: string;
  kind: AttachmentKind;
  filename: string;
  fileType: string;
  /**
   * Local device URI of the picked file (image attachments only). Kept so the
   * user bubble can render a tappable thumbnail and open the full-screen preview
   * without re-downloading. Device-local and ephemeral — not persisted, so it is
   * absent after a conversation reload.
   */
  localUri?: string;
}

export interface AnalysisResponse {
  reply: string;
  msgCount?: number;
  msgLimit?: number;
  imageCount?: number;
  imageLimit?: number;
  imageAnalysisCount?: number;
  imageAnalysisLimit?: number;
  resetsAt?: string | null;
}

/**
 * Raw dataset-analysis result. The /dataset-analysis endpoint returns a
 * structured `result` object (the AI output plus a dataset profile), NOT a
 * plain `reply` like the image/file analysis endpoints.
 */
export interface DatasetAnalysisResult {
  summary?: string;
  datasetProfile?: {
    rowCount?: number;
    colCount?: number;
    truncated?: boolean;
    sheetName?: string;
  };
  rowCount?: number;
  columnCount?: number;
  truncated?: boolean;
  analysisType?: string;
  keyFindings?: string[];
  recommendations?: string[];
  actionPlan?: Array<{
    action: string;
    priority: string;
    owner?: string;
    timeline?: string;
  }>;
  nextSteps?: string[];
  risksAndLimitations?: string[];
  fileAgentPreview?: OraFileAgentPreview;
  analystWorkflow?: {
    chartSuggestions?: Array<{
      title: string;
      chartType: string;
      xColumn?: string;
      yColumn?: string;
      groupByColumn?: string;
      reason: string;
    }>;
    calculationSuggestions?: Array<{
      label: string;
      expression: string;
      description: string;
      columns: string[];
    }>;
    reportSuggestions?: Array<{
      title: string;
      format: string;
      description: string;
    }>;
  };
  [key: string]: unknown;
}

export interface DatasetAnalysisResponse {
  result: DatasetAnalysisResult;
  msgCount?: number;
  msgLimit?: number;
}

export interface OraProfile {
  id?: number;
  userId?: string;
  preferredName?: string;
  occupation?: string;
  industry?: string;
  goals?: string;
  skillLevel?: string;
  preferredLanguage?: string;
  responseStyle?: string;
  avoid?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OraMemory {
  id: number;
  title: string;
  content: string;
  enabled: boolean;
  category: string | null;
  sourceConversationId: number | null;
  oraProjectId: number | null;
  supersededBy: number | null;
  createdAt: string;
}

export interface MemoryUsage {
  count: number;
  limit: number;
}

export interface OraConversationSummary {
  id: number;
  title: string | null;
  titleSource?: "client" | "ai" | "user" | null;
  projectId: number | null;
  preview: string | null;
  lastMessageAt: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  messageCount?: number | null;
  metaHasImages?: boolean;
  metaHasGeneratedFiles?: boolean;
  metaHasSources?: boolean;
  metaHasVoice?: boolean;
  metaLastActivityType?: string | null;
}

export interface OraConversationDetail {
  id: number;
  title: string;
  projectId: number | null;
  messages: OraMessage[];
}

export interface OraProjectSummary {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set when the project is archived; only present on includeArchived fetches. */
  archivedAt?: string | null;
}

export interface OraAsset {
  id: number;
  kind: "file" | "image";
  fileName: string;
  mimeType: string;
  format: string;
  prompt: string;
  sizeBytes: number;
  createdAt: string;
}

export interface OraAssetsResponse {
  assets: OraAsset[];
  total: number;
  storage: { usedBytes: number; capBytes: number };
}

export interface OraAssetVersion {
  id: number;
  fileName: string;
  mimeType: string;
  format: string;
  sizeBytes: number;
  versionNumber: number;
  editSummary: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export interface OraAssetVersionsResponse {
  rootAssetId: number;
  currentAssetId: number;
  versions: OraAssetVersion[];
}

export interface RestoreAssetVersionResponse {
  ok: boolean;
  assetId: number;
  versionNumber: number;
  restoredFromVersion: number;
  fileName: string;
  relinked: boolean;
}

export interface OraxCapabilities {
  available: string[];
  lockedUntilApprovalLayer: string[];
}

export type OraxTaskKind = "analyze" | "plan" | "review" | "fix";

export interface OraxRepository {
  id: number;
  provider?: string;
  owner: string;
  name: string;
  connectionStatus: "metadata_only" | "read_only" | string;
  repositoryUrl?: string;
  defaultBranch?: string;
  githubAccountName?: string | null;
  tokenScopes?: string | null;
  connectedAt?: string | null;
  scanStatus?: string;
  lastScanAt?: string | null;
  updatedAt?: string;
}

export interface OraxScan {
  id: number;
  repositoryId: number;
  status: string;
  branch: string;
  commitSha?: string | null;
  fileCount?: number;
  directoryCount?: number;
  totalBytes?: number;
  summary?: {
    repo?: {
      fullName?: string;
      htmlUrl?: string;
      defaultBranch?: string;
      private?: boolean;
      language?: string | null;
    };
    branch?: string;
    commitSha?: string;
    fileCount?: number;
    directoryCount?: number;
    totalBytes?: number;
    languages?: Record<string, number>;
    sampleFiles?: string[];
    truncated?: boolean;
  };
  error?: string | null;
  createdAt?: string;
  completedAt?: string | null;
}

export interface OraxCheckpointSummary {
  goal: string;
  status: string;
  filesReviewed: string[];
  approvals: {
    pending: number;
    completed: number;
    failed: number;
    denied: number;
    total: number;
  };
  artifacts: {
    draftPatches: number;
    sandboxResults: number;
    commandResults: number;
    githubPrResults: number;
    total: number;
  };
  latestBlocker: string | null;
  nextStep: string;
  updatedAt: string;
}

export interface OraxTaskActionSuggestion {
  type:
    | "read_files"
    | "draft_patch"
    | "sandbox_run"
    | "controlled_checks"
    | "github_pr"
    | "review_pending_approval";
  title: string;
  description: string;
  buttonLabel?: string;
  paths?: string[];
  reason?: string;
  instructions?: string;
  artifactId?: number;
  approvalId?: number;
  commands?: string[];
  requiresManualConfirmation?: boolean;
}

export interface OraxTask {
  id: number;
  repositoryId: number;
  kind: OraxTaskKind;
  title?: string;
  prompt?: string;
  status: string;
  plan?: {
    mode?: string;
    objective?: string;
    steps?: string[];
    guardrails?: string[];
    unavailableUntilApproved?: string[];
  };
  result?: {
    message?: string;
    currentCheckpoint?: OraxCheckpointSummary;
    [key: string]: unknown;
  };
  createdAt?: string;
}

export interface OraxTaskMessage {
  id: number;
  repositoryId: number;
  taskId: number;
  role: "user" | "assistant" | "system" | "tool" | string;
  content: string;
  metadata?: {
    actionSuggestions?: OraxTaskActionSuggestion[];
    checkpoint?: OraxCheckpointSummary;
    event?: string;
    executionSessionId?: number;
    executionStep?: OraxExecutionStep;
    source?: string;
    [key: string]: unknown;
  };
  artifactId?: number | null;
  approvalId?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OraxExecutionStep {
  id?: string;
  action?: string;
  label?: string;
  status?: string;
  message?: string;
  approvalId?: number;
  artifactId?: number;
  createdAt?: string;
}

export type OraxComposerReasoning = "low" | "medium" | "high" | "extra_high";
export type OraxComposerPermissionMode = "ask" | "auto" | "read_only";

export interface OraxComposerAttachment {
  id?: string;
  name: string;
  type?: string;
  size?: number;
  source?: "web" | "mobile";
  contentKind?: "text" | "image" | "binary" | "unsupported";
  contentText?: string;
  dataUrl?: string;
  preview?: string;
  truncated?: boolean;
  ingestionStatus?: "ready" | "unsupported" | "error";
}

export interface OraxComposerMetadata {
  composer: {
    model: string;
    reasoning: OraxComposerReasoning;
    permissionMode: OraxComposerPermissionMode;
    inputMode: "text" | "voice";
    attachments: OraxComposerAttachment[];
  };
}

export interface OraxApproval {
  id: number;
  repositoryId: number;
  taskId: number;
  action: "read_files" | "sandbox_run" | "safe_check" | "github_pr" | string;
  status: "pending" | "approved" | "denied" | "completed" | "failed" | string;
  request: {
    paths?: string[];
    branch?: string;
    reason?: string | null;
    artifactId?: number;
    commands?: string[];
    title?: string;
    scope?: string;
    [key: string]: unknown;
  };
  result?: {
    artifactId?: number;
    branch?: string;
    totalBytes?: number;
    files?: Array<{ path: string; sha?: string; size?: number; truncated?: boolean }>;
    skipped?: Array<{ path: string; reason: string }>;
    pullRequestUrl?: string;
    [key: string]: unknown;
  };
  riskSummary?: string | null;
  createdAt?: string;
  decidedAt?: string | null;
  completedAt?: string | null;
}

export interface OraxArtifact {
  id: number;
  repositoryId: number;
  taskId: number;
  approvalId?: number | null;
  type: "draft_patch" | "sandbox_result" | "command_result" | "github_pr_result" | string;
  status: "completed" | "failed" | string;
  title: string;
  summary?: string | null;
  payload: {
    branch?: string;
    unifiedDiff?: string;
    explanation?: string;
    risks?: string[];
    tests?: string[];
    filesRead?: Array<{ path: string; sha?: string; size?: number }>;
    skipped?: Array<{ path: string; reason: string }>;
    sourceArtifactId?: number;
    workspaceChangeSetArtifactId?: number;
    sourceApprovalId?: number;
    applied?: boolean;
    diffSummary?: { additions?: number; deletions?: number };
    changedFiles?: Array<{
      path: string;
      additions?: number;
      deletions?: number;
      beforeBytes?: number;
      afterBytes?: number;
    }>;
    patchedFiles?: Array<{ path: string; size?: number; sourceSha?: string }>;
    rollback?: {
      sourceFiles?: Array<{ path: string; sha?: string; size?: number; truncated?: boolean }>;
    };
    commands?: Array<{
      id: string;
      label?: string;
      status: string;
      exitCode?: number | null;
      message?: string;
    }>;
    passed?: boolean;
    branchName?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    filesChanged?: string[];
    steps?: OraxExecutionStep[];
    startedAt?: string;
    updatedAt?: string;
    retryOfArtifactId?: number;
    retryOfArtifactType?: string;
    retryAttempt?: number;
    failureSummary?: string;
    error?: { code?: string; message?: string; hint?: string; rawMessage?: string };
    [key: string]: unknown;
  };
  createdAt?: string;
  updatedAt?: string;
}

export type OraxTaskApproval = OraxApproval;
export type OraxTaskArtifact = OraxArtifact;

export interface UserPreferences {
  userId?: string;
  dismissedOnboarding?: boolean;
  preferredMode?: "builder" | "developer" | "ora";
  voiceLang?: string;
  autoReadReplies?: boolean;
}

export type BillingTierId = "free" | "core" | "wave";

export interface BillingSubscription {
  userId?: string;
  tier: BillingTierId;
  status: "active" | "trialing" | "grace_period" | "past_due" | "canceled" | string;
  sourceTier?: BillingTierId;
  isSuperuser?: boolean;
  currentPeriodEnd: string | null;
  gracePeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  monthlyCredits?: number;
  maxConcurrentBuilds?: number;
  stripeConfigured?: boolean;
  publishableKey?: string;
  tiers?: BillingTierMeta[];
  /**
   * Ora-only plan metadata (no AI Builder features). Mobile Settings renders
   * THIS — never `tiers`, which carries Builder credits/concurrent-builds.
   */
  oraTiers?: OraTierMeta[];
}

export interface BillingTierMeta {
  id: BillingTierId;
  name: string;
  priceUsd: number;
  monthlyCredits: number;
  maxConcurrentBuilds: number;
  features: string[];
  available: boolean;
  current: boolean;
}

/**
 * Ora-only plan tier. Mirrors the server's ORA_TIERS_META / OpenAPI OraTierMeta.
 * Contains ONLY Ora features (messages, images, voice minutes, Deep Thinking,
 * support level) — never AI Builder credits, concurrent builds, build queue, or
 * Builder connectors.
 */
export interface OraTierMeta {
  id: BillingTierId;
  name: string;
  priceUsd: number;
  messageLimit: number;
  imageLimit: number;
  windowHours: number;
  voiceMinutes: number;
  deepThinking: boolean;
  features: string[];
  available: boolean;
  current?: boolean;
}

export interface PaymentMethodInfo {
  hasPaymentMethod: boolean;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  status?: "active" | "expired" | string | null;
}

export interface HelpArticle {
  id: number;
  slug?: string;
  title: string;
  body: string;
  category: string;
  tags?: string[];
  isFaq?: boolean;
  updatedAt?: string;
}

export interface SupportMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SupportConversationSummary {
  id: number;
  title: string;
  preview?: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface SupportTicketSummary {
  id: number;
  subject: string;
  category: string | null;
  status: string;
  projectId: number | null;
  attachmentCount: number;
  emailStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketDetail extends SupportTicketSummary {
  transcript: SupportMessage[];
  attachments: Array<{
    fileName: string;
    mimeType: string;
    size: number;
    url: string;
  }>;
}

// ---------------------------------------------------------------------------
// ORAX action result types
// ---------------------------------------------------------------------------

export type OraxApprovalDecision = "approved" | "denied";

export interface OraxGithubConnectResult {
  repository: OraxRepository;
}

export interface OraxReadFilesResult {
  approval: OraxTaskApproval;
  branch: string;
  files: Array<{ path: string; content: string; sha: string; size: number; truncated: boolean }>;
  skipped: Array<{ path: string; reason: string }>;
}

export interface OraxDraftPatchResult {
  artifact: OraxTaskArtifact;
}

export interface OraxApprovalWithArtifact {
  approval: OraxTaskApproval;
  artifact: OraxTaskArtifact;
  reused?: boolean;
}

export interface OraxTaskRunnerResult {
  status: "continued" | "waiting" | "blocked";
  action: string;
  message: string;
  approvalId?: number;
  artifactId?: number;
  sessionArtifactId?: number;
  approval?: OraxTaskApproval;
  artifact?: OraxTaskArtifact;
  approvals?: OraxTaskApproval[];
  artifacts?: OraxTaskArtifact[];
  runnerResults?: Array<{
    status: "continued" | "waiting" | "blocked";
    action: string;
    message: string;
    approvalId?: number;
    artifactId?: number;
    sessionArtifactId?: number;
  }>;
}

export type OraxSandboxResult = OraxApprovalWithArtifact;
export type OraxCommandResult = OraxApprovalWithArtifact;
export type OraxPRResult = OraxApprovalWithArtifact;

export interface SupportAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export type OraxHostPermissionMode =
  | "read_only"
  | "ask_everything"
  | "ask_risky"
  | "trusted_project"
  | "full_access"
  | "custom";

export interface OraxHostSummary {
  id: string;
  deviceName: string;
  platform: string;
  osVersion: string | null;
  appVersion: string | null;
  status: "online" | "offline" | "revoked";
  capabilities: Record<string, boolean>;
  permissionMode: OraxHostPermissionMode;
  lastSeenAt: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OraxPairingCode {
  code: string;
  qrPayload: string;
  expiresAt: string;
}

export interface RedeemPairingPayload {
  code: string;
  mobileDeviceId: string;
  displayName: string;
  platform: string;
}
