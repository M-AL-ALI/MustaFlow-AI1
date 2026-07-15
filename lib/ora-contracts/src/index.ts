import { z } from "zod";

/* ── Legal sections ─────────────────────────────────────────────────────────
 * Single source of truth for the "Legal & Privacy" disclosure shown on both
 * the mobile app (LegalPrivacyModal) and the web app (Settings → Privacy tab).
 * Update here and both surfaces stay in sync automatically.
 */
export const LEGAL_SECTIONS = [
  {
    heading: "How Ora works",
    body: "Ora is an AI assistant created and powered by MustaFlow AI. Ora uses MustaFlow AI's systems to understand your requests, generate responses, analyze files and images, create content, and support voice interactions. Ora can make mistakes, so you should review important answers before relying on them.",
  },
  {
    heading: "What we collect",
    body: "Account identifiers, conversation messages, uploaded file content, generated content, usage counts, diagnostics, and support information. Voice audio may be processed in real time for Talk to Ora. Unless a feature clearly says otherwise, voice audio is not stored after processing.",
  },
  {
    heading: "Memory",
    body: "Ora can save notes you approve or enable to improve future replies. You control memory. Saved memories can be viewed, paused, restored, or deleted from the Memory screen at any time.",
  },
  {
    heading: "Service processing",
    body: "To provide Ora features, MustaFlow AI may process your messages, uploaded content, voice transcripts, generated files, images, usage data, diagnostics, and support information. Some processing may be performed through trusted infrastructure and service providers that support MustaFlow AI's systems. These providers are used only to operate, secure, improve, and deliver Ora features under applicable agreements.",
  },
  {
    heading: "Not professional advice",
    body: "Ora is not a licensed medical, legal, financial, or safety professional. Do not rely on Ora as the only source for decisions in those areas. For important decisions, consult a qualified professional.",
  },
  {
    heading: "Acceptable use",
    body: "Ora may not be used for illegal activity, harassment, abuse, creating harmful content, or attempting to bypass safety protections.",
  },
  {
    heading: "Contact",
    body: "For support or data requests, contact support@mustaflow.com.",
  },
] as const;

export type LegalSection = (typeof LEGAL_SECTIONS)[number];

/**
 * Shared Ora message + chat contracts.
 *
 * Single source of truth for the Ora chat wire shape, used by:
 *  - the API server (artifacts/api-server) for request validation and for
 *    conversation/transcript persistence, and
 *  - the Ora mobile client (artifacts/ora-mobile), which imports the TYPES ONLY
 *    (`import type`) so the zod runtime is never bundled by Metro.
 *
 * The zod schemas below mirror the persisted storage contract exactly. Do not
 * change a field, cap, or transform here without updating the server
 * persistence tests — this shape is what is written to and read from storage.
 */

/* ── Scalar unions ──────────────────────────────────────────────────────── */

export type OraRole = "user" | "assistant";
export type OraMode = "instant" | "deep";
export type OraTier = "anonymous" | "free" | "core" | "wave";
export type OraMessageKind = "image-analysis" | "document-analysis";
export type FileFormat = "csv" | "xlsx" | "docx" | "pdf" | "pptx";

/* ── Persisted sub-schemas (exact server wire contract) ─────────────────── */

/**
 * A file generated in-session. The raw base64 `fileData` is intentionally
 * stripped before persistence (it would bloat the row), so a message reloaded
 * from storage keeps the file metadata but never the bytes.
 */
export const oraGeneratedFileSchema = z
  .object({
    fileName: z.string(),
    fileData: z.string().optional(),
    mimeType: z.string(),
    format: z.string(),
    // Durable library asset id. Unlike `fileData`, this is KEPT through the
    // transform so a reloaded message can still be downloaded by fetching
    // /api/ora/assets/:id/download (signed-in users only).
    assetId: z.number().int().optional(),
  })
  .transform(({ fileData: _fileData, ...rest }) => rest);

export const oraDatasetResultSchema = z
  .object({
    summary: z.string().optional(),
    columnCount: z.number().optional(),
    rowCount: z.number().optional(),
    truncated: z.boolean().optional(),
    analysisType: z.string().optional(),
    datasetProfile: z
      .object({
        rowCount: z.number().optional(),
        colCount: z.number().optional(),
        truncated: z.boolean().optional(),
        sheetName: z.string().max(200).optional(),
      })
      .optional(),
    keyFindings: z.array(z.string().max(500)).max(10).optional(),
    recommendations: z.array(z.string().max(500)).max(10).optional(),
    actionPlan: z
      .array(
        z.object({
          action: z.string().max(500),
          priority: z.string().max(40),
          owner: z.string().max(200).optional(),
          timeline: z.string().max(200).optional(),
        }),
      )
      .max(10)
      .optional(),
    nextSteps: z.array(z.string().max(500)).max(8).optional(),
    risksAndLimitations: z.array(z.string().max(500)).max(8).optional(),
    analystWorkflow: z
      .object({
        chartSuggestions: z
          .array(
            z.object({
              title: z.string().max(200),
              chartType: z.string().max(40),
              xColumn: z.string().max(200).optional(),
              yColumn: z.string().max(200).optional(),
              groupByColumn: z.string().max(200).optional(),
              reason: z.string().max(500),
            }),
          )
          .max(5)
          .optional(),
        calculationSuggestions: z
          .array(
            z.object({
              label: z.string().max(200),
              expression: z.string().max(300),
              description: z.string().max(500),
              columns: z.array(z.string().max(200)).max(10),
            }),
          )
          .max(6)
          .optional(),
        reportSuggestions: z
          .array(
            z.object({
              title: z.string().max(200),
              format: z.string().max(20),
              description: z.string().max(500),
            }),
          )
          .max(6)
          .optional(),
      })
      .optional(),
  })
  .catchall(z.unknown())
  .transform(
    ({
      summary,
      columnCount,
      rowCount,
      truncated,
      analysisType,
      datasetProfile,
      keyFindings,
      recommendations,
      actionPlan,
      nextSteps,
      risksAndLimitations,
      analystWorkflow,
    }) => ({
      summary,
      columnCount,
      rowCount,
      truncated,
      analysisType,
      datasetProfile,
      keyFindings,
      recommendations,
      actionPlan,
      nextSteps,
      risksAndLimitations,
      analystWorkflow,
    }),
  );

export const oraSourceSchema = z.object({
  title: z.string().max(500),
  url: z.string().max(2000),
});

export const oraImageSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500).optional(),
  source: z.string().max(2000).optional(),
});

export const oraVideoSchema = z.object({
  url: z.string().max(2000),
  title: z.string().max(500).optional(),
  thumbnailUrl: z.string().max(2000).optional(),
});

/**
 * The canonical persisted Ora message schema. Mirrored byte-for-byte by both
 * the conversations store and the legacy/anonymous transcript store.
 */
export const oraMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32000),
  datasetResult: oraDatasetResultSchema.optional(),
  messageKind: z.enum(["image-analysis", "document-analysis"]).optional(),
  suggestions: z.array(z.string()).optional(),
  generatedFile: oraGeneratedFileSchema.optional(),
  hadAttachment: z.boolean().optional(),
  // Display metadata for a user's uploaded file — persisted so the attachment
  // chip stays visible in the thread after reload (never the file bytes).
  attachment: z
    .object({
      filename: z.string().max(300),
      fileType: z.string().max(120),
      isImage: z.boolean().optional(),
      isDataset: z.boolean().optional(),
    })
    .optional(),
  editedFrom: z.boolean().optional(),
  // Web-search citation cards — persisted so they survive reload.
  sources: z.array(oraSourceSchema).max(20).optional(),
  // Web-found media: real images shown inline + video link cards.
  images: z.array(oraImageSchema).max(8).optional(),
  videos: z.array(oraVideoSchema).max(6).optional(),
  // Inline image fields — imageUrl is a hosted/remote URL (never base64), so it
  // is safe to persist; imageId/editInstruction restore the editable lineage.
  imageUrl: z.string().max(4000).optional(),
  imageId: z.number().int().optional(),
  editInstruction: z.string().max(2000).optional(),
  imageMeta: z
    .object({
      kind: z.string().max(80),
      aspectRatio: z.string().max(20),
      style: z.string().max(40),
      quality: z.string().max(40),
    })
    .optional(),
  memorySaveCandidate: z.string().max(400).optional(),
  memorySaveCandidateConfidence: z.enum(["high", "low"]).optional(),
  memorySaveCandidateSensitive: z.boolean().optional(),
  memorySaved: z.boolean().optional(),
  // Titles of earlier memories this save replaced — persisted so the inline
  // "Updated your memory" note survives reload.
  memorySupersededTitles: z.array(z.string().max(200)).max(20).optional(),
  // Saved Ora memories that shaped this reply (Ora-scoped only) — persisted so
  // the "based on your saved memories" indicator survives reload.
  memoriesUsed: z
    .array(z.object({ id: z.number().int(), title: z.string().max(200) }))
    .max(30)
    .optional(),
});

/** Post-transform persisted message type (bytes stripped from generatedFile). */
export type OraPersistedMessage = z.infer<typeof oraMessageSchema>;

/* ── Client-facing rich types ───────────────────────────────────────────── */

export interface OraSource {
  title: string;
  url: string;
}

/** A real image found on the web during search, shown inline in the chat. */
export interface OraImage {
  url: string;
  title?: string;
  /** The page the image was found on, so the user can verify the context. */
  source?: string;
}

/** A relevant video found on the web during search, shown as a link card. */
export interface OraVideo {
  url: string;
  title?: string;
  thumbnailUrl?: string;
}

/** A saved Ora memory that shaped a reply (Ora-scoped only). */
export interface OraMemoryUsed {
  id: number;
  title: string;
}

/** Display metadata for a user's uploaded file (never the bytes). */
export interface OraAttachmentMeta {
  filename: string;
  fileType: string;
  isImage?: boolean;
  isDataset?: boolean;
}

/** Lightweight dataset-analysis summary surfaced inline with a reply. */
export interface OraDatasetChartSuggestion {
  title: string;
  chartType: string;
  xColumn?: string;
  yColumn?: string;
  groupByColumn?: string;
  reason: string;
}

export interface OraDatasetCalculationSuggestion {
  label: string;
  expression: string;
  description: string;
  columns: string[];
}

export interface OraDatasetReportSuggestion {
  title: string;
  format: string;
  description: string;
}

export interface OraDatasetAnalystWorkflow {
  chartSuggestions?: OraDatasetChartSuggestion[];
  calculationSuggestions?: OraDatasetCalculationSuggestion[];
  reportSuggestions?: OraDatasetReportSuggestion[];
}

export interface OraDatasetResult {
  summary?: string;
  columnCount?: number;
  rowCount?: number;
  truncated?: boolean;
  analysisType?: string;
  datasetProfile?: {
    rowCount?: number;
    colCount?: number;
    truncated?: boolean;
    sheetName?: string;
  };
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
  analystWorkflow?: OraDatasetAnalystWorkflow;
  [key: string]: unknown;
}

/**
 * A file generated in-session. `fileData` (base64 bytes) is present only for an
 * in-session file; messages reloaded from storage carry the metadata without
 * bytes, so download cards must guard on `fileData` being present.
 */
export interface GeneratedFile {
  fileName: string;
  fileData?: string;
  mimeType: string;
  format: FileFormat;
  /**
   * Durable library asset id. Present for files generated while signed in.
   * Survives persistence (bytes do not), so a reloaded message can still be
   * downloaded via /api/ora/assets/:id/download when `fileData` is absent.
   */
  assetId?: number;
}

/**
 * The full persistable Ora message data (input side of `oraMessageSchema`),
 * shared by web and mobile so both render an identical message model. Client
 * runtimes layer their own ephemeral fields (id, pending, streaming, ...) on
 * top of this base.
 */
export interface OraMessageData {
  role: OraRole;
  content: string;
  datasetResult?: OraDatasetResult;
  messageKind?: OraMessageKind;
  suggestions?: string[];
  generatedFile?: GeneratedFile;
  hadAttachment?: boolean;
  attachment?: OraAttachmentMeta;
  editedFrom?: boolean;
  sources?: OraSource[];
  images?: OraImage[];
  videos?: OraVideo[];
  imageUrl?: string;
  imageId?: number;
  editInstruction?: string;
  imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  memorySaved?: boolean;
  memorySupersededTitles?: string[];
  memoriesUsed?: OraMemoryUsed[];
}

/* ── Account consistency diagnostics ───────────────────────────────────────── */

/**
 * A single "latest" row in the account-consistency snapshot. Carries an id, a
 * short human label (conversation title / project name / memory title), and a
 * timestamp only — never message or memory content.
 */
export interface OraAccountConsistencyLatest {
  id: number;
  label: string | null;
  at: string | null;
}

/**
 * Privacy-safe, owner-scoped account diagnostics returned by
 * GET /api/ora/account-consistency. Shared by the API server (response shape),
 * the Ora mobile client (TYPE-only import), and the website Settings panel so
 * all three confirm the SAME Clerk user resolves to the same server-side
 * identity, billing tier, chat tier, and per-user counts on every surface.
 *
 * Never contains a raw user id, message/memory content, or asset bytes/keys.
 */
export interface OraAccountConsistency {
  identity: {
    /** First 12 hex chars of sha256(userId) — a stable fingerprint, not the id. */
    userIdHash: string;
    /** Last 4 chars of the Clerk user id (null when shorter than 4). */
    clerkUserIdLast4: string | null;
    /** The signed-in user's own email, when Clerk resolves it. */
    email: string | null;
  };
  api: {
    environment: string;
    host: string | null;
  };
  billing: {
    /** Effective tier after subscription status + superuser fallback. */
    billingTier: string;
    /** Raw subscription tier on file ("free" when no subscription row). */
    sourceTier: string;
    status: string | null;
    isSuperuser: boolean;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  chatSession: {
    /** Effective tier the chat path uses — always equals billing.billingTier. */
    tier: string;
    isPaid: boolean;
    messageLimit: number;
    imageLimit: number;
    resetsAt: string | null;
  };
  counts: {
    conversations: number;
    projects: number;
    userLevelMemories: number;
    projectMemories: number;
    assets: number;
    supportTickets: number;
  };
  latest: {
    conversation: OraAccountConsistencyLatest | null;
    project: OraAccountConsistencyLatest | null;
    memory: OraAccountConsistencyLatest | null;
  };
  checkedAt: string;
}
