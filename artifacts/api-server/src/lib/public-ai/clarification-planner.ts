import type { OraClarificationKind, OraPendingClarification } from "@workspace/ora-contracts";
import type { OraTool } from "./orchestrator";
import type { OraRouteConflictResolution } from "./route-resolution";
import type { FileFormat } from "./prompt";
import { detectFileRequest, isUploadedFileModificationRequest } from "./prompt";
import { detectAmbiguousEditTarget } from "./multi-file-planner";

/**
 * Phase 4 — Clarifying Questions.
 *
 * Deterministic, pre-LLM planner that decides whether Ora should ask ONE
 * clarifying question instead of guessing on an ambiguous uploaded-file edit.
 * Runs AFTER resolveFinalOraRoute (so it consumes the final routing decision
 * and can never fight the image/search/ZIP escapes) and BEFORE
 * checkToolAccess/quota (a clarification is never charged).
 *
 * The server is stateless per turn: the pending-task context round-trips
 * through the CLIENT. A clarification response carries `pendingTaskContext`;
 * the client echoes it back as `pendingClarification` on the next send and
 * `resolveClarificationContinuation` merges it with the user's answer so the
 * original task continues with documentRefs intact (clients re-send refs on
 * every turn already).
 */

export interface OraClarificationPlan {
  kind: OraClarificationKind;
  question: string;
  pendingTaskContext: OraPendingClarification;
}

export interface OraClarificationPlanInput {
  /** The raw user message for this turn. */
  message: string;
  /** Re-hydrated uploaded-document context ("" when nothing resolved). */
  carriedDocs: string;
  /** decision.tool AFTER resolveFinalOraRoute. */
  finalTool: OraTool;
  /** Which precedence rule fired in resolveFinalOraRoute (null = none). */
  conflictResolution: OraRouteConflictResolution;
  /** Format the resolver inferred for the edit (null when not an edit route). */
  inferredFileFormat: FileFormat | null;
  /** True when this turn already carries a pendingClarification echo. */
  hasPendingClarification: boolean;
  /**
   * Resolved carried-file metadata (Phase 5). When provided, the planner can
   * also detect an ambiguous edit TARGET ("update the deck" with two decks
   * uploaded). Optional so existing call sites/tests stay valid.
   */
  files?: Array<{ fileRef: string; filename: string }>;
}

/** Static question templates (dynamic kinds fill in the actual file names). */
export const ORA_CLARIFICATION_QUESTIONS: Record<
  Exclude<OraClarificationKind, "multi_file_source" | "ambiguous_target_file">,
  string
> = {
  vague_file_edit:
    "Do you want me to preserve the original layout, or create a redesigned version?",
  unclear_replacement_target:
    "Which text should I replace exactly? You can quote the sentence, or tell me the slide or section it's in.",
  missing_edit_instruction: "What modification should I make before returning the file?",
};

/* ── Detection patterns ────────────────────────────────────────────────────
 * All full-message patterns are anchored (^...$) so ANY additional concrete
 * instruction makes the request "clear" and Ora executes immediately.
 */

/** Quoted text = the user already pinpointed the target. Never ask. */
const QUOTED_TEXT_PATTERN =
  /"[^"]{2,}"|'[^']{4,}'|\u201c[^\u201d]{2,}\u201d|\u2018[^\u2019]{4,}\u2019/;

/** The user already answered the layout question inside the request. */
const EXPLICIT_LAYOUT_INTENT_PATTERN =
  /\b(?:preserve|keep|maintain|retain)\b[^.?!\n]{0,30}\b(?:layout|format(?:ting)?|design|style)\b|\b(?:redesign(?:ed)?|restyle|reformat)\b/i;

const FILE_NOUN = String.raw`file|document|doc|deck|presentation|slides?|slide\s*deck|spreadsheet|sheet|workbook|report|pdf|resume|cv`;

/**
 * vague_file_edit — a bare "improve it" with no direction at all.
 * Directional asks ("make it shorter", "more professional") stay clear.
 */
const VAGUE_IMPROVE_PATTERN = new RegExp(
  String.raw`^(?:please\s+|pls\s+|can\s+you\s+(?:please\s+)?|could\s+you\s+(?:please\s+)?)?` +
    String.raw`(?:make\s+(?:it|this|that|the\s+(?:${FILE_NOUN}))\s+(?:better|nicer|good|great|stronger|prettier)` +
    String.raw`|(?:improve|enhance|polish|beautify)\s+(?:it|this|that|the\s+(?:${FILE_NOUN}))` +
    String.raw`|fix\s+(?:it|this)\s+up)` +
    String.raw`\s*(?:please|pls)?\s*[.?!]*\s*$`,
  "i",
);

/**
 * missing_edit_instruction — "return/send it back after modification" with
 * the modification never stated. Anchored so "return it after changing the
 * title to X" (a stated modification) stays clear.
 */
const RETURN_WITHOUT_INSTRUCTION_PATTERN = new RegExp(
  String.raw`\b(?:return|send|give)\b[^.?!\n]{0,40}\b(?:it|this|that|them|the\s+(?:${FILE_NOUN}))\b` +
    String.raw`[^.?!\n]{0,30}\b(?:after|with|once|when)\b[^.?!\n]{0,20}?` +
    String.raw`(?:the\s+|some\s+|your\s+|any\s+)?(?:modif(?:ication|ications|ying)|chang(?:es|ing)|edit(?:s|ing)?|updat(?:es|ing)|revis(?:ion|ions|ing))` +
    String.raw`\s*[.?!]*\s*$`,
  "i",
);

/**
 * unclear_replacement_target — "change the pricing section" with no quoted
 * text, no replacement content, no slide/section number. Anchored: a trailing
 * "to say ..." or "of the DOCX to mention ..." makes it clear.
 */
const UNCLEAR_TARGET_PATTERN = new RegExp(
  String.raw`^(?:please\s+|pls\s+|can\s+you\s+(?:please\s+)?|could\s+you\s+(?:please\s+)?)?` +
    String.raw`(?:change|replace|update|edit|rewrite|revise|reword|fix)\s+(?:the|that|this|its)\s+` +
    String.raw`([\w][\w-]*(?:\s+[\w][\w-]*){0,2}?)\s*` +
    String.raw`(?:section|part|paragraph|text|copy|wording|blurb)` +
    String.raw`\s*[.?!]*\s*$`,
  "i",
);

/** The user already named the data source — multi-file edit is clear. */
const SOURCE_MENTION_PATTERN =
  /\b(?:spreadsheet|excel|xlsx|xls\b|csv|workbook|worksheet|data\s+source|source\s+file|from\s+the\s+data|using\s+the\s+data)\b/i;

/**
 * An EDIT-verb ask against the target document family ("update the
 * presentation"). Deliberately excludes conversion verbs (convert/turn/export)
 * — those name their own source and are clear.
 */
const MULTI_EDIT_TARGET_PATTERN =
  /\b(?:update|edit|revise|refresh|improve|polish|rework|modify|fix\s+up|clean\s+up)\b[^.?!\n]{0,30}\b(?:presentation|deck|slides?|slideshow|power\s?point|pptx?|document|docx?|word\s+doc|report|pdf)\b/i;

const DATA_FILE_PATTERN = /\.(?:xlsx?|csv)$/i;
const PRESENTATION_FILE_PATTERN = /\.(?:pptx?)$/i;
const DOCUMENT_FILE_PATTERN = /\.(?:docx?|pdf)$/i;

/** Route outcomes where a clarification must never fire: an explicit image,
 * current-info search, ZIP-analysis, or user-forced search escape already won
 * the turn. */
const ESCAPED_CONFLICTS: ReadonlySet<Exclude<OraRouteConflictResolution, null>> = new Set([
  "explicit_image_over_edit",
  "search_over_edit_current_info",
  "zip_analysis_guard",
  "force_search_pin",
] as const);

/** Carried-docs block lists files as "File: <name>" lines, newest first. */
function carriedFileNames(carriedDocs: string): string[] {
  const names: string[] = [];
  for (const line of carriedDocs.split(/\r?\n/)) {
    const name = line.match(/^File:\s*(.+)$/i)?.[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

/** The user typed one of the carried file names — the target is explicit. */
function mentionsCarriedFileName(message: string, fileNames: string[]): boolean {
  const lower = message.toLowerCase();
  return fileNames.some((name) => {
    const base = name.replace(/\.[^.]+$/, "").toLowerCase();
    return base.length >= 3 && lower.includes(base);
  });
}

function detectMultiFileSource(message: string, carriedDocs: string): { question: string } | null {
  const files = carriedFileNames(carriedDocs);
  if (files.length < 2) return null;
  const dataFiles = files.filter((f) => DATA_FILE_PATTERN.test(f));
  const targetFiles = files.filter(
    (f) => PRESENTATION_FILE_PATTERN.test(f) || DOCUMENT_FILE_PATTERN.test(f),
  );
  if (dataFiles.length === 0 || targetFiles.length === 0) return null;
  if (!MULTI_EDIT_TARGET_PATTERN.test(message)) return null;
  // Already clear: the user named the source, or a specific carried file.
  if (SOURCE_MENTION_PATTERN.test(message)) return null;
  if (mentionsCarriedFileName(message, files)) return null;

  // Pick the target file matching the family the user mentioned.
  const wantsPresentation = /\b(?:presentation|deck|slides?|slideshow|power\s?point|pptx?)\b/i.test(
    message,
  );
  const target =
    (wantsPresentation
      ? targetFiles.find((f) => PRESENTATION_FILE_PATTERN.test(f))
      : targetFiles.find((f) => DOCUMENT_FILE_PATTERN.test(f))) ?? targetFiles[0];
  const source = dataFiles[0];
  return {
    question: `You've uploaded more than one file. Should I use "${source}" as the data source when updating "${target}", or edit "${target}" on its own?`,
  };
}

/**
 * Decide whether to ask ONE clarifying question for this turn.
 * Returns null when the request is clear enough to execute immediately.
 */
export function planOraClarification(
  input: OraClarificationPlanInput,
): OraClarificationPlan | null {
  const {
    message,
    carriedDocs,
    finalTool,
    conflictResolution,
    inferredFileFormat,
    hasPendingClarification,
  } = input;

  // Clarifications exist ONLY for ambiguous uploaded-file work.
  if (!carriedDocs) return null;
  // Once per task: if this turn already answers a clarification (or the
  // client still carries one), never ask again — execute best-effort.
  if (hasPendingClarification) return null;
  // Never fight a resolved image/search/ZIP/forced-search escape.
  if (conflictResolution && ESCAPED_CONFLICTS.has(conflictResolution)) return null;
  // Only the edit path (file_generation) or a plain answer that LOOKS like an
  // uninstructed edit ("return it after modification") are eligible.
  if (finalTool !== "file_generation" && finalTool !== "answer") return null;
  // Quoted text pinpoints the target — clear.
  if (QUOTED_TEXT_PATTERN.test(message)) return null;

  const pendingContext = (kind: OraClarificationKind): OraPendingClarification => ({
    originalMessage: message.slice(0, 4000),
    kind,
    inferredFileFormat: inferredFileFormat ?? null,
  });

  // 1. "Return it after modification." — no modification stated.
  if (RETURN_WITHOUT_INSTRUCTION_PATTERN.test(message)) {
    return {
      kind: "missing_edit_instruction",
      question: ORA_CLARIFICATION_QUESTIONS.missing_edit_instruction,
      pendingTaskContext: pendingContext("missing_edit_instruction"),
    };
  }

  // The remaining detectors only apply to the actual file-edit route.
  if (finalTool !== "file_generation") return null;

  // 2. Multiple uploads + "update the presentation" — source file unclear.
  //    Checked BEFORE the explicit-format guard: naming the target format
  //    ("the presentation") does not disambiguate the SOURCE.
  const multi = detectMultiFileSource(message, carriedDocs);
  if (multi) {
    return {
      kind: "multi_file_source",
      question: multi.question,
      pendingTaskContext: pendingContext("multi_file_source"),
    };
  }

  // 2b. Two+ same-family uploads + "update the deck" — TARGET file unclear.
  //     Also checked before the explicit-format guard: naming the target
  //     format does not say WHICH of the matching files to edit.
  if (input.files && input.files.length >= 2) {
    const ambiguousTarget = detectAmbiguousEditTarget(message, input.files);
    if (ambiguousTarget) {
      return {
        kind: "ambiguous_target_file",
        question: ambiguousTarget.question,
        pendingTaskContext: pendingContext("ambiguous_target_file"),
      };
    }
  }

  // An explicit output-format ask is a clear instruction ("convert to PDF").
  if (detectFileRequest(message)) return null;

  // 3. "Make this better." — no direction; ask layout vs redesign (unless the
  //    user already stated a layout intent).
  if (VAGUE_IMPROVE_PATTERN.test(message) && !EXPLICIT_LAYOUT_INTENT_PATTERN.test(message)) {
    return {
      kind: "vague_file_edit",
      question: ORA_CLARIFICATION_QUESTIONS.vague_file_edit,
      pendingTaskContext: pendingContext("vague_file_edit"),
    };
  }

  // 4. "Change the pricing section." — replacement target unclear.
  if (UNCLEAR_TARGET_PATTERN.test(message)) {
    return {
      kind: "unclear_replacement_target",
      question: ORA_CLARIFICATION_QUESTIONS.unclear_replacement_target,
      pendingTaskContext: pendingContext("unclear_replacement_target"),
    };
  }

  return null;
}

/* ── Continuation ─────────────────────────────────────────────────────────── */

export interface OraClarificationContinuation {
  /**
   * The message ROUTING and the file-edit engine should see. When a pending
   * clarification was merged, this is originalMessage + the user's answer;
   * otherwise the raw message unchanged. The raw message stays the
   * chat-visible/persisted user turn on the client.
   */
  routedMessage: string;
  /** True when the pending context was merged into routedMessage. */
  applied: boolean;
}

/**
 * Detector-only probe used by the stale-pending guard: would the planner have
 * asked about this message on its own? (Route gates deliberately excluded —
 * this is a pure ambiguity check.)
 */
function looksAmbiguous(message: string, carriedDocs: string): boolean {
  if (QUOTED_TEXT_PATTERN.test(message)) return false;
  if (RETURN_WITHOUT_INSTRUCTION_PATTERN.test(message)) return true;
  // Same ordering as the planner: a multi-file source ambiguity survives an
  // explicit-format mention ("update the presentation").
  if (detectMultiFileSource(message, carriedDocs)) return true;
  if (detectFileRequest(message)) return false;
  if (VAGUE_IMPROVE_PATTERN.test(message) && !EXPLICIT_LAYOUT_INTENT_PATTERN.test(message)) {
    return true;
  }
  return UNCLEAR_TARGET_PATTERN.test(message);
}

/**
 * Merge a clarification answer with its pending task context.
 *
 * Stale-pending guard: clients echo `pendingClarification` on the very next
 * send even if the user changed subject. If the new message is a complete
 * edit instruction on its own (the planner would not have asked about it),
 * the pending context is ignored and the message is treated as a new task.
 */
export function resolveClarificationContinuation(input: {
  message: string;
  pending: OraPendingClarification | null | undefined;
  carriedDocs?: string;
}): OraClarificationContinuation {
  const { message, pending } = input;
  const carriedDocs = input.carriedDocs ?? "";
  if (!pending) return { routedMessage: message, applied: false };
  if (isUploadedFileModificationRequest(message) && !looksAmbiguous(message, carriedDocs)) {
    return { routedMessage: message, applied: false };
  }
  return {
    routedMessage: `${pending.originalMessage}\n\nUser clarification: ${message}`,
    applied: true,
  };
}
