/**
 * Rolling conversation summary for Ora.
 *
 * Ora's chat context is capped at the last `ORA_RECENT_WINDOW` messages. In a
 * long conversation, the earliest turns scroll out of that window and Ora
 * "forgets" what was established earlier in the SAME chat. To keep long
 * conversations coherent without unbounded token growth, the older turns are
 * condensed into a compact running summary that is kept in context alongside
 * the recent-message window.
 *
 * The summary is maintained incrementally: the client tracks how many leading
 * messages have already been folded in and only sends the NEW overflow turns
 * each request, so each message is summarized once and the per-request cost is
 * bounded. This module merges the prior summary with the new overflow turns
 * into a single, length-bounded summary.
 *
 * ISOLATION: this is Ora-only, in-conversation context. It must NOT touch the
 * AI Builder, the Knowledge Vault, or the long-term user Memory Center — it is
 * purely ephemeral context for the current chat.
 */
import { logger } from "../logger";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  runCandidateChain,
  selectOraMemoryModelRoute,
} from "./model-router";

/**
 * Number of most-recent messages kept verbatim in Ora's context window. Turns
 * older than this are folded into the rolling summary. Mirrors the client's
 * recent-window slice so the two stay in lockstep.
 */
export const ORA_RECENT_WINDOW = 20;

/**
 * Hard cap on how many overflow messages are folded into the summary in a
 * single request. Normally only a couple of turns overflow per message, but
 * after a reload (when the client's "already summarized" counter resets) the
 * whole pre-window backlog can arrive at once — this caps that one-time cost.
 */
export const ORA_SUMMARIZE_BATCH_MAX = 40;

/** Truncate any single message before feeding it to the summarizer. */
const PER_MESSAGE_CHAR_CAP = 20_000;

/** Soft target length for the rolling summary, to bound its token cost. */
const SUMMARY_CHAR_TARGET = 1800;

export interface SummaryTurn {
  role: "user" | "assistant";
  content: string;
}

const SUMMARY_SYSTEM_PROMPT = [
  "You maintain a concise running summary of an ongoing conversation between a user and an AI assistant named Ora.",
  "You will be given the existing summary (may be empty) and the next batch of earlier messages that have scrolled out of the live context window.",
  "Produce a single updated summary that MERGES the existing summary with the new messages.",
  "",
  "Keep ONLY durable, reusable context:",
  "- Facts the user stated about themselves, their project, or their goals.",
  "- Decisions made and the reasoning behind them.",
  "- Names, preferences, constraints, and requirements established.",
  "- Open questions or tasks still in progress.",
  "",
  "Rules:",
  "- Be terse and factual. Use short bullet points or compact sentences.",
  "- Do NOT invent anything not present in the inputs.",
  "- Do NOT include pleasantries, filler, or restated questions that were already answered.",
  '- Write in the third person (e.g. "The user wants...", "Ora suggested...").',
  `- Keep the entire summary under roughly ${SUMMARY_CHAR_TARGET} characters; drop the least important older details first if it would otherwise grow beyond that.`,
  "- Return ONLY the summary text, with no preamble or headings.",
].join("\n");

function formatTurns(turns: SummaryTurn[]): string {
  return turns
    .filter((t) => t.content.trim().length > 0)
    .map((t) => {
      const who = t.role === "user" ? "User" : "Ora";
      const text = t.content.trim().slice(0, PER_MESSAGE_CHAR_CAP);
      return `${who}: ${text}`;
    })
    .join("\n");
}

/**
 * Merge the prior rolling summary with a new batch of overflow turns into one
 * compact, length-bounded summary.
 *
 * Fails safe: on any error (or empty model output) it returns the prior
 * summary unchanged so the caller can still reply using the recent-message
 * window. Returns "" when there is nothing to summarize and no prior summary.
 */
export async function updateConversationSummary(input: {
  priorSummary: string;
  newMessages: SummaryTurn[];
  subscriptionTier?: string | null;
}): Promise<string> {
  const priorSummary = input.priorSummary.trim();
  const batch = input.newMessages.slice(-ORA_SUMMARIZE_BATCH_MAX);
  const formatted = formatTurns(batch);

  // Nothing new to fold in — keep whatever we already have.
  if (formatted.length === 0) return priorSummary;

  const planTier = normalizeOraPlanTier(input.subscriptionTier);
  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  const candidates = selectOraMemoryModelRoute({
    task: "conversation_summary",
    subscriptionTier: planTier,
    available,
    openCircuits,
  });
  const timeoutMs = Number(process.env.ORA_SUMMARY_TIMEOUT_MS) || 5000;
  const start = Date.now();
  let winningProvider = "none";
  let winningModel = candidates[candidates.length - 1]?.model ?? "none";

  try {
    const { createChatCompletion } = await import("../ai-providers");
    const userContent = [
      priorSummary
        ? `Existing summary:\n${priorSummary}`
        : "Existing summary:\n(none yet — this is the start of the summary)",
      "",
      "New earlier messages to fold into the summary:",
      formatted,
    ].join("\n");

    const result = await Promise.race([
      runCandidateChain(
        candidates,
        (candidate) =>
          createChatCompletion({
            provider: candidate.provider,
            model: candidate.model,
            messages: [
              { role: "system", content: SUMMARY_SYSTEM_PROMPT },
              { role: "user", content: userContent },
            ],
            response_format: { type: "text" },
            max_completion_tokens: 600,
          }),
        (candidate, i, err) =>
          logger.warn(
            {
              component: "ora-summary",
              provider: candidate.provider,
              model: candidate.model,
              attempt: i + 1,
              ofCandidates: candidates.length,
              err,
            },
            "Summary model candidate failed — trying next provider",
          ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ora-summary-timeout")), timeoutMs),
      ),
    ]);
    winningProvider = result.candidate.provider;
    winningModel = result.candidate.model;

    const updated = result.result.choices[0]?.message?.content?.trim() ?? "";
    if (!updated) {
      logger.warn(
        {
          component: "ora-summary",
          provider: winningProvider,
          model: winningModel,
          planTier,
          latencyMs: Date.now() - start,
        },
        "Summary model returned empty — keeping prior summary",
      );
      return priorSummary;
    }

    logger.info(
      {
        component: "ora-summary",
        provider: winningProvider,
        model: winningModel,
        planTier,
        latencyMs: Date.now() - start,
        foldedMessages: batch.length,
        summaryChars: updated.length,
      },
      "Updated rolling conversation summary",
    );
    return updated;
  } catch (err) {
    // Best-effort: never block a reply on summarization. Degrade to the recent
    // window by returning whatever summary we already had.
    logger.error(
      {
        component: "ora-summary",
        provider: winningProvider,
        model: winningModel,
        planTier,
        err,
      },
      "Conversation summarization failed — keeping prior summary",
    );
    return priorSummary;
  }
}
