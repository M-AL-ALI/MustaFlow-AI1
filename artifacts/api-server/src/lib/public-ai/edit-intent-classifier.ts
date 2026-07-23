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
  | "layout_edit" // rearrange, reorder slides/sections, align elements
  | "structure_edit" // add/remove slides, sections, headings, rows
  | "formula_chart" // formulas, calculations, charts in a spreadsheet
  | "full_redesign" // total overhaul, from scratch, new direction
  | "new_creation" // clearly a fresh file unrelated to a prior one
  | "revision_ambiguous" // looks like a revision but can't classify further
  | "unrelated"; // conversational — nothing to do with a file

// ─── Verb-priority patterns ───────────────────────────────────────────────────

/**
 * Strong content verbs always mean a targeted text/content edit regardless of
 * other signals. "fix the typo in slide 3" is content_edit even though "slide"
 * would normally trigger structure_edit.
 */
const STRONG_CONTENT_VERBS =
  /\b(?:fix|correct|replace|rewrite|rephrase|reword|translate|proofread|spell[\s-]?check|capitaliz|lowercase|uppercase)\b/i;

/**
 * Moderate content verbs — used as final tie-breaker when no other signal
 * dominates. "change the title to Alpha" → content_edit because "title" alone
 * is not a visual property keyword.
 */
const MODERATE_CONTENT_VERBS =
  /\b(?:change|update|edit|modify|shorten|expand|revise)\b/i;

/**
 * Layout verbs describe repositioning/ordering of existing elements.
 * Checked before structure verbs so "reorder the slides" → layout_edit,
 * not structure_edit from the "slide" noun.
 */
const LAYOUT_VERBS =
  /\b(?:reorder|rearrange|move|swap|shuffle|sort|align|center|centre|justify|indent)\b/i;

/**
 * Structure verbs describe adding or removing discrete document elements.
 */
const STRUCTURE_VERBS =
  /\b(?:add(?:ing)?|insert(?:ing)?|append(?:ing)?|remove|delete|drop)\b/i;

// ─── Content-domain patterns ──────────────────────────────────────────────────

/**
 * Visual/style property keywords. Deliberately excludes nouns that are also
 * content targets ("title", "heading") — those classify as content_edit when
 * paired with a moderate content verb, not as style changes.
 */
const STYLE_EDIT_PATTERNS =
  /\b(?:color(?:s)?|colour(?:s)?|font(?:s)?|bold|italic|underline|highlight|theme|style(?:d|s)?|format(?:ting)?|background|foreground|blue|red|green|dark|light|bigger|smaller|larger|resize|appearance|visual|look)\b/i;

const FORMULA_CHART_PATTERNS =
  /\b(?:formula(?:s)?|calculat|sum|average|total(?:s)?|chart(?:s)?|graph(?:s)?|histogram(?:s)?|dashboard|pivot|vlookup|hlookup|countif|sumif|mean|median|variance|percentage|ratio)\b/i;

const FULL_REDESIGN_PATTERNS =
  /\b(?:redesign|restyle|overhaul|rebuild|redo|completely\s+different|brand[\s-]?new\s+version|start(?:ing)?\s+over|from\s+scratch|new\s+design|transform)\b/i;

const NEW_CREATION_PATTERNS =
  /\b(?:create|make|build|generate|write|draft|produce|compose|prepare|new\s+(?:deck|presentation|document|doc|file|report|spreadsheet|workbook))\b.*\b(?:about|on|for|regarding|covering)\b/i;

/** Revision-targeting pronouns that anchor the intent to an existing file. */
const REVISION_ANCHORS =
  /\b(?:it|this|the\s+(?:file|document|doc|deck|presentation|slides?|spreadsheet|workbook)|that\s+(?:file|document|doc|deck)|my\s+(?:file|document|doc|deck|presentation)|the\s+one\s+(?:you|i))\b/i;

/**
 * Classify the edit intent of a user message. Only call this when an active
 * artifact is tracked (activeAssetId is set) — the `unrelated` and
 * `new_creation` results are only meaningful in that context.
 *
 * Priority tiers (highest first):
 *   1. full_redesign — explicit start-over signals
 *   2. new_creation — explicit new-file request without a revision anchor
 *   3. content_edit (strong) — fix/correct/replace/rewrite/translate/etc.
 *   4. formula_chart — unambiguous calculation/chart terms
 *   5. layout_edit — reorder/move/align verbs
 *   6. structure_edit — add/remove/delete/insert verbs
 *   7. style_edit — visual property keywords (color, font, theme)
 *   8. content_edit (moderate) — change/update/edit with no other signal
 *   9. revision_ambiguous — bare revision pronoun + quality/polish keyword
 *  10. unrelated — no file-revision signal detected
 */
export function classifyEditIntent(message: string): EditIntent {
  const lower = message.toLowerCase();

  // ── Tier 1: broad redesign override ──────────────────────────────────────
  if (FULL_REDESIGN_PATTERNS.test(message)) return "full_redesign";

  // ── Tier 2: explicit new creation (no revision anchor) ───────────────────
  if (NEW_CREATION_PATTERNS.test(message) && !REVISION_ANCHORS.test(message)) {
    return "new_creation";
  }

  // ── Tier 3: strong unambiguous content verbs ─────────────────────────────
  // These always win regardless of structure/style signals in the same message.
  if (STRONG_CONTENT_VERBS.test(message)) return "content_edit";

  // ── Tier 4: formula/chart — explicit and unambiguous ────────────────────
  if (FORMULA_CHART_PATTERNS.test(message)) return "formula_chart";

  // ── Tier 5: layout verbs (reorder/move/align) ────────────────────────────
  // Checked before structure so "reorder the slides" → layout_edit, not
  // structure_edit from the "slide(?:s)?" noun.
  if (LAYOUT_VERBS.test(message)) return "layout_edit";

  // ── Tier 6: structure verbs (add/remove/delete/insert) ───────────────────
  if (STRUCTURE_VERBS.test(message)) return "structure_edit";

  // ── Tier 7: visual style keywords ────────────────────────────────────────
  if (STYLE_EDIT_PATTERNS.test(message)) return "style_edit";

  // ── Tier 8: moderate content verbs with no other signal ──────────────────
  // "change the title to Alpha" — no style keyword for "title" → content_edit
  if (MODERATE_CONTENT_VERBS.test(message)) return "content_edit";

  // ── Tier 9: bare revision anchor + quality/polish keyword ────────────────
  const hasRevisionAnchor = REVISION_ANCHORS.test(message);
  if (hasRevisionAnchor) {
    if (
      /\b(?:improve|polish|clean|better|nicer|prettier|professional|sharper)\b/i.test(lower)
    ) {
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
