/**
 * Phase 10 — True Artifact Revision Engine: lightweight pattern-based
 * classifier that identifies whether a user message is a revision request
 * targeting an existing artifact vs. a brand-new creation request.
 *
 * Deliberately lightweight (no AI call). Used by routes to decide whether to
 * pass `activeAssetBuffer` into the edit engine before falling back to full
 * generation. The AI edit engine makes the final authoritative decision about
 * what can and cannot be applied in-place.
 */

export type EditIntent =
  | "content_edit" // rewrite/replace/delete specific text
  | "style_edit" // color, font, theme, visual formatting
  | "layout_edit" // rearrange, reorder slides/sections, add/remove columns
  | "structure_edit" // add/remove slides, sections, headings, rows
  | "formula_chart" // formulas, calculations, charts in a spreadsheet
  | "full_redesign" // total overhaul, from scratch, new direction
  | "new_creation" // clearly a fresh file unrelated to a prior one
  | "revision_ambiguous" // looks like a revision but can't classify further
  | "unrelated"; // conversational — nothing to do with a file

/** Patterns that strongly suggest in-place editing of an existing file. */
const CONTENT_EDIT_PATTERNS =
  /\b(?:change|update|edit|fix|correct|replace|rewrite|revise|modify|rephrase|reword|shorten|expand|translate|proofread|spell[\s-]?check|capitaliz|lowercase|uppercase)\b/i;

const STYLE_EDIT_PATTERNS =
  /\b(?:color(?:s)?|colour(?:s)?|font(?:s)?|bold|italic|underline|highlight|theme|style|format(?:ting)?|background|foreground|heading(?:s)?|title(?:s)?|blue|red|green|dark|light|bigger|smaller|larger|resize)\b/i;

const LAYOUT_EDIT_PATTERNS =
  /\b(?:reorder|rearrange|move|swap|shuffle|sort|align|column(?:s)?|row(?:s)?|margin(?:s)?|spacing|indent|layout|section(?:s)?|position|center|justify)\b/i;

const STRUCTURE_EDIT_PATTERNS =
  /\b(?:add(?:ing)?|insert(?:ing)?|append(?:ing)?|remove|delete|drop|slide(?:s)?|page(?:s)?|sheet(?:s)?|tab(?:s)?|header(?:s)?|footer(?:s)?|section(?:s)?|chapter(?:s)?|bullet(?:s)?|list item)\b/i;

const FORMULA_CHART_PATTERNS =
  /\b(?:formula(?:s)?|calculat|sum|average|total(?:s)?|chart(?:s)?|graph(?:s)?|histogram(?:s)?|dashboard|pivot|vlookup|hlookup|countif|sumif|mean|median|variance|percentage|ratio)\b/i;

const FULL_REDESIGN_PATTERNS =
  /\b(?:redesign|restyle|overhaul|rebuild|redo|redo|completely\s+different|brand[\s-]?new\s+version|start(?:ing)?\s+over|from\s+scratch|new\s+design|transform)\b/i;

const NEW_CREATION_PATTERNS =
  /\b(?:create|make|build|generate|write|draft|produce|compose|prepare|new\s+(?:deck|presentation|document|doc|file|report|spreadsheet|workbook))\b.*\b(?:about|on|for|regarding|covering)\b/i;

/** Revision-targeting pronouns that anchor the intent to an existing file. */
const REVISION_ANCHORS =
  /\b(?:it|this|the\s+(?:file|document|doc|deck|presentation|slides?|spreadsheet|workbook)|that\s+(?:file|document|doc|deck)|my\s+(?:file|document|doc|deck|presentation)|the\s+one\s+(?:you|i))\b/i;

/**
 * Classify the edit intent of a user message. Only call this when an active
 * artifact is tracked (activeAssetId is set) — the `unrelated` and
 * `new_creation` results are only meaningful in that context.
 */
export function classifyEditIntent(message: string): EditIntent {
  const lower = message.toLowerCase();

  // Full redesign / start-over explicitly overrides everything else.
  if (FULL_REDESIGN_PATTERNS.test(message)) return "full_redesign";

  // Explicit new file request unrelated to the active artifact.
  if (NEW_CREATION_PATTERNS.test(message) && !REVISION_ANCHORS.test(message)) {
    return "new_creation";
  }

  const hasRevisionAnchor = REVISION_ANCHORS.test(message);
  const hasContentEdit = CONTENT_EDIT_PATTERNS.test(message);
  const hasStyleEdit = STYLE_EDIT_PATTERNS.test(message);
  const hasLayoutEdit = LAYOUT_EDIT_PATTERNS.test(message);
  const hasStructureEdit = STRUCTURE_EDIT_PATTERNS.test(message);
  const hasFormulaChart = FORMULA_CHART_PATTERNS.test(message);

  const hasAnyEditSignal =
    hasContentEdit ||
    hasStyleEdit ||
    hasLayoutEdit ||
    hasStructureEdit ||
    hasFormulaChart;

  if (hasStyleEdit) return "style_edit";
  if (hasFormulaChart) return "formula_chart";
  if (hasLayoutEdit) return "layout_edit";
  if (hasStructureEdit) return "structure_edit";
  if (hasContentEdit) return "content_edit";

  // Bare revision pronoun with no specific edit signal — probably a follow-up
  // like "make it shorter" (shorter matched contentEdit) or "can you improve it?".
  if (hasRevisionAnchor && !hasAnyEditSignal) {
    // "improve it", "polish it", "clean it up", "make it better" → style_edit fallback
    if (/\b(?:improve|polish|clean|better|nicer|prettier|professional|sharper)\b/i.test(lower)) {
      return "style_edit";
    }
    return "revision_ambiguous";
  }

  return "unrelated";
}

/**
 * Returns true when the classified intent targets the active working artifact
 * rather than requesting a brand-new file. Routes use this to decide whether
 * to activate the Phase 10 revision path.
 */
export function isRevisionIntent(intent: EditIntent): boolean {
  return (
    intent === "content_edit" ||
    intent === "style_edit" ||
    intent === "layout_edit" ||
    intent === "structure_edit" ||
    intent === "formula_chart" ||
    intent === "revision_ambiguous"
  );
}
