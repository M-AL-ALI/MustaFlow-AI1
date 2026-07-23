import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  markSessionAsPreIncremented,
  acknowledgeStreamingIncrement,
  setSessionCookie,
  createStreamFallbackToken,
  verifyStreamFallbackToken,
  MSG_LIMIT_VALUE,
  type OraSessionPayload,
} from "../../lib/public-ai/session";
import {
  scanUserInput,
  ORA_SYSTEM_PROMPT,
  buildCurrentDateTimeBlock,
  isPastedReferenceAnalysisRequest,
  summarizePastedReferenceSignals,
  detectClaimedFileDelivery,
} from "../../lib/public-ai/prompt";

import { classifyIntent, CLASSIFIER_FALLBACK, type OraTopic } from "../../lib/public-ai/classifier";
import {
  routeOraMessage,
  checkToolAccess,
  extractMemorySaveCandidate,
} from "../../lib/public-ai/orchestrator";
import { resolveFinalOraRoute } from "../../lib/public-ai/route-resolution";
import {
  planOraClarification,
  resolveClarificationContinuation,
} from "../../lib/public-ai/clarification-planner";
import { oraPendingClarificationSchema } from "@workspace/ora-contracts";
import type { AuthedOraUser } from "../../lib/public-ai/authed-user";
import type { Provider } from "../../lib/ai-provider-config";
import type { OraVideo } from "../../lib/public-ai/web-search";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  openAiModelForOraRoute,
  selectOraModelRoute,
  runCandidateChain,
  assertNonEmptyCompletion,
  type OraRouteTier,
  type OraPlanTier,
  type ModelCandidate,
} from "../../lib/public-ai/model-router";
import {
  buildCarriedDocumentContext,
  resolveCarriedFileMeta,
  type CarriedFileMeta,
} from "../../lib/public-ai/carried-docs";
import { buildFileAgentPreview } from "../../lib/public-ai/file-agent-preview";
import {
  buildFileCitationAllowList,
  buildSourceCitationAddendum,
  deriveFileCitations,
} from "../../lib/public-ai/source-citations";
import { planOraMultiFile, resolveNamedEditTarget } from "../../lib/public-ai/multi-file-planner";
import { buildOraExpertiseProfile } from "../../lib/public-ai/expertise";
import { buildOraImageGenerationProfile } from "../../lib/public-ai/image-quality";
import { generateEmbedding, cosineSimilarity, buildEmbeddingInput } from "../../lib/embeddings";
import { eq, and, isNull, isNotNull, ne, desc, sql } from "drizzle-orm";
import type { SubscriptionTier } from "@workspace/db";
import type { OraQuotaKind } from "../../lib/public-ai/ora-usage";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { withTimeout } from "../../lib/public-ai/stream-adapter";

// Authenticated Ora users are metered by per-user ROLLING-WINDOW quotas per
// subscription tier (TIER_ORA_MESSAGE_LIMIT / TIER_ORA_IMAGE_LIMIT) — NOT by the
// AI Builder credit wallet. Anonymous visitors keep the per-session cap.

async function oraMessageLimit(tier: string): Promise<number> {
  const { TIER_ORA_MESSAGE_LIMIT } = await import("@workspace/db");
  return TIER_ORA_MESSAGE_LIMIT[tier as SubscriptionTier] ?? TIER_ORA_MESSAGE_LIMIT.free;
}

function oraPlanTier(authed: AuthedOraUser | null): OraPlanTier {
  return normalizeOraPlanTier(authed?.tier ?? null);
}

function isNonEnglishLanguage(value: string | undefined): boolean {
  if (!value || value === "auto") return false;
  const primary = value.split(",")[0].trim().split("-")[0].toLowerCase();
  return !!primary && primary !== "en";
}

/**
 * Lightweight sync heuristics used by the Instant fast-lane to detect prompts
 * that carry a special-intent signal and MUST NOT skip the classifier.
 * Conservative: a false negative (missing intent) just falls through to the
 * normal classifier path; a false positive is fine (fast-lane is opt-in).
 */
function looksLikeImageGenerationIntent(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /\b(generate|create|draw|make|design|paint|render|show me)\b/.test(m) &&
    /\b(image|photo|picture|pic|illustration|artwork|logo|icon|avatar|banner|poster)\b/.test(m)
  );
}
function looksLikeWebSearchIntent(msg: string): boolean {
  const m = msg.toLowerCase();
  return /\b(search|find online|look up|google|browse|what.{0,5}(latest|current|recent|today|news))\b/.test(
    m,
  );
}
function looksLikeFileGenIntent(msg: string): boolean {
  const m = msg.toLowerCase();
  return /\b(pdf|csv|excel|spreadsheet|docx|pptx|presentation)\b/.test(m);
}

/**
 * Build the usage fields returned to the client. For signed-in users this
 * reflects current rolling-window message/image usage + reset time; for
 * anonymous visitors it reflects the per-session message counter.
 */
async function oraUsageResponse(
  authed: AuthedOraUser | null,
  sessionMsgCount: number,
): Promise<Record<string, number | string | null>> {
  if (!authed) return { msgCount: sessionMsgCount, msgLimit: MSG_LIMIT_VALUE, resetsAt: null };
  const { getOraUsage } = await import("../../lib/public-ai/ora-usage");
  const u = await getOraUsage(authed.userId, authed.tier);
  return {
    msgCount: u.messageCount,
    msgLimit: u.messageLimit,
    imageCount: u.imageCount,
    imageLimit: u.imageLimit,
    resetsAt: u.resetsAt,
  };
}

async function refundOraQuotaFor(
  authed: AuthedOraUser | null,
  quotaKind: OraQuotaKind,
): Promise<void> {
  if (!authed) return;
  const { refundOraQuota } = await import("../../lib/public-ai/ora-usage");
  await refundOraQuota(authed.userId, quotaKind);
}

const DEEP_SYSTEM_ADDENDUM = `\n\n## Deep Thinking mode\nYou are in DEEP THINKING mode. Be careful and substantive, but do not be verbose by default. Answer first with the clearest recommendation or conclusion, then add the reasoning, trade-offs, edge cases, sequencing, and verification steps only as much as the task warrants. Prefer concrete specifics (data models, flows, calculations, risks, next actions) over generalities. Keep length proportional to complexity: simple comparisons should be compact, medium planning answers should be structured but not padded, and only genuinely complex analysis should be long. Treat the token budget as a ceiling, not a target. Stop when the useful answer is complete.`;

/**
 * Prepended to a reply when live web search failed and we answered from the
 * model's own knowledge instead of a dead error banner. Honest about the
 * degradation — never claims the answer is verified or 100% accurate.
 */
const SEARCH_FALLBACK_NOTE =
  "I couldn't verify live web results right now, so I'm answering from general knowledge.\n\n";

/**
 * Freshness-critical variant of the fallback note, used when the query needed
 * CURRENT information (news, "today", "latest", live prices). In that case a
 * general-knowledge answer must NOT be presented as today's verified headlines,
 * so this note is explicit that the latest could not be confirmed and points the
 * user at the Retry affordance to run a live search again. Any background that
 * follows is framed as possibly out of date. Kept clutter-free per the product
 * copy rule: no markdown, no bold.
 */
const SEARCH_FALLBACK_NOTE_FRESH =
  "I couldn't verify live results right now, so I can't confirm the latest. Tap Retry live search below to try again. Here's some general background in the meantime, which may be out of date:\n\n";

// ── Saved-memory retrieval (relevance-ranked) ────────────────────────────────

/**
 * Budget for the saved-memories block, in characters (~4 chars/token). Reuses
 * the shared knowledge token budget so Ora memory and the Builder vault stay
 * tuned together. Replaces the old hard 15-entry recency cap.
 */
const ORA_MEMORY_CHAR_BUDGET = parseInt(process.env.KNOWLEDGE_TOKEN_BUDGET ?? "2400", 10);
/** Hard ceiling on injected memories regardless of how small each one is. */
const ORA_MEMORY_MAX_ENTRIES = 30;
/** Candidate pool cap so a huge memory store doesn't blow up scoring cost. */
const ORA_MEMORY_CANDIDATE_LIMIT = 200;
/** Max embeddings backfilled per retrieval (fire-and-forget). */
const ORA_MEMORY_BACKFILL_PER_CALL = 8;
/** Weight applied to cosine similarity, mirroring the Builder vault. */
const ORA_MEMORY_SEMANTIC_WEIGHT = 6.0;
/** Max time we'll wait for the query embedding before falling back to TF-IDF. */
const ORA_MEMORY_EMBED_TIMEOUT_MS = 2500;
/**
 * Share of the recall budget reserved for the CURRENT project's memories in a
 * project chat (Phase 7 blend). Project facts rank first against this reserve
 * so a relevant project memory always survives; global memories fill the
 * remainder plus any unused reserve. Tunable via the
 * ORA_PROJECT_MEMORY_RESERVE env var (0..1); defaults to 0.45.
 */
function resolveProjectMemoryReserve(): number {
  const raw = Number.parseFloat(process.env.ORA_PROJECT_MEMORY_RESERVE ?? "");
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return 0.45;
}
const ORA_PROJECT_MEMORY_RESERVE = resolveProjectMemoryReserve();

export interface OraMemoryRecallProfile {
  planTier: OraPlanTier;
  charBudget: number;
  maxEntries: number;
  candidateLimit: number;
  semanticWeight: number;
  categoryBaseBoost: Record<string, number>;
  categoryMatchBoost: number;
}

export interface OraMemoryRow {
  id: number;
  title: string;
  content: string;
  category: string | null;
  embedding: number[] | null;
  createdAt: Date;
}

/**
 * Soft, additive boost applied per memory category during ranking. Sized to the
 * same magnitude as the recency tiebreakers (0.15–0.3) so it nudges ordering —
 * e.g. surfaces preferences and personal facts that should usually be in scope —
 * without ever overriding a strong semantic/keyword relevance signal (semantic
 * weight is 6.0). Categories not listed get no boost.
 */
const ORA_MEMORY_CATEGORY_BOOST: Record<string, number> = {
  preference: 0.25,
  personal: 0.15,
};

export function resolveOraMemoryRecallProfile(
  subscriptionTier?: string | null,
): OraMemoryRecallProfile {
  const planTier = normalizeOraPlanTier(subscriptionTier);
  if (planTier === "wave") {
    return {
      planTier,
      charBudget: Math.round(ORA_MEMORY_CHAR_BUDGET * 1.8),
      maxEntries: 50,
      candidateLimit: 350,
      semanticWeight: 7.0,
      categoryBaseBoost: { preference: 0.35, personal: 0.25, project: 0.2, document: 0.15 },
      categoryMatchBoost: 0.75,
    };
  }
  if (planTier === "core") {
    return {
      planTier,
      charBudget: Math.round(ORA_MEMORY_CHAR_BUDGET * 1.35),
      maxEntries: 38,
      candidateLimit: 260,
      semanticWeight: 6.5,
      categoryBaseBoost: { preference: 0.3, personal: 0.2, project: 0.15, document: 0.1 },
      categoryMatchBoost: 0.55,
    };
  }
  return {
    planTier,
    charBudget: ORA_MEMORY_CHAR_BUDGET,
    maxEntries: ORA_MEMORY_MAX_ENTRIES,
    candidateLimit: ORA_MEMORY_CANDIDATE_LIMIT,
    semanticWeight: ORA_MEMORY_SEMANTIC_WEIGHT,
    categoryBaseBoost: ORA_MEMORY_CATEGORY_BOOST,
    categoryMatchBoost: 0.35,
  };
}

export function inferMemoryQueryCategories(message: string): Set<string> {
  const text = message.toLowerCase();
  const categories = new Set<string>();
  if (
    /\b(prefer|preference|favorite|favourite|tone|style|format|theme|dark mode|light mode|concise|verbose|answer)\b/.test(
      text,
    )
  ) {
    categories.add("preference");
  }
  if (
    /\b(name|role|job|title|company|business|location|live|based|timezone|time zone|language|about me|who am i)\b/.test(
      text,
    )
  ) {
    categories.add("personal");
  }
  if (
    /\b(project|app|product|stack|database|repo|client|customer|launch|feature|deadline|integration)\b/.test(
      text,
    )
  ) {
    categories.add("project");
  }
  if (/\b(document|file|upload|pdf|docx|spreadsheet|csv|xlsx|deck|report)\b/.test(text)) {
    categories.add("document");
  }
  return categories;
}

// Answer-style conflict vocabulary for saved memory recall.
const CONCISE_STYLE_TERMS = [
  "direct",
  "minimum",
  "minimal",
  "concise",
  "brief",
  "short",
  "to the point",
  "straight to the point",
  "no fluff",
];

const DETAILED_STYLE_TERMS = [
  "detailed",
  "thorough",
  "full breakdown",
  "long form",
  "long-form",
  "verbose",
  "step by step",
  "step-by-step",
  "deep explanation",
  "explain the reasoning",
];

function mentionsAnyPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function statesCurrentPreference(text: string): boolean {
  return /\b(?:i\s+(?:now\s+)?prefer|i\s+(?:want|need|like)\s+you\s+to|from\s+now\s+on|going\s+forward|actually,\s*i\s+prefer|please\s+(?:answer|respond|keep)|change\s+(?:my\s+)?(?:answer\s+)?style|switch\s+(?:my\s+)?(?:answer\s+)?style)\b/i.test(
    text,
  );
}

/**
 * Avoid surfacing stale saved preferences when the current user message states
 * a different preference. This keeps `memoriesUsed` honest: it should only show
 * memories that were eligible to shape the answer, not facts the model was told
 * to ignore because the user just changed direction.
 */
export function memoryConflictsWithCurrentMessage(
  memory: Pick<OraMemoryRow, "title" | "content" | "category">,
  currentMessage?: string,
): boolean {
  const message = currentMessage?.trim().toLowerCase() ?? "";
  if (!message || !statesCurrentPreference(message)) return false;

  const category = memory.category?.toLowerCase() ?? "";
  const memoryText = `${memory.title} ${memory.content}`.toLowerCase();
  const looksLikeStyleMemory =
    category === "preference" ||
    /\b(answer|reply|response|tone|style|concise|brief|direct|detailed|verbose|step[-\s]?by[-\s]?step)\b/.test(
      memoryText,
    );
  if (!looksLikeStyleMemory) return false;

  const currentWantsConcise = mentionsAnyPhrase(message, CONCISE_STYLE_TERMS);
  const currentWantsDetailed = mentionsAnyPhrase(message, DETAILED_STYLE_TERMS);
  const memoryWantsConcise = mentionsAnyPhrase(memoryText, CONCISE_STYLE_TERMS);
  const memoryWantsDetailed = mentionsAnyPhrase(memoryText, DETAILED_STYLE_TERMS);

  return (
    (currentWantsConcise && memoryWantsDetailed) || (currentWantsDetailed && memoryWantsConcise)
  );
}

/** Lowercase tokens (≥3 chars) for TF-IDF keyword overlap. */
export function tokeniseMemory(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.:;_\-/()[\]{}'"!?]+/)
    .filter((w) => w.length >= 3);
}

/**
 * Take memories from an already-ordered list until the character budget or the
 * max-entry ceiling is hit. Always keeps at least the first entry so recall
 * never silently returns nothing when a single memory exceeds the budget.
 */
export function selectMemoriesWithinBudget(
  ordered: OraMemoryRow[],
  profile: OraMemoryRecallProfile = resolveOraMemoryRecallProfile(),
): OraMemoryRow[] {
  const selected: OraMemoryRow[] = [];
  let chars = 0;
  for (const r of ordered) {
    if (selected.length >= profile.maxEntries) break;
    const cost = r.title.length + (r.content?.length ?? 0) + 4;
    if (selected.length > 0 && chars + cost > profile.charBudget) break;
    selected.push(r);
    chars += cost;
  }
  return selected;
}

/**
 * Best-effort embedding of the current prompt, raced against a short timeout.
 * Returns null on any failure or slow provider — recall then degrades to
 * TF-IDF; it never blocks or noticeably slows the reply.
 */
async function embedPromptBestEffort(trimmed: string): Promise<number[] | null> {
  try {
    return await Promise.race([
      generateEmbedding(trimmed),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ORA_MEMORY_EMBED_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

/**
 * Rank memories by relevance to the current message, following the Builder
 * vault's approach: semantic cosine similarity when an entry has an embedding,
 * per-entry TF-IDF keyword overlap as a fallback, plus a light recency
 * tiebreaker. When NO entry produces any relevance signal (e.g. embeddings are
 * unavailable and there is zero keyword overlap), it degrades to a pure recency
 * ordering so recall behaves at least as well as the old path.
 */
export async function rankMemoriesByRelevance(
  rows: OraMemoryRow[],
  message: string,
  profile: OraMemoryRecallProfile = resolveOraMemoryRecallProfile(),
  promptEmbeddingOverride?: number[] | null,
): Promise<OraMemoryRow[]> {
  const trimmed = message.trim();
  if (trimmed.length === 0) return selectMemoriesWithinBudget(rows, profile);

  // Best-effort prompt embedding, raced against a short timeout. On any failure
  // OR if the provider is slow, we fall back to TF-IDF for every entry — never
  // block or noticeably slow the reply on the embedding provider. Callers that
  // rank multiple pools for the same message (e.g. the project + global blend
  // in buildMemoryContext) pass a precomputed embedding so the prompt is only
  // embedded once per reply.
  const promptEmbedding =
    promptEmbeddingOverride !== undefined
      ? promptEmbeddingOverride
      : await embedPromptBestEffort(trimmed);

  const promptTokens = tokeniseMemory(trimmed);
  const queryCategories = inferMemoryQueryCategories(trimmed);
  const rowTokens = rows.map((e) => tokeniseMemory(`${e.title} ${e.content}`));
  const N = rows.length;

  // Document frequency for each unique query token (for TF-IDF idf).
  const df = new Map<string, number>();
  for (const t of new Set(promptTokens)) {
    let count = 0;
    for (const toks of rowTokens) if (toks.includes(t)) count++;
    df.set(t, count);
  }

  const now = Date.now();
  const ONE_DAY_MS = 86_400_000;
  const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

  let anySignal = false;
  const scored = rows.map((e, i) => {
    let score = 0;
    let signal = false;

    const entryEmbedding = e.embedding;
    if (
      promptEmbedding &&
      Array.isArray(entryEmbedding) &&
      entryEmbedding.length === promptEmbedding.length
    ) {
      // Primary: semantic similarity.
      const sim = cosineSimilarity(promptEmbedding, entryEmbedding);
      score += sim * profile.semanticWeight;
      if (sim > 0.05) signal = true;
    } else {
      // Fallback: TF-IDF keyword overlap (per-entry, graceful).
      const toks = rowTokens[i];
      const counts = new Map<string, number>();
      for (const w of toks) counts.set(w, (counts.get(w) ?? 0) + 1);
      let tfidf = 0;
      for (const t of promptTokens) {
        const tc = counts.get(t);
        if (tc) {
          const tf = tc / Math.max(toks.length, 1);
          const idf = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
          tfidf += tf * idf;
        }
      }
      score += tfidf;
      if (tfidf > 0) signal = true;
    }

    // Light recency tiebreaker — relevance dominates, recency breaks ties.
    const ageMs = now - new Date(e.createdAt).getTime();
    if (ageMs < ONE_DAY_MS) score += 0.3;
    else if (ageMs < SEVEN_DAYS_MS) score += 0.15;

    // Soft category signal: gently favour categories that should usually be in
    // scope (preferences, personal facts). Additive and small — never sets the
    // relevance `signal`, so it can't manufacture a match where none exists.
    if (e.category) {
      score += profile.categoryBaseBoost[e.category] ?? 0;
      if (queryCategories.has(e.category)) score += profile.categoryMatchBoost;
    }

    if (signal) anySignal = true;
    return { entry: e, score };
  });

  // No relevance signal anywhere → preserve the recency-based floor.
  if (!anySignal) return selectMemoriesWithinBudget(rows, profile);

  scored.sort((a, b) => b.score - a.score);
  return selectMemoriesWithinBudget(
    scored.map((s) => s.entry),
    profile,
  );
}

/**
 * Lazily backfill embeddings for Ora memories that lack them so future
 * retrievals can use semantic similarity. Fire-and-forget and strictly bounded
 * — never awaited, never blocks the reply, and silently no-ops when the
 * embedding provider is unavailable. Does NOT change how memories are saved.
 */
function backfillMemoryEmbeddings(rows: OraMemoryRow[]): void {
  const missing = rows
    .filter((r) => !Array.isArray(r.embedding) || r.embedding.length === 0)
    .slice(0, ORA_MEMORY_BACKFILL_PER_CALL);
  if (missing.length === 0) return;
  void (async () => {
    let dbModule: typeof import("@workspace/db");
    try {
      dbModule = await import("@workspace/db");
    } catch {
      return;
    }
    const { db, knowledgeEntriesTable } = dbModule;
    for (const m of missing) {
      try {
        const input = buildEmbeddingInput(m.title, m.content).trim();
        if (input.length === 0) continue;
        const vec = await generateEmbedding(input);
        await db
          .update(knowledgeEntriesTable)
          .set({ embedding: vec })
          .where(eq(knowledgeEntriesTable.id, m.id));
      } catch {
        // Best-effort — a later retrieval will retry the backfill.
      }
    }
  })();
}

/**
 * A saved Ora memory that was injected into a given reply's context. Surfaced
 * to the client (Ora-scoped only) so the UI can show which memories shaped the
 * answer and deep-link them to the Memory Center. Carries only the memory id +
 * its short title — never AI Builder / project data.
 */
export interface OraMemoryUsed {
  id: number;
  title: string;
}

/** Result of building the saved-memory context block for a reply. */
export interface MemoryContextResult {
  /** The formatted context block appended to the system prompt (or ""). */
  text: string;
  /** The memories actually injected, for client-side transparency. */
  used: OraMemoryUsed[];
}

/**
 * Fetch the user's saved Ora memories and format them as a compact context
 * block for the system prompt. Returns an empty block + empty `used` list when
 * there is nothing to inject.
 *
 * When the current message is provided, memories are RELEVANCE-RANKED (semantic
 * similarity primary, TF-IDF fallback, recency tiebreaker) so older-but-relevant
 * facts are recalled even past the old 15-entry recency window. Without a
 * message, it falls back to a budget-aware recency ordering.
 *
 * SCOPE MODEL (Phase 7): global (user-level) memories apply everywhere; a
 * project chat blends them with that project's memories via a reserved
 * sub-budget for project facts. Other projects' memories never appear, and
 * standalone chats never see project-scoped facts.
 *
 * ISOLATION: Ora is a standalone assistant kept fully separate from the AI
 * Builder. This intentionally injects ONLY user-approved Ora memories
 * (scope="user" AND origin="ora"). It must never pull AI Builder Knowledge Vault
 * entries — neither project-scoped build/refine notes nor Builder-generated
 * user-scope style memories / brand profiles (origin="builder") — into Ora's
 * context, which would leak Builder engineering knowledge into Ora.
 */
export async function buildMemoryContext(
  userId: string,
  oraProjectId?: number | null,
  currentMessage?: string,
  subscriptionTier?: string | null,
): Promise<MemoryContextResult> {
  try {
    const { db, knowledgeEntriesTable, oraProjectsTable } = await import("@workspace/db");
    const profile = resolveOraMemoryRecallProfile(subscriptionTier);
    // SCOPE MODEL (Phase 7): global (user-level) memories apply EVERYWHERE —
    // standalone chats and every project chat. Project memories apply ONLY
    // inside their own project. A project chat therefore blends global +
    // that-project memories; other projects' memories are never pulled, and a
    // standalone chat never sees project-scoped facts.
    const isProjectChat = typeof oraProjectId === "number";

    // A project chat must belong to a project the caller actually owns (and
    // that is not archived). An unowned/unknown project injects NOTHING — not
    // even global memories — so a forged projectId can never harvest context.
    if (isProjectChat) {
      const [owned] = await db
        .select({ id: oraProjectsTable.id })
        .from(oraProjectsTable)
        .where(
          and(
            eq(oraProjectsTable.id, oraProjectId),
            eq(oraProjectsTable.userId, userId),
            isNull(oraProjectsTable.archivedAt),
          ),
        )
        .limit(1);
      if (!owned) return { text: "", used: [] };
    }

    const baseMemoryFilter = [
      eq(knowledgeEntriesTable.userId, userId),
      eq(knowledgeEntriesTable.scope, "user"),
      eq(knowledgeEntriesTable.origin, "ora"),
      // Respect the Memory Center "pause" toggle: paused memories are kept
      // but excluded from Ora's context.
      eq(knowledgeEntriesTable.enabled, true),
      // Consolidation: never inject a memory that a newer fact superseded —
      // only the current version of a fact reaches Ora's context.
      isNull(knowledgeEntriesTable.supersededBy),
      isNull(knowledgeEntriesTable.archivedAt),
    ];
    const memorySelection = {
      id: knowledgeEntriesTable.id,
      title: knowledgeEntriesTable.title,
      content: knowledgeEntriesTable.content,
      category: knowledgeEntriesTable.category,
      embedding: knowledgeEntriesTable.embedding,
      createdAt: knowledgeEntriesTable.createdAt,
    };

    // Global (user-level) memories — recalled in every chat.
    const userRowsPromise = db
      .select(memorySelection)
      .from(knowledgeEntriesTable)
      .where(and(...baseMemoryFilter, isNull(knowledgeEntriesTable.oraProjectId)))
      .orderBy(desc(knowledgeEntriesTable.createdAt))
      .limit(profile.candidateLimit);

    // Project memories persist across every conversation in an Ora project
    // (ownership already verified above). Only the CURRENT project's memories
    // are ever pulled — no cross-project leakage.
    const projectRowsPromise = isProjectChat
      ? db
          .select(memorySelection)
          .from(knowledgeEntriesTable)
          .where(and(...baseMemoryFilter, eq(knowledgeEntriesTable.oraProjectId, oraProjectId)))
          .orderBy(desc(knowledgeEntriesTable.createdAt))
          .limit(profile.candidateLimit)
      : Promise.resolve([] as OraMemoryRow[]);

    const [userRows, projectRows] = await Promise.all([userRowsPromise, projectRowsPromise]);

    const globalPool = userRows.filter(
      (row) => !memoryConflictsWithCurrentMessage(row, currentMessage),
    );
    const projectPool = projectRows.filter(
      (row) => !memoryConflictsWithCurrentMessage(row, currentMessage),
    );
    if (globalPool.length === 0 && projectPool.length === 0) return { text: "", used: [] };

    const trimmedMessage = currentMessage?.trim() ?? "";
    const hasMessage = trimmedMessage.length > 0;
    // Embed the prompt ONCE and share it across both ranking passes so the
    // blend never doubles embedding latency/cost on the pre-reply path.
    const promptEmbedding = hasMessage ? await embedPromptBestEffort(trimmedMessage) : null;
    const rankPool = async (
      pool: OraMemoryRow[],
      poolProfile: OraMemoryRecallProfile,
    ): Promise<OraMemoryRow[]> =>
      hasMessage
        ? rankMemoriesByRelevance(pool, currentMessage ?? "", poolProfile, promptEmbedding)
        : selectMemoriesWithinBudget(pool, poolProfile);

    let selected: OraMemoryRow[];
    if (!isProjectChat || projectPool.length === 0) {
      // Single-tier: standalone chats (or a project chat with no project
      // memories yet) rank the global pool against the full budget.
      selected = await rankPool(globalPool, profile);
    } else {
      // Blend via sub-budgets: project memories rank first against a reserved
      // share of the budget so relevant project facts always survive, then
      // global memories fill the remainder (plus any unused reserve). This is
      // deterministic — no score-boost constants to tune.
      const reserveProfile: OraMemoryRecallProfile = {
        ...profile,
        charBudget: Math.max(1, Math.floor(profile.charBudget * ORA_PROJECT_MEMORY_RESERVE)),
        maxEntries: Math.max(1, Math.ceil(profile.maxEntries / 2)),
      };
      const selectedProject = await rankPool(projectPool, reserveProfile);
      const usedChars = selectedProject.reduce(
        (sum, r) => sum + r.title.length + (r.content?.length ?? 0) + 4,
        0,
      );
      const remainingEntries = profile.maxEntries - selectedProject.length;
      const remainingChars = profile.charBudget - usedChars;
      const selectedGlobal =
        remainingEntries > 0 && remainingChars > 0 && globalPool.length > 0
          ? await rankPool(globalPool, {
              ...profile,
              charBudget: remainingChars,
              maxEntries: remainingEntries,
            })
          : [];
      selected = [...selectedProject, ...selectedGlobal];
    }

    // Lazily index any memories missing an embedding so later retrievals can
    // use semantic similarity. Fire-and-forget; never blocks this reply.
    backfillMemoryEmbeddings([...projectPool, ...globalPool]);

    if (selected.length === 0) return { text: "", used: [] };

    const lines = selected
      .map((r) => `- ${r.title}${r.content ? `: ${r.content}` : ""}`)
      .join("\n");
    return {
      text: `\n\n## Saved memories\nThe user has saved these preferences and facts about themselves and their projects. Apply them when relevant, but defer to anything they say in the current conversation. Ignore any saved memory that conflicts with the current message:\n${lines}`,
      used: selected.map((r) => ({ id: r.id, title: r.title })),
    };
  } catch {
    // Memory injection is best-effort — never block a reply on it.
    return { text: "", used: [] };
  }
}

/** Max OTHER conversations whose summaries we consider for recall. */
const CROSS_CONV_CANDIDATE_LIMIT = 25;
/** How many past-conversation summaries actually get injected. */
const CROSS_CONV_MAX = 3;
/** Total character budget for the injected cross-conversation block. */
const CROSS_CONV_CHAR_BUDGET = 1400;
/** Per-summary excerpt cap so one long summary can't dominate the budget. */
const CROSS_CONV_EXCERPT_CHARS = 500;

/**
 * Cross-conversation recall: pull the rolling summaries of the user's OTHER Ora
 * conversations in the SAME tier as the current chat and surface the few most
 * relevant ones, so a fact mentioned in conversation A can be recalled in a new
 * conversation B.
 *
 * ISOLATION (mirrors buildMemoryContext): a project chat recalls only summaries
 * of OTHER conversations in that SAME project; a general (standalone) chat
 * recalls only other general conversations. The two tiers never cross.
 *
 * Best-effort: returns an empty string on any error and never blocks the reply.
 * Callers gate this on `referenceChatHistory` being on and the chat NOT being
 * temporary.
 */
export async function buildCrossConversationContext(
  userId: string,
  oraProjectId: number | null | undefined,
  currentMessage: string,
  currentConversationId: number | null | undefined,
): Promise<string> {
  try {
    const { db, oraConversationsTable } = await import("@workspace/db");
    const isProjectChat = typeof oraProjectId === "number";

    const rows = await db
      .select({
        id: oraConversationsTable.id,
        title: oraConversationsTable.title,
        summary: oraConversationsTable.summary,
        lastMessageAt: oraConversationsTable.lastMessageAt,
      })
      .from(oraConversationsTable)
      .where(
        and(
          eq(oraConversationsTable.userId, userId),
          eq(oraConversationsTable.surface, "normal"),
          isNull(oraConversationsTable.archivedAt),
          isNotNull(oraConversationsTable.summary),
          // Tier isolation: same project, or general-only when not in a project.
          isProjectChat
            ? eq(oraConversationsTable.projectId, oraProjectId)
            : isNull(oraConversationsTable.projectId),
          // Exclude the conversation we're currently in (its own context is
          // already provided by the in-session messages + rolling summary).
          typeof currentConversationId === "number"
            ? ne(oraConversationsTable.id, currentConversationId)
            : undefined,
        ),
      )
      .orderBy(desc(oraConversationsTable.lastMessageAt))
      .limit(CROSS_CONV_CANDIDATE_LIMIT);

    const candidates = rows.filter((r) => (r.summary ?? "").trim().length > 0);
    if (candidates.length === 0) return "";

    // Rank by keyword overlap with the current message, with a light recency
    // tiebreak so a recent-but-equally-relevant chat wins. No embeddings here —
    // summaries are long-form and TF-IDF overlap is sufficient + cheap.
    const promptTokens = new Set(tokeniseMemory(currentMessage));
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 86_400_000;
    const scored = candidates
      .map((r) => {
        const toks = tokeniseMemory(`${r.title ?? ""} ${r.summary ?? ""}`);
        let overlap = 0;
        const seen = new Set<string>();
        for (const t of toks) {
          if (promptTokens.has(t) && !seen.has(t)) {
            overlap++;
            seen.add(t);
          }
        }
        const ageMs = now - new Date(r.lastMessageAt).getTime();
        const recency = Math.max(0, 1 - ageMs / SEVEN_DAYS_MS); // 0..1 over a week
        return { row: r, score: overlap + recency * 0.5 };
      })
      .sort((a, b) => b.score - a.score);

    // Require at least some keyword signal: if nothing overlaps the current
    // message, don't inject stale unrelated chatter.
    const relevant = scored.filter((s) => s.score > 0.5);
    if (relevant.length === 0) return "";

    const picked: string[] = [];
    let chars = 0;
    for (const { row } of relevant) {
      if (picked.length >= CROSS_CONV_MAX) break;
      const excerpt = (row.summary ?? "").trim().slice(0, CROSS_CONV_EXCERPT_CHARS);
      const label = (row.title ?? "").trim() || "Earlier conversation";
      const line = `- ${label}: ${excerpt}`;
      if (picked.length > 0 && chars + line.length > CROSS_CONV_CHAR_BUDGET) break;
      picked.push(line);
      chars += line.length;
    }
    if (picked.length === 0) return "";

    return `\n\n## From your past conversations\nRelevant context from the user's OTHER recent conversations with you. Use it when it helps, but defer to anything in the current conversation:\n${picked.join("\n")}`;
  } catch {
    // Best-effort — never block a reply on cross-conversation recall.
    return "";
  }
}

/**
 * Fetch the user's Ora profile ("About you" / custom instructions) and format
 * it as a compact context block for the system prompt. Returns an empty string
 * when the user has no profile.
 *
 * ISOLATION: like buildMemoryContext, this is Ora-only. The profile lives in
 * its own `ora_profiles` table and is injected only here, never into the AI
 * Builder.
 */
export async function buildProfileContext(userId: string): Promise<string> {
  try {
    const { db, oraProfilesTable } = await import("@workspace/db");
    const [p] = await db.select().from(oraProfilesTable).where(eq(oraProfilesTable.userId, userId));
    if (!p) return "";

    const lines: string[] = [];
    if (p.preferredName) lines.push(`- Preferred name: ${p.preferredName}`);
    if (p.occupation) lines.push(`- Occupation: ${p.occupation}`);
    if (p.industry) lines.push(`- Industry: ${p.industry}`);
    if (p.skillLevel) lines.push(`- Skill level: ${p.skillLevel}`);
    if (p.preferredLanguage) lines.push(`- Preferred language: ${p.preferredLanguage}`);
    if (p.goals) lines.push(`- Goals: ${p.goals}`);
    if (p.responseStyle) lines.push(`- Preferred response style: ${p.responseStyle}`);
    if (p.avoid) lines.push(`- Things to avoid: ${p.avoid}`);

    if (lines.length === 0) return "";

    return `\n\n## About the user\nThe user has shared these details about themselves and how they'd like you to respond. Honor them throughout the conversation, but defer to anything they say in the current message:\n${lines.join("\n")}`;
  } catch {
    // Profile injection is best-effort — never block a reply on it.
    return "";
  }
}

const IMAGE_GENERATE_CTA =
  "Image generation is available for signed-in MustaFlow users. Sign up at www.mustaflow.com to access AI image generation, including inline images here in Ora and the full Image Studio with quality presets, aspect ratios, and style controls.";

const SEARCH_SIGNIN_CTA =
  "Live web search is available for signed-in MustaFlow users. Sign up at www.mustaflow.com and I'll search the web for you, then answer with up-to-date information and cited sources.";

/**
 * Build an explicit file-availability hint injected into the system prompt.
 *
 * When carriedDocs is non-empty the model has the file(s) in context and must
 * NOT ask the user to re-upload or repeat the information. When documentRefs
 * were sent but all expired or belong to a different session (carriedDocs is
 * empty), we tell the model so it can explain gracefully instead of
 * hallucinating content or silently ignoring the reference. Returns an empty
 * string when no documentRefs were sent at all.
 */
export function buildFileContextAddendum(carriedDocs: string, documentRefs: string[]): string {
  if (documentRefs.length === 0) return "";
  if (carriedDocs.trim().length > 0) {
    const fileCount = (carriedDocs.match(/^File: /gm) ?? []).length || 1;
    const plural = fileCount === 1 ? "file" : "files";
    return `\n\n## Uploaded ${plural} available this turn\nThe user has ${fileCount} uploaded ${plural} whose full contents appear in your context above. You have the data. Do NOT ask the user to re-upload, re-paste, or repeat any information from these ${plural}. Use the contents directly to answer their question or build the requested output.`;
  }
  return `\n\n## Uploaded file status\nThe user references an uploaded file, but the file session has expired and the contents are no longer available in your context. Tell them the file session expired and offer to continue if they re-upload.`;
}

const PASTED_REFERENCE_ANALYSIS_ADDENDUM = `\n\n## Current turn: pasted reference analysis
The user's current message appears to include pasted output from tools such as Replit, Codex, GitHub, tests, or workflows. Treat the pasted text as evidence to analyze. Do not generate a downloadable file. Do not answer with generic capability suggestions.

Response shape for this turn:
1. Start with the direct answer, diagnosis, or exact message the user should send.
2. Identify who is who when relevant: Replit = hosted dev/runtime workspace; Codex = OpenAI coding agent; ChatGPT = OpenAI chat assistant; GitHub = source-control host.
3. Use the minimum useful steps or bullets. Keep it concise unless the user explicitly asks for a full breakdown.
4. If the pasted text is too long, conflicting, or missing key details, state the specific missing detail instead of guessing.`;

const router = Router();

/**
 * Charge one message slot against the session JWT.
 *
 * The streaming route pre-increments `msgCount` and sets `streamingPreIncremented: true`
 * before flushing SSE headers (the only window where Set-Cookie is possible). If a
 * pre-first-token failure causes the client to retry via /chat, the client presents
 * the server-signed `streamFallbackToken` from the `stream_failed` SSE event. This
 * helper honours the skip-increment ONLY when the token is present, the session flag
 * is set, AND the JWT signature+sessionId verify — preventing both client forgery and
 * stale-flag reuse after a successful streaming turn (the flag is cleared on first
 * valid redemption via `acknowledgeStreamingIncrement`).
 */
function chargeSession(
  session: OraSessionPayload,
  streamFallbackToken?: string,
): { token: string; payload: OraSessionPayload } {
  if (
    streamFallbackToken &&
    session.streamingPreIncremented &&
    verifyStreamFallbackToken(streamFallbackToken, session)
  ) {
    return acknowledgeStreamingIncrement(session);
  }
  return incrementMessageCount(session);
}

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const summarizeMessageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const bodySchema = z.object({
  message: z.string().min(1),
  messages: z.array(messageItemSchema).max(20).default([]),
  language: z.string().max(20).optional(),
  languageHint: z.string().max(20).optional(),
  // IANA timezone (e.g. "America/New_York") the client resolves from the browser.
  // Used to render the user's local date/time in the authoritative date block.
  timeZone: z.string().max(64).optional(),
  mode: z.enum(["instant", "deep"]).default("instant"),
  referenceSavedMemories: z.boolean().default(true),
  referenceChatHistory: z.boolean().default(true),
  /**
   * Refs of documents the user uploaded earlier in this conversation. The
   * extracted text lives only in the ephemeral, session-scoped file-store, so
   * the client re-sends recent refs and we re-hydrate them here to answer
   * follow-up questions about an earlier upload. Expired/foreign refs are
   * silently skipped.
   */
  documentRefs: z.array(z.string().uuid()).max(5).default([]),
  /**
   * Rolling conversation summary maintained client-side. As a conversation
   * grows past the recent-message window, older turns are condensed into this
   * running summary and re-sent so long conversations stay coherent. Echoed
   * back (possibly updated) in the response so the client can persist it.
   */
  conversationSummary: z.string().optional(),
  /**
   * Earlier overflow turns that have just scrolled out of the recent window and
   * are not yet reflected in `conversationSummary`. They are folded into the
   * summary on this request. Bounded by the client; capped again server-side.
   */
  summarizeMessages: z.array(summarizeMessageItemSchema).max(40).default([]),
  /**
   * The Ora project this chat belongs to, if any. When set (and owned by the
   * caller), Ora also injects that project's persistent memories alongside the
   * user-level ones. Standalone chats omit it and only get user-level memory.
   */
  oraProjectId: z.number().int().positive().nullable().optional(),
  /**
   * Temporary ("incognito") chat. When true, Ora neither READS long-term memory
   * (saved memories + cross-conversation recall) nor WRITES it: no memory inject,
   * no cross-conversation recall, and no memory-save candidate is surfaced. The
   * current in-session messages still provide context. The client also skips
   * persisting a temporary conversation entirely.
   */
  temporary: z.boolean().default(false),
  /**
   * The id of the conversation this turn belongs to (when it has been persisted).
   * Used by cross-conversation recall to EXCLUDE the current conversation from the
   * "past conversations" it pulls in. Null/omitted for a brand-new chat.
   */
  conversationId: z.number().int().positive().nullable().optional(),
  /**
   * Set to true when this /chat request is a silent retry after a streaming
   * pre-first-token failure. The streaming route pre-increments the session
   * counter before flushing SSE headers; when the stream fails before the
   * first token the client retries here and this flag tells the server not to
   * double-count the anonymous-session slot. Ignored for authenticated users
   * (whose quota is tracked server-side and already consumed by the streaming
   * endpoint before the error occurred).
   */
  streamFallbackToken: z.string().optional(),
  /**
   * Set to true when the user explicitly taps "Retry live search" after a
   * search degraded to a general-knowledge fallback. Pins this turn to the live
   * web-search tool instead of re-classifying the message (which might route it
   * to a plain conversational answer), so a retry always attempts a fresh LIVE
   * search. Auth/plan gating still applies, so anonymous callers are still
   * funneled to the sign-in CTA.
   */
  forceSearch: z.boolean().optional(),
  /**
   * Echo of the pendingTaskContext from a clarifying-question response. When
   * Ora asked ONE clarification for an ambiguous uploaded-file edit, the
   * client sends this back with the user's answer so the server can merge
   * them and continue the ORIGINAL task (the server is stateless per turn).
   * Client-supplied: originalMessage is capped by the schema and re-scanned
   * with scanUserInput exactly like `message`.
   */
  pendingClarification: oraPendingClarificationSchema.optional(),
  /**
   * Phase 10 — True Artifact Revision Engine: the asset id of the last file
   * generated or edited in this conversation. When provided and an edit intent
   * is detected, the file-gen branch applies the change to those exact bytes
   * rather than regenerating a lookalike from extracted text.
   * Signed-in only; anonymous users never have persisted assets.
   */
  activeAssetId: z.number().int().positive().nullable().optional(),
});

/**
 * Build the system prompt, injecting an explicit language instruction when
 * the caller specifies one. When the user's selector is "auto", a browser
 * locale hint (`languageHint`) is used as a tiebreaker for ambiguous or
 * very short messages so the model defaults to the user's preferred language
 * instead of picking arbitrarily.
 */
// Tells the model the CURRENT user's auth state so it never has to guess.
// Without this, the prompt's "signed-in vs visitor" branches leave the model to
// infer auth status — and it wrongly defaults to the "you need to sign in"
// hedge even for users who are already signed in (the reported bug).
function sessionAuthBlock(isSignedIn: boolean): string {
  return isSignedIn
    ? `\n\n## Current session (authoritative)\nThe user you are talking to right now IS signed in. Every capability — image generation, file generation, and live web search — is fully available to them this turn. NEVER tell this user they need to sign in, sign up, or create an account to use any feature, and never ask them to "sign in first" or hand them a prompt "to use after signing in". Just proceed.`
    : `\n\n## Current session (authoritative)\nThe user you are talking to right now is NOT signed in. Image generation and live web search require an account: warmly invite them to sign up to unlock these, and never claim you are technically unable to do them.`;
}

export function buildSystemPrompt(
  language: string | undefined,
  languageHint: string | undefined,
  isSignedIn: boolean,
  timeZone?: string,
  dateTimeAsOfLabel?: string,
): string {
  const authBlock = sessionAuthBlock(isSignedIn);
  // Authoritative current date/time — computed per request (never cached at
  // module load) so today/tomorrow/date-math and freshness judgments are correct
  // on every surface (chat, stream, realtime, file/image analysis).
  const dateBlock = buildCurrentDateTimeBlock(timeZone, undefined, dateTimeAsOfLabel);
  const base = ORA_SYSTEM_PROMPT + dateBlock + authBlock;
  if (!language || language === "auto") {
    if (!languageHint) return base;
    // Normalise: "fr-FR" → "fr", "en-US" → "en"
    const primaryLang = languageHint.split("-")[0].toLowerCase();
    if (primaryLang === "en") return base; // English is the default — no hint needed
    return (
      base +
      `\n\n## Language tiebreaker\nThe visitor's browser is set to "${languageHint}". When their message is too short or ambiguous to reliably detect a language, default to responding in ${primaryLang}. If the message is clearly in a different language, match that language instead.`
    );
  }
  return (
    base +
    `\n\n## Language override\nThe user has selected "${language}" as their preferred language. Respond entirely in that language for this conversation, regardless of the language the user writes in.`
  );
}

export function isOraMemoryRecallRequest(message: string): boolean {
  const text = message.toLowerCase();
  if (/\bremember\s+(?:that|this|to|my|our)\b/.test(text)) return false;
  return (
    /\b(?:what|which|do|did|can|could|have|has|tell|remind)\b[\s\S]{0,120}\b(?:remember|know|saved|memory|memories|prefer|preference|answer style|about me)\b/i.test(
      message,
    ) || /\b(?:what|which)\b[\s\S]{0,80}\b(?:answer|reply|response)\s+style\b/i.test(message)
  );
}

function buildMemoryStatusContext({
  authed,
  temporary,
  referenceSavedMemories,
  message,
  memoryUsedCount,
  hasCrossConversationContext,
}: {
  authed: boolean;
  temporary: boolean;
  referenceSavedMemories: boolean;
  message: string;
  memoryUsedCount: number;
  hasCrossConversationContext: boolean;
}): string {
  if (temporary) {
    return "\n\n## Memory status for this turn\nThis is a temporary chat. Do not read, write, or claim to remember saved memories or past conversations outside this temporary chat.";
  }

  if (!isOraMemoryRecallRequest(message)) return "";

  if (!authed) {
    return "\n\n## Memory status for this turn\nNo saved Ora memories are available because the user is not signed in. If they ask what you remember, say you do not have that saved.";
  }

  if (!referenceSavedMemories) {
    return "\n\n## Memory status for this turn\nSaved-memory reference is turned off for this user. If they ask what you remember, say memory reference is off rather than guessing.";
  }

  if (memoryUsedCount === 0 && !hasCrossConversationContext) {
    return "\n\n## Memory status for this turn\nNo relevant saved memories or past-conversation summaries were available. If the user asks what you remember, say you do not have that saved instead of guessing.";
  }

  return "";
}

/**
 * Returns topic-specific guidance injected into the suggestion system prompt
 * so follow-up questions are relevant to the detected conversation domain.
 */
function topicSuggestionGuidance(topic: OraTopic): string {
  const guidance: Record<OraTopic, string> = {
    "product-features":
      "Focus on MustaFlow capabilities: integrations available, how specific features work, what's possible with the platform.",
    pricing:
      "Focus on value and cost: plan comparisons, credit usage, what's included at each tier, how to get started cheaply.",
    onboarding:
      "Focus on first steps: how to create a first project, what to expect, common beginner questions, tips for getting results quickly.",
    "app-planning":
      "Focus on app scope and design decisions: must-have features, user flows, data model choices, MVP vs full build tradeoffs.",
    saas: "Focus on SaaS-specific concerns: subscription billing, authentication, role-based access, multi-tenancy, dashboard design, churn reduction.",
    ecommerce:
      "Focus on e-commerce specifics: product catalog, checkout flow, payment integration, inventory management, order tracking, returns.",
    mobile:
      "Focus on mobile-specific concerns: iOS vs Android differences, offline support, push notifications, app store submission, performance on device.",
    technical:
      "Focus on technical depth: database schema choices, API design, deployment strategy, scaling, security hardening, monitoring.",
    general:
      "Focus on broadly useful follow-ups: clarifying the goal, exploring alternatives, understanding tradeoffs, next concrete steps.",
  };
  return guidance[topic] ?? guidance.general;
}

// ── False file-delivery rescue ───────────────────────────────────────────────
// The conversational path can never attach files, yet the model occasionally
// imitates the file-builder's delivery template from an earlier REAL delivery
// in the history ("Here's your PPTX file — … Click the card below to download
// it.") without any file existing. When a conversational reply makes such a
// claim, generate the promised file for REAL so the delivery card actually
// appears. On generation failure the hallucinated claim is replaced with an
// honest correction — Ora must never claim a delivery that did not happen.
// No extra quota is charged: the turn was already metered as a message.
type RescuedFileDelivery = {
  reply: string;
  fileName?: string;
  fileData?: string;
  mimeType?: string;
  assetId?: number | null;
};

/**
 * Resolve the Ora project id that library persists should carry for this turn.
 * Returns the id only when it names an ACTIVE project owned by the user;
 * anything else (absent, foreign, archived, lookup failure) degrades to null —
 * i.e. the Personal space — so persistence never fails on a bad project id.
 * Called lazily at persist time (never on the pre-stream path) so it cannot
 * affect time-to-first-token.
 */
async function resolveAssetProjectId(
  userId: string,
  oraProjectId: number | null | undefined,
): Promise<number | null> {
  if (typeof oraProjectId !== "number") return null;
  try {
    const { isOwnedActiveOraProject } = await import("../../lib/public-ai/ora-projects");
    return (await isOwnedActiveOraProject(userId, oraProjectId)) ? oraProjectId : null;
  } catch {
    return null;
  }
}

async function rescueClaimedFileDelivery(params: {
  reply: string;
  message: string;
  carriedDocs: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  language: string | undefined;
  authed: AuthedOraUser | null;
  oraProjectId: number | null | undefined;
  logComponent: string;
}): Promise<RescuedFileDelivery | null> {
  const claimedFormat = detectClaimedFileDelivery(params.reply);
  if (!claimedFormat) return null;
  logger.warn(
    { component: params.logComponent, claimedFormat },
    "Conversational reply claimed a file delivery with no file attached — generating it for real",
  );
  try {
    const { generateFileFromPrompt } = await import("../../lib/public-ai/file-builder");
    const filePrompt = params.carriedDocs
      ? `${params.message}\n\n${params.carriedDocs}`
      : params.message;
    const result = await generateFileFromPrompt(
      filePrompt,
      claimedFormat,
      params.history.slice(-10),
      params.language,
      params.carriedDocs.length > 0,
      params.authed?.tier ?? null,
    );
    let assetId: number | null = null;
    if (params.authed && result.fileData) {
      try {
        const { persistOraAsset } = await import("../../lib/ora-assets");
        assetId = await persistOraAsset({
          userId: params.authed.userId,
          oraProjectId: await resolveAssetProjectId(params.authed.userId, params.oraProjectId),
          kind: "file",
          fileName: result.fileName,
          mimeType: result.mimeType,
          format: claimedFormat,
          prompt: params.message,
          base64: result.fileData,
        });
      } catch (persistErr) {
        logger.error(
          { component: params.logComponent, err: persistErr },
          "Failed to persist rescued file to asset library",
        );
      }
    }
    return {
      reply: result.reply,
      fileName: result.fileName,
      fileData: result.fileData,
      mimeType: result.mimeType,
      assetId,
    };
  } catch (err) {
    logger.error(
      { component: params.logComponent, claimedFormat, err },
      "False-delivery rescue generation failed — replacing claim with honest correction",
    );
    return {
      reply:
        "I wasn't able to attach that file — my earlier message was wrong to say it was ready. " +
        `Please ask me again (for example, "create it as a ${claimedFormat.toUpperCase()}") and I'll generate it for you.`,
    };
  }
}

router.post("/public-ai/chat", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const {
    message,
    messages,
    language,
    languageHint,
    mode,
    referenceSavedMemories,
    referenceChatHistory,
    documentRefs,
    conversationSummary: priorSummary,
    summarizeMessages,
    oraProjectId,
    temporary,
    conversationId,
    streamFallbackToken,
    forceSearch,
    pendingClarification,
    activeAssetId,
  } = parsed.data;

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }

  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }

  // Privacy-safe per-bucket timing (mirrors streaming route).
  const timing = {
    t0: Date.now(), // request entered handler (past kill switches)
    t1: Date.now(), // session validated (set here, immediately after validation)
    t2: 0, // after auth user resolved
    t3: 0, // after spend-cap check
    t4: 0, // after route decision + quota reserve
    t5: 0, // after context builders awaited
  };

  // Detect fast-lane BEFORE firing the classifier — once we know this is a
  // short, simple prompt with no special-intent signals we skip the AI
  // classifier call entirely (saves the full 500 ms timeout on every fast-lane
  // turn). Previously the classifier was fired unconditionally and only the
  // *await* was skipped; now the call itself is omitted so there is zero
  // background CPU/network cost for these high-volume simple turns.
  const isInstantFastLane =
    mode === "instant" &&
    message.length <= 120 &&
    documentRefs.length === 0 &&
    !looksLikeImageGenerationIntent(message) &&
    !looksLikeWebSearchIntent(message) &&
    !looksLikeFileGenIntent(message);

  // Skip the intent classifier when it cannot change routing: fast-lane turns
  // (already forced to the mini model) and explicit deep mode. routeOraMessage
  // always routes deep to deep_thinking, and deep already fed CLASSIFIER_FALLBACK
  // to routing on every turn (the classifier reliably returns empty for deep and
  // defaults to premium/high/general), so skipping the ~1.7s call is byte-identical.
  // routeOraMessage accepts a pre-computed `classifier` result and skips its
  // own internal AI call when we supply one.
  const skipClassifier = isInstantFastLane || mode === "deep";
  const classifierPromise = skipClassifier ? null : classifyIntent(message);
  // Attach a no-op catch so any unexpected rejection from classifyIntent does
  // not become an unhandled rejection when an early-return path exits before
  // `await classifierPromise` is reached.
  if (classifierPromise) void classifierPromise.catch(() => undefined);

  // Resolve the signed-in user (if any). Authenticated users draw on their
  // monthly credit balance and are exempt from the anonymous visitor cap.
  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  timing.t2 = Date.now();

  // planTier is available as soon as auth resolves (only depends on authed.tier).
  const planTier = oraPlanTier(authed);

  // Start context builders in parallel immediately after auth — userId and
  // planTier are both available now. Previously these were sequential awaits
  // inside the answer-path, adding 100-2500ms of unnecessary serial delay.
  // They are awaited (with an Instant-mode timeout) after routing completes.
  const earlyMemoryP =
    authed && referenceSavedMemories && !temporary
      ? buildMemoryContext(authed.userId, oraProjectId, message, planTier)
      : Promise.resolve({ text: "", used: [] as Array<{ id: number; title: string }> });
  void earlyMemoryP.catch(() => undefined);
  const earlyProfileP = authed ? buildProfileContext(authed.userId) : Promise.resolve("");
  void earlyProfileP.catch(() => undefined);

  const effectiveMsgLimit = authed ? await oraMessageLimit(authed.tier) : MSG_LIMIT_VALUE;

  if (!authed && session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error: `You've reached the ${MSG_LIMIT_VALUE}-message limit for anonymous sessions. Sign up free at www.mustaflow.com for unlimited conversations, memory, image generation, and more.`,
      upgradeCta: true,
      signUpUrl: "https://www.mustaflow.com/sign-up",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  // ── Daily spend cap (global + per-IP anonymous) ─────────────────────────
  {
    const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
    const capResult = await checkOraSpendCapAsync(
      req,
      "chat",
      authed?.userId ?? null,
      authed?.tier ?? "anonymous",
    );
    if (!capResult.allowed) {
      res.status(429).json({
        error: capResult.message,
        limitType: capResult.limitType,
        upgradeAvailable: capResult.upgradeAvailable,
        resetAt: capResult.resetAt,
        retryAfter: capResult.retryAfter,
      });
      return;
    }
  }
  timing.t3 = Date.now();

  if (
    !scanUserInput(message) ||
    (pendingClarification && !scanUserInput(pendingClarification.originalMessage))
  ) {
    res
      .status(400)
      .json({ error: "Your message contains patterns that cannot be processed. Please rephrase." });
    return;
  }

  const referenceAnalysisTurn = isPastedReferenceAnalysisRequest(message);

  // The classifier was either skipped entirely (fast-lane / deep mode) or fired
  // in parallel with auth. classifierMs isolates the await cost for diagnostics.
  const classifierTimeoutMs = mode === "instant" ? 500 : 2_000;
  const classifierSkipped = classifierPromise === null;
  const tClassifier0 = Date.now();
  const classifierResult = classifierSkipped
    ? CLASSIFIER_FALLBACK // skipped: routing uses the premium/high/general default
    : await withTimeout(classifierPromise!, classifierTimeoutMs, CLASSIFIER_FALLBACK);
  const classifierMs = classifierSkipped ? 0 : Date.now() - tClassifier0;

  // Route the message through the Ora orchestrator. Ora is a STANDALONE
  // assistant: build/"make me an app" requests are answered as normal
  // conversation — never refused, never auto-handed-off to the Builder.
  let decision = await routeOraMessage({
    message,
    mode,
    recentMessages: messages.slice(-8),
    classifier: classifierResult, // pre-computed above — skips the internal AI call
  });
  // Re-hydrate any documents the user uploaded earlier this conversation so
  // follow-up questions ("what did that file say?") and "make a summary of it"
  // both have the source text. Empty when nothing resolves (expired/foreign).
  const carriedDocs = await buildCarriedDocumentContext(
    documentRefs,
    session.sessionId,
    message,
    authed?.userId ?? null,
  );
  // Phase 5: lightweight per-file metadata for the multi-file planner. Only
  // resolved when TWO+ refs rode in — single-file turns pay zero extra cost.
  const carriedFileMeta: CarriedFileMeta[] =
    documentRefs.length >= 2
      ? await resolveCarriedFileMeta(documentRefs, session.sessionId, authed?.userId ?? null)
      : [];

  // Merge a clarification answer with its round-tripped pending task context
  // so ROUTING and the file-edit engine see the full original task. The raw
  // `message` stays the chat-visible user turn everywhere else (persistence,
  // memory extraction). Includes the stale-pending guard: a self-sufficient
  // new instruction ignores the pending context entirely.
  const continuation = resolveClarificationContinuation({
    message,
    pending: pendingClarification ?? null,
    carriedDocs,
  });

  // Cancel short-circuit — free (pre-quota, pre-LLM), like clarifications.
  if (continuation.isCancelled) {
    res.json({
      reply:
        continuation.cancelledReply ??
        "No problem — cancelled. Let me know if you'd like to make a different change.",
      msgCount: session.msgCount,
      msgLimit: effectiveMsgLimit,
    });
    return;
  }

  const routedMessage = continuation.routedMessage;

  // Deterministic final routing precedence — forceSearch pin (a user-initiated
  // "Retry live search" is terminal and keeps all auth/metering gating below),
  // uploaded-file-edit priority over chat/incidental image/incidental search,
  // and the ZIP/code-archive analysis guard. Shared with /chat/stream via
  // resolveFinalOraRoute so the two handlers cannot drift.
  const finalRoute = resolveFinalOraRoute({
    decision,
    message: routedMessage,
    carriedDocs,
    forceSearch,
  });
  decision = finalRoute.decision;

  // Phase 5: recognize cross-file workflows (compare/merge/data→deck/summary)
  // over 2+ resolved uploads. Runs AFTER resolveFinalOraRoute (never fights
  // image/search/ZIP escapes) and BEFORE routeDiag/access/quota. The only
  // route change it can make is file_generation → answer for compare-analysis
  // asks — both draw on the MESSAGE quota bucket, so cost is unchanged.
  const multiFilePlan = planOraMultiFile({
    message: routedMessage,
    files: carriedFileMeta,
    finalTool: decision.tool,
  });
  if (multiFilePlan?.toolOverride === "answer" && decision.tool === "file_generation") {
    decision = { ...decision, tool: "answer" };
  }

  const deepAllowed = decision.tool === "deep_thinking";
  const routedTool = decision.tool;
  const searchUsed = decision.tool === "search";
  // Routing diagnostics attached to every successful /chat reply (privacy-safe:
  // static reason templates and enum values only — no user content).
  const routeDiag = {
    routedTool,
    routeReason: decision.reason,
    classifierSkipped,
    classifierMs,
    searchUsed,
    inferredFileFormat: finalRoute.inferredFileFormat,
    conflictResolution: finalRoute.conflictResolution,
    multiFileWorkflow: multiFilePlan?.workflow ?? null,
  };

  // Ask ONE clarifying question instead of guessing on an ambiguous
  // uploaded-file edit. Deterministic and pre-LLM — returned BEFORE
  // checkToolAccess/quota so a clarification is never charged or counted
  // (deny-CTA precedent). The pending context round-trips through the client;
  // documentRefs persist because clients re-send them on every turn.
  const clarification = continuation.applied
    ? null
    : planOraClarification({
        message,
        carriedDocs,
        finalTool: decision.tool,
        conflictResolution: finalRoute.conflictResolution,
        inferredFileFormat: finalRoute.inferredFileFormat,
        hasPendingClarification: !!pendingClarification,
        files: carriedFileMeta,
      });
  if (clarification) {
    res.json({
      reply: clarification.question,
      needsClarification: true,
      clarificationKind: clarification.kind,
      pendingTaskContext: clarification.pendingTaskContext,
      ...(clarification.fileAgentPreview
        ? { fileAgentPreview: clarification.fileAgentPreview }
        : {}),
      msgCount: session.msgCount,
      msgLimit: effectiveMsgLimit,
      serverDiag: { ...routeDiag, clarificationKind: clarification.kind },
    });
    return;
  }

  // Plan gating is derived entirely from the selected tool's required access
  // level. Denied requests return a CTA without charging or counting them.
  const access = checkToolAccess(decision.tool, {
    authed: !!authed,
    isPaid: authed?.isPaid ?? false,
  });
  if (!access.allowed) {
    if (access.denyCode === "deep_paid_only") {
      res.json({
        reply: authed
          ? "Deep Thinking is available on the Core Pack and Deep Wave plans. It reasons step by step for more thorough, considered answers. Upgrade to unlock it — or keep chatting in Instant mode."
          : "Deep Thinking is available to signed-in MustaFlow members on the Core Pack and Deep Wave plans. Sign up to unlock slower, more thorough reasoning — or keep chatting here in Instant mode.",
        upgradeCta: true,
        mode: "instant",
        msgCount: session.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    if (access.denyCode === "image_signin_required") {
      res.json({
        reply: IMAGE_GENERATE_CTA,
        upgradeCta: true,
        msgCount: session.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    if (access.denyCode === "search_signin_required") {
      res.json({
        reply: SEARCH_SIGNIN_CTA,
        upgradeCta: true,
        msgCount: session.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    res.json({
      reply:
        "That capability isn't available yet. I can still help you plan it, analyze your data, generate files, or talk it through.",
      msgCount: session.msgCount,
      msgLimit: effectiveMsgLimit,
    });
    return;
  }

  // Ora is metered by per-user ROLLING-WINDOW quotas per tier — never by the AI
  // Builder credit wallet. Image generation/edit draws on the IMAGE bucket;
  // everything else (answer, deep, search, file gen, analysis) draws on the
  // MESSAGE bucket. Messages and images share ONE window timer per user (they
  // refill together). Uploads are unlimited (handled in the upload route).
  // Atomically reserve the quota slot up-front so concurrent requests cannot
  // overshoot the tier limit. Every branch below that does NOT complete the
  // metered action MUST refund this reservation (see refundOraQuota calls).
  const quotaKind: OraQuotaKind =
    decision.tool === "image_generation" || decision.tool === "image_editing" ? "image" : "message";
  if (authed) {
    const { consumeOraQuota } = await import("../../lib/public-ai/ora-usage");
    const quota = await consumeOraQuota(authed.userId, authed.tier, quotaKind);
    if (!quota.allowed) {
      const usage = await oraUsageResponse(authed, session.msgCount);
      res.status(429).json({
        error:
          quotaKind === "image"
            ? `You've used all ${quota.limit} Ora images in your current window on your plan. Upgrade for a higher limit, or wait for your window to reset.`
            : `You've used all ${quota.limit} Ora messages in your current window on your plan. Upgrade for a higher limit, or wait for your window to reset.`,
        upgradeCta: true,
        ...usage,
      });
      return;
    }
  }
  timing.t4 = Date.now();

  // ── File generation tool ────────────────────────────────────────────────────
  if (decision.tool === "file_generation" && decision.fileFormat) {
    const detectedFormat = decision.fileFormat;
    const history = messages
      .slice(-10)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    // When the user is asking for a file built from an earlier upload, feed the
    // re-hydrated source text into the builder so the output reflects it.
    // routedMessage carries the merged original-task + clarification answer
    // when this turn continues a clarifying question. A multi-file plan
    // prepends its role directive so generation uses each file as planned.
    const promptWithPlan = multiFilePlan
      ? `${routedMessage}\n\n${multiFilePlan.directive}`
      : routedMessage;

    // Phase 10: resolve active working artifact so revision requests target the
    // exact bytes the user is working with rather than regenerating a lookalike.
    let chatActiveAssetBuffer: Buffer | null = null;
    let chatActiveAssetFileName: string | null = null;
    if (activeAssetId && authed) {
      try {
        const { getOraAssetBytes, getOraAssetMeta } = await import("../../lib/ora-assets");
        const [buffer, meta] = await Promise.all([
          getOraAssetBytes(activeAssetId, authed.userId),
          getOraAssetMeta(activeAssetId, authed.userId),
        ]);
        if (buffer && meta) {
          chatActiveAssetBuffer = buffer;
          chatActiveAssetFileName = meta.fileName;
        }
      } catch (err) {
        logger.warn(
          { component: "ora-chat-file", activeAssetId, err },
          "Failed to resolve active asset; proceeding without revision target",
        );
      }
    }

    let filePrompt = carriedDocs ? `${promptWithPlan}\n\n${carriedDocs}` : promptWithPlan;
    // Inject active-asset context text so the fallback generator is anchored
    // to the file's actual content when the in-place edit path returns null.
    if (chatActiveAssetFileName && chatActiveAssetBuffer) {
      const ext = chatActiveAssetFileName.replace(/^.*\./, "").toLowerCase();
      // xlsx not supported by extractText (txt/docx/pptx/pdf only).
      if (ext === "docx" || ext === "pptx") {
        try {
          const { extractText } = await import("../../lib/public-ai/file-extract");
          const text = await extractText(
            chatActiveAssetBuffer,
            ext as "docx" | "pptx",
          );
          if (text.trim()) {
            filePrompt =
              filePrompt +
              "\n\n[ACTIVE WORKING FILE — REVISION TARGET]\n" +
              `The user wants to revise this file: ${chatActiveAssetFileName}\n` +
              "Apply only the requested changes. Preserve all other content, structure, and layout.\n\n" +
              `"""\n${text.slice(0, 8_000)}\n"""\n` +
              "[END OF ACTIVE WORKING FILE]";
          }
        } catch {
          // no text extraction — AI edit path still works
        }
      }
    }

    const { generateFileFromPrompt, FileGenerationError } =
      await import("../../lib/public-ai/file-builder");
    try {
      const { tryApplyLayoutPreservingFileEdit } =
        await import("../../lib/public-ai/office-layout-edit");
      const layoutEditResult = await tryApplyLayoutPreservingFileEdit({
        message: routedMessage,
        format: detectedFormat,
        documentRefs,
        sessionId: session.sessionId,
        userId: authed?.userId ?? null,
        subscriptionTier: authed?.tier ?? null,
        // Plan target first; otherwise pin a file the user named by filename
        // (covers answered ambiguous_target_file clarifications and explicit
        // "update <name>" asks) so the ordered-refs scan never edits the
        // wrong same-format upload.
        preferredFileRef:
          multiFilePlan?.targetFileRef ?? resolveNamedEditTarget(routedMessage, carriedFileMeta),
        // Phase 10: revision of the active working artifact.
        activeAssetBuffer: chatActiveAssetBuffer,
        activeAssetFileName: chatActiveAssetFileName,
      });
      const result =
        layoutEditResult ??
        (await generateFileFromPrompt(
          filePrompt,
          detectedFormat,
          history,
          language,
          carriedDocs.length > 0,
          authed?.tier ?? null,
        ));
      // The full generator rebuilt the file from an uploaded source's extracted
      // text — an honest "redesigned" stamp so the quality card can say the
      // original layout was NOT carried over. Pure from-scratch generation
      // (no uploaded source) intentionally gets no editQuality at all.
      if (!layoutEditResult && documentRefs.length > 0 && carriedDocs.length > 0) {
        result.editQuality = {
          editMode: "redesigned",
          changes: [],
          outputFileName: result.fileName.slice(0, 300),
          preservedLayout: false,
          canRedesign: false,
        };
      }
      const { token, payload } = chargeSession(session, streamFallbackToken);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      // Persist to the durable asset library BEFORE responding so the returned
      // asset id can ride on the download card (keeping it usable after reload
      // and on other devices). Best-effort — a library failure must never break
      // the in-chat generation. Only for signed-in users.
      let assetId: number | null = null;
      if (authed && result.fileData) {
        try {
          const { persistOraAsset, getNextVersionLineage, getNextVersionLineageFromAssetId } =
            await import("../../lib/ora-assets");
          // Version lineage: Phase 10 active-asset revisions chain off the
          // activeAssetId directly. Uploaded-file in-place edits chain via the
          // editedFileRef session-store key. Plain generation is standalone v1.
          const lineage =
            activeAssetId && layoutEditResult
              ? await getNextVersionLineageFromAssetId(authed.userId, activeAssetId)
              : result.editedFileRef
                ? await getNextVersionLineage(authed.userId, result.editedFileRef)
                : null;
          const isRevision = activeAssetId && layoutEditResult;
          const editSummary =
            isRevision || result.editedFileRef
              ? (result.editQuality?.changes?.length
                  ? result.editQuality.changes.join("; ")
                  : `Revised: ${message}`
                ).slice(0, 300)
              : null;
          assetId = await persistOraAsset({
            userId: authed.userId,
            // Chained versions inherit the parent's project via the lineage
            // spread below; only a standalone v1 uses this turn's project.
            oraProjectId: await resolveAssetProjectId(authed.userId, oraProjectId),
            kind: "file",
            fileName: result.fileName,
            mimeType: result.mimeType,
            format: detectedFormat,
            prompt: message,
            base64: result.fileData,
            ...(lineage ?? {}),
            sourceFileRef: result.editedFileRef ?? null,
            editSummary,
          });
          // Surface the persisted version on the quality card so clients can
          // open revision history directly from it.
          if (assetId != null && result.editQuality) {
            result.editQuality.versionId = assetId;
          }
          // In-place Office edit: repoint the durable file-context mirror at
          // the edited asset so revisions after a restart/rotated session
          // compound instead of reverting to the original upload.
          if (assetId != null && result.editedFileRef) {
            const { relinkDurableFileContextBestEffort } =
              await import("../../lib/public-ai/file-context-store");
            relinkDurableFileContextBestEffort({
              fileRef: result.editedFileRef,
              sessionId: session.sessionId,
              userId: authed.userId,
              assetId,
            });
          }
        } catch (persistErr) {
          logger.error(
            { component: "ora-chat-file", err: persistErr },
            "Failed to persist generated file to asset library",
          );
        }
      }
      const fileAgentPreview = buildFileAgentPreview({
        format: detectedFormat,
        fileName: result.fileName,
        hasSourceData: carriedDocs.length > 0,
        sourceCount: documentRefs.length,
        editQuality: result.editQuality,
        usedFiles: multiFilePlan?.usedFiles,
      });
      res.json({
        reply: result.reply,
        fileName: result.fileName,
        fileData: result.fileData,
        mimeType: result.mimeType,
        ...(assetId != null ? { assetId } : {}),
        ...(result.editQuality ? { editQuality: result.editQuality } : {}),
        fileAgentPreview,
        ...(multiFilePlan ? { usedFiles: multiFilePlan.usedFiles } : {}),
        ...usage,
        serverDiag: routeDiag,
      });
    } catch (err) {
      await refundOraQuotaFor(authed, quotaKind);
      logger.error(
        { component: "ora-chat-file", format: detectedFormat, err },
        "Auto file generation failed",
      );
      // A FileGenerationError carries a user-safe message (e.g. the model lost
      // the attached data) — surface it instead of the generic 500 fallback.
      if (err instanceof FileGenerationError) {
        res.status(422).json({ error: err.message });
      } else {
        res.status(500).json({ error: "Failed to generate file. Please try again." });
      }
    }
    return;
  }

  // ── Image generation tool (inline, signed-in users) ─────────────────────────
  // Anonymous visitors are caught by checkToolAccess above (image_signin_required).
  if (decision.tool === "image_generation") {
    // For a continuation reply ("go ahead and do it") the user's message carries
    // no description — use the prompt resolved from prior context by the router.
    const imagePrompt = decision.imagePrompt ?? message;
    let imageProviderModule: typeof import("../../lib/image-provider");
    try {
      imageProviderModule = await import("../../lib/image-provider");
    } catch (importErr) {
      await refundOraQuotaFor(authed, quotaKind);
      logger.error(
        { component: "ora-chat-image", err: importErr },
        "Failed to load image provider module",
      );
      res
        .status(500)
        .json({ error: "Image generation is temporarily unavailable. Please try again." });
      return;
    }
    const { generateImage, isImageProviderConfigured } = imageProviderModule;
    if (!isImageProviderConfigured()) {
      await refundOraQuotaFor(authed, quotaKind);
      const { token, payload } = chargeSession(session, streamFallbackToken);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply:
          "Image generation isn't configured on this server right now. Please try again later.",
        ...usage,
      });
      return;
    }
    try {
      const imageProfile = buildOraImageGenerationProfile({
        prompt: imagePrompt,
        subscriptionTier: authed?.tier ?? null,
      });
      const result = await generateImage({
        prompt: imageProfile.prompt,
        quality: imageProfile.quality,
        aspectRatio: imageProfile.aspectRatio,
        style: imageProfile.style,
        subscriptionTier: authed?.tier ?? null,
      });
      let editableImageId: number | undefined;
      if (authed) {
        // Persist the image into generated_images so it carries an editable id.
        // This is what powers inline editing: the existing /images/:id/edit
        // pipeline keys off a generated_images row (parent fileUrl + ownership).
        // Ora images are metered by the rolling-window IMAGE quota (incremented below),
        // NOT the Builder credit wallet, so this record is creditCost:0.
        try {
          const { storeGeneratedImage } = await import("../../lib/image-storage");
          const { db, generatedImagesTable } = await import("@workspace/db");
          const [imageRow] = await db
            .insert(generatedImagesTable)
            .values({
              userId: authed.userId,
              prompt: imageProfile.originalPrompt,
              quality: result.quality,
              aspectRatio: imageProfile.aspectRatio,
              style: imageProfile.style,
              providerName: result.providerName,
              modelName: result.modelName,
              status: "pending",
              safetyStatus: "passed",
              creditCost: 0,
              sourceType: "generated",
            })
            .returning({ id: generatedImagesTable.id });
          if (imageRow) {
            const stored = await storeGeneratedImage(result.openaiUrl, imageRow.id);
            await db
              .update(generatedImagesTable)
              .set({
                status: "completed",
                fileUrl: stored.fileUrl,
                thumbnailUrl: stored.thumbnailUrl,
                storageKey: stored.storageKey,
                revisedPrompt: result.revisedPrompt,
                updatedAt: sql`now()`,
              })
              .where(eq(generatedImagesTable.id, imageRow.id));
            editableImageId = imageRow.id;
          }
        } catch (storeErr) {
          // Non-fatal: the user still sees the inline image; it just won't be
          // editable. The durable Library copy (ora_assets) is handled below.
          logger.error(
            { component: "ora-chat-image", err: storeErr },
            "Failed to create editable generated_images record for Ora image",
          );
        }
      }
      const { token, payload } = chargeSession(session, streamFallbackToken);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply: "Here's the image you asked for. Tap Edit to refine it with an instruction.",
        imageUrl: result.openaiUrl,
        ...(editableImageId ? { imageId: editableImageId } : {}),
        imageMeta: {
          kind: imageProfile.kind,
          aspectRatio: imageProfile.aspectRatio,
          style: imageProfile.style,
          quality: imageProfile.quality,
        },
        ...usage,
        serverDiag: routeDiag,
      });
      // Persist to the durable asset library (best-effort, after the response so
      // the remote-URL fetch never adds latency) so the image survives chat
      // resets, reloads, and other devices (the OpenAI CDN URL expires).
      if (authed) {
        void (async () => {
          try {
            const { persistOraAsset, parseDataUri } = await import("../../lib/ora-assets");
            const parsed = parseDataUri(result.openaiUrl);
            let base64: string | null = parsed?.base64 ?? null;
            let mimeType = parsed?.mimeType ?? "image/png";
            if (!base64) {
              const imgRes = await fetch(result.openaiUrl);
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                base64 = buf.toString("base64");
                mimeType = imgRes.headers.get("content-type") ?? mimeType;
              }
            }
            if (base64) {
              const ext = mimeType.split("/")[1]?.split("+")[0] ?? "png";
              await persistOraAsset({
                userId: authed.userId,
                oraProjectId: await resolveAssetProjectId(authed.userId, oraProjectId),
                kind: "image",
                fileName: `ora-image-${Date.now()}.${ext}`,
                mimeType,
                format: ext,
                prompt: imageProfile.originalPrompt,
                base64,
              });
            }
          } catch (persistErr) {
            logger.error(
              { component: "ora-chat-image", err: persistErr },
              "Failed to persist Ora image to library",
            );
          }
        })();
      }
    } catch (err) {
      await refundOraQuotaFor(authed, quotaKind);
      logger.error({ component: "ora-chat-image", err }, "Inline image generation failed");
      res.status(500).json({ error: "Failed to generate the image. Please try again." });
    }
    return;
  }

  // ── Web search tool (live, grounded, cited) ─────────────────────────────────
  // Anonymous visitors are caught by checkToolAccess above (search_signin_required).
  if (decision.tool === "search") {
    if (isKillSwitchActive("web_search")) {
      await refundOraQuotaFor(authed, quotaKind);
      res.status(503).json(killSwitchBody("web_search"));
      return;
    }
    let webSearchModule: typeof import("../../lib/public-ai/web-search");
    try {
      webSearchModule = await import("../../lib/public-ai/web-search");
    } catch (importErr) {
      await refundOraQuotaFor(authed, quotaKind);
      logger.error(
        { component: "ora-chat-search", err: importErr },
        "Failed to load web search module",
      );
      res.status(500).json({ error: "Web search is temporarily unavailable. Please try again." });
      return;
    }
    const { isWebSearchConfigured, runOraWebSearch } = webSearchModule;
    if (!isWebSearchConfigured()) {
      await refundOraQuotaFor(authed, quotaKind);
      const { token, payload } = chargeSession(session, streamFallbackToken);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply:
          "Live web search isn't configured on this server right now. I can still help from what I already know.",
        ...usage,
      });
      return;
    }
    const history = (
      referenceChatHistory
        ? messages
            .slice(-6)
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
        : []
    ).filter((m) => m.content.trim().length > 0);
    // Personalize web search with what Ora already knows about the user, so a
    // search answer stays tailored (e.g. resolving "near me" to a saved city).
    // Mirrors the conversational branch: profile is always applied for signed-in
    // users; saved memories respect the referenceSavedMemories opt-out toggle.
    // Await the context builders started in parallel after auth; they have likely
    // already settled by this point (after the classifier + routing overhead).
    const searchProfileContext = await withTimeout(earlyProfileP, 600, "");
    // Temporary ("incognito") chats never read long-term saved memories.
    const searchMemory = await withTimeout(earlyMemoryP, 600, {
      text: "",
      used: [] as Array<{ id: number; title: string }>,
    });
    const searchPersonalContext = searchProfileContext + searchMemory.text;
    try {
      const result = await runOraWebSearch({
        query: message,
        history,
        language,
        personalContext: searchPersonalContext || undefined,
        documentContext: carriedDocs || undefined,
        wantsVideos: decision.wantsVideos,
        subscriptionTier: oraPlanTier(authed),
        // A user-initiated "Retry live search" runs the harder forced strategy
        // (longer timeout + low-effort secondary attempt) inside runOraWebSearch.
        forceLive: forceSearch,
      });
      const { token, payload } = chargeSession(session, streamFallbackToken);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply: result.reply,
        sources: result.sources,
        images: result.images,
        videos: result.videos,
        ...(searchMemory.used.length > 0 ? { memoriesUsed: searchMemory.used } : {}),
        ...usage,
        serverDiag: routeDiag,
      });
    } catch (err) {
      // Graceful degradation (Deep-mode QA blocker): a live web-search failure or
      // timeout must NOT leave the user with a dead "Web search failed" banner.
      // Answer from the model's own knowledge with an honest caveat, and tell the
      // client whether a live-verification retry is worthwhile (freshness-critical
      // queries) so it can surface a working Retry affordance. The quota already
      // consumed for this turn stays consumed because an answer is delivered; it
      // is refunded ONLY if the fallback answer itself also fails.
      // Structured triage metadata: the search module attaches attempt count,
      // latency, and a coarse failure reason to OraWebSearchError. Log it once so
      // forced vs. normal search failures are distinguishable in production.
      const searchErrMeta =
        err instanceof webSearchModule.OraWebSearchError
          ? {
              searchAttemptCount: err.attemptCount,
              searchLatencyMs: err.latencyMs,
              searchFailureReason: err.failureReason,
              searchProvider: err.searchProvider,
            }
          : {};
      // FORCED-RETRY CONTRACT: when the user explicitly tapped "Retry live
      // search", we already ran the harder forced strategy and it still failed.
      // Regenerating the long general-knowledge fallback here would just repeat
      // the exact answer they rejected. Instead, refund the quota (no answer
      // delivered) and return a retryable 503 so the client keeps the user's
      // message and the Retry affordance. This is the FIRST branch of the catch
      // so it runs BEFORE (and instead of) the general-knowledge fallback, which
      // guarantees exactly one refund and never calls createChatCompletion.
      if (forceSearch) {
        await refundOraQuotaFor(authed, quotaKind);
        logger.warn(
          { component: "ora-chat-search", forceSearch: true, ...searchErrMeta, err },
          "Ora forced live search failed — returning retryable 503 (no general-knowledge fallback)",
        );
        res.status(503).json({
          error:
            "Live search is temporarily unavailable. I could not verify current results. Please try again in a moment — your message is still here.",
          searchRetryable: true,
        });
        return;
      }
      // Graceful degradation for a NON-forced search failure: answer from the
      // model's own knowledge with an honest caveat instead of a dead banner.
      logger.warn(
        { component: "ora-chat-search", ...searchErrMeta, err },
        "Ora web search failed — degrading to a general-knowledge answer",
      );
      try {
        const fallbackDeep = mode === "deep" && !!authed?.isPaid;
        const fallbackRouteTier: OraRouteTier = fallbackDeep ? "deep" : "premium";
        const fallbackModel = openAiModelForOraRoute(fallbackRouteTier, planTier);
        const fallbackSystemPrompt =
          buildSystemPrompt(language, languageHint, !!authed, parsed.data.timeZone) +
          (fallbackDeep ? DEEP_SYSTEM_ADDENDUM : "") +
          searchPersonalContext +
          buildFileContextAddendum(carriedDocs, documentRefs);
        const fallbackMessages = [
          { role: "system" as const, content: fallbackSystemPrompt },
          ...history,
          ...(carriedDocs ? [{ role: "user" as const, content: carriedDocs }] : []),
          { role: "user" as const, content: message },
        ];
        const { createChatCompletion } = await import("../../lib/ai-providers");
        const { available, openCircuits } = getOraProviderRoutingSnapshot();
        const fallbackCandidates: ModelCandidate[] = selectOraModelRoute({
          tier: fallbackRouteTier,
          subscriptionTier: planTier,
          topic: classifierResult.topic,
          intent: classifierResult.intent,
          confidence: classifierResult.confidence,
          multilingual:
            isNonEnglishLanguage(language) ||
            ((!language || language === "auto") && isNonEnglishLanguage(languageHint)),
          hasDocumentContext: carriedDocs.trim().length > 0,
          available,
          openCircuits,
          openaiModel: fallbackModel,
        });
        const chain = await runCandidateChain(fallbackCandidates, async (candidate) => {
          const completion = await createChatCompletion({
            provider: candidate.provider,
            model: candidate.model,
            messages: fallbackMessages,
            response_format: { type: "text" },
            max_completion_tokens: fallbackDeep ? 1400 : 900,
            disableThinking: true,
          });
          // Fall through to the next provider on a blank completion instead of
          // failing the whole search-fallback with an empty answer.
          assertNonEmptyCompletion(completion);
          return completion;
        });
        const fallbackReply = chain.result.choices[0]?.message?.content?.trim() ?? "";
        if (!fallbackReply) {
          // Preserve the original search failure as the cause so both the search
          // error and the empty-fallback condition are visible when debugging.
          throw new Error("Ora search-fallback answer was empty", { cause: err });
        }
        // Freshness-critical prompts (e.g. "latest price", "today's news") are the
        // ones where a general-knowledge answer may be stale, so those get a
        // "retry live search" affordance; evergreen questions do not need one.
        const searchRetryable =
          webSearchModule.inferOraSearchPlan({ query: message }).freshness === "current";
        // Freshness-critical prompts must never present general knowledge as
        // today's verified headlines, so those get the explicit "couldn't
        // confirm the latest, tap Retry" note; evergreen questions keep the
        // generic note.
        const fallbackNote = searchRetryable ? SEARCH_FALLBACK_NOTE_FRESH : SEARCH_FALLBACK_NOTE;
        const { token, payload } = chargeSession(session, streamFallbackToken);
        setSessionCookie(res, token);
        const usage = await oraUsageResponse(authed, payload.msgCount);
        res.json({
          reply: fallbackNote + fallbackReply,
          searchFallback: true,
          searchRetryable,
          ...(searchMemory.used.length > 0 ? { memoriesUsed: searchMemory.used } : {}),
          ...usage,
          serverDiag: routeDiag,
        });
      } catch (fallbackErr) {
        // Both the live search AND the general-knowledge fallback failed. Refund
        // the quota (no answer delivered) and return a friendly, retryable error
        // instead of a dead banner — the client keeps the message and offers Retry.
        await refundOraQuotaFor(authed, quotaKind);
        logger.error(
          { component: "ora-chat-search", err: fallbackErr },
          "Ora web search fallback answer also failed",
        );
        res.status(503).json({
          error:
            "I couldn't reach live web results just now. Please try again in a moment — your message is still here.",
          searchRetryable: true,
        });
      }
    }
    return;
  }

  // ── Conversational answer / deep thinking ───────────────────────────────────
  // classifierResult and planTier are pre-computed in the parallel fan-out above;
  // no re-declaration needed here.

  // Deep Thinking always uses the strongest model with a larger token budget so
  // the step-by-step reasoning has room to land. Otherwise fall back to the
  // mini model only when the classifier is highly confident this is a simple FAQ.
  const usesMini =
    isInstantFastLane || // fast-lane always routes to the mini/fast model
    (!deepAllowed &&
      classifierResult.intent === "simple_faq" &&
      classifierResult.confidence === "high");
  // The routing tier mirrors the model/token dial above. `openaiModel` is the
  // env-aware OpenAI model the router uses verbatim for its OpenAI candidate.
  const routeTier: OraRouteTier = deepAllowed ? "deep" : usesMini ? "fast" : "premium";
  const primaryModel = openAiModelForOraRoute(routeTier, planTier);
  const expertiseProfile = buildOraExpertiseProfile({
    message,
    topic: classifierResult.topic,
    planTier,
    routeTier,
    intent: classifierResult.intent,
    confidence: classifierResult.confidence,
    hasDocumentContext: carriedDocs.trim().length > 0,
  });
  // Fast-lane keeps the standard "concise" token budget (450). A previous
  // hard 75-token cap truncated replies mid-sentence (e.g. greeting lists);
  // brevity is enforced by the concise depth guidance, not a hard cutoff,
  // and streaming means a larger ceiling does not delay the first token.
  const maxTokens = expertiseProfile.maxTokens;
  const isMultilingual =
    isNonEnglishLanguage(language) ||
    ((!language || language === "auto") && isNonEnglishLanguage(languageHint));

  // Chat history is opt-out: when the user turns off "reference chat history"
  // in their memory settings, each message is treated as a fresh conversation.
  // Fast-lane limits to the last 3 turns (6 messages) to minimise prompt size.
  const historyMessages: Array<{ role: "user" | "assistant"; content: string }> =
    referenceChatHistory
      ? messages
          .slice(isInstantFastLane ? -6 : -20)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];

  // Await the context builders that were started in parallel after auth.
  // Deep mode: 2000 ms. Fast-lane: 150 ms (simple prompts need minimal context).
  // Standard Instant: 300 ms (tightened from 600 ms — memory/profile resolve in
  // <20 ms in practice, so the cap is rarely the bottleneck).
  const CTX_BUDGET_MS = deepAllowed ? 2_000 : isInstantFastLane ? 150 : 300;
  const [memory, crossConvContext, profileContext] = await Promise.all([
    withTimeout(earlyMemoryP, CTX_BUDGET_MS, {
      text: "",
      used: [] as Array<{ id: number; title: string }>,
    }),
    authed && referenceChatHistory && !temporary
      ? withTimeout(
          buildCrossConversationContext(authed.userId, oraProjectId, message, conversationId),
          CTX_BUDGET_MS,
          "",
        )
      : Promise.resolve(""),
    withTimeout(earlyProfileP, CTX_BUDGET_MS, ""),
  ]);
  timing.t5 = Date.now();

  // Rolling conversation summary. Use the client-provided prior summary for the
  // model prompt so this turn is never blocked on a slow AI summary refresh.
  // Fire the refresh concurrently and await it AFTER the model returns so the
  // echoed value the client persists is up-to-date. Fail-safe to priorSummary.
  let conversationSummary = referenceChatHistory && !temporary ? (priorSummary ?? "").trim() : "";
  let summaryPromise: Promise<string> | null = null;
  if (referenceChatHistory && !temporary && summarizeMessages.length > 0) {
    const priorForSummary = conversationSummary;
    summaryPromise = (async () => {
      const { updateConversationSummary } =
        await import("../../lib/public-ai/conversation-summary");
      return updateConversationSummary({
        priorSummary: priorForSummary,
        newMessages: summarizeMessages.map((m) => ({ role: m.role, content: m.content })),
        subscriptionTier: planTier,
      });
    })();
    summaryPromise = summaryPromise.catch(() => priorForSummary);
  }
  const summaryContext = conversationSummary
    ? `\n\n## Earlier in this conversation\nThe following is a running summary of earlier parts of THIS conversation that have scrolled out of the recent message window. Treat these as established context and stay consistent with them, but defer to anything more recent:\n${conversationSummary}`
    : "";
  const memoryStatusContext = buildMemoryStatusContext({
    authed: !!authed,
    temporary,
    referenceSavedMemories,
    message,
    memoryUsedCount: memory.used.length,
    hasCrossConversationContext: crossConvContext.trim().length > 0,
  });

  // A multi-file plan appends its role directive so the answer path (compare
  // analyses, collection summaries) uses each uploaded file as planned.
  const fileContextAddendum =
    buildFileContextAddendum(carriedDocs, documentRefs) +
    (multiFilePlan ? `\n\n${multiFilePlan.directive}` : "");

  const systemPrompt =
    buildSystemPrompt(language, languageHint, !!authed, parsed.data.timeZone) +
    (deepAllowed ? DEEP_SYSTEM_ADDENDUM : "") +
    (referenceAnalysisTurn
      ? PASTED_REFERENCE_ANALYSIS_ADDENDUM + summarizePastedReferenceSignals(message)
      : "") +
    expertiseProfile.systemAddendum +
    fileContextAddendum +
    buildSourceCitationAddendum(carriedDocs) +
    profileContext +
    memoryStatusContext +
    memory.text +
    crossConvContext +
    summaryContext;

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...historyMessages,
    // Re-injected earlier uploads (if any) so follow-up questions about a
    // previously uploaded document can be answered from its actual content.
    ...(carriedDocs ? [{ role: "user" as const, content: carriedDocs }] : []),
    { role: "user" as const, content: message },
  ];

  // Build the topic-enriched suggestion prompt using the classifier's detected topic.
  const topicGuidance = topicSuggestionGuidance(classifierResult.topic);
  const suggestionSystemPrompt = [
    "You generate follow-up questions for a conversational AI assistant named Ora.",
    'Given the conversation so far, return a JSON object with a "suggestions" array of 2-3 short follow-up questions the user could ask next.',
    "Each question must be under 60 characters, natural, and non-repetitive.",
    "",
    `Detected conversation topic: ${classifierResult.topic}`,
    `Topic guidance: ${topicGuidance}`,
    "",
    'Generate follow-ups that are specific and useful for this topic — avoid generic questions like "Tell me more" or "What else can you do?".',
  ].join("\n");

  const recentHistory = historyMessages.slice(-4);
  let aiProvidersModule: typeof import("../../lib/ai-providers");
  try {
    aiProvidersModule = await import("../../lib/ai-providers");
  } catch (importErr) {
    await refundOraQuotaFor(authed, quotaKind);
    logger.error({ component: "ora-chat", err: importErr }, "Failed to load AI providers module");
    res
      .status(502)
      .json({ error: "Ora is temporarily unavailable. Please try again in a moment." });
    return;
  }
  const { createChatCompletion } = aiProvidersModule;

  // Smart-route across all four providers (Task #1400). Build a snapshot of
  // which providers are configured and which circuits are currently open, then
  // ask the router for an availability-aware ordered candidate chain.
  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  const candidates: ModelCandidate[] = selectOraModelRoute({
    tier: routeTier,
    subscriptionTier: planTier,
    topic: classifierResult.topic,
    intent: classifierResult.intent,
    confidence: classifierResult.confidence,
    multilingual: isMultilingual,
    hasDocumentContext: carriedDocs.trim().length > 0,
    available,
    openCircuits,
    openaiModel: primaryModel,
  });

  // Run the main reply and suggestion generation in parallel to reduce latency.
  // Suggestions use the conversation history + current message + topic context;
  // the main reply is not yet available but topic-enriched guidance compensates.
  const start = Date.now();

  const [mainResult, suggestionResult] = await Promise.allSettled([
    (async () => {
      const chain = await runCandidateChain(
        candidates,
        async (candidate) => {
          const completion = await createChatCompletion({
            provider: candidate.provider,
            model: candidate.model,
            messages: callMessages,
            response_format: { type: "text" },
            max_completion_tokens: maxTokens,
            disableThinking: true,
          });
          // A blank HTTP-200 completion (observed with gemini-3-flash-preview at
          // low token ceilings) does not throw, so without this the chain would
          // "succeed" with empty content and 502 instead of trying the next
          // provider. Throwing here advances to the Anthropic/OpenAI fallback.
          assertNonEmptyCompletion(completion);
          return completion;
        },
        (candidate, i, candidateErr) =>
          logger.warn(
            {
              component: "ora-chat",
              provider: candidate.provider,
              model: candidate.model,
              attempt: i + 1,
              ofCandidates: candidates.length,
              err: candidateErr,
            },
            "Ora model candidate failed — trying next provider in fallback chain",
          ),
      );
      return {
        reply: chain.result.choices[0]?.message?.content?.trim() ?? null,
        // "usedFallback" means we did not land on the first-choice provider.
        usedFallback: chain.usedFallback,
        modelUsed: chain.candidate.model,
        provider: chain.candidate.provider,
        fallbackReason: chain.fallbackReason ?? null,
      };
    })(),
    referenceAnalysisTurn
      ? Promise.resolve(null)
      : createChatCompletion({
          provider: "openai",
          model: "gpt-5-mini",
          messages: [
            { role: "system" as const, content: suggestionSystemPrompt },
            ...recentHistory,
            { role: "user" as const, content: message },
            {
              role: "user" as const,
              content: "Suggest 2-3 short follow-up questions I could ask next.",
            },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: 200,
        }),
  ]);

  const latencyMs = Date.now() - start;

  // Extract main reply result
  let reply: string | null = null;
  let usedFallback = false;
  let modelUsed = primaryModel;
  let provider: Provider = "openai";
  let fallbackReason: string | null = null;

  if (mainResult.status === "fulfilled") {
    ({ reply, usedFallback, modelUsed, provider, fallbackReason } = mainResult.value);
  } else {
    logger.error(
      { component: "ora-chat", err: mainResult.reason },
      "Main model and fallback both failed",
    );
  }

  logger.info(
    {
      component: "ora-chat",
      model: modelUsed,
      provider,
      intent: classifierResult.intent,
      confidence: classifierResult.confidence,
      topic: classifierResult.topic,
      routeTier,
      planTier,
      expertiseDomain: expertiseProfile.domain,
      answerDepth: expertiseProfile.depth,
      candidates: candidates.map((c) => `${c.provider}:${c.model}`),
      latencyMs,
      usedFallback,
      fallbackReason,
      maxTokens,
      classifierMs,
      classifierSkipped,
      routedTool,
      searchUsed,
      replyEmpty: !reply,
    },
    "Ora chat completion",
  );

  if (!reply) {
    await refundOraQuotaFor(authed, quotaKind);
    res
      .status(502)
      .json({ error: "Ora is temporarily unavailable. Please try again in a moment." });
    return;
  }

  // Safety net: if the conversational reply CLAIMED a file was attached (it
  // never is on this path), generate the promised file for real — or replace
  // the claim with an honest correction if generation fails.
  const rescuedDelivery = await rescueClaimedFileDelivery({
    reply,
    message,
    carriedDocs,
    history: historyMessages,
    language,
    authed,
    oraProjectId,
    logComponent: "ora-chat",
  });
  if (rescuedDelivery) {
    reply = rescuedDelivery.reply;
  }

  // Video links in conversational replies: the model occasionally volunteers a
  // YouTube/Vimeo URL inline in its prose. Lift those out and render them as
  // verified play cards (same pipeline as the search branch) instead of plain,
  // unverified, often-dead links. Only runs when the reply actually contains an
  // embeddable video URL, so normal replies pay no extra cost.
  let videos: OraVideo[] = [];
  {
    const { extractProseVideos, verifyVideos } = await import("../../lib/public-ai/web-search");
    const lifted = extractProseVideos(reply);
    if (lifted.videos.length > 0) {
      videos = await verifyVideos(lifted.videos);
      // Only swap in the stripped text if something remains; if the reply was
      // essentially just the lifted URL(s), keep a short lead-in so the bubble
      // is never empty (the cards carry the payload).
      const stripped = lifted.text.trim();
      reply = stripped.length > 0 ? lifted.text : "Here you go:";
    }
  }

  // Phase 8: derive verified uploaded-file citations from the FINAL reply text
  // (post-rescue, post video-lift) against the file content actually injected
  // this turn. Deterministic and allow-listed — the model cannot fabricate one.
  const fileCitations = deriveFileCitations(reply, buildFileCitationAllowList(carriedDocs));

  // Extract suggestions — failures are silently swallowed so the main reply is never blocked.
  let suggestions: string[] = [];
  if (!referenceAnalysisTurn) {
    if (suggestionResult.status === "fulfilled") {
      try {
        const raw = suggestionResult.value?.choices[0]?.message?.content?.trim() ?? "{}";
        const parsedSuggestions = JSON.parse(raw) as { suggestions?: unknown };
        if (Array.isArray(parsedSuggestions.suggestions)) {
          suggestions = (parsedSuggestions.suggestions as unknown[])
            .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 60)
            .slice(0, 3);
        }
      } catch (parseErr) {
        logger.debug({ component: "ora-chat", err: parseErr }, "Suggestion parse failed");
      }
    } else {
      logger.debug(
        { component: "ora-chat", err: suggestionResult.reason },
        "Suggestion generation skipped",
      );
    }
  }

  // The rolling-window MESSAGE quota was already reserved atomically at the top of the
  // handler (consumeOraQuota). Since the reply succeeded we keep the reservation
  // — no extra increment here, and no refund.
  const { token, payload } = chargeSession(session, streamFallbackToken);
  setSessionCookie(res, token);

  // Ora is a standalone assistant. It NEVER proactively routes to any external
  // builder or handoff endpoint — no topic- or message-count-based redirects.

  // Fire memory-save extraction immediately after the model returns — it only
  // needs the user message + tier, so it can run concurrently with the usage
  // query below. Previously this was a sequential await, adding ~300ms.
  const memoryCandidatePromise =
    authed && !temporary && !referenceAnalysisTurn
      ? extractMemorySaveCandidate(message, planTier).catch(() => null)
      : Promise.resolve(null);

  // Await summary refresh, memory candidate, and usage concurrently.
  // summaryPromise has been in flight since before the model call, so it is
  // usually already settled by the time we get here.
  if (summaryPromise) {
    conversationSummary = await summaryPromise;
  }
  const [memoryCandidate, usage] = await Promise.all([
    memoryCandidatePromise,
    oraUsageResponse(authed, payload.msgCount),
  ]);

  const totalMs = Date.now() - timing.t0;
  logger.info(
    {
      component: "ora-chat",
      intent: classifierResult.intent,
      confidence: classifierResult.confidence,
      topic: classifierResult.topic,
      routeTier,
      planTier,
      totalMs,
      classifierSkipped,
      routedTool,
      searchUsed,
      timingMs: {
        sessionMs: timing.t1 - timing.t0,
        authMs: timing.t2 - timing.t1,
        spendCapMs: timing.t3 - timing.t2,
        quotaMs: timing.t4 - timing.t3,
        classifierMs, // isolated intent-classifier await (0 when skipped)
        contextMs: timing.t5 - timing.t4,
        modelMs: totalMs - (timing.t5 - timing.t0),
      },
    },
    "Ora non-streaming completion",
  );

  res.json({
    serverDiag: routeDiag,
    reply,
    suggestions,
    ...(videos.length > 0 ? { videos } : {}),
    ...(memoryCandidate
      ? {
          memorySaveCandidate: memoryCandidate.fact,
          memorySaveCandidateConfidence: memoryCandidate.confidence,
          memorySaveCandidateSensitive: memoryCandidate.sensitive,
        }
      : {}),
    // Echo the (possibly updated) rolling summary so the client can persist it
    // and re-send it on the next turn. Always present when chat history is on so
    // the client can advance its "already summarized" pointer.
    ...(referenceChatHistory && !temporary ? { conversationSummary } : {}),
    // Surface which saved Ora memories shaped this reply (Ora-scoped only) so
    // the client can show an unobtrusive "based on your saved memories"
    // indicator that deep-links to the Memory Center.
    ...(memory.used.length > 0 ? { memoriesUsed: memory.used } : {}),
    // Phase 5: which uploaded files this reply drew on, and in what role —
    // lets clients render "Used: report.docx + budget.xlsx" chips.
    ...(multiFilePlan ? { usedFiles: multiFilePlan.usedFiles } : {}),
    // Phase 8: verified uploaded-file citations (file + slide/sheet locator),
    // derived server-side against the injected content — never model-claimed.
    ...(fileCitations.length > 0 ? { fileCitations } : {}),
    ...(rescuedDelivery?.fileName && rescuedDelivery.fileData && rescuedDelivery.mimeType
      ? {
          fileName: rescuedDelivery.fileName,
          fileData: rescuedDelivery.fileData,
          mimeType: rescuedDelivery.mimeType,
          ...(rescuedDelivery.assetId != null ? { assetId: rescuedDelivery.assetId } : {}),
        }
      : {}),
    mode: deepAllowed ? "deep" : "instant",
    ...usage,
  });
});

// ── Streaming chat: POST /public-ai/chat/stream ─────────────────────────────
// Requires ORA_STREAMING_ENABLED=true; falls back to /chat when absent.
// Specialist tools (file_gen, image_gen, search) return a JSON
// { streamingFallback: true } signal so the client can retry via /chat.
// Conversational replies stream tokens using streamChatCompletion with the
// same multi-provider candidate chain as the non-streaming route.
router.post("/public-ai/chat/stream", async (req, res) => {
  if (isKillSwitchActive("streaming")) {
    res.status(503).json(killSwitchBody("streaming"));
    return;
  }
  if (process.env.ORA_STREAMING_ENABLED !== "true") {
    res
      .status(503)
      .json({ error: "Streaming is not enabled on this server.", streamingFallback: true });
    return;
  }

  // ── Per-bucket latency tracking ───────────────────────────────────────────
  // Privacy-safe: only timings and routing metadata logged — no prompt text,
  // no memory content, no user identifiers beyond anonymised tier/mode.
  // Object accumulator avoids the no-useless-assignment lint rule that fires
  // when let variables are given an initial value that is overwritten before
  // it is read (which is the case here — each bucket is set at its own point).
  const timing = {
    t0: Date.now(), // request entered handler (past kill switches)
    t1: 0, // after session validation
    t2: 0, // after auth user resolved
    t3: 0, // after spend-cap check
    t4: 0, // after quota reserve + route decision
    t5: 0, // after memory/context/profile loaded (concurrent)
    t6: 0, // after SSE headers flushed + start event emitted
    t7: 0, // after stream loop complete
    tFirstToken: -1, // first token written to client (-1 = not received)
  };

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const {
    message,
    messages,
    language,
    languageHint,
    mode,
    referenceSavedMemories,
    referenceChatHistory,
    documentRefs,
    conversationSummary: priorSummary,
    summarizeMessages,
    oraProjectId,
    temporary,
    conversationId,
    pendingClarification,
  } = parsed.data;

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }
  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }
  timing.t1 = Date.now(); // session cookie validated

  if (
    !scanUserInput(message) ||
    (pendingClarification && !scanUserInput(pendingClarification.originalMessage))
  ) {
    res
      .status(400)
      .json({ error: "Your message contains patterns that cannot be processed. Please rephrase." });
    return;
  }

  // Detect fast-lane BEFORE firing the classifier — once we know this is a
  // short, simple prompt we skip the AI classifier call entirely (saves the
  // full 500 ms timeout per fast-lane turn, no background kick-off).
  const isInstantFastLane =
    mode === "instant" &&
    message.length <= 120 &&
    documentRefs.length === 0 &&
    !looksLikeImageGenerationIntent(message) &&
    !looksLikeWebSearchIntent(message) &&
    !looksLikeFileGenIntent(message);

  // Skip the intent classifier when it cannot change routing: fast-lane turns
  // and explicit deep mode. Deep always routes to deep_thinking and already fed
  // CLASSIFIER_FALLBACK to routing on every turn (the classifier reliably returns
  // empty for deep and defaults to premium/high/general), so skipping the ~1.7s
  // call is byte-identical. routeOraMessage accepts a pre-computed `classifier`
  // result so it skips its own internal AI call when we supply one.
  const skipClassifier = isInstantFastLane || mode === "deep";
  const classifierPromise = skipClassifier ? null : classifyIntent(message);
  // Attach a no-op catch so any unexpected rejection from classifyIntent does
  // not become an unhandled rejection when an early-return path (429, spend cap)
  // exits before `await classifierPromise` is reached.
  if (classifierPromise) void classifierPromise.catch(() => undefined);

  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  timing.t2 = Date.now(); // auth user resolved (Clerk JWT + DB lookup)

  // planTier is available as soon as auth resolves (only depends on authed.tier).
  const planTier = oraPlanTier(authed);

  // Start context builders immediately after auth — userId and planTier are both
  // available now. Previously these started after the routing decision (classifier
  // AI call + quota), adding up to 600 ms of unnecessary sequential delay.
  // They are awaited (with an Instant-mode timeout) after routing completes.
  const earlyMemoryP =
    authed && referenceSavedMemories && !temporary
      ? buildMemoryContext(authed.userId, oraProjectId, message, planTier)
      : Promise.resolve<MemoryContextResult>({ text: "", used: [] });
  // Guard: prevent unhandled rejections when an early-exit path (429, spend cap)
  // returns before earlyMemoryP is awaited. The builders have internal try/catch
  // but this is a defensive belt-and-suspenders guard.
  void earlyMemoryP.catch(() => undefined);
  const earlyProfileP = authed ? buildProfileContext(authed.userId) : Promise.resolve("");
  void earlyProfileP.catch(() => undefined);

  const effectiveMsgLimit = authed ? await oraMessageLimit(authed.tier) : MSG_LIMIT_VALUE;

  if (!authed && session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error: `You've reached the ${MSG_LIMIT_VALUE}-message limit for anonymous sessions. Sign up free at www.mustaflow.com for unlimited conversations, memory, image generation, and more.`,
      upgradeCta: true,
      signUpUrl: "https://www.mustaflow.com/sign-up",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  // ── Daily spend cap (global + per-IP anonymous) ─────────────────────────
  {
    const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
    const capResult = await checkOraSpendCapAsync(
      req,
      "streaming_chat",
      authed?.userId ?? null,
      authed?.tier ?? "anonymous",
    );
    if (!capResult.allowed) {
      res.status(429).json({
        error: capResult.message,
        limitType: capResult.limitType,
        upgradeAvailable: capResult.upgradeAvailable,
        resetAt: capResult.resetAt,
        retryAfter: capResult.retryAfter,
      });
      return;
    }
  }
  timing.t3 = Date.now(); // spend-cap check complete

  // The classifier was either skipped entirely (fast-lane / deep mode) or fired
  // in parallel with auth. classifierMs isolates the await cost for diagnostics.
  const classifierTimeoutMsStream = mode === "instant" ? 500 : 2_000;
  const classifierSkipped = classifierPromise === null;
  const tClassifier0 = Date.now();
  const classifierResult = classifierSkipped
    ? CLASSIFIER_FALLBACK // skipped: routing uses the premium/high/general default
    : await withTimeout(classifierPromise!, classifierTimeoutMsStream, CLASSIFIER_FALLBACK);
  const classifierMs = classifierSkipped ? 0 : Date.now() - tClassifier0;

  if (authed && session.msgCount >= effectiveMsgLimit) {
    const usage = await oraUsageResponse(authed, session.msgCount);
    res.status(429).json({
      error:
        "You've reached your Ora message limit for this period. Upgrade your plan or wait for your window to reset.",
      upgradeCta: true,
      ...usage,
    });
    return;
  }

  const referenceAnalysisTurn = isPastedReferenceAnalysisRequest(message);

  let decision = await routeOraMessage({
    message,
    mode,
    recentMessages: messages.slice(-8),
    classifier: classifierResult, // pre-computed above — skips the internal AI call
  });
  const carriedDocs = await buildCarriedDocumentContext(
    documentRefs,
    session.sessionId,
    message,
    authed?.userId ?? null,
  );
  // Phase 5: multi-file metadata (2+ refs only) so the stream route can detect
  // cross-file workflows and bounce them to /chat — multi-file turns need the
  // planner directive and usedFiles payload, which only /chat produces.
  const carriedFileMeta: CarriedFileMeta[] =
    documentRefs.length >= 2
      ? await resolveCarriedFileMeta(documentRefs, session.sessionId, authed?.userId ?? null)
      : [];

  // Merge a clarification answer with its round-tripped pending task context
  // so routing sees the full original task (same logic as /chat — the merged
  // edit then bounces to /chat below, which repeats the merge and executes).
  const continuation = resolveClarificationContinuation({
    message,
    pending: pendingClarification ?? null,
    carriedDocs,
  });

  // Cancel short-circuit — mirrors the non-streaming handler; streams a
  // single acknowledgement chunk so the client SSE path stays consistent.
  if (continuation.isCancelled) {
    const cancelReply =
      continuation.cancelledReply ??
      "No problem — cancelled. Let me know if you'd like to make a different change.";
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ chunk: cancelReply, done: false })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const routedMessage = continuation.routedMessage;

  // Deterministic final routing precedence — same shared resolver as the
  // non-streaming /chat route so the two handlers cannot drift. The stream
  // route never receives a user-forced search retry (clients send those to
  // the non-streaming route), so forceSearch is always false here.
  const finalRoute = resolveFinalOraRoute({
    decision,
    message: routedMessage,
    carriedDocs,
    forceSearch: false,
  });
  decision = finalRoute.decision;

  const deepAllowed = decision.tool === "deep_thinking";
  const routedTool = decision.tool;
  const searchUsed = decision.tool === "search";

  const access = checkToolAccess(decision.tool, {
    authed: !!authed,
    isPaid: authed?.isPaid ?? false,
  });
  if (!access.allowed) {
    if (access.denyCode === "deep_paid_only") {
      res.json({
        reply: authed
          ? "Deep Thinking is available on the Core Pack and Deep Wave plans. It reasons step by step for more thorough, considered answers. Upgrade to unlock it — or keep chatting in Instant mode."
          : "Deep Thinking is available to signed-in MustaFlow members on the Core Pack and Deep Wave plans. Sign up to unlock it — or keep chatting here in Instant mode.",
        upgradeCta: true,
        mode: "instant",
        msgCount: session.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    if (access.denyCode === "image_signin_required") {
      res.json({
        reply: IMAGE_GENERATE_CTA,
        upgradeCta: true,
        msgCount: session.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    if (access.denyCode === "search_signin_required") {
      res.json({
        reply: SEARCH_SIGNIN_CTA,
        upgradeCta: true,
        msgCount: session.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    res.json({
      reply:
        "That capability isn't available yet. I can still help you plan it, analyze your data, generate files, or talk it through.",
      msgCount: session.msgCount,
      msgLimit: effectiveMsgLimit,
    });
    return;
  }

  // Clarifying questions are only ever emitted by the non-streaming /chat
  // route. When this turn would trigger one (including the "answer"-routed
  // "return it after modification" case that would otherwise stream a generic
  // reply), bounce the client there exactly like the specialist tools below —
  // stream clients discard any other plain JSON on this endpoint.
  if (
    !continuation.applied &&
    planOraClarification({
      message,
      carriedDocs,
      finalTool: decision.tool,
      conflictResolution: finalRoute.conflictResolution,
      inferredFileFormat: finalRoute.inferredFileFormat,
      hasPendingClarification: !!pendingClarification,
      files: carriedFileMeta,
    })
  ) {
    res.json({ streamingFallback: true, tool: "file_generation" });
    return;
  }

  // Phase 5: multi-file workflows (compare/merge/data→deck/summarize across
  // 2+ uploads) always execute on the non-streaming /chat route, which owns
  // the planner directive, target steering, and usedFiles payload. Bounce
  // exactly like the specialist tools below. This does NOT change streaming
  // cadence for any single-file or no-file turn.
  if (
    planOraMultiFile({
      message: routedMessage,
      files: carriedFileMeta,
      finalTool: decision.tool,
    })
  ) {
    res.json({ streamingFallback: true, tool: decision.tool });
    return;
  }

  // Specialist tools: fall back to the non-streaming /chat endpoint. The
  // client receives this JSON signal and immediately re-issues the request to
  // /api/public-ai/chat which has all the specialised logic.
  if (
    decision.tool === "file_generation" ||
    decision.tool === "image_generation" ||
    decision.tool === "image_editing" ||
    decision.tool === "search"
  ) {
    res.json({ streamingFallback: true, tool: decision.tool });
    return;
  }

  const quotaKind: OraQuotaKind = "message";
  if (authed) {
    const { consumeOraQuota } = await import("../../lib/public-ai/ora-usage");
    const quota = await consumeOraQuota(authed.userId, authed.tier, quotaKind);
    if (!quota.allowed) {
      const usage = await oraUsageResponse(authed, session.msgCount);
      res.status(429).json({
        error: `You've used all ${quota.limit} Ora messages in your current window. Upgrade for a higher limit, or wait for your window to reset.`,
        upgradeCta: true,
        ...usage,
      });
      return;
    }
  }
  timing.t4 = Date.now(); // quota reserved + route decision complete

  // ── Conversational answer / deep thinking (token streaming) ─────────────────
  // classifierResult was pre-computed in parallel with auth (above).
  // planTier was computed right after auth resolved (above).

  const usesMini =
    isInstantFastLane || // fast-lane always routes to the mini/fast model
    (!deepAllowed &&
      classifierResult.intent === "simple_faq" &&
      classifierResult.confidence === "high");
  const routeTier: OraRouteTier = deepAllowed ? "deep" : usesMini ? "fast" : "premium";
  const primaryModel = openAiModelForOraRoute(routeTier, planTier);
  const expertiseProfile = buildOraExpertiseProfile({
    message,
    topic: classifierResult.topic,
    planTier,
    routeTier,
    intent: classifierResult.intent,
    confidence: classifierResult.confidence,
    hasDocumentContext: carriedDocs.trim().length > 0,
  });
  // Fast-lane keeps the standard "concise" token budget (450). A previous
  // hard 75-token cap truncated replies mid-sentence; brevity comes from the
  // concise depth guidance, not a hard cutoff.
  const maxTokens = expertiseProfile.maxTokens;
  const isMultilingual =
    isNonEnglishLanguage(language) ||
    ((!language || language === "auto") && isNonEnglishLanguage(languageHint));

  // Fast-lane limits to the last 3 turns (6 messages) to minimise prompt size.
  const historyMessages: Array<{ role: "user" | "assistant"; content: string }> =
    referenceChatHistory
      ? messages
          .slice(isInstantFastLane ? -6 : -20)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];

  // Await the context builders that were started in parallel with auth (above).
  // Instant mode applies a 600 ms remaining-budget cap so a slow DB query does
  // not hold up the first streaming token. The promises have been in flight
  // since t2, so the budget is the maximum ADDITIONAL wait after routing — not
  // an absolute deadline from the start of the request.
  // Deep mode: 2000 ms. Fast-lane: 150 ms (simple prompts need minimal context).
  // Standard Instant: 300 ms (tightened from 600 ms — memory/profile resolve in
  // <20 ms in practice so the cap is rarely the limiting factor).
  const CTX_BUDGET_MS = deepAllowed ? 2_000 : isInstantFastLane ? 150 : 300;
  const [memory, crossConvContext, profileContext] = await Promise.all([
    withTimeout(earlyMemoryP, CTX_BUDGET_MS, {
      text: "",
      used: [] as Array<{ id: number; title: string }>,
    }),
    authed && referenceChatHistory && !temporary
      ? withTimeout(
          buildCrossConversationContext(authed.userId, oraProjectId, message, conversationId),
          CTX_BUDGET_MS,
          "",
        )
      : Promise.resolve(""),
    withTimeout(earlyProfileP, CTX_BUDGET_MS, ""),
  ]);
  timing.t5 = Date.now(); // memory + cross-conv + profile context loaded

  // Rolling conversation summary. The summary refresh is a separate AI call
  // (timeout up to 5s, frequently the long pole) and is only needed to enrich
  // the prompt with context that has scrolled out of the recent window plus the
  // echoed value the client persists. To keep streaming perceptible we do NOT
  // block the first token on it: this turn's prompt uses the client-provided
  // prior summary, and the refresh runs concurrently with the AI stream. The
  // updated value is awaited only just before the final done payload (by which
  // point the ~5s stream has usually let it finish). The omitted context is the
  // 1-2 messages that just overflowed the recent 20-turn window; they fold into
  // the summary on the next turn.
  let conversationSummary = referenceChatHistory && !temporary ? (priorSummary ?? "").trim() : "";
  let summaryPromise: Promise<string> | null = null;
  if (referenceChatHistory && !temporary && summarizeMessages.length > 0) {
    const priorForSummary = conversationSummary;
    summaryPromise = (async () => {
      const { updateConversationSummary } =
        await import("../../lib/public-ai/conversation-summary");
      return updateConversationSummary({
        priorSummary: priorForSummary,
        newMessages: summarizeMessages.map((m) => ({ role: m.role, content: m.content })),
        subscriptionTier: planTier,
      });
    })();
    // Fail safe to the prior summary so a rejected/timed-out refresh never
    // surfaces as an unhandled rejection or breaks the done payload.
    summaryPromise = summaryPromise.catch(() => priorForSummary);
  }
  const summaryContext = conversationSummary
    ? `\n\n## Earlier in this conversation\nThe following is a running summary of earlier parts of THIS conversation that have scrolled out of the recent message window. Treat these as established context and stay consistent with them, but defer to anything more recent:\n${conversationSummary}`
    : "";
  const memoryStatusContext = buildMemoryStatusContext({
    authed: !!authed,
    temporary,
    referenceSavedMemories,
    message,
    memoryUsedCount: memory.used.length,
    hasCrossConversationContext: crossConvContext.trim().length > 0,
  });

  const fileContextAddendum = buildFileContextAddendum(carriedDocs, documentRefs);

  const systemPrompt =
    buildSystemPrompt(language, languageHint, !!authed, parsed.data.timeZone) +
    (deepAllowed ? DEEP_SYSTEM_ADDENDUM : "") +
    (referenceAnalysisTurn
      ? PASTED_REFERENCE_ANALYSIS_ADDENDUM + summarizePastedReferenceSignals(message)
      : "") +
    expertiseProfile.systemAddendum +
    fileContextAddendum +
    buildSourceCitationAddendum(carriedDocs) +
    profileContext +
    memoryStatusContext +
    memory.text +
    crossConvContext +
    summaryContext;

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...historyMessages,
    ...(carriedDocs ? [{ role: "user" as const, content: carriedDocs }] : []),
    { role: "user" as const, content: message },
  ];

  let aiProvidersModule: typeof import("../../lib/ai-providers");
  try {
    aiProvidersModule = await import("../../lib/ai-providers");
  } catch (importErr) {
    await refundOraQuotaFor(authed, quotaKind);
    logger.error(
      { component: "ora-chat-stream", err: importErr },
      "Failed to load AI providers module",
    );
    res
      .status(502)
      .json({ error: "Ora is temporarily unavailable. Please try again in a moment." });
    return;
  }
  const { createChatCompletion } = aiProvidersModule;

  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  const candidates: ModelCandidate[] = selectOraModelRoute({
    tier: routeTier,
    subscriptionTier: planTier,
    topic: classifierResult.topic,
    intent: classifierResult.intent,
    confidence: classifierResult.confidence,
    multilingual: isMultilingual,
    hasDocumentContext: carriedDocs.trim().length > 0,
    available,
    openCircuits,
    openaiModel: primaryModel,
  });

  // Fire suggestion generation in parallel with the main stream.
  const topicGuidance = topicSuggestionGuidance(classifierResult.topic);
  const suggestionSystemPrompt = [
    "You generate follow-up questions for a conversational AI assistant named Ora.",
    'Given the conversation so far, return a JSON object with a "suggestions" array of 2-3 short follow-up questions the user could ask next.',
    "Each question must be under 60 characters, natural, and non-repetitive.",
    "",
    `Detected conversation topic: ${classifierResult.topic}`,
    `Topic guidance: ${topicGuidance}`,
    "",
    'Generate follow-ups that are specific and useful for this topic — avoid generic questions like "Tell me more" or "What else can you do?".',
  ].join("\n");
  const recentHistory = historyMessages.slice(-4);
  const suggestionPromise = referenceAnalysisTurn
    ? Promise.resolve(null)
    : createChatCompletion({
        provider: "openai",
        model: "gpt-5-mini",
        messages: [
          { role: "system" as const, content: suggestionSystemPrompt },
          ...recentHistory,
          { role: "user" as const, content: message },
          {
            role: "user" as const,
            content: "Suggest 2-3 short follow-up questions I could ask next.",
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 200,
      }).catch(() => null);

  // Import stream helpers BEFORE flushHeaders so anySignal is available for
  // the first-token timeout we create here (timeout must be set up before we
  // start streaming, and cookies must be set before headers flush).
  const { writeSSE, anySignal, streamOraMessage } =
    await import("../../lib/public-ai/stream-adapter");

  // Pre-increment session + set cookie BEFORE flushing SSE headers — once
  // headers are flushed no further Set-Cookie headers can be added.
  // `markSessionAsPreIncremented` tags the JWT with `streamingPreIncremented: true`
  // so the non-streaming /chat route (chargeSession helper) can detect a fallback
  // retry and skip the increment, preventing an anonymous-session double-count.
  const { token: updatedToken, payload: updatedPayload } = markSessionAsPreIncremented(session);
  setSessionCookie(res, updatedToken);

  // SSE headers:
  //   Cache-Control: no-cache, no-transform — disables CDN/edge buffering and
  //     prevents any proxy from re-encoding the byte stream.
  //   X-Accel-Buffering: no — tells nginx not to buffer SSE frames.
  //   Connection: keep-alive — required for long-running SSE responses.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Disable Nagle's algorithm on the underlying TCP socket so each res.write()
  // is sent as its own TCP segment immediately without waiting for an ACK.
  // Without this, small SSE frames can be held in the OS send buffer for up to
  // the Nagle timeout (~200 ms) before being transmitted.
  const sock = res.socket as import("net").Socket | null;
  if (sock?.setNoDelay) sock.setNoDelay(true);

  // Emit `start` immediately so the client knows the SSE connection is live
  // before the first AI token arrives (avoids a perceived hang while the
  // candidate chain warms up).
  writeSSE(res, {
    type: "start",
    ...(conversationId ? { conversationId: String(conversationId) } : {}),
  });
  timing.t6 = Date.now(); // SSE headers flushed + start event emitted

  // Abort the stream when the client closes the connection.
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  // 30-second guard: if no first token arrives within this window the provider
  // is considered stuck. The timeout signal is combined with the client-
  // disconnect signal so whichever fires first wins. Once the first token
  // arrives the timer is cleared and only client-disconnect matters.
  const firstTokenTimeoutController = new AbortController();
  const FIRST_TOKEN_TIMEOUT_MS = 30_000;
  const firstTokenTimer = setTimeout(
    () => firstTokenTimeoutController.abort(),
    FIRST_TOKEN_TIMEOUT_MS,
  );
  const combinedSignal = anySignal([abortController.signal, firstTokenTimeoutController.signal]);

  // Streaming candidate chain: delegated to `streamOraMessage` which handles
  // provider-switch logic, fallback semantics, and abort propagation.
  // The route handles SSE writing, quota accounting, and session cookies.
  const start = Date.now();
  let streamedReply = "";
  let firstTokenSent = false;
  let usedFallback = false;
  let fallbackReason: string | null = null;
  let streamProvider: Provider = candidates[0]?.provider ?? "openai";
  let streamModel = candidates[0]?.model ?? primaryModel;
  let streamFailed = false;
  let streamMetrics = { usedSimulatedChunks: false, providerDeltaCount: 0 };

  try {
    for await (const event of streamOraMessage({
      candidates,
      messages: callMessages,
      maxTokens,
      signal: combinedSignal,
      logger,
    })) {
      if (event.type === "candidate") {
        usedFallback = event.usedFallback;
        fallbackReason = event.reason ?? null;
        streamProvider = event.provider as Provider;
        streamModel = event.model;
      } else if (event.type === "token") {
        if (!firstTokenSent) {
          // Cancel the first-token timeout — we have a live stream.
          clearTimeout(firstTokenTimer);
          timing.tFirstToken = Date.now(); // first token written to client
        }
        firstTokenSent = true;
        streamedReply += event.text;
        writeSSE(res, { type: "token", text: event.text });
      } else if (event.type === "metrics") {
        streamMetrics = {
          usedSimulatedChunks: event.usedSimulatedChunks,
          providerDeltaCount: event.providerDeltaCount,
        };
      } else if (event.type === "error") {
        streamFailed = true;
      }
      // "done" event: generator finished cleanly; route continues to success path.
    }
  } finally {
    clearTimeout(firstTokenTimer);
  }

  timing.t7 = Date.now(); // stream loop completed
  const latencyMs = timing.t7 - start;

  // Fire memory-save-candidate extraction immediately after the stream ends.
  // Previously this was a sequential await before writeSSE(done), adding 1-3s
  // of post-stream latency. Running it concurrently with video/suggestion
  // post-processing eliminates that sequential delay.
  // extractMemorySaveCandidate takes the user message + tier (not the reply),
  // so it can start as soon as the stream loop completes.
  const memoryCandidatePromise =
    authed && !temporary && !referenceAnalysisTurn
      ? extractMemorySaveCandidate(message, planTier).catch(() => null)
      : Promise.resolve(null);

  if (abortController.signal.aborted) {
    res.end();
    return;
  }

  if (streamFailed || !streamedReply.trim()) {
    // Only refund the authed quota when no tokens were delivered. If at least
    // one token was already sent (stream_interrupted), the user received a
    // partial reply and one turn has been consumed — no refund.
    if (!firstTokenSent) {
      await refundOraQuotaFor(authed, quotaKind);
    }
    logger.error(
      { component: "ora-chat-stream" },
      "Ora streaming failed — all candidates exhausted",
    );
    // Emit a signed fallback token only on pre-first-token failure so the
    // client can prove to /chat that the stream pre-incremented the session.
    const fallbackToken = !firstTokenSent ? createStreamFallbackToken(updatedPayload) : undefined;
    writeSSE(res, {
      type: "error",
      code: firstTokenSent ? "stream_interrupted" : "stream_failed",
      message: "Ora is temporarily unavailable. Please try again in a moment.",
      ...(fallbackToken !== undefined ? { fallbackToken } : {}),
    });
    res.end();
    return;
  }

  logger.info(
    {
      component: "ora-chat-stream",
      model: streamModel,
      provider: streamProvider,
      intent: classifierResult.intent,
      confidence: classifierResult.confidence,
      topic: classifierResult.topic,
      routeTier,
      planTier,
      expertiseDomain: expertiseProfile.domain,
      answerDepth: expertiseProfile.depth,
      candidates: candidates.map((c) => `${c.provider}:${c.model}`),
      latencyMs,
      usedFallback,
      fallbackReason,
      maxTokens,
      replyChars: streamedReply.length,
      classifierSkipped,
      routedTool,
      searchUsed,
      // Per-bucket timing breakdown (ms) — privacy-safe, no user content.
      timingMs: {
        sessionMs: timing.t1 - timing.t0, // session cookie validation
        authMs: timing.t2 - timing.t1, // Clerk JWT + DB user resolve
        spendCapMs: timing.t3 - timing.t2, // global / per-IP spend-cap check
        quotaMs: timing.t4 - timing.t3, // routing decision + quota reserve
        classifierMs, // isolated intent-classifier await (0 when skipped)
        contextMs: timing.t5 - timing.t4, // memory + cross-conv + profile (concurrent)
        headerFlushMs: timing.t6 - timing.t5, // model selection + SSE headers flush
        ttftMs: timing.tFirstToken >= 0 ? timing.tFirstToken - timing.t0 : -1,
        streamMs: timing.t7 - (timing.tFirstToken >= 0 ? timing.tFirstToken : timing.t6),
        totalMs: timing.t7 - timing.t0,
      },
      streaming: {
        realTime: !streamMetrics.usedSimulatedChunks,
        providerDeltaCount: streamMetrics.providerDeltaCount,
        memoryCount: memory.used.length,
      },
    },
    "Ora streaming completion",
  );

  let reply = streamedReply.trim();

  // Safety net: if the streamed conversational reply CLAIMED a file was
  // attached (it never is on this path), generate the promised file for real
  // before the done payload — the client replaces the streamed text with the
  // done payload's reply, so the hallucinated claim never persists.
  const rescuedDelivery = await rescueClaimedFileDelivery({
    reply,
    message,
    carriedDocs,
    history: historyMessages,
    language,
    authed,
    oraProjectId,
    logComponent: "ora-chat-stream",
  });
  if (rescuedDelivery) {
    reply = rescuedDelivery.reply;
  }

  let videos: OraVideo[] = [];
  {
    const { extractProseVideos, verifyVideos } = await import("../../lib/public-ai/web-search");
    const lifted = extractProseVideos(reply);
    if (lifted.videos.length > 0) {
      videos = await verifyVideos(lifted.videos);
      const stripped = lifted.text.trim();
      reply = stripped.length > 0 ? lifted.text : "Here you go:";
    }
  }

  // Phase 8: derive verified uploaded-file citations from the FINAL reply text
  // (post-rescue, post video-lift). Runs after the token stream has fully
  // completed, so it has zero impact on streaming cadence.
  const fileCitations = deriveFileCitations(reply, buildFileCitationAllowList(carriedDocs));

  let suggestions: string[] = [];
  const suggestionResult = await suggestionPromise;
  if (!referenceAnalysisTurn && suggestionResult) {
    try {
      const raw = suggestionResult.choices[0]?.message?.content?.trim() ?? "{}";
      const parsedSuggestions = JSON.parse(raw) as { suggestions?: unknown };
      if (Array.isArray(parsedSuggestions.suggestions)) {
        suggestions = (parsedSuggestions.suggestions as unknown[])
          .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 60)
          .slice(0, 3);
      }
    } catch {
      /* best-effort */
    }
  }

  // Await memory candidate and usage concurrently. memoryCandidatePromise was
  // fired right after the stream loop, so it has been running in parallel with
  // the video extraction and suggestion awaiting above.
  const [memoryCandidate, usage] = await Promise.all([
    memoryCandidatePromise,
    oraUsageResponse(authed, updatedPayload.msgCount),
  ]);

  // The rolling-summary refresh was kicked off before streaming and ran
  // concurrently with the AI stream. Resolve it now (already settled in the
  // common case) so the echoed value the client persists is up to date. The
  // promise is pre-caught, so this never rejects.
  if (summaryPromise) {
    conversationSummary = await summaryPromise;
  }

  writeSSE(res, {
    type: "done",
    payload: {
      reply,
      suggestions,
      ...(videos.length > 0 ? { videos } : {}),
      ...(memoryCandidate
        ? {
            memorySaveCandidate: memoryCandidate.fact,
            memorySaveCandidateConfidence: memoryCandidate.confidence,
            memorySaveCandidateSensitive: memoryCandidate.sensitive,
          }
        : {}),
      ...(referenceChatHistory && !temporary ? { conversationSummary } : {}),
      ...(memory.used.length > 0 ? { memoriesUsed: memory.used } : {}),
      // Phase 8: verified uploaded-file citations — derived server-side
      // against the injected content, never model-claimed.
      ...(fileCitations.length > 0 ? { fileCitations } : {}),
      ...(rescuedDelivery?.fileName && rescuedDelivery.fileData && rescuedDelivery.mimeType
        ? {
            fileName: rescuedDelivery.fileName,
            fileData: rescuedDelivery.fileData,
            mimeType: rescuedDelivery.mimeType,
            ...(rescuedDelivery.assetId != null ? { assetId: rescuedDelivery.assetId } : {}),
          }
        : {}),
      mode: deepAllowed ? ("deep" as const) : ("instant" as const),
      msgCount: Number(usage.msgCount ?? 0),
      msgLimit: Number(usage.msgLimit ?? 0),
      ...(usage.imageCount != null ? { imageCount: Number(usage.imageCount) } : {}),
      ...(usage.imageLimit != null ? { imageLimit: Number(usage.imageLimit) } : {}),
      ...(usage.resetsAt !== undefined
        ? { resetsAt: typeof usage.resetsAt === "string" ? usage.resetsAt : null }
        : {}),
      ...(usage.windowHours != null ? { windowHours: Number(usage.windowHours) } : {}),
      isRealStreaming: !streamMetrics.usedSimulatedChunks,
      // Server-measured timing for client-side diagnostics (privacy-safe:
      // no user content, no user identifiers, only routing/timing metadata).
      serverDiag: {
        ttftMs: timing.tFirstToken >= 0 ? timing.tFirstToken - timing.t0 : null,
        totalMs: timing.t7 - timing.t0,
        provider: streamProvider,
        routeTier,
        fastLane: isInstantFastLane,
        classifierMs,
        classifierSkipped,
        routedTool,
        searchUsed,
        fallbackReason,
        // Phase 3 route diagnostics (privacy-safe: static templates/enums only).
        routeReason: decision.reason,
        inferredFileFormat: finalRoute.inferredFileFormat,
        conflictResolution: finalRoute.conflictResolution,
      },
    },
  });
  res.end();
});

export default router;
