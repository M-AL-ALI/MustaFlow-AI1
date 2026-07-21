import { resolveOraVisualIntent, type OraRouteDecision } from "./orchestrator";
import {
  detectFileRequest,
  inferFileFormatFromUploadedContext,
  isUploadedFileModificationRequest,
  type FileFormat,
} from "./prompt";
import { inferOraSearchPlan } from "./web-search";

/**
 * How an image/file/search routing conflict was resolved for this turn.
 * Static enum values only — never user content — so it is safe to expose in
 * client-visible diagnostics (serverDiag).
 */
export type OraRouteConflictResolution =
  | "force_search_pin" // user-initiated Retry live search overrides everything
  | "edit_over_chat" // uploaded-file edit beat a conversational answer
  | "edit_over_image" // uploaded-file edit beat an incidental image-pattern hit
  | "edit_over_search" // uploaded-file edit beat an incidental search-pattern hit
  | "explicit_image_over_edit" // explicit image ask kept image over a file edit
  | "search_over_edit_current_info" // explicit current/live ask kept search
  | "zip_analysis_guard" // archive context stays analysis without an export ask
  | null;

export interface OraFinalRouteInput {
  /** The decision produced by routeOraMessage for this turn. */
  decision: OraRouteDecision;
  /** The current user message. */
  message: string;
  /** Re-hydrated uploaded-document context block ("" when nothing resolved). */
  carriedDocs: string;
  /** User-initiated "Retry live search" — pins the turn to the search tool. */
  forceSearch?: boolean;
}

export interface OraFinalRouteResult {
  decision: OraRouteDecision;
  /** Which precedence rule fired, for diagnostics. Null = no conflict. */
  conflictResolution: OraRouteConflictResolution;
  /** The format inferred for an uploaded-file edit, when that rule fired. */
  inferredFileFormat: FileFormat | null;
}

// Newest carried file is an archive/code bundle (carried-docs lists newest
// first). Kept in sync with the archive blueprint branch in carried-docs.ts.
const ARCHIVE_FILE_PATTERN = /\.(?:zip|tar|tgz|gz|7z)$/i;

function newestCarriedFileName(carriedDocs: string): string | null {
  for (const line of carriedDocs.split(/\r?\n/)) {
    const name = line.match(/^File:\s*(.+)$/i)?.[1]?.trim();
    if (name) return name;
  }
  return null;
}

/**
 * Deterministic final routing precedence, applied AFTER routeOraMessage and
 * shared by BOTH /public-ai/chat and /public-ai/chat/stream so the two
 * handlers cannot drift. Rules, in order:
 *
 * 1. forceSearch (user-initiated Retry live search) pins the turn to the
 *    search tool. TERMINAL — nothing may override a user-forced retry.
 * 2. Uploaded-file edit precedence: when carried document context exists and
 *    the message is an edit/modification request, the edit beats a normal
 *    chat answer, an incidental image-pattern hit, and an incidental
 *    search-pattern hit — UNLESS:
 *      a. the user explicitly asked for image generation
 *         (resolveOraVisualIntent === "generate_image", the single source of
 *         truth that already excludes explicit downloadable formats), or
 *      b. the message explicitly asks for current/live information
 *         (inferOraSearchPlan freshness === "current", the same signal that
 *         drives searchRetryable), in which case search keeps the turn, or
 *      c. the newest carried file is a ZIP/code archive and the user did not
 *         explicitly ask for a report/export (detectFileRequest is null) —
 *         archive follow-ups stay analysis, never silent file generation.
 * 3. Otherwise the routeOraMessage decision stands unchanged.
 */
export function resolveFinalOraRoute(input: OraFinalRouteInput): OraFinalRouteResult {
  const { decision, message, carriedDocs, forceSearch } = input;

  // 1. Forced live-search retry is terminal: the user already saw a fallback
  //    answer and explicitly asked for a fresh live search. Placed BEFORE the
  //    edit precedence so a retry with carried docs is never flipped back to
  //    file_generation.
  if (forceSearch) {
    return {
      decision:
        decision.tool === "search"
          ? decision
          : {
              ...decision,
              tool: "search",
              reason: `${decision.reason}; user-forced live search retry`,
            },
      conflictResolution: "force_search_pin",
      inferredFileFormat: null,
    };
  }

  // 2. Uploaded-file edit precedence.
  if (carriedDocs && isUploadedFileModificationRequest(message)) {
    // 2a. An explicit image-generation ask wins over the edit inference.
    if (resolveOraVisualIntent(message) === "generate_image") {
      return {
        decision,
        conflictResolution:
          decision.tool === "image_generation" ? "explicit_image_over_edit" : null,
        inferredFileFormat: null,
      };
    }

    // 2b. An explicit current/live-info ask keeps the search tool.
    if (decision.tool === "search" && inferOraSearchPlan({ query: message }).freshness === "current") {
      return {
        decision,
        conflictResolution: "search_over_edit_current_info",
        inferredFileFormat: null,
      };
    }

    // 2c. Archive/code-bundle context stays analysis unless the user
    //     explicitly asked for a report/export in the message itself.
    const newestFile = newestCarriedFileName(carriedDocs);
    const explicitFormatAsk = detectFileRequest(message);
    if (newestFile && ARCHIVE_FILE_PATTERN.test(newestFile) && !explicitFormatAsk) {
      return {
        decision,
        conflictResolution: "zip_analysis_guard",
        inferredFileFormat: null,
      };
    }

    // 2d. Route the edit to file generation with the best inferred format.
    const inferredFormat = explicitFormatAsk ?? inferFileFormatFromUploadedContext(carriedDocs);
    if (inferredFormat && decision.tool !== "file_generation") {
      const conflictResolution: OraRouteConflictResolution =
        decision.tool === "search"
          ? "edit_over_search"
          : decision.tool === "image_generation"
            ? "edit_over_image"
            : "edit_over_chat";
      return {
        decision: {
          ...decision,
          tool: "file_generation",
          fileFormat: inferredFormat,
          reason: `${decision.reason}; uploaded file modification routed to ${inferredFormat}`,
        },
        conflictResolution,
        inferredFileFormat: inferredFormat,
      };
    }
    if (inferredFormat && decision.tool === "file_generation") {
      // Already a file route; just make sure a format is set.
      return {
        decision: decision.fileFormat ? decision : { ...decision, fileFormat: inferredFormat },
        conflictResolution: null,
        inferredFileFormat: inferredFormat,
      };
    }
  }

  // 3. No precedence rule fired — the orchestrator decision stands.
  return { decision, conflictResolution: null, inferredFileFormat: null };
}
