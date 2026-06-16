/**
 * Shared types for the MustaFlow mobile client. These mirror the response
 * shapes of the EXISTING production API (artifacts/api-server) — they are not a
 * new contract. Keep field names in sync with the web Ora experience.
 */

export type OraMode = "instant" | "deep";
export type OraTier = "free" | "core" | "wave";

export type OraRole = "user" | "assistant";

export interface OraSource {
  title: string;
  url: string;
}

export interface OraGeneratedFile {
  fileName: string;
  fileData: string; // base64
  mimeType: string;
}

export interface OraMessage {
  id: string;
  role: OraRole;
  content: string;
  createdAt?: string;
  sources?: OraSource[];
  imageUrl?: string;
  imageId?: number;
  file?: OraGeneratedFile;
  pending?: boolean;
  error?: boolean;
  /** True while this assistant message is still being streamed token-by-token. */
  isStreaming?: boolean;
}

/**
 * Payload carried by the SSE `done` event from /api/public-ai/chat/stream.
 * Mirrors the shape the backend stream-adapter emits.
 */
export interface StreamDonePayload {
  reply: string;
  sources?: OraSource[];
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  imageUrl?: string;
  imageId?: number;
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

export interface ChatRequest {
  message: string;
  messages: Array<{ role: OraRole; content: string }>;
  language?: string;
  mode: OraMode;
  referenceSavedMemories: boolean;
  referenceChatHistory: boolean;
}

export interface ChatResponse {
  reply: string;
  sources?: OraSource[];
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  imageUrl?: string;
  imageId?: number;
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  msgCount?: number;
  msgLimit?: number;
  imageCount?: number;
  imageLimit?: number;
  resetsAt?: string | null;
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

export interface UserPreferences {
  userId?: string;
  dismissedOnboarding?: boolean;
  preferredMode?: "builder" | "developer" | "ora";
  voiceLang?: string;
  autoReadReplies?: boolean;
}

export interface BillingSubscription {
  userId: string;
  tier: OraTier;
  status: "active" | "canceled";
  currentPeriodEnd: string;
}
