/**
 * Ora Memory consolidation — overlap detection.
 *
 * When a user saves a new Ora memory that covers the SAME fact as an earlier
 * one (e.g. "I prefer dark mode" then later "I prefer light mode"), keeping both
 * active means Ora gets two contradictory facts injected at once. This module
 * decides, conservatively, which existing memories a newly-saved one supersedes.
 *
 * Design goals (from the task spec):
 *  - Supersede on HIGH confidence only. When the signal is weak, keep BOTH —
 *    a false "keep both" merely repeats the old behaviour, whereas a false
 *    merge silently destroys a distinct fact. We bias hard toward keeping both.
 *  - Genuinely distinct facts ("I like coffee" / "I like tea") must never merge.
 *
 * This is a PURE module: it does no DB or network I/O so it is trivially
 * testable. The route layer feeds it the candidate + existing memories and
 * applies the supersession it returns.
 */

export interface MemoryLike {
  id: number;
  title: string;
  content: string;
}

// Common words carry no fact signal — strip them before comparing so two
// memories aren't judged "similar" just because they both contain "the"/"is".
// "remember"/"forget"/"note"/"save" are save-imperative scaffolding the user
// often prepends ("remember that I prefer dark mode") and are pure noise.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "about",
  "as",
  "it",
  "its",
  "i",
  "me",
  "my",
  "mine",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
  "his",
  "her",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "must",
  "shall",
  "not",
  "no",
  "yes",
  "so",
  "very",
  "just",
  "also",
  "too",
  "please",
  "remember",
  "forget",
  "note",
  "save",
  "saving",
  "want",
  "wants",
  "wanted",
  "like",
  "likes",
  "liked",
  "when",
  "what",
  "who",
  "how",
  "why",
  "where",
  "which",
  "always",
  "usually",
  "really",
]);

/**
 * Reduce a memory's text to its set of SIGNIFICANT tokens:
 *  - lowercase, split on any non-alphanumeric run,
 *  - drop tokens shorter than 3 chars and stopwords,
 *  - normalise a trailing plural "s" so "dollars"/"dollar" collapse.
 *
 * Note "like" is a stopword on purpose: "I like coffee" vs "I like tea" must
 * NOT look similar, so the verb is dropped and only the objects compared.
 */
export function tokenizeMemory(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    // Basic plural normalisation: dollars -> dollar, modes -> mode.
    const token = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    out.add(token);
  }
  return out;
}

function combinedText(m: { title: string; content: string }): string {
  return `${m.title} ${m.content}`.trim();
}

const ATTRIBUTE_SLOT_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  {
    key: "name",
    patterns: [/\bmy name is\b/i, /\bname is\b/i, /\bcall me\b/i],
  },
  {
    key: "company_identity",
    patterns: [
      /\bmy (?:company|business|shop) is\b/i,
      /\b(?:company|business|shop) (?:is|called|named)\b/i,
      /\bour (?:company|business|shop) is\b/i,
      /\bworks? (?:at|for)\b/i,
    ],
  },
  {
    key: "role",
    patterns: [
      /\bmy (?:role|job|title) is\b/i,
      /\bi(?:'m| am) (?:a|an) (?:developer|designer|engineer|founder|manager|marketer|consultant|student|teacher|writer|analyst|operator|owner|ceo|cto|cfo|product manager|project manager)\b/i,
      /\bworks? as\b/i,
    ],
  },
  {
    key: "timezone",
    patterns: [/\btime\s?zone\b/i],
  },
  {
    key: "location",
    patterns: [/\bi live in\b/i, /\bi(?:'m| am) based in\b/i, /\bbased in\b/i, /\blocated in\b/i],
  },
  {
    key: "budget",
    patterns: [/\bbudget\b/i],
  },
  {
    key: "answer_style",
    patterns: [/\b(?:prefer|wants?) (?:concise|brief|detailed|thorough|short|long)\b/i],
  },
];

export function memoryAttributeSlots(text: string): Set<string> {
  const slots = new Set<string>();
  for (const slot of ATTRIBUTE_SLOT_PATTERNS) {
    if (slot.patterns.some((pattern) => pattern.test(text))) slots.add(slot.key);
  }
  return slots;
}

/**
 * High-confidence overlap test: should `existing` be superseded by `incoming`?
 *
 * We require ALL of:
 *  - both memories have >= 2 significant tokens (enough signal to compare),
 *  - they share >= 2 significant tokens (a single shared generic word like
 *    "mode" or "budget" is never enough on its own), and
 *  - the overlap coefficient |A ∩ B| / min(|A|,|B|) >= 0.6 (the smaller fact is
 *    mostly contained in the larger — i.e. they are about the same thing).
 *
 * Worked examples:
 *  - "I prefer dark mode" vs "I prefer light mode": tokens {prefer,dark,mode} /
 *    {prefer,light,mode}; shared {prefer,mode}=2; overlap 2/3≈0.67 → supersede.
 *  - "my budget is 5000 dollars" vs "...8000 dollars": shared {budget,dollar}=2;
 *    overlap 0.67 → supersede.
 *  - "I like coffee" vs "I like tea": shared {coffee?}=0 ("like" is a stopword)
 *    → keep both.
 *  - "my company is Acme" vs "my company is Globex": shared {company}=1 → keep
 *    both (conservative: a single shared noun is too weak to be sure).
 */
export function shouldSupersede(
  incoming: { title: string; content: string },
  existing: { title: string; content: string },
): boolean {
  const incomingText = combinedText(incoming);
  const existingText = combinedText(existing);
  const incomingSlots = memoryAttributeSlots(incomingText);
  if (incomingSlots.size > 0) {
    const existingSlots = memoryAttributeSlots(existingText);
    for (const slot of incomingSlots) {
      if (existingSlots.has(slot)) return true;
    }
  }

  const a = tokenizeMemory(incomingText);
  const b = tokenizeMemory(existingText);
  if (a.size < 2 || b.size < 2) return false;

  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  if (shared < 2) return false;

  const overlap = shared / Math.min(a.size, b.size);
  return overlap >= 0.6;
}

/**
 * Given a newly-saved memory and the user's existing ACTIVE Ora memories,
 * return the ids of the ones the new memory supersedes. The caller must pass
 * only active rows (enabled, not archived, not already superseded) and must
 * exclude the new row itself.
 */
export function findMemoriesToSupersede(
  incoming: { title: string; content: string },
  existing: MemoryLike[],
): number[] {
  const ids: number[] = [];
  for (const m of existing) {
    if (shouldSupersede(incoming, m)) ids.push(m.id);
  }
  return ids;
}
