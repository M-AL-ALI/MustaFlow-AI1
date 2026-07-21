import type { OraMultiFileRole, OraUsedFile } from "@workspace/ora-contracts";
import type { CarriedFileMeta } from "./carried-docs.js";
import type { OraTool } from "./orchestrator.js";
import type { FileFormat } from "./prompt.js";
import { detectFileRequest } from "./prompt.js";

/**
 * Phase 5 — Multi-File Intelligence.
 *
 * Deterministic, pre-LLM planner that recognizes cross-file workflows over
 * the files uploaded this conversation (data → deck updates, comparisons,
 * merges, collection summaries, archive reports), assigns each file a role,
 * and steers execution:
 *
 *  - `targetFileRef` pins the in-place Office edit engine to the RIGHT file
 *    (its latest revision head) instead of "first ref matching the format".
 *  - `toolOverride: "answer"` re-routes compare-style asks that the router
 *    sent to file_generation but that want an analysis reply, not a download.
 *  - `directive` is a compact task block injected into the model prompt so
 *    generation/answers use each file in its planned role.
 *  - `usedFiles` is the client-facing "working from" metadata (names + roles
 *    only — never refs or content).
 *
 * Runs AFTER resolveFinalOraRoute (never fights image/search/ZIP escapes) and
 * BEFORE checkToolAccess/quota. Both `answer` and `file_generation` draw on
 * the same message quota bucket, so the answer override never changes what a
 * turn costs. Single-file turns (fewer than 2 resolved uploads) always return
 * null — existing behavior is untouched.
 */

export type OraMultiFileWorkflow =
  | "data_to_presentation" // xlsx/csv feeding a PPTX update
  | "data_to_document" // xlsx/csv feeding a DOCX/PDF update
  | "compare_documents"
  | "compare_spreadsheets"
  | "merge_documents"
  | "combine_spreadsheets"
  | "summarize_collection"
  | "archive_report";

export interface OraMultiFilePlanFile {
  fileRef: string;
  filename: string;
  role: OraMultiFileRole;
}

export interface OraMultiFilePlan {
  workflow: OraMultiFileWorkflow;
  files: OraMultiFilePlanFile[];
  /** The file the in-place edit engine should target (null when N/A). */
  targetFileRef: string | null;
  /** Explicit output format implied by the workflow (null = router's call). */
  outputFormat: FileFormat | null;
  /** "answer": compare-analysis reply instead of a generated file. */
  toolOverride: "answer" | null;
  /** Compact task block injected into the model prompt. */
  directive: string;
  /** Client-facing "working from" chips (names + roles only). */
  usedFiles: OraUsedFile[];
}

export interface OraMultiFilePlanInput {
  /** The ROUTED message (post-clarification-continuation merge). */
  message: string;
  /** Resolved carried-file metadata, in upload order (oldest → newest). */
  files: CarriedFileMeta[];
  /** decision.tool AFTER resolveFinalOraRoute. */
  finalTool: OraTool;
}

/* ── File-family classification ─────────────────────────────────────────── */

const DATA_FILE_PATTERN = /\.(?:xlsx?|csv|tsv)$/i;
const PRESENTATION_FILE_PATTERN = /\.(?:pptx?|ppsx?)$/i;
const TEXT_DOCUMENT_PATTERN = /\.(?:docx?|pdf|txt|md|rtf)$/i;
const ARCHIVE_FILE_PATTERN = /\.(?:zip|tar|tgz|gz|7z)$/i;

function isDataFile(f: CarriedFileMeta): boolean {
  return f.rawFileType === "xlsx" || f.isDataset || DATA_FILE_PATTERN.test(f.filename);
}

function isPresentationFile(f: CarriedFileMeta): boolean {
  return f.rawFileType === "pptx" || PRESENTATION_FILE_PATTERN.test(f.filename);
}

function isTextDocumentFile(f: CarriedFileMeta): boolean {
  if (isPresentationFile(f) || isDataFile(f)) return false;
  return f.rawFileType === "docx" || TEXT_DOCUMENT_PATTERN.test(f.filename);
}

function isArchiveFile(f: CarriedFileMeta): boolean {
  return ARCHIVE_FILE_PATTERN.test(f.filename);
}

/* ── Intent patterns ────────────────────────────────────────────────────── */

/**
 * Cross-file comparison ask. Requires 2+ comparable files at the call site,
 * so "compare the numbers in this file" (single upload) can never match.
 */
const COMPARE_PATTERN =
  /\b(?:compare|comparison|difference|differences|diff|discrepanc|deviat|what(?:'s| is| has)?\s+changed|changes?\s+between|contrast|side[\s-]by[\s-]side|versus|\bvs\.?\b)\b/i;

/** Merge/combine multiple files into one output. */
const MERGE_PATTERN =
  /\b(?:merge|combine|consolidate|unify|(?:put|bring|join)\s+(?:them|these|both|all)?\s*together|into\s+(?:one|a\s+single)|single\s+(?:document|file|report|deck|presentation|spreadsheet|workbook))\b/i;

/** Summary/overview across the uploaded set. */
const SUMMARIZE_COLLECTION_PATTERN =
  /\b(?:summar(?:y|ize|ise|ies)|overview|executive\s+summary|digest|key\s+(?:points|takeaways|findings)|(?:combined|overall|joint)\s+report|report\s+(?:of|on|from|covering|across))\b[^.?!\n]{0,60}\b(?:all|both|these|the(?:se)?\s+\d+|every|each|files?|documents?|uploads?|attachments?|everything)\b|\b(?:all|both|each|every)\b[^.?!\n]{0,40}\b(?:files?|documents?|uploads?|attachments?)\b[^.?!\n]{0,60}\b(?:summar|overview|report|digest)/i;

/** Analysis/report over an uploaded archive plus supporting files. */
const ARCHIVE_REPORT_PATTERN = /\b(?:report|analy[sz]e|analysis|review|audit|assess|inspect)\b/i;

/**
 * EDIT-verb ask against a presentation/document target ("update the deck").
 * Mirrors the clarification planner's target detection.
 */
const EDIT_VERB_PATTERN =
  /\b(?:update|edit|revise|refresh|improve|polish|rework|modify|rebuild|regenerate|fix\s+up|clean\s+up|fill\s+in|populate|sync)\b/i;

const PRESENTATION_NOUN_PATTERN =
  /\b(?:presentation|deck|slides?|slideshow|power\s?point|pptx?)\b/i;
const DOCUMENT_NOUN_PATTERN = /\b(?:document|docx?|word\s+doc|report|pdf|write[\s-]?up)\b/i;

/** The user named the data source — a data→target update is explicit. */
const SOURCE_MENTION_PATTERN =
  /\b(?:spreadsheet|excel|xlsx|xls\b|csv|workbook|worksheet|data\s+source|source\s+file|from\s+the\s+data|using\s+the\s+data|with\s+the\s+(?:new|latest)\s+(?:data|numbers|figures)|latest\s+(?:data|numbers|figures))\b/i;

/* ── Helpers ────────────────────────────────────────────────────────────── */

function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").toLowerCase();
}

/** Files the message mentions by (base) name, preserving mention order. */
function mentionedFiles(message: string, files: CarriedFileMeta[]): CarriedFileMeta[] {
  const lower = message.toLowerCase();
  return files
    .map((f) => ({
      f,
      idx: baseName(f.filename).length >= 3 ? lower.indexOf(baseName(f.filename)) : -1,
    }))
    .filter((m) => m.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((m) => m.f);
}

function toUsedFiles(files: OraMultiFilePlanFile[]): OraUsedFile[] {
  return files.slice(0, 5).map((f) => ({ name: f.filename.slice(0, 300), role: f.role }));
}

const ROLE_LABELS: Record<OraMultiFileRole, string> = {
  source_data: "data source",
  target_document: "document to update",
  target_presentation: "presentation to update",
  comparison_a: "comparison side A",
  comparison_b: "comparison side B",
  merge_input: "merge input",
  reference: "reference material",
};

function buildDirective(workflow: OraMultiFileWorkflow, files: OraMultiFilePlanFile[]): string {
  const lines = files.map((f, i) => `${i + 1}. "${f.filename}" — ${ROLE_LABELS[f.role]}.`);
  const guidance: Record<OraMultiFileWorkflow, string> = {
    data_to_presentation:
      "Update the target presentation using values from the data source file(s). Keep the deck's structure and intent; replace figures, tables, and data-driven statements with the source data's real values. Never invent numbers.",
    data_to_document:
      "Update the target document using values from the data source file(s). Keep the document's structure and intent; replace figures, tables, and data-driven statements with the source data's real values. Never invent numbers.",
    compare_documents:
      "Compare the two files directly. Lead with the most important differences, then cover additions, removals, and changed wording or values. Quote or cite the exact differing passages. Do not fabricate differences.",
    compare_spreadsheets:
      "Compare the two datasets directly. Lead with the most important differences in values, rows, columns, and totals. Cite the exact cells/rows that differ. Do not fabricate differences.",
    merge_documents:
      "Merge the input files into ONE coherent document. Preserve all substantive content from every input, remove duplicated passages, and organize with a clear structure. Attribute conflicting statements to their source file.",
    combine_spreadsheets:
      "Combine the input spreadsheets into ONE workbook/table. Align columns by header where they match, preserve all rows from every input, and note (do not silently drop) mismatched columns.",
    summarize_collection:
      "Produce ONE combined summary that draws on EVERY listed file. Organize by theme or by file (whichever answers the request better) and make clear which file each key point comes from.",
    archive_report:
      "Build the requested report/analysis from the archive digest and any supporting files. Use the file listing and extracted contents as evidence; be explicit about anything the digest does not contain.",
  };
  return [
    "[MULTI-FILE TASK PLAN]",
    `Workflow: ${workflow.replace(/_/g, " ")}.`,
    "The user's request involves ALL of the following uploaded files in these roles:",
    ...lines,
    guidance[workflow],
    "[END MULTI-FILE TASK PLAN]",
  ].join("\n");
}

/* ── Ambiguous edit-target detection (fed into the clarification planner) ── */

/**
 * "Update the deck" while TWO+ decks are uploaded and none is named — asking
 * is mandatory: silently picking the first same-format file edits the wrong
 * document. Compare/merge/summary intents are exempt (they use ALL files).
 */
export function detectAmbiguousEditTarget(
  message: string,
  files: Array<{ fileRef: string; filename: string }>,
): { question: string; candidates: string[] } | null {
  if (files.length < 2) return null;
  if (COMPARE_PATTERN.test(message) || MERGE_PATTERN.test(message)) return null;
  if (SUMMARIZE_COLLECTION_PATTERN.test(message)) return null;
  if (!EDIT_VERB_PATTERN.test(message)) return null;

  const wantsPresentation = PRESENTATION_NOUN_PATTERN.test(message);
  const wantsDocument = !wantsPresentation && DOCUMENT_NOUN_PATTERN.test(message);
  if (!wantsPresentation && !wantsDocument) return null;

  const family = wantsPresentation ? PRESENTATION_FILE_PATTERN : TEXT_DOCUMENT_PATTERN;
  const candidates = files.filter((f) => family.test(f.filename));
  if (candidates.length < 2) return null;

  // Naming any candidate (by base filename) disambiguates — never ask then.
  const lower = message.toLowerCase();
  const named = candidates.some((f) => {
    const base = baseName(f.filename);
    return base.length >= 3 && lower.includes(base);
  });
  if (named) return null;

  const names = candidates.slice(0, 5).map((f) => `"${f.filename}"`);
  const noun = wantsPresentation ? "presentations" : "documents";
  return {
    question: `You've uploaded ${candidates.length} ${noun}: ${names.join(", ")}. Which one should I update?`,
    candidates: candidates.map((f) => f.filename),
  };
}

/**
 * Pin the edit target when the message names exactly ONE uploaded file but no
 * multi-file plan produced a targetFileRef. Two paths depend on this promise:
 *
 *  1. detectAmbiguousEditTarget skips its question when a candidate is named —
 *     so the name MUST steer the edit engine, or upload order wins anyway.
 *  2. An ambiguous_target_file clarification answered with a filename merges
 *     into routedMessage; without a data-source mention no plan fires, and the
 *     ordered documentRefs scan would silently edit the FIRST same-format
 *     upload — the exact wrong-file pick the question existed to avoid.
 *
 * Exactly-one semantics keep this conservative: zero or 2+ name matches
 * return null and leave existing behavior untouched. The edit engine's
 * format+bytes guard still applies, so naming a file of the wrong format
 * (e.g. the data source) safely falls back to the ordered scan.
 */
export function resolveNamedEditTarget(message: string, files: CarriedFileMeta[]): string | null {
  if (files.length < 2) return null;
  const named = mentionedFiles(message, files);
  if (named.length !== 1) return null;
  return named[0].fileRef;
}

/* ── Workflow planners ──────────────────────────────────────────────────── */

function planCompare(message: string, files: CarriedFileMeta[]): OraMultiFilePlan | null {
  if (!COMPARE_PATTERN.test(message)) return null;
  // Prefer an explicitly-named pair (in mention order), then same-family pairs.
  const named = mentionedFiles(message, files);
  let pair: CarriedFileMeta[] | null = null;
  if (named.length >= 2) {
    pair = named.slice(0, 2);
  } else {
    const docs = files.filter(isTextDocumentFile);
    const sheets = files.filter(isDataFile);
    const decks = files.filter(isPresentationFile);
    if (docs.length >= 2) pair = docs.slice(0, 2);
    else if (sheets.length >= 2) pair = sheets.slice(0, 2);
    else if (decks.length >= 2) pair = decks.slice(0, 2);
    else if (named.length === 1)
      return null; // one named + nothing comparable
    else if (files.length === 2) pair = [files[0]!, files[1]!];
  }
  if (!pair) return null;
  const [a, b] = pair as [CarriedFileMeta, CarriedFileMeta];
  const workflow: OraMultiFileWorkflow =
    isDataFile(a) && isDataFile(b) ? "compare_spreadsheets" : "compare_documents";
  const planFiles: OraMultiFilePlanFile[] = [
    { fileRef: a.fileRef, filename: a.filename, role: "comparison_a" },
    { fileRef: b.fileRef, filename: b.filename, role: "comparison_b" },
  ];
  // A comparison wants an ANALYSIS reply unless the user explicitly asked for
  // a downloadable output format ("compare them and give me a PDF report").
  const explicitFormat = detectFileRequest(message);
  return {
    workflow,
    files: planFiles,
    targetFileRef: null,
    outputFormat: explicitFormat,
    toolOverride: explicitFormat ? null : "answer",
    directive: buildDirective(workflow, planFiles),
    usedFiles: toUsedFiles(planFiles),
  };
}

function planMerge(message: string, files: CarriedFileMeta[]): OraMultiFilePlan | null {
  if (!MERGE_PATTERN.test(message)) return null;
  const sheets = files.filter(isDataFile);
  const docs = files.filter(isTextDocumentFile);
  let inputs: CarriedFileMeta[];
  let workflow: OraMultiFileWorkflow;
  let outputFormat: FileFormat;
  if (sheets.length >= 2 && sheets.length >= docs.length) {
    inputs = sheets;
    workflow = "combine_spreadsheets";
    outputFormat = "xlsx";
  } else if (docs.length >= 2) {
    inputs = docs;
    workflow = "merge_documents";
    outputFormat = "docx";
  } else {
    return null;
  }
  const planFiles: OraMultiFilePlanFile[] = inputs
    .slice(0, 5)
    .map((f) => ({ fileRef: f.fileRef, filename: f.filename, role: "merge_input" as const }));
  return {
    workflow,
    files: planFiles,
    targetFileRef: null,
    outputFormat: detectFileRequest(message) ?? outputFormat,
    toolOverride: null,
    directive: buildDirective(workflow, planFiles),
    usedFiles: toUsedFiles(planFiles),
  };
}

function planDataToTarget(message: string, files: CarriedFileMeta[]): OraMultiFilePlan | null {
  const dataFiles = files.filter(isDataFile);
  if (dataFiles.length === 0) return null;
  if (!EDIT_VERB_PATTERN.test(message)) return null;

  const wantsPresentation = PRESENTATION_NOUN_PATTERN.test(message);
  const wantsDocument = !wantsPresentation && DOCUMENT_NOUN_PATTERN.test(message);
  if (!wantsPresentation && !wantsDocument) return null;
  // The user must have made the SOURCE explicit (named the data family or a
  // file). When it isn't, the clarification planner asks — never guess here.
  if (!SOURCE_MENTION_PATTERN.test(message) && mentionedFiles(message, dataFiles).length === 0) {
    return null;
  }

  const family = wantsPresentation ? isPresentationFile : isTextDocumentFile;
  const candidates = files.filter(family);
  if (candidates.length === 0) return null;
  // Two+ candidate targets: only proceed when the message names one — the
  // ambiguous case is handled by the ambiguous_target_file clarification.
  let target: CarriedFileMeta;
  if (candidates.length === 1) {
    target = candidates[0]!;
  } else {
    const named = mentionedFiles(message, candidates);
    if (named.length === 0) return null;
    target = named[0]!;
  }

  const workflow: OraMultiFileWorkflow = wantsPresentation
    ? "data_to_presentation"
    : "data_to_document";
  const planFiles: OraMultiFilePlanFile[] = [
    ...dataFiles
      .slice(0, 4)
      .map((f) => ({ fileRef: f.fileRef, filename: f.filename, role: "source_data" as const })),
    {
      fileRef: target.fileRef,
      filename: target.filename,
      role: wantsPresentation ? ("target_presentation" as const) : ("target_document" as const),
    },
  ];
  return {
    workflow,
    files: planFiles,
    targetFileRef: target.fileRef,
    outputFormat: wantsPresentation ? "pptx" : "docx",
    toolOverride: null,
    directive: buildDirective(workflow, planFiles),
    usedFiles: toUsedFiles(planFiles),
  };
}

function planSummarizeCollection(
  message: string,
  files: CarriedFileMeta[],
): OraMultiFilePlan | null {
  if (!SUMMARIZE_COLLECTION_PATTERN.test(message)) return null;
  const inputs = files.filter((f) => !isArchiveFile(f));
  if (inputs.length < 2) return null;
  const planFiles: OraMultiFilePlanFile[] = inputs
    .slice(0, 5)
    .map((f) => ({ fileRef: f.fileRef, filename: f.filename, role: "reference" as const }));
  return {
    workflow: "summarize_collection",
    files: planFiles,
    targetFileRef: null,
    outputFormat: detectFileRequest(message),
    toolOverride: null,
    directive: buildDirective("summarize_collection", planFiles),
    usedFiles: toUsedFiles(planFiles),
  };
}

function planArchiveReport(message: string, files: CarriedFileMeta[]): OraMultiFilePlan | null {
  const archives = files.filter(isArchiveFile);
  const others = files.filter((f) => !isArchiveFile(f));
  if (archives.length === 0 || others.length === 0) return null;
  if (!ARCHIVE_REPORT_PATTERN.test(message)) return null;
  const planFiles: OraMultiFilePlanFile[] = [
    ...archives
      .slice(0, 2)
      .map((f) => ({ fileRef: f.fileRef, filename: f.filename, role: "reference" as const })),
    ...others
      .slice(0, 3)
      .map((f) => ({ fileRef: f.fileRef, filename: f.filename, role: "source_data" as const })),
  ];
  return {
    workflow: "archive_report",
    files: planFiles,
    targetFileRef: null,
    outputFormat: detectFileRequest(message),
    toolOverride: null,
    directive: buildDirective("archive_report", planFiles),
    usedFiles: toUsedFiles(planFiles),
  };
}

/**
 * Recognize a multi-file workflow for this turn. Returns null when fewer than
 * two uploads resolve, when the routed tool escaped to a specialist surface
 * (image/search/etc.), or when no cross-file intent is present — all of which
 * leave existing single-file behavior byte-identical.
 */
export function planOraMultiFile(input: OraMultiFilePlanInput): OraMultiFilePlan | null {
  const { message, files, finalTool } = input;
  if (files.length < 2) return null;
  if (finalTool !== "file_generation" && finalTool !== "answer") return null;

  return (
    planCompare(message, files) ??
    planMerge(message, files) ??
    planDataToTarget(message, files) ??
    planSummarizeCollection(message, files) ??
    planArchiveReport(message, files)
  );
}
