// ─────────────────────────────────────────────────────────────────────────────
// Phase 8B-3A: Knowledge-Aware Reporting routes
//
// All routes require Clerk authentication and enforce per-user ownership.
// Raw vectors are never exposed.  Only user-selected, ownership-verified,
// sanitized entries are used in AI prompts.
//
// Routes:
//   POST /vault/knowledge-suggestions   — semantic search for a report query
//   POST /vault/approved-context        — build safe context from selected entries
//   POST /vault/generate-report         — generate a report with approved context
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { z } from "zod";
import { semanticSearchVault } from "../lib/vault-search-service";
import { buildApprovedKnowledgeContext, logKnowledgeUsage } from "../lib/vault-knowledge-service";
import { createChatCompletion } from "../lib/ai-providers";
import { logger } from "../lib/logger";

const router = Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────

const suggestionsSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(10).default(6),
  category: z.string().optional(),
  department: z.string().optional(),
  tags: z.array(z.string()).max(10).optional(),
  status: z.string().optional(),
});

const approvedContextSchema = z.object({
  selectedEntryIds: z.array(z.number().int().positive()).min(1).max(8),
});

const generateReportSchema = z.object({
  query: z.string().min(1).max(2000),
  selectedEntryIds: z.array(z.number().int().positive()).max(8).default([]),
  title: z.string().max(200).optional(),
});

// ── System prompt for report generation ──────────────────────────────────────

const REPORT_SYSTEM_PROMPT = `You are Ora, a professional intelligence analyst and report writer.
Generate a structured, professional Knowledge Report based on the user's request.

REPORT REQUIREMENTS:
1. Write in clear, professional markdown format with ## headings, bullet lists, and bold emphasis.
2. Include at minimum 3 substantive sections relevant to the query.
3. If Knowledge Vault context is provided, cite the relevant entries inline using the source reference.
   Example: "Prior analysis indicates seal head wear is a recurring cause (vault-entry-12)."
4. Always end the report with a "## Knowledge Vault References Used" section that lists every
   vault entry that informed the report. Format each entry as:
   - **[Title]** (category: [Category], dept: [Department], version: [N], updated: [date])
   If no vault entries were provided or none were relevant, write:
   - No Knowledge Vault entries were used in this report.
5. Do not invent financial figures, dates, measurements, or metrics that were not provided.
6. If the provided vault context is insufficient, say so and provide general guidance instead.
7. Keep the report concise but substantive — aim for 400–800 words.
8. Do not include raw IDs, database references, or internal system details in the output.
9. Use only the vault entries explicitly provided — do not reference imaginary entries.`;

// ── POST /vault/knowledge-suggestions ────────────────────────────────────────
// Semantic search over the user's vault to find relevant entries for a
// report query.  Returns suggestion cards (no raw vectors).

router.post("/vault/knowledge-suggestions", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = suggestionsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { query, limit, category, department, tags, status } = parsed.data;

  try {
    const searchResult = await semanticSearchVault(
      { query, limit, category, department, tags, status },
      userId,
    );

    if (searchResult.embeddingError) {
      res.status(502).json({
        error: "Embedding service temporarily unavailable. Please try again.",
        embeddingError: true,
      });
      return;
    }

    if (searchResult.noEmbeddingsExist) {
      res.json({
        query,
        suggestions: [],
        noEmbeddingsExist: true,
        remaining: searchResult.remaining,
      });
      return;
    }

    if (searchResult.rateLimited) {
      res.status(429).json({
        error: "Search rate limit reached. Please wait before searching again.",
        retryAfterSec: searchResult.retryAfterSec,
      });
      return;
    }

    res.json({
      query,
      suggestions: searchResult.results,
      remaining: searchResult.remaining,
      noEmbeddingsExist: false,
    });
  } catch (err) {
    logger.error({ userId, err }, "vault-knowledge-suggestions: unexpected error");
    res.status(500).json({ error: "Failed to fetch knowledge suggestions" });
  }
});

// ── POST /vault/approved-context ─────────────────────────────────────────────
// Build the safe sanitized context block for a set of selected entry IDs.
// Used by the frontend to preview what will be sent to the AI.

router.post("/vault/approved-context", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = approvedContextSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const context = await buildApprovedKnowledgeContext({
      userId,
      selectedEntryIds: parsed.data.selectedEntryIds,
    });

    res.json({
      entries: context.entries,
      totalChars: context.totalChars,
      skippedCount: context.skippedCount,
    });
  } catch (err) {
    logger.error({ userId, err }, "vault-approved-context: unexpected error");
    res.status(500).json({ error: "Failed to build context" });
  }
});

// ── POST /vault/generate-report ───────────────────────────────────────────────
// Generate a knowledge-aware report.  Only the user-selected, ownership-checked,
// sanitized entries are included in the AI prompt.

router.post("/vault/generate-report", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = generateReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const { query, selectedEntryIds, title } = parsed.data;

  try {
    // 1. Build approved context (ownership + sanitization enforced internally)
    const context = await buildApprovedKnowledgeContext({ userId, selectedEntryIds });

    const activeEntries = context.entries.filter((e) => !e.skipped);

    // 2. Compose the user message for the AI
    const reportTitle = title ?? query.slice(0, 100);

    let userContent = `Report request: ${query}\n\nReport title: ${reportTitle}`;
    if (context.promptBlock) {
      userContent += `\n\n${context.promptBlock}`;
    } else {
      userContent +=
        "\n\nNote: No Knowledge Vault context was selected for this report. Generate based on general knowledge only.";
    }

    // 3. Call AI — retry once on empty content (proxy can transiently return null content)
    const model = process.env.ORA_PREMIUM_MODEL ?? "gpt-5-mini";
    let reportText = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      logger.info(
        {
          userId,
          model,
          attempt,
          entryCount: activeEntries.length,
          userContentLen: userContent.length,
          hasPromptBlock: !!context.promptBlock,
        },
        "vault-generate-report: calling AI",
      );
      let aiResult;
      try {
        aiResult = await createChatCompletion({
          provider: "openai",
          model,
          messages: [
            { role: "system", content: REPORT_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_completion_tokens: 2000,
        });
      } catch (aiErr) {
        const e = aiErr as Record<string, unknown>;
        logger.error(
          {
            userId,
            model,
            attempt,
            errMessage: typeof e.message === "string" ? e.message : String(aiErr),
            errStatus: e.status,
            errCode: e.code,
            errName: e.name,
          },
          "vault-generate-report: AI call threw",
        );
        if (attempt < 2) {
          await new Promise<void>((r) => setTimeout(r, 1500));
          continue;
        }
        res.status(502).json({ error: "Report generation failed. Please try again." });
        return;
      }

      const choice = aiResult.choices?.[0];
      const candidate = choice?.message?.content?.trim() ?? "";
      if (candidate) {
        reportText = candidate;
        break;
      }
      logger.warn(
        {
          userId,
          model,
          attempt,
          finishReason: choice?.finish_reason,
          choicesLen: aiResult.choices?.length,
          hasContent: !!choice?.message?.content,
        },
        "vault-generate-report: AI returned empty content",
      );
      if (attempt < 2) {
        await new Promise<void>((r) => setTimeout(r, 1500));
      }
    }

    if (!reportText) {
      logger.error({ userId, model }, "vault-generate-report: all attempts returned empty content");
      res.status(502).json({ error: "Report generation failed. Please try again." });
      return;
    }

    // 4. Audit trail — non-fatal
    await logKnowledgeUsage({
      userId,
      query: query.slice(0, 500),
      reportType: "knowledge-report",
      selectedEntryIds: activeEntries.map((e) => e.entryId),
      selectedEntryVersions: activeEntries.map((e) => e.version),
      entryCount: activeEntries.length,
    });

    logger.info(
      { userId, entryCount: activeEntries.length, skippedCount: context.skippedCount },
      "vault-generate-report: report generated",
    );

    res.json({
      report: reportText,
      knowledgeReferences: activeEntries.map((e) => ({
        entryId: e.entryId,
        title: e.title,
        category: e.category,
        department: e.department,
        version: e.version,
        updatedAt: e.updatedAt,
        sourceRef: e.sourceRef,
      })),
      entryCount: activeEntries.length,
      skippedCount: context.skippedCount,
      usedEntryIds: activeEntries.map((e) => e.entryId),
    });
  } catch (err) {
    logger.error({ userId, err }, "vault-generate-report: unexpected error");
    res.status(500).json({ error: "Failed to generate report" });
  }
});

export default router;
