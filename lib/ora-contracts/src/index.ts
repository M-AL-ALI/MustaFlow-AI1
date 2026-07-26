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

/* Fresh-start-on-return
 * Shared policy for the website and mobile Ora clients. Conversation history
 * and the server-synced lastConversationId remain durable; this policy only
 * decides whether a client should auto-open that saved conversation.
 */

/** Return within this window to keep the currently selected conversation. */
export const IDLE_RESET_MS = 5 * 60 * 1000;

/** Visible clients refresh this timestamp often enough to survive abrupt exits. */
export const ORA_ACTIVE_HEARTBEAT_MS = 30 * 1000;

/** Shared storage key (localStorage on web, AsyncStorage on mobile). */
export const ORA_LAST_ACTIVE_AT_STORAGE_KEY = "ora:last-active-at";

/** Number of recent conversations shown before the user expands the home list. */
export const ORA_HOME_RECENT_LIMIT = 5;

/** Whether a saved conversation may auto-resume at `nowMs`. */
export function shouldResumeOraConversation(
  lastActiveAt: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (
    typeof lastActiveAt !== "number" ||
    !Number.isFinite(lastActiveAt) ||
    lastActiveAt <= 0 ||
    !Number.isFinite(nowMs)
  ) {
    return false;
  }
  // A backwards clock adjustment should not unexpectedly discard the user's
  // place. Clamp negative elapsed time to zero and allow the short resume.
  const elapsedMs = Math.max(0, nowMs - lastActiveAt);
  return elapsedMs <= IDLE_RESET_MS;
}

export interface OraHomeRecentConversationLike {
  id: number;
  projectId: number | null;
  lastMessageAt: string;
  archivedAt?: string | null;
}

/**
 * Return active conversations newest-first. A project home is scoped to that
 * project; standalone Ora may show recents from every project.
 */
export function sortOraHomeRecentConversations<T extends OraHomeRecentConversationLike>(
  conversations: readonly T[],
  activeProjectId: number | null,
): T[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.archivedAt == null &&
        (activeProjectId == null || conversation.projectId === activeProjectId),
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.lastMessageAt);
      const rightTime = Date.parse(right.lastMessageAt);
      const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
      const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
      return safeRight - safeLeft || right.id - left.id;
    });
}

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

/* ── Live activity trace ────────────────────────────────────────────────────
 * Single source of truth for the Ora activity trace: the animated, step-by-step
 * "what Ora is doing right now" line shown while a reply is being prepared
 * (web search, file generation, image generation, repo analysis, file reading).
 *
 * The server emits `{ type: "activity", phase, tool, text }` frames on the
 * existing SSE stream (an extension of the `status` event — same channel), and
 * both clients synthesize the same steps for the non-streaming specialist-tool
 * paths. ALL human-visible wording lives here so the website and mobile app
 * always show byte-identical copy for the same tool + phase.
 *
 * Wording rules: present-continuous while running ("Searching the web…"),
 * short on success, honest on failure. NEVER include provider names, model
 * ids, stack traces, or filesystem paths in activity text.
 */

export const ORA_ACTIVITY_TOOLS = [
  "web-search",
  "file-generation",
  "image-generation",
  "repo-analysis",
  "file-reading",
  "dataset-analysis",
] as const;

export type OraActivityTool = (typeof ORA_ACTIVITY_TOOLS)[number];

export const ORA_ACTIVITY_PHASES = ["start", "ok", "fail"] as const;

export type OraActivityPhase = (typeof ORA_ACTIVITY_PHASES)[number];

/** One step of the live activity trace (tool + lifecycle phase + human line). */
export interface OraActivityStep {
  tool: OraActivityTool;
  phase: OraActivityPhase;
  text: string;
}

/** The SSE wire shape: an OraActivityStep tagged with the event type. */
export interface OraActivityEvent extends OraActivityStep {
  type: "activity";
}

/** Default copy per tool + phase — the branded, user-friendly voice. */
export const ORA_ACTIVITY_TEXT: Record<OraActivityTool, Record<OraActivityPhase, string>> = {
  "web-search": {
    start: "Searching the web…",
    ok: "Search complete",
    fail: "Web search failed — answering from what I know",
  },
  "file-generation": {
    start: "Generating your file…",
    ok: "File ready",
    fail: "File generation failed — continuing",
  },
  "image-generation": {
    start: "Creating your image…",
    ok: "Image ready",
    fail: "Image generation failed — continuing",
  },
  "repo-analysis": {
    start: "Reading the repository…",
    ok: "Repository analysis complete",
    fail: "Couldn't finish reading the repository — continuing",
  },
  "file-reading": {
    start: "Reading your file…",
    ok: "Finished reading",
    fail: "Couldn't read that file — continuing",
  },
  "dataset-analysis": {
    start: "Analyzing your data…",
    ok: "Analysis complete",
    fail: "Dataset analysis failed — continuing",
  },
};

/** Resolve the shared copy for a tool + phase. */
export function oraActivityText(tool: OraActivityTool, phase: OraActivityPhase): string {
  return ORA_ACTIVITY_TEXT[tool][phase];
}

/** Build an activity step, defaulting the text to the shared copy. */
export function oraActivityStep(
  tool: OraActivityTool,
  phase: OraActivityPhase,
  text?: string,
): OraActivityStep {
  return { tool, phase, text: text?.trim() ? text : oraActivityText(tool, phase) };
}

/** "Found N sources" — the web-search success line (source-count aware). */
export function oraWebSearchOkText(sourceCount: number): string {
  if (!Number.isFinite(sourceCount) || sourceCount <= 0) return ORA_ACTIVITY_TEXT["web-search"].ok;
  return sourceCount === 1 ? "Found 1 source" : `Found ${sourceCount} sources`;
}

/** "Reading report.docx…" — name-aware document-reading line. */
export function oraReadingFileText(fileName: string): string {
  const name = fileName.trim();
  return name ? `Reading ${name}…` : ORA_ACTIVITY_TEXT["file-reading"].start;
}

/** "Analyzing sales.xlsx…" — name-aware dataset-analysis line. */
export function oraAnalyzingDatasetText(fileName: string): string {
  const name = fileName.trim();
  return name ? `Analyzing ${name}…` : ORA_ACTIVITY_TEXT["dataset-analysis"].start;
}

/** "Analyzing your image…" — image-analysis line (never echoes the file name). */
export const ORA_ANALYZING_IMAGE_TEXT = "Analyzing your image…";

/**
 * Map the server's routed-tool ids (as carried on the streamingFallback JSON
 * signal: "search" | "file_generation" | "image_generation" | "image_editing"
 * | "dataset_analysis") to an activity tool, so clients can show the right
 * "start" step while the non-streaming /chat specialist branch runs. Unknown
 * tools → null (no trace).
 */
export function oraActivityToolForRoutedTool(tool: string | undefined): OraActivityTool | null {
  switch (tool) {
    case "search":
      return "web-search";
    case "file_generation":
      return "file-generation";
    case "image_generation":
    case "image_editing":
      return "image-generation";
    case "dataset_analysis":
      return "dataset-analysis";
    default:
      return null;
  }
}

/**
 * Validate an unknown parsed SSE `data:` payload as an activity step.
 * Hand-rolled (no zod) so the mobile bundle stays slim; returns null for
 * anything malformed so a bad frame can never break the stream loop.
 */
export function parseOraActivityStep(value: unknown): OraActivityStep | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { tool?: unknown; phase?: unknown; text?: unknown };
  if (!(ORA_ACTIVITY_TOOLS as readonly string[]).includes(v.tool as string)) return null;
  if (!(ORA_ACTIVITY_PHASES as readonly string[]).includes(v.phase as string)) return null;
  if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > 300) return null;
  return { tool: v.tool as OraActivityTool, phase: v.phase as OraActivityPhase, text: v.text };
}

/* ── Scalar unions ──────────────────────────────────────────────────────── */

export type OraRole = "user" | "assistant";
export type OraMode = "instant" | "deep";
export type OraTier = "anonymous" | "free" | "core" | "wave";
export type OraMessageKind = "image-analysis" | "document-analysis";
export type FileFormat = "csv" | "xlsx" | "docx" | "pdf" | "pptx";

/* ── Persisted sub-schemas (exact server wire contract) ─────────────────── */

/**
 * How a file response relates to the user's uploaded original:
 *  - `original_edited`  — the uploaded package was edited in place (layout kept)
 *  - `unchanged`        — the original was returned without modification
 *  - `redesigned`       — a brand-new file was generated instead of editing
 *  - `failed_safe`      — the edit could not be applied safely; original kept
 */
export type OraFileEditMode = "original_edited" | "unchanged" | "redesigned" | "failed_safe";

/**
 * Structured edit-quality metadata attached to a generated-file response when
 * the request involved an uploaded source file. Rendered as a quality card on
 * both website and mobile, and persisted with the message (bytes are not).
 */
export const oraFileEditQualitySchema = z.object({
  editMode: z.enum(["original_edited", "unchanged", "redesigned", "failed_safe"]),
  /** Human-readable list of applied changes, e.g. `Replaced: "A" → "B"`. */
  changes: z.array(z.string().max(300)).max(20).optional(),
  originalFileName: z.string().max(300).optional(),
  outputFileName: z.string().max(300).optional(),
  /** Source file extension, e.g. "docx" | "pptx" | "xlsx". */
  sourceFileType: z.string().max(20).optional(),
  preservedLayout: z.boolean().optional(),
  /**
   * The persisted library asset id of this saved version. Clients can open
   * revision history (`GET /api/ora/assets/:id/versions`) directly from it.
   * Only present for signed-in users whose edited file was persisted.
   */
  versionId: z.number().int().optional(),
  canRedesign: z.boolean().optional(),
  warning: z.string().max(500).optional(),
});

export type OraFileEditQuality = z.infer<typeof oraFileEditQualitySchema>;

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
    // Edit-quality card metadata — KEPT through the transform so the quality
    // card survives conversation reload on both website and mobile.
    editQuality: oraFileEditQualitySchema.optional(),
  })
  .transform(({ fileData: _fileData, ...rest }) => rest);

export const oraFileAgentPreviewSchema = z.object({
  kind: z.enum(["file_edit", "file_generation", "data_analysis", "report_export"]),
  status: z.enum(["applied", "planned", "unchanged", "failed_safe", "needs_confirmation"]),
  title: z.string().max(120),
  summary: z.string().max(500).optional(),
  detectedInputs: z.array(z.string().max(180)).max(8).optional(),
  plannedActions: z.array(z.string().max(180)).max(8).optional(),
  calculations: z.array(z.string().max(180)).max(8).optional(),
  charts: z.array(z.string().max(180)).max(8).optional(),
  outputSections: z.array(z.string().max(180)).max(10).optional(),
  assumptions: z.array(z.string().max(220)).max(6).optional(),
  safetyNotes: z.array(z.string().max(220)).max(6).optional(),
  canApply: z.boolean().optional(),
  canRedesign: z.boolean().optional(),
  /**
   * Specific content-level changes extracted from the user's message.
   * Shown as before→after pairs in the preview card so the user can see
   * exactly what will change before confirming.
   */
  contentChanges: z
    .array(
      z.object({
        label: z.string().max(120),
        from: z.string().max(300).optional(),
        to: z.string().max(300).optional(),
      }),
    )
    .max(5)
    .optional(),
});

export type OraFileAgentPreview = z.infer<typeof oraFileAgentPreviewSchema>;

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
    fileAgentPreview: oraFileAgentPreviewSchema.optional(),
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
      fileAgentPreview,
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
      fileAgentPreview,
    }),
  );

export const oraSourceSchema = z.object({
  title: z.string().max(500),
  url: z.string().max(2000),
  /** Publication/last-updated date reported by the search provider (display string). */
  date: z.string().max(40).optional(),
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
 * Why Ora asked a clarifying question instead of executing an ambiguous
 * uploaded-file edit. Static enum values only — safe for diagnostics.
 */
export const ORA_CLARIFICATION_KINDS = [
  "vague_file_edit", // "make this better" — no concrete instruction
  "multi_file_source", // several uploads, source file for the edit unclear
  "unclear_replacement_target", // "change the pricing section" — no target text
  "missing_edit_instruction", // "return it after modification" — no modification stated
  "ambiguous_target_file", // two+ same-format uploads, edit target file unclear
  "file_edit_preview_confirmation", // risky/requested file edit preview awaiting Apply/Redesign
] as const;

export type OraClarificationKind = (typeof ORA_CLARIFICATION_KINDS)[number];

/**
 * Phase 5 — Multi-File Intelligence. The role each uploaded file played in a
 * multi-file turn (data source feeding a deck, one side of a comparison, ...).
 * Static enum values only — safe for diagnostics and persistence.
 */
export const ORA_MULTI_FILE_ROLES = [
  "source_data", // spreadsheet/CSV feeding an update
  "target_document", // the DOCX/PDF being updated
  "target_presentation", // the PPTX being updated
  "comparison_a", // first side of a comparison
  "comparison_b", // second side of a comparison
  "merge_input", // one of several files being merged/combined
  "reference", // consulted as context (summaries, archive reports)
] as const;

export type OraMultiFileRole = (typeof ORA_MULTI_FILE_ROLES)[number];

/**
 * "Working from" chip metadata: which uploaded file was used in which role on
 * a multi-file turn. Names only — never refs, bytes, or content.
 */
export const oraUsedFileSchema = z.object({
  name: z.string().max(300),
  role: z.enum(ORA_MULTI_FILE_ROLES),
});

export type OraUsedFile = z.infer<typeof oraUsedFileSchema>;

/**
 * Phase 8 — Source-Aware Answers. The kind of location inside an uploaded
 * file a reply cited. Static enum values only — safe for persistence.
 */
export const ORA_FILE_CITATION_KINDS = [
  "slide", // PPTX slide number ("Slide 3")
  "sheet", // spreadsheet sheet name
  "section", // document section/heading (reserved; DOCX/PDF extract flat text today)
  "file", // whole-file reference (no finer locator available)
] as const;

export type OraFileCitationKind = (typeof ORA_FILE_CITATION_KINDS)[number];

/**
 * A verified citation of an uploaded file beneath an assistant reply.
 * Derived server-side by cross-checking the reply text against the file
 * content actually injected into the model's context — never model-claimed,
 * so a citation can only exist for a file/slide/sheet that is really there.
 * Names and locators only — never refs, bytes, or content.
 */
export const oraFileCitationSchema = z.object({
  file: z.string().max(300),
  /** Human-readable locator inside the file, e.g. "Slide 3" or a sheet name. */
  locator: z.string().max(120).optional(),
  kind: z.enum(ORA_FILE_CITATION_KINDS).optional(),
});

export type OraFileCitation = z.infer<typeof oraFileCitationSchema>;

/**
 * The pending-task context a clarification round-trips through the CLIENT
 * (the server is stateless per turn). Returned on a clarification response,
 * echoed back as `pendingClarification` on the user's next send, and merged
 * server-side with the answer so the original task continues.
 */
export const oraPendingClarificationSchema = z.object({
  /** The original ambiguous request (re-validated server-side on echo). */
  originalMessage: z.string().min(1).max(4000),
  kind: z.enum(ORA_CLARIFICATION_KINDS),
  /** Output format inferred at ask time, so continuation doesn't re-infer. */
  inferredFileFormat: z.enum(["csv", "xlsx", "docx", "pdf", "pptx"]).nullable().optional(),
});

export type OraPendingClarification = z.infer<typeof oraPendingClarificationSchema>;

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
  // Clarifying-question state — persisted so a pending clarification survives
  // reload and the client can re-arm the continuation context.
  needsClarification: z.boolean().optional(),
  clarificationKind: z.enum(ORA_CLARIFICATION_KINDS).optional(),
  pendingTaskContext: oraPendingClarificationSchema.optional(),
  // Multi-file turns: which uploads were used in which role — persisted so the
  // "working from" chips survive reload. Mirrors the client documentRefs cap.
  usedFiles: z.array(oraUsedFileSchema).max(5).optional(),
  // Phase 8: verified uploaded-file citations (file + slide/sheet locator) —
  // persisted so the source chips survive reload.
  fileCitations: z.array(oraFileCitationSchema).max(10).optional(),
  // Phase 9A: file/data agent preview metadata. Display-only, never file bytes.
  fileAgentPreview: oraFileAgentPreviewSchema.optional(),
});

/** Post-transform persisted message type (bytes stripped from generatedFile). */
export type OraPersistedMessage = z.infer<typeof oraMessageSchema>;

/* ── Client-facing rich types ───────────────────────────────────────────── */

export interface OraSource {
  title: string;
  url: string;
  /** Publication/last-updated date reported by the search provider (display string). */
  date?: string;
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
  fileAgentPreview?: OraFileAgentPreview;
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
  /**
   * Edit-quality card metadata, present when the response relates to an
   * uploaded source file. Survives persistence so the card renders on reload.
   */
  editQuality?: OraFileEditQuality;
}

/**
 * Realtime function tools exposed to "Talk to Ora". This is the complete
 * voice-side capability surface: one search tool, five read-only repository
 * tools, and the existing Ora file/image/report engines. Keep this list shared
 * so the API, website, mobile app, and safety tests cannot drift.
 */
export const ORA_REALTIME_TOOL_NAMES = [
  "web_search",
  "list_files",
  "read_file",
  "search_repo",
  "read_commits",
  "diff",
  "generate_file",
  "generate_image",
  "analyze_repo",
] as const;

export type OraRealtimeToolName = (typeof ORA_REALTIME_TOOL_NAMES)[number];

/** Shared activity category for each realtime function tool. */
export const ORA_REALTIME_TOOL_ACTIVITY: Record<OraRealtimeToolName, OraActivityTool> = {
  web_search: "web-search",
  list_files: "repo-analysis",
  read_file: "repo-analysis",
  search_repo: "repo-analysis",
  read_commits: "repo-analysis",
  diff: "repo-analysis",
  generate_file: "file-generation",
  generate_image: "image-generation",
  analyze_repo: "repo-analysis",
};

export function oraRealtimeToolActivity(name: OraRealtimeToolName): OraActivityTool {
  return ORA_REALTIME_TOOL_ACTIVITY[name];
}

/** Metadata marker used for out-of-band spoken tool narration responses. */
export const ORA_REALTIME_TOOL_NARRATION_PURPOSE = "ora_tool_narration";
export const ORA_REALTIME_TOOL_NARRATION_TIMEOUT_MS = 4_000;

/**
 * Build a short, out-of-band audio response before a realtime tool runs.
 * It uses the shared activity wording, cannot call another tool, and does not
 * pollute the user's conversation history.
 */
export function buildOraRealtimeToolNarrationEvent(
  callId: string,
  toolName: OraRealtimeToolName,
): Record<string, unknown> {
  const text = ORA_ACTIVITY_TEXT[oraRealtimeToolActivity(toolName)].start;
  return {
    type: "response.create",
    response: {
      conversation: "none",
      output_modalities: ["audio"],
      tools: [],
      tool_choice: "none",
      max_output_tokens: 64,
      metadata: {
        purpose: ORA_REALTIME_TOOL_NARRATION_PURPOSE,
        tool_call_id: callId,
      },
      input: [
        {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `Say exactly this one short status sentence and nothing else: "${text}"`,
            },
          ],
        },
      ],
    },
  };
}

/** Return the tool call id only for Ora's out-of-band narration responses. */
export function parseOraRealtimeToolNarrationCallId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const response =
    event.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>)
      : null;
  const metadata =
    response?.metadata && typeof response.metadata === "object"
      ? (response.metadata as Record<string, unknown>)
      : null;
  if (metadata?.purpose !== ORA_REALTIME_TOOL_NARRATION_PURPOSE) return null;
  return typeof metadata.tool_call_id === "string" && metadata.tool_call_id
    ? metadata.tool_call_id
    : null;
}

/** Shared web/native recovery policy for one continuous Talk to Ora session. */
export const ORA_REALTIME_RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
export const ORA_REALTIME_RECONNECT_MAX_ATTEMPTS = 6;

export interface OraRealtimeClientCapabilities {
  realtimeFunctionBridge?: number;
  realtimeToolNarration?: number;
}

export const ORA_REALTIME_CURRENT_CLIENT_CAPABILITIES: Readonly<
  Required<OraRealtimeClientCapabilities>
> = {
  realtimeFunctionBridge: 1,
  realtimeToolNarration: 1,
};

export function oraRealtimeClientNarratesTools(
  capabilities: OraRealtimeClientCapabilities | null | undefined,
): boolean {
  return (capabilities?.realtimeToolNarration ?? 0) >= 1;
}

/** Selected read-only GitHub repository carried into a live voice session. */
export interface OraRealtimeRepoContext {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch?: string;
}

/** The active file revision target carried into a live voice session. */
export interface OraRealtimeActiveArtifact {
  assetId: number;
  fileName: string;
  format: FileFormat;
}

/**
 * A durable written result produced while voice is active. The spoken reply can
 * stay concise while this richer payload is inserted into the normal chat
 * thread for reading, copying, downloading, or later revision.
 */
export interface OraRealtimeToolWrittenResult {
  content: string;
  sources?: OraSource[];
  usedFiles?: OraUsedFile[];
  generatedFile?: GeneratedFile;
  imageUrl?: string;
  imageId?: number;
  imageMeta?: { kind: string; aspectRatio: string; style: string; quality: string };
}

/** Privacy-safe response from the authenticated realtime function-call bridge. */
export interface OraRealtimeToolBridgeResponse {
  ok: boolean;
  /** Stable privacy-safe outcome code for UI, telemetry, and retry decisions. */
  code?: OraRealtimeToolResultCode;
  /** Tool output returned to the realtime model as function_call_output. */
  output: string;
  /** Shared branded activity copy; never contains provider/model/path internals. */
  activity: OraActivityStep;
  /** Optional rich result mirrored into the visible chat thread. */
  writtenResult?: OraRealtimeToolWrittenResult;
  /** True means the live session should continue even when `ok` is false. */
  recoverable: true;
}

export const ORA_REALTIME_TOOL_RESULT_CODES = [
  "ok",
  "invalid_arguments",
  "not_signed_in",
  "github_not_connected",
  "repo_not_resolved",
  "no_code_analyzed",
  "repo_read_failed",
  "temporarily_unavailable",
  "quota_reached",
  "tool_failed",
] as const;

export type OraRealtimeToolResultCode = (typeof ORA_REALTIME_TOOL_RESULT_CODES)[number];

/** Normalized function call emitted by the GA Realtime data channel. */
export interface OraRealtimeFunctionCall {
  callId: string;
  name: OraRealtimeToolName;
  argumentsJson: string;
}

function isOraRealtimeToolName(value: unknown): value is OraRealtimeToolName {
  return (
    typeof value === "string" && (ORA_REALTIME_TOOL_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Parse GA function-call completion event shapes. Realtime clients use this one
 * helper so browser and native never disagree about event names or fields.
 * Malformed/unknown calls return null and cannot break the live session.
 */
export function parseOraRealtimeFunctionCallEvent(value: unknown): OraRealtimeFunctionCall | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;

  if (event.type === "response.function_call_arguments.done") {
    const callId =
      typeof event.call_id === "string"
        ? event.call_id
        : typeof event.item_id === "string"
          ? event.item_id
          : "";
    const name = event.name;
    const argumentsJson = typeof event.arguments === "string" ? event.arguments : "{}";
    if (!callId || !isOraRealtimeToolName(name)) return null;
    return { callId, name, argumentsJson };
  }

  if (event.type === "response.output_item.done") {
    const item =
      event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
    if (!item || item.type !== "function_call") return null;
    const callId =
      typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "";
    const name = item.name;
    const argumentsJson = typeof item.arguments === "string" ? item.arguments : "{}";
    if (!callId || !isOraRealtimeToolName(name)) return null;
    return { callId, name, argumentsJson };
  }

  if (event.type === "response.done") {
    const response =
      event.response && typeof event.response === "object"
        ? (event.response as Record<string, unknown>)
        : null;
    const output = response && Array.isArray(response.output) ? response.output : [];
    for (const rawItem of output) {
      const item =
        rawItem && typeof rawItem === "object" ? (rawItem as Record<string, unknown>) : null;
      if (!item || item.type !== "function_call") continue;
      const callId =
        typeof item.call_id === "string"
          ? item.call_id
          : typeof item.id === "string"
            ? item.id
            : "";
      const name = item.name;
      const argumentsJson = typeof item.arguments === "string" ? item.arguments : "{}";
      if (callId && isOraRealtimeToolName(name)) {
        return { callId, name, argumentsJson };
      }
    }
  }

  return null;
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
  /** True when this assistant turn is a clarifying question for an ambiguous
   * uploaded-file edit; the client echoes `pendingTaskContext` back as
   * `pendingClarification` on the next send so the original task continues. */
  needsClarification?: boolean;
  clarificationKind?: OraClarificationKind;
  pendingTaskContext?: OraPendingClarification;
  /** Multi-file turns: which uploads were used in which role ("working from"
   * chips). Names + roles only — never refs or content. */
  usedFiles?: OraUsedFile[];
  /** Phase 8: verified uploaded-file citations (file + slide/sheet locator),
   * derived server-side against the actually-injected file content. */
  fileCitations?: OraFileCitation[];
  /** Phase 9A: display-only file/data agent preview metadata. */
  fileAgentPreview?: OraFileAgentPreview;
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
