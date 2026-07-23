/**
 * Lightweight client-side heuristic for detecting revision intent.
 *
 * This mirrors the server-side edit-intent-classifier logic in a deliberately
 * simplified form. It is used by the website and bubble components to
 * auto-reroute natural follow-up messages to the generate-file endpoint when
 * an active working artifact is tracked, so the user doesn't have to click
 * "Revise" manually.
 *
 * False positives are safe — the backend's edit engine will fall back to full
 * generation if it can't apply an in-place edit. False negatives mean the
 * user's follow-up misses the active-artifact path, which is the existing
 * baseline behavior.
 */
export function looksLikeFileRevision(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;

  // Explicit new-creation patterns — do not reroute to the revision engine.
  if (
    /\b(create\s+a\s+new|generate\s+a\s+new|make\s+a\s+new|write\s+a\s+new|build\s+a\s+new|start\s+over|from\s+scratch|completely\s+different)\b/.test(
      lower,
    )
  ) {
    return false;
  }

  // Strong content verbs (always revision intent)
  if (/\b(fix|correct|replace|rewrite|rephrase|reword|translate|proofread)\b/.test(lower)) {
    return true;
  }

  // Layout / structure / formula verbs
  if (
    /\b(reorder|rearrange|move|swap|remove|delete|insert|add\s+a|add\s+an|add\s+the|shorten|expand)\b/.test(
      lower,
    )
  ) {
    return true;
  }

  // Style / formatting keywords
  if (
    /\b(color|colour|font|bold|italic|theme|heading|format|spacing|margin|align|background)\b/.test(
      lower,
    )
  ) {
    return true;
  }

  // Moderate content verbs + a content/style target
  if (
    /\b(change|update|modify|edit|make)\b/.test(lower) &&
    /\b(title|heading|header|text|word|section|paragraph|color|colour|font|blue|red|green|dark|light)\b/.test(
      lower,
    )
  ) {
    return true;
  }

  // Formula / chart operations
  if (/\b(formula|chart|calculate|sum|average|total|pivot)\b/.test(lower)) {
    return true;
  }

  return false;
}
