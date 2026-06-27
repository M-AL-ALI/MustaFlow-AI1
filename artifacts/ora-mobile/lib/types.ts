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
  OraMessageData,
} from "@workspace/ora-contracts";

import type {
  OraImage,
  OraMemoryUsed,
  OraMessageData,
  OraMode,
  OraRole,
  OraSource,
  OraTier,
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

export interface RealtimeSessionContext {
  language?: string;
  languageHint?: string;
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
}

/** Response from POST /public-ai/realtime/session — a short-lived ek_ token. */
export interface RealtimeSessionResult {
  value: string;
  expiresAt: number | null;
  model: string;
  voice: string;
  maxDurationSeconds: number;
  // Echoed back by the server so diagnostics can confirm the negotiated posture.
  focusMode?: FocusMode;
  createResponse?: boolean;
}

/** Response from GET /public-ai/realtime/diagnostics (non-charging). */
export interface RealtimeDiagnostics {
  enabled: boolean;
  configured: boolean;
  killSwitch: boolean;
  model: string;
  defaultVoice: string;
  tier: string;
  maxDurationSeconds: number;
}

export interface ChatRequest {
  message: string;
  messages: Array<{ role: OraRole; content: string }>;
  language?: string;
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
  imageUrl?: string;
  imageId?: number;
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  memoriesUsed?: OraMemoryUsed[];
  conversationSummary?: string;
  mode?: OraMode;
  msgCount?: number;
  msgLimit?: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
  windowHours?: number;
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
  truncated?: boolean;
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
  sourceConversationId: number | null;
  createdAt: string;
}

export interface OraConversationSummary {
  id: number;
  title: string;
  projectId: number | null;
  preview: string;
  lastMessageAt: string;
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

export interface OraxCapabilities {
  available: string[];
  lockedUntilApprovalLayer: string[];
}

export interface OraxRepository {
  id: number;
  owner: string;
  name: string;
  connectionStatus: "metadata_only" | "read_only";
  repositoryUrl?: string;
  defaultBranch?: string;
  scanStatus?: string;
  lastScanAt?: string | null;
}

export interface OraxTask {
  id: number;
  repositoryId?: number;
  kind?: "analyze" | "coding";
  title?: string;
  prompt?: string;
  status: string;
  result?: unknown;
  createdAt?: string;
}

export interface OraxScan {
  id: number;
  repositoryId: number;
  status: string;
  branch?: string | null;
  summary?: unknown;
  error?: string | null;
  createdAt?: string;
  completedAt?: string | null;
}

export interface OraxTaskMessage {
  id: number;
  taskId: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  event?: string | null;
  approvalId?: number | null;
  artifactId?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface OraxTaskApproval {
  id: number;
  taskId: number;
  action: string;
  status: string;
  request?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OraxTaskArtifact {
  id: number;
  taskId: number;
  approvalId?: number | null;
  type: string;
  status: string;
  title?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
  content?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

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

export type OraxSandboxResult = OraxApprovalWithArtifact;
export type OraxCommandResult = OraxApprovalWithArtifact;
export type OraxPRResult = OraxApprovalWithArtifact;

export interface SupportAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}
