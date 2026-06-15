import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import {
  scanUserInput,
  ORA_SYSTEM_PROMPT,
  isPastedReferenceAnalysisRequest,
  summarizePastedReferenceSignals,
} from "../../lib/public-ai/prompt";

import { type OraTopic } from "../../lib/public-ai/classifier";
import {
  routeOraMessage,
  checkToolAccess,
  extractMemorySaveCandidate,
} from "../../lib/public-ai/orchestrator";
import type { AuthedOraUser } from "../../lib/public-ai/authed-user";
import type { Provider } from "../../lib/ai-provider-config";
import type { OraVideo } from "../../lib/public-ai/web-search";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  openAiModelForOraRoute,
  selectOraModelRoute,
  runCandidateChain,
  type OraRouteTier,
  type OraPlanTier,
  type ModelCandidate,
} from "../../lib/public-ai/model-router";
import { buildCarriedDocumentContext } from "../../lib/public-ai/carried-docs";
import { buildOraExpertiseProfile } from "../../lib/public-ai/expertise";
import { buildOraImageGenerationProfile } from "../../lib/public-ai/image-quality";
import { generateEmbedding, cosineSimilarity, buildEmbeddingInput } from "../../lib/embeddings";
import { eq, and, isNull, isNotNull, ne, desc, sql } from "drizzle-orm";
import type { SubscriptionTier } from "@workspace/db";
import type { OraQuotaKind } from "../../lib/public-ai/ora-usage";

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

const DEEP_SYSTEM_ADDENDUM = `\n\n## Deep Thinking mode\nYou are in DEEP THINKING mode. Take extra care: reason step by step before answering, weigh trade-offs explicitly, surface assumptions and edge cases, and give a thorough, well-structured response. Prefer concrete specifics (data models, flows, sequencing) over generalities. It is acceptable to be longer here than in normal replies.`;

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
): Promise<OraMemoryRow[]> {
  const trimmed = message.trim();
  if (trimmed.length === 0) return selectMemoriesWithinBudget(rows, profile);

  // Best-effort prompt embedding, raced against a short timeout. On any failure
  // OR if the provider is slow, we fall back to TF-IDF for every entry — never
  // block or noticeably slow the reply on the embedding provider.
  let promptEmbedding: number[] | null = null;
  try {
    promptEmbedding = await Promise.race([
      generateEmbedding(trimmed),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ORA_MEMORY_EMBED_TIMEOUT_MS)),
    ]);
  } catch {
    promptEmbedding = null;
  }

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
    // ISOLATION (project vs general): a project chat sees ONLY that project's
    // memories; a standalone chat sees ONLY user-level memories. The two tiers
    // are never mixed — a project's context must not leak general facts, and a
    // general chat must not surface project-specific facts.
    const isProjectChat = typeof oraProjectId === "number";

    // User-level memories apply to standalone (non-project) chats only. We skip
    // this query entirely inside a project chat so isolation is enforced.
    let userRows: OraMemoryRow[] = [];
    if (!isProjectChat) {
      userRows = await db
        .select({
          id: knowledgeEntriesTable.id,
          title: knowledgeEntriesTable.title,
          content: knowledgeEntriesTable.content,
          category: knowledgeEntriesTable.category,
          embedding: knowledgeEntriesTable.embedding,
          createdAt: knowledgeEntriesTable.createdAt,
        })
        .from(knowledgeEntriesTable)
        .where(
          and(
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
            // User-level only — project memories are pulled separately below.
            isNull(knowledgeEntriesTable.oraProjectId),
          ),
        )
        .orderBy(desc(knowledgeEntriesTable.createdAt))
        .limit(profile.candidateLimit);
    }

    // Project memories persist across every conversation in an Ora project, but
    // only when the caller actually owns the (non-archived) project. They must
    // also exclude superseded entries so only the current version of a fact is
    // injected, matching the user-level query above.
    let projectRows: OraMemoryRow[] = [];
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
      if (owned) {
        projectRows = await db
          .select({
            id: knowledgeEntriesTable.id,
            title: knowledgeEntriesTable.title,
            content: knowledgeEntriesTable.content,
            category: knowledgeEntriesTable.category,
            embedding: knowledgeEntriesTable.embedding,
            createdAt: knowledgeEntriesTable.createdAt,
          })
          .from(knowledgeEntriesTable)
          .where(
            and(
              eq(knowledgeEntriesTable.userId, userId),
              eq(knowledgeEntriesTable.scope, "user"),
              eq(knowledgeEntriesTable.origin, "ora"),
              eq(knowledgeEntriesTable.enabled, true),
              isNull(knowledgeEntriesTable.supersededBy),
              isNull(knowledgeEntriesTable.archivedAt),
              eq(knowledgeEntriesTable.oraProjectId, oraProjectId),
            ),
          )
          .orderBy(desc(knowledgeEntriesTable.createdAt))
          .limit(profile.candidateLimit);
      }
    }

    // Single-tier candidate pool (project chat → project memories only; general
    // chat → user-level only), then apply the Builder-style semantic/TF-IDF
    // ranker so only pertinent memories surface within the budget.
    const pool = (isProjectChat ? projectRows : userRows).filter(
      (row) => !memoryConflictsWithCurrentMessage(row, currentMessage),
    );
    if (pool.length === 0) return { text: "", used: [] };

    const selected =
      currentMessage && currentMessage.trim().length > 0
        ? await rankMemoriesByRelevance(pool, currentMessage, profile)
        : selectMemoriesWithinBudget(pool, profile);

    // Lazily index any memories missing an embedding so later retrievals can
    // use semantic similarity. Fire-and-forget; never blocks this reply.
    backfillMemoryEmbeddings(pool);

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
async function buildCrossConversationContext(
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
async function buildProfileContext(userId: string): Promise<string> {
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
  "Image generation is available for signed-in MustaFlow users. Sign up at mustaflow.app to access AI image generation, including inline images here in Ora and the full Image Studio with quality presets, aspect ratios, and style controls.";

const SEARCH_SIGNIN_CTA =
  "Live web search is available for signed-in MustaFlow users. Sign up at mustaflow.app and I'll search the web for you, then answer with up-to-date information and cited sources.";

const PASTED_REFERENCE_ANALYSIS_ADDENDUM = `\n\n## Current turn: pasted reference analysis
The user's current message appears to include pasted output from tools such as Replit, Codex, GitHub, tests, or workflows. Treat the pasted text as evidence to analyze. Do not generate a downloadable file. Do not answer with generic capability suggestions.

Response shape for this turn:
1. Start with the direct answer, diagnosis, or exact message the user should send.
2. Identify who is who when relevant: Replit = hosted dev/runtime workspace; Codex = OpenAI coding agent; ChatGPT = OpenAI chat assistant; GitHub = source-control host.
3. Use the minimum useful steps or bullets. Keep it concise unless the user explicitly asks for a full breakdown.
4. If the pasted text is too long, conflicting, or missing key details, state the specific missing detail instead of guessing.`;

const router = Router();

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

function buildSystemPrompt(
  language: string | undefined,
  languageHint: string | undefined,
  isSignedIn: boolean,
): string {
  const authBlock = sessionAuthBlock(isSignedIn);
  if (!language || language === "auto") {
    if (!languageHint) return ORA_SYSTEM_PROMPT + authBlock;
    // Normalise: "fr-FR" → "fr", "en-US" → "en"
    const primaryLang = languageHint.split("-")[0].toLowerCase();
    if (primaryLang === "en") return ORA_SYSTEM_PROMPT + authBlock; // English is the default — no hint needed
    return (
      ORA_SYSTEM_PROMPT +
      authBlock +
      `\n\n## Language tiebreaker\nThe visitor's browser is set to "${languageHint}". When their message is too short or ambiguous to reliably detect a language, default to responding in ${primaryLang}. If the message is clearly in a different language, match that language instead.`
    );
  }
  return (
    ORA_SYSTEM_PROMPT +
    authBlock +
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

  // Resolve the signed-in user (if any). Authenticated users draw on their
  // monthly credit balance and are exempt from the anonymous visitor cap.
  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  const effectiveMsgLimit = authed ? await oraMessageLimit(authed.tier) : MSG_LIMIT_VALUE;

  if (!authed && session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error:
        "You have reached the message limit for this session. Start a new session to continue.",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  if (!scanUserInput(message)) {
    res
      .status(400)
      .json({ error: "Your message contains patterns that cannot be processed. Please rephrase." });
    return;
  }

  const referenceAnalysisTurn = isPastedReferenceAnalysisRequest(message);

  // Route the message through the Ora orchestrator. Ora is a STANDALONE
  // assistant: build/"make me an app" requests are answered as normal
  // conversation — never refused, never auto-handed-off to the Builder.
  const decision = await routeOraMessage({
    message,
    mode,
    recentMessages: messages.slice(-8),
  });
  const deepAllowed = decision.tool === "deep_thinking";

  // Re-hydrate any documents the user uploaded earlier this conversation so
  // follow-up questions ("what did that file say?") and "make a summary of it"
  // both have the source text. Empty when nothing resolves (expired/foreign).
  const carriedDocs = buildCarriedDocumentContext(documentRefs, session.sessionId, message);

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

  // ── File generation tool ────────────────────────────────────────────────────
  if (decision.tool === "file_generation" && decision.fileFormat) {
    const detectedFormat = decision.fileFormat;
    const history = messages
      .slice(-10)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    // When the user is asking for a file built from an earlier upload, feed the
    // re-hydrated source text into the builder so the output reflects it.
    const filePrompt = carriedDocs ? `${message}\n\n${carriedDocs}` : message;
    const { generateFileFromPrompt, FileGenerationError } =
      await import("../../lib/public-ai/file-builder");
    try {
      const result = await generateFileFromPrompt(
        filePrompt,
        detectedFormat,
        history,
        language,
        carriedDocs.length > 0,
        authed?.tier ?? null,
      );
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply: result.reply,
        fileName: result.fileName,
        fileData: result.fileData,
        mimeType: result.mimeType,
        ...usage,
      });
      // Persist to the durable asset library (best-effort, after the response so
      // it never adds latency) so the generated file survives chat resets,
      // reloads, and other devices. Only for signed-in users.
      if (authed && result.fileData) {
        void (async () => {
          try {
            const { persistOraAsset } = await import("../../lib/ora-assets");
            await persistOraAsset({
              userId: authed.userId,
              kind: "file",
              fileName: result.fileName,
              mimeType: result.mimeType,
              format: detectedFormat,
              prompt: message,
              base64: result.fileData,
            });
          } catch (persistErr) {
            logger.error(
              { component: "ora-chat-file", err: persistErr },
              "Failed to persist generated file to asset library",
            );
          }
        })();
      }
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
      const { token, payload } = incrementMessageCount(session);
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
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply: "Here's the image you asked for. Tap Edit to refine it with an instruction.",
        imageUrl: result.openaiUrl,
        ...(editableImageId ? { imageId: editableImageId } : {}),
        ...usage,
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
      const { token, payload } = incrementMessageCount(session);
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
    const searchProfileContext = authed ? await buildProfileContext(authed.userId) : "";
    // Temporary ("incognito") chats never read long-term saved memories.
    const searchMemory =
      authed && referenceSavedMemories && !temporary
        ? await buildMemoryContext(authed.userId, oraProjectId, message, authed.tier)
        : { text: "", used: [] };
    const searchPersonalContext = searchProfileContext + searchMemory.text;
    try {
      const result = await runOraWebSearch({
        query: message,
        history,
        language,
        personalContext: searchPersonalContext || undefined,
        wantsVideos: decision.wantsVideos,
        subscriptionTier: oraPlanTier(authed),
      });
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      const usage = await oraUsageResponse(authed, payload.msgCount);
      res.json({
        reply: result.reply,
        sources: result.sources,
        images: result.images,
        videos: result.videos,
        ...(searchMemory.used.length > 0 ? { memoriesUsed: searchMemory.used } : {}),
        ...usage,
      });
    } catch (err) {
      await refundOraQuotaFor(authed, quotaKind);
      logger.error({ component: "ora-chat-search", err }, "Ora web search failed");
      res.status(500).json({ error: "Web search failed. Please try again." });
    }
    return;
  }

  // ── Conversational answer / deep thinking ───────────────────────────────────
  const classifierResult = {
    intent: decision.intent,
    confidence: decision.confidence,
    topic: decision.topic,
  };

  // Deep Thinking always uses the strongest model with a larger token budget so
  // the step-by-step reasoning has room to land. Otherwise fall back to the
  // mini model only when the classifier is highly confident this is a simple FAQ.
  const usesMini =
    !deepAllowed &&
    classifierResult.intent === "simple_faq" &&
    classifierResult.confidence === "high";
  // The routing tier mirrors the model/token dial above. `openaiModel` is the
  // env-aware OpenAI model the router uses verbatim for its OpenAI candidate.
  const routeTier: OraRouteTier = deepAllowed ? "deep" : usesMini ? "fast" : "premium";
  const planTier = oraPlanTier(authed);
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
  const maxTokens = expertiseProfile.maxTokens;
  const isMultilingual =
    isNonEnglishLanguage(language) ||
    ((!language || language === "auto") && isNonEnglishLanguage(languageHint));

  // Chat history is opt-out: when the user turns off "reference chat history"
  // in their memory settings, each message is treated as a fresh conversation.
  const historyMessages: Array<{ role: "user" | "assistant"; content: string }> =
    referenceChatHistory
      ? messages.slice(-20).map((m) => ({ role: m.role, content: m.content }))
      : [];

  // Saved memories are opt-out and only available to signed-in users. Temporary
  // ("incognito") chats never read long-term memory.
  const memory =
    authed && referenceSavedMemories && !temporary
      ? await buildMemoryContext(authed.userId, oraProjectId, message, planTier)
      : { text: "", used: [] };

  // Cross-conversation recall: pull relevant gist from the user's OTHER recent
  // conversations (same tier per isolation). Gated on chat-history being on and
  // the chat NOT being temporary — and only for signed-in users (anonymous
  // sessions have no persisted conversations to recall from).
  const crossConvContext =
    authed && referenceChatHistory && !temporary
      ? await buildCrossConversationContext(authed.userId, oraProjectId, message, conversationId)
      : "";

  // The Ora profile ("About you") is custom instructions — always applied for
  // signed-in users when present, independent of the saved-memories toggle.
  const profileContext = authed ? await buildProfileContext(authed.userId) : "";

  // Rolling conversation summary: when the chat has grown past the recent
  // window, fold the newly overflowed turns into a compact running summary so
  // facts/decisions from early in the chat stay in context. Bounded + fail-safe
  // (returns the prior summary on any error). Skipped entirely when the user
  // has chat history turned off, or for short chats with no overflow.
  let conversationSummary = referenceChatHistory && !temporary ? (priorSummary ?? "").trim() : "";
  if (referenceChatHistory && !temporary && summarizeMessages.length > 0) {
    const { updateConversationSummary } = await import("../../lib/public-ai/conversation-summary");
    conversationSummary = await updateConversationSummary({
      priorSummary: conversationSummary,
      newMessages: summarizeMessages.map((m) => ({ role: m.role, content: m.content })),
      subscriptionTier: planTier,
    });
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

  const systemPrompt =
    buildSystemPrompt(language, languageHint, !!authed) +
    (deepAllowed ? DEEP_SYSTEM_ADDENDUM : "") +
    (referenceAnalysisTurn
      ? PASTED_REFERENCE_ANALYSIS_ADDENDUM + summarizePastedReferenceSignals(message)
      : "") +
    expertiseProfile.systemAddendum +
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
        (candidate) =>
          createChatCompletion({
            provider: candidate.provider,
            model: candidate.model,
            messages: callMessages,
            response_format: { type: "text" },
            max_completion_tokens: maxTokens,
          }),
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

  if (mainResult.status === "fulfilled") {
    ({ reply, usedFallback, modelUsed, provider } = mainResult.value);
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
      maxTokens,
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
  const { token, payload } = incrementMessageCount(session);
  setSessionCookie(res, token);

  // Ora is a standalone assistant. It NEVER proactively pushes the AI Builder —
  // no topic- or message-count-based handoff. The Builder handoff stays an
  // explicit, user-initiated action handled by a separate endpoint.

  // Surface a memory-save candidate when the user stated a durable fact. This is
  // a non-binding suggestion for signed-in users; the client decides whether to
  // offer the save. It never persists anything on its own. Model-based
  // extraction catches durable facts phrased outside the fixed regex patterns
  // and avoids offering to save transient chatter; it fails safe to the regex
  // detector and never throws.
  // Temporary ("incognito") chats never surface a memory-save candidate, so the
  // client has nothing to persist.
  const memoryCandidate =
    authed && !temporary && !referenceAnalysisTurn
      ? await extractMemorySaveCandidate(message, planTier)
      : null;
  const usage = await oraUsageResponse(authed, payload.msgCount);

  res.json({
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
    mode: deepAllowed ? "deep" : "instant",
    ...usage,
  });
});

export default router;
