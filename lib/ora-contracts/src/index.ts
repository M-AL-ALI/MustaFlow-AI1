import { z } from "zod";

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
  })
  .transform(({ fileData: _fileData, ...rest }) => rest);

export const oraDatasetResultSchema = z
  .object({
    summary: z.string().optional(),
    columnCount: z.number().optional(),
    rowCount: z.number().optional(),
    truncated: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .transform(({ summary, columnCount, rowCount, truncated }) => ({
    summary,
    columnCount,
    rowCount,
    truncated,
  }));

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
export interface OraDatasetResult {
  summary?: string;
  columnCount?: number;
  rowCount?: number;
  truncated?: boolean;
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
  memorySaveCandidate?: string;
  memorySaveCandidateConfidence?: "high" | "low";
  memorySaveCandidateSensitive?: boolean;
  memorySaved?: boolean;
  memorySupersededTitles?: string[];
  memoriesUsed?: OraMemoryUsed[];
}
