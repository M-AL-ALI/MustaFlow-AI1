/**
 * Ora orchestrator — Phase 2 agent-runtime foundation.
 *
 * Ora is a STANDALONE AI assistant. It is NOT a router into the AI Builder /
 * Agent Zero pipeline and must never proactively hand off to it. This module is
 * the single decision point that decides which Ora tool answers a message, and
 * which plan tier may invoke it. Execution side-effects (credits, session
 * counters, cookies) stay in the route; this module is pure and testable.
 *
 * ISOLATION: must NOT import from builder.ts, ai.ts, jobs.ts, or any builder
 * pipeline module. It may only depend on the public-ai prompt helpers and the
 * Ora intent classifier.
 */
import { classifyIntent, type OraConfidence, type OraIntent, type OraTopic } from "./classifier";
import { detectFileRequest, type FileFormat } from "./prompt";

// ── Tool taxonomy ───────────────────────────────────────────────────────────

/**
 * The full set of capabilities Ora can route a message to. Tools marked
 * `planned` are registered for the runtime contract but executed by a later
 * phase; the router never selects a `planned` tool today.
 */
export type OraTool =
  | "answer"
  | "deep_thinking"
  | "search"
  | "file_analysis"
  | "dataset_analysis"
  | "image_analysis"
  | "image_generation"
  | "image_editing"
  | "file_generation"
  | "memory_lookup"
  | "memory_save_candidate"
  | "builder_handoff";

/** Minimum account level required to invoke a tool. */
export type OraToolAccess = "anon" | "free" | "paid";

export interface OraToolMeta {
  tool: OraTool;
  description: string;
  /** Minimum access level required to invoke this tool. */
  minAccess: OraToolAccess;
  /** Credit cost charged to authenticated users when this tool executes. */
  creditCost: number;
  /** `live` tools are wired for execution today; `planned` are reserved. */
  status: "live" | "planned";
}

export const ORA_TOOL_REGISTRY: Record<OraTool, OraToolMeta> = {
  answer: {
    tool: "answer",
    description: "Direct conversational answer (Instant mode).",
    minAccess: "anon",
    creditCost: 1,
    status: "live",
  },
  deep_thinking: {
    tool: "deep_thinking",
    description: "Slower, step-by-step reasoning (Deep mode). Paid plans only.",
    minAccess: "paid",
    creditCost: 5,
    status: "live",
  },
  file_generation: {
    tool: "file_generation",
    description: "Generate a downloadable CSV / XLSX / DOCX / PDF / PPTX file.",
    minAccess: "anon",
    creditCost: 2,
    status: "live",
  },
  image_generation: {
    tool: "image_generation",
    description: "Generate an image inline from a text description.",
    minAccess: "free",
    creditCost: 3,
    status: "live",
  },
  image_editing: {
    tool: "image_editing",
    description: "Edit a previously generated or uploaded image.",
    minAccess: "free",
    creditCost: 3,
    status: "planned",
  },
  image_analysis: {
    tool: "image_analysis",
    description: "Describe or answer questions about an attached image.",
    minAccess: "anon",
    creditCost: 2,
    status: "live",
  },
  file_analysis: {
    tool: "file_analysis",
    description: "Summarize or answer questions about an attached document.",
    minAccess: "anon",
    creditCost: 2,
    status: "live",
  },
  dataset_analysis: {
    tool: "dataset_analysis",
    description: "Analyze an attached CSV / spreadsheet dataset.",
    minAccess: "anon",
    creditCost: 2,
    status: "live",
  },
  search: {
    tool: "search",
    description: "Search the live web and answer grounded in cited sources.",
    minAccess: "free",
    creditCost: 1,
    status: "live",
  },
  memory_lookup: {
    tool: "memory_lookup",
    description: "Recall the user's saved Ora memories. Injected into context today.",
    minAccess: "free",
    creditCost: 0,
    status: "planned",
  },
  memory_save_candidate: {
    tool: "memory_save_candidate",
    description: "Detect a durable fact worth offering to save to memory.",
    minAccess: "free",
    creditCost: 0,
    status: "live",
  },
  builder_handoff: {
    tool: "builder_handoff",
    description:
      "Explicit, user-initiated handoff to the AI Builder. NEVER selected automatically by the router.",
    minAccess: "anon",
    creditCost: 0,
    status: "live",
  },
};

// ── Image-generation intent detection ───────────────────────────────────────

/**
 * Patterns that indicate the user wants an image generated (not analyzed).
 * Centralized here so the router is the single source of truth for image intent.
 */
export const ORA_IMAGE_PATTERNS: RegExp[] = [
  // Verb + optional filler + singular or plural visual noun
  /\b(generate|create|make|draw|render|produce|design|show\s+me)\s+(?:(?:me|us|my|you|a|an|some|few|the)\s+)*(?:images?|photos?|pictures?|illustrations?|artworks?|graphics?|visuals?|logos?|banners?|icons?|thumbnails?|avatars?|mockups?|posters?|flyers?|badges?|paintings?|portraits?|sketches?)\b/i,
  // Visual noun + preposition (describing what's in it)
  /\b(images?|photos?|pictures?|illustrations?|artworks?|graphic)\s+(of|showing|depicting|featuring|with)\b/i,
  // Image generation feature references
  /\bimage\s+(generation|studio|ai)\b/i,
  // AI art tool references
  /\b(dall-?e|stable\s+diffusion|midjourney|ai\s+art)\b/i,
  // "Can you generate/make/draw a picture/image/graphic"
  /\bcan\s+you\s+(generate|create|make|draw|render|produce|design)\b.*\b(images?|pictures?|photos?|visuals?|graphics?|illustrations?)\b/i,
];

export function isImageGenerationRequest(message: string): boolean {
  return ORA_IMAGE_PATTERNS.some((p) => p.test(message));
}

// ── Web-search intent detection ─────────────────────────────────────────────

/**
 * Conservative signals that a message needs CURRENT/live information and should
 * be answered by a real web search rather than the model's static knowledge.
 * Kept narrow on purpose so ordinary MustaFlow/product questions are NOT
 * hijacked into search.
 */
export const ORA_SEARCH_PATTERNS: RegExp[] = [
  // Explicit "search/look up/google the web/online/internet"
  /\b(search|look\s+up|google|browse|check)\s+(?:(?:on|the)\s+)?(?:web|online|internet|google)\b/i,
  /\bsearch\s+(?:for|the\s+web)\b/i,
  // "latest/current/recent/newest <thing>" where it implies fresh data
  /\b(latest|current|recent|newest|up[-\s]?to[-\s]?date|most\s+recent)\b.*\b(news|version|release|releases?|price|prices?|update|updates?|score|scores?|results?|stats?|standings?|data|figures?|rates?|headlines?)\b/i,
  /\bwhat(?:'?s| is| are)\s+(?:the\s+)?(?:latest|current|newest|most\s+recent)\b/i,
  // Time-anchored questions about volatile topics
  /\b(today|today'?s|this\s+(?:week|month|morning|year)|right\s+now|currently|at\s+the\s+moment)\b.*\b(news|weather|price|prices?|stock|stocks?|score|scores?|happening|headlines?|forecast|rate|rates?)\b/i,
  /\b(news|headlines?)\s+(?:about|on|for|today|this\s+week|right\s+now)\b/i,
  // Weather / forecast
  /\b(weather|forecast|temperature)\b.*\b(today|tomorrow|now|tonight|this\s+(?:week|weekend)|in\s+[a-z])/i,
  // Markets / finance
  /\b(stock\s+price|share\s+price|exchange\s+rate|crypto\s+price|bitcoin\s+price|ethereum\s+price|market\s+cap)\b/i,
  // Sports / events outcomes
  /\bwho\s+won\b/i,
  /\bas\s+of\s+(?:today|now|this\s+(?:week|month|year))\b/i,
];

export function isWebSearchRequest(message: string): boolean {
  return ORA_SEARCH_PATTERNS.some((p) => p.test(message));
}

// ── Routing ─────────────────────────────────────────────────────────────────

export interface OraRouteInput {
  message: string;
  mode: "instant" | "deep";
  /** Optional pre-computed classifier result (lets callers reuse one call). */
  classifier?: { intent: OraIntent; confidence: OraConfidence; topic: OraTopic };
  /**
   * Recent conversation turns (oldest→newest, excluding the current message).
   * Used to resolve short continuation replies ("yes", "go ahead", "still
   * waiting") back to a file the assistant just offered, so the file is actually
   * generated instead of the model merely claiming it delivered one.
   */
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

// Short affirmations / nudges that, on their own, carry no file request but are
// almost always a "yes, do the thing you just offered" reply. Kept deliberately
// tight (whole-message match, length-capped) to avoid hijacking real questions.
const FILE_CONTINUATION_PATTERNS: RegExp[] = [
  /^(yes|yeah|yep|yup|sure|ok|okay|please|please\s+do|do\s+it|go\s+ahead|go\s+for\s+it|proceed|continue|sounds\s+good|that\s+works|perfect|great)\b/i,
  /\b(make|create|generate|build|produce|send|give)\s+(it|me\s+one|that|one)\b/i,
  /\b(still\s+waiting|i'?m\s+waiting|where\s+is\s+it|i\s+don'?t\s+see\s+it|nothing\s+(showed|appeared)|didn'?t\s+(get|see)\s+it)\b/i,
];

// An explicit OFFER to generate a file in the assistant's last turn. We require
// this (not a bare format mention) so "here's how PDFs work" + a user "yes"
// can't spuriously trigger file generation. Matches "I can/I'll/would you like
// me to/want me to/shall I/let me … create/generate/make/build/put together/
// prepare/draft/whip up …" — the file noun/format is verified separately via
// detectFileRequest on the same message.
const ASSISTANT_FILE_OFFER_PATTERN =
  /\b(i\s+can|i'?ll|i\s+will|i\s+could|let\s+me|shall\s+i|would\s+you\s+like\s+me\s+to|want\s+me\s+to|do\s+you\s+want\s+me\s+to|happy\s+to)\b[^.?!]*\b(create|generate|make|build|put\s+together|prepare|draft|whip\s+up|export|produce|write\s+up)\b/i;

/**
 * Resolve a short continuation reply to the file format the assistant just
 * offered. Returns null unless ALL of the following hold:
 *  - the current message is a brief affirmation/nudge ("yes", "go ahead"), and
 *  - the most recent assistant turn explicitly OFFERED to generate a file, and
 *  - that same assistant turn names a concrete file format.
 *
 * This is intentionally narrow: it only inspects the single latest assistant
 * message (the one that prompted the reply), and a generic mention of a format
 * ("you could open it as a PDF") without an offer verb will NOT trigger it.
 */
function detectFileContinuation(
  message: string,
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>,
): FileFormat | null {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  if (!FILE_CONTINUATION_PATTERNS.some((p) => p.test(trimmed))) return null;

  // Only the single latest assistant turn (the one being replied to) counts.
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i];
    if (m.role !== "assistant") continue;
    if (!ASSISTANT_FILE_OFFER_PATTERN.test(m.content)) return null;
    return detectFileRequest(m.content);
  }
  return null;
}

export interface OraRouteDecision {
  tool: OraTool;
  reason: string;
  /** Set when tool === "file_generation". */
  fileFormat?: FileFormat;
  intent: OraIntent;
  confidence: OraConfidence;
  topic: OraTopic;
}

/**
 * Decide which tool should answer a text message.
 *
 * Fast-path regex first (file/image), then fall back to the LLM classifier for
 * model selection + suggestion topic. Critically: a build/"make me an app"
 * request is NOT refused and NOT handed off — it routes to `answer` /
 * `deep_thinking` so Ora responds as a standalone assistant. `builder_handoff`
 * is only ever reached through an explicit, user-initiated action elsewhere.
 */
export async function routeOraMessage(input: OraRouteInput): Promise<OraRouteDecision> {
  const { message, mode } = input;

  // 1. File generation fast-path (no classifier needed).
  const fileFormat = detectFileRequest(message);
  if (fileFormat) {
    return {
      tool: "file_generation",
      reason: `Detected a request for a ${fileFormat.toUpperCase()} file.`,
      fileFormat,
      // File requests don't need the classifier; report neutral defaults.
      intent: "premium",
      confidence: "high",
      topic: "general",
    };
  }

  // 1b. File generation continuation. A short "yes / go ahead / still waiting"
  //     reply to a turn where the assistant offered a specific file must
  //     actually generate it — otherwise it falls through to a conversational
  //     answer and the model only *claims* it delivered a file that never
  //     attached (the reported hallucinated-delivery bug).
  if (input.recentMessages?.length) {
    const continuationFormat = detectFileContinuation(message, input.recentMessages);
    if (continuationFormat) {
      return {
        tool: "file_generation",
        reason: `Continuation of an offered ${continuationFormat.toUpperCase()} file.`,
        fileFormat: continuationFormat,
        intent: "premium",
        confidence: "high",
        topic: "general",
      };
    }
  }

  // 2. Image generation fast-path.
  if (isImageGenerationRequest(message)) {
    return {
      tool: "image_generation",
      reason: "Detected an image generation request.",
      intent: "premium",
      confidence: "high",
      topic: "general",
    };
  }

  // 3. Web-search fast-path — current-info questions need live results. Runs
  //    before the instant/deep classifier so a grounded answer always wins over
  //    a (possibly stale) model-only reply, regardless of the selected mode.
  if (isWebSearchRequest(message)) {
    return {
      tool: "search",
      reason: "Detected a request for current/live information.",
      intent: "premium",
      confidence: "high",
      topic: "general",
    };
  }

  // 4. Conversational answer — classify for model selection + suggestion topic.
  const classifier = input.classifier ?? (await classifyIntent(message));
  const tool: OraTool = mode === "deep" ? "deep_thinking" : "answer";
  return {
    tool,
    reason:
      mode === "deep"
        ? "Deep Thinking requested for a conversational message."
        : "Conversational message answered directly by Ora.",
    intent: classifier.intent,
    confidence: classifier.confidence,
    topic: classifier.topic,
  };
}

// ── Plan gating ─────────────────────────────────────────────────────────────

export interface OraAccessContext {
  authed: boolean;
  isPaid: boolean;
}

/** Why a tool was denied, so the route can render the right CTA copy. */
export type OraDenyCode =
  | "deep_paid_only"
  | "image_signin_required"
  | "search_signin_required"
  | "tool_unavailable";

export interface OraAccessResult {
  allowed: boolean;
  denyCode?: OraDenyCode;
}

/**
 * Decide whether the current visitor/user may invoke the selected tool, based
 * on the tool's `minAccess` level and `status`. Returns a structured deny code
 * so the route can map it to user-facing copy without embedding plan logic.
 */
export function checkToolAccess(tool: OraTool, ctx: OraAccessContext): OraAccessResult {
  const meta = ORA_TOOL_REGISTRY[tool];

  if (meta.status !== "live") {
    return { allowed: false, denyCode: "tool_unavailable" };
  }

  switch (meta.minAccess) {
    case "anon":
      return { allowed: true };
    case "free":
      if (!ctx.authed) {
        // Free-min tools a visitor can hit via routing are image_generation and
        // search; surface the matching sign-in CTA for each.
        return {
          allowed: false,
          denyCode: tool === "search" ? "search_signin_required" : "image_signin_required",
        };
      }
      return { allowed: true };
    case "paid":
      if (!ctx.authed || !ctx.isPaid) {
        return { allowed: false, denyCode: "deep_paid_only" };
      }
      return { allowed: true };
  }
}

// ── Memory-save candidate detection (foundation) ────────────────────────────

// Explicit imperative "save this" phrasing. A match here is a HIGH-confidence
// signal the user actively wants this remembered — eligible for opt-in auto-save.
const MEMORY_SAVE_EXPLICIT_PATTERNS: RegExp[] = [
  /\b(?:please\s+)?remember\s+(?:that\s+)?/i,
  /\bdon'?t\s+forget\s+(?:that\s+)?/i,
  /\b(?:keep|make)\s+a\s+note\s+(?:that|of)\b/i,
  /\bfor\s+future\s+reference\b/i,
];

// Implicit durable facts the user stated in passing. Worth offering to save,
// but only as a LOW-confidence suggestion — never auto-saved.
const MEMORY_SAVE_IMPLICIT_PATTERNS: RegExp[] = [
  /\bmy\s+(?:name|company|business|product|preference|budget|timezone|stack)\s+is\b/i,
  /\bi\s+(?:prefer|always|usually)\b/i,
];

// Sensitive-data signals. A candidate matching ANY of these is treated as
// containing PII / credentials and is NEVER auto-saved — it always requires an
// explicit user click, even when the user used imperative "remember…" phrasing
// and has auto-save turned on. The patterns are deliberately broad (favouring a
// false positive that costs one extra click over silently auto-saving a secret).
const SENSITIVE_FACT_PATTERNS: RegExp[] = [
  // Email addresses
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  // Phone numbers (7+ digits, optional country code / separators incl. "(415) ")
  /(?:\+?\d[\s().-]{0,2}){7,}\d/,
  // Credit-card-like sequences (13–16 digits, optionally space/dash grouped)
  /\b(?:\d[ -]?){13,16}\b/,
  // US SSN-like
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Explicit secret labels followed by a value
  /\b(?:password|passcode|pin|api[\s_-]?key|secret|access[\s_-]?token|auth[\s_-]?token|private[\s_-]?key|seed[\s_-]?phrase|credit[\s_-]?card|card[\s_-]?number|cvv|routing[\s_-]?number|account[\s_-]?number|social[\s_-]?security)\b\s*(?:is|=|:|->)?\s*\S+/i,
  // Common API-key shapes (provider prefixes + long random token)
  /\b(?:sk|pk|rk|ghp|gho|xox[bap]|AKIA)[-_][A-Za-z0-9]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  // Street addresses: a house number followed by a street name + a street-type
  // suffix (e.g. "742 Evergreen Terrace", "10 Downing St"). The leading number
  // keeps benign location mentions like "I live in Berlin" from matching.
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|ter|circle|cir|square|sq|highway|hwy|parkway|pkwy|suite|ste|apartment|apt|unit)\b\.?/i,
  // Explicit address labels followed by a value.
  /\b(?:home\s+address|street\s+address|mailing\s+address|shipping\s+address|billing\s+address|zip\s*code|postal\s+code)\b\s*(?:is|=|:)?\s*\S+/i,
  // IBAN-style bank account identifiers (2-letter country + 2 check digits + body).
  /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/,
];

/**
 * Returns true when a piece of text looks like it contains sensitive
 * information (PII or credentials). Used to block auto-saving such facts to
 * memory without explicit confirmation.
 */
export function detectSensitiveFact(text: string): boolean {
  return SENSITIVE_FACT_PATTERNS.some((p) => p.test(text));
}

export interface MemorySaveCandidate {
  /** A short, declarative fact extracted from the user's message. */
  fact: string;
  /**
   * "high" when the user used explicit imperative phrasing ("remember that…",
   * "don't forget…"), making this eligible for opt-in auto-save. "low" for
   * facts merely stated in passing — surfaced as a suggestion only. A fact
   * flagged `sensitive` is always forced to "low" so it is never auto-saved.
   */
  confidence: "high" | "low";
  /**
   * True when the fact appears to contain PII or credentials. The UI surfaces a
   * warning and the auto-save path is disabled for these — they require an
   * explicit click to persist.
   */
  sensitive: boolean;
}

/**
 * Best-effort detection of a durable fact the user stated that may be worth
 * saving to their Ora memory. This is the FOUNDATION only — it surfaces a
 * candidate; it never persists anything on its own.
 */
export function detectMemorySaveCandidate(message: string): MemorySaveCandidate | null {
  const trimmed = message.trim();
  if (trimmed.length < 6 || trimmed.length > 400) return null;
  const isExplicit = MEMORY_SAVE_EXPLICIT_PATTERNS.some((p) => p.test(trimmed));
  const isImplicit = MEMORY_SAVE_IMPLICIT_PATTERNS.some((p) => p.test(trimmed));
  if (!isExplicit && !isImplicit) return null;

  // Strip a leading "remember that" / "don't forget" preamble so the stored
  // candidate reads as a clean fact.
  const fact = trimmed
    .replace(/^\s*(?:please\s+)?remember\s+(?:that\s+)?/i, "")
    .replace(/^\s*don'?t\s+forget\s+(?:that\s+)?/i, "")
    .replace(/^\s*(?:keep|make)\s+a\s+note\s+(?:that|of)\s+/i, "")
    .trim();

  const cleanFact = fact.length > 0 ? fact : trimmed;
  // Check the FULL message for sensitive data — the value may live in the
  // stripped preamble (e.g. "remember my password is …"). A sensitive fact is
  // always forced to low confidence so it can never be auto-saved.
  const sensitive = detectSensitiveFact(trimmed) || detectSensitiveFact(cleanFact);
  return {
    fact: cleanFact,
    confidence: sensitive ? "low" : isExplicit ? "high" : "low",
    sensitive,
  };
}
