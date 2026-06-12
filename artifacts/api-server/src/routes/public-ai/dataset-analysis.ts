import { Router } from "express";
import { z } from "zod";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { getFile } from "../../lib/public-ai/file-store";
import { scanUserInput } from "../../lib/public-ai/prompt";
import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { consumeOraQuota, refundOraQuota, oraMessageFields } from "../../lib/public-ai/ora-usage";
import {
  DATASET_SYSTEM_PROMPT,
  buildDatasetContextBlock,
} from "../../lib/public-ai/dataset-prompt";
import { DatasetAnalysisAiSchema } from "../../lib/public-ai/dataset-schema";
import type { DatasetAnalysisAiOutput } from "../../lib/public-ai/dataset-schema";
import { logger } from "../../lib/logger";
import type { Provider } from "../../lib/ai-providers";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  openAiModelForOraFile,
  runCandidateChain,
  selectOraFileModelRoute,
  type ModelCandidate,
} from "../../lib/public-ai/model-router";

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const bodySchema = z.object({
  fileRef: z.string().uuid(),
  message: z.string().min(1),
  messages: z.array(messageItemSchema).max(20).default([]),
  language: z.string().max(20).optional(),
});

function extractJsonFromText(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenceMatch?.[1]) return fenceMatch[1];
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return text;
}

function isNonEnglishLanguage(value: string | undefined): boolean {
  if (!value || value === "auto") return false;
  const primary = value.split(",")[0].trim().split("-")[0].toLowerCase();
  return !!primary && primary !== "en";
}

router.post("/public-ai/dataset-analysis", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }

  const { fileRef, message, messages, language } = parsed.data;

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    req.resume();
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }

  const session = validateSession(sessionToken);
  if (!session) {
    req.resume();
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }

  // Resolve the signed-in Ora user up-front. The anonymous per-session cap is a
  // side-effect-free read, so it can be signaled early; only the authed rolling-window
  // quota is RESERVED (consumed), and that reservation is deferred until after
  // cheap validation so rejected/stale requests never consume a user's allowance.
  const authed = await resolveAuthedOraUser(req);
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
    res.status(400).json({
      error: "Your message contains patterns that cannot be processed. Please rephrase.",
    });
    return;
  }

  const fileEntry = getFile(fileRef, session.sessionId);
  if (!fileEntry) {
    res.status(404).json({
      error: "This file is no longer available. It may have expired. Please upload it again.",
    });
    return;
  }

  if (!fileEntry.datasetSummary) {
    res.status(400).json({
      error:
        "This file is a document, not a dataset. Please use the document analysis endpoint instead.",
    });
    return;
  }

  // Signed-in users are metered by rolling-window quotas (MESSAGE bucket). consumeOraQuota
  // is atomic; the reservation is held below and only released via refundOraQuota
  // on model failure.
  if (authed) {
    const quota = await consumeOraQuota(authed.userId, authed.tier, "message");
    if (!quota.allowed) {
      res.status(429).json({
        error: `You've used all ${quota.limit} Ora messages in your current window on your plan. Upgrade for a higher limit, or wait for your window to reset.`,
        upgradeCta: true,
        msgCount: quota.used,
        msgLimit: quota.limit,
        resetsAt: quota.resetsAt,
      });
      return;
    }
  }

  const summary = fileEntry.datasetSummary;

  let systemPrompt = DATASET_SYSTEM_PROMPT;
  if (language && language !== "auto") {
    systemPrompt += `\n\n## Language override\nRespond in "${language}" for all text fields in the JSON output.`;
  }

  const contextBlock = buildDatasetContextBlock(fileEntry.filename, summary, message);

  const historyMessages = messages
    .slice(-20)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...historyMessages,
    { role: "user" as const, content: contextBlock },
  ];

  const planTier = normalizeOraPlanTier(authed?.tier ?? null);
  const openaiModel = openAiModelForOraFile("dataset_analysis", planTier);
  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  const candidates: ModelCandidate[] = selectOraFileModelRoute({
    task: "dataset_analysis",
    subscriptionTier: planTier,
    topic: "technical",
    multilingual: isNonEnglishLanguage(language),
    available,
    openCircuits,
    openaiModel,
  });
  const maxTokens = 5000;

  const start = Date.now();
  let usedFallback = false;
  let modelUsed = openaiModel;
  let provider: Provider = "openai";
  let aiOutput: DatasetAnalysisAiOutput | null = null;

  try {
    const { createChatCompletion } = await import("../../lib/ai-providers");
    const chain = await runCandidateChain(
      candidates,
      async (candidate) => {
        const result = await createChatCompletion({
          provider: candidate.provider,
          model: candidate.model,
          messages: callMessages,
          response_format: { type: "json_object" },
          max_completion_tokens: maxTokens,
        });
        const raw = result.choices[0]?.message?.content?.trim() ?? "";
        const jsonStr = extractJsonFromText(raw);
        const parsedJson = JSON.parse(jsonStr) as unknown;
        return DatasetAnalysisAiSchema.parse(parsedJson);
      },
      (candidate, i, candidateErr) =>
        logger.warn(
          {
            component: "ora-dataset-analysis",
            provider: candidate.provider,
            model: candidate.model,
            attempt: i + 1,
            ofCandidates: candidates.length,
            err: candidateErr,
          },
          "Ora dataset-analysis candidate failed - trying next provider",
        ),
    );
    aiOutput = chain.result;
    usedFallback = chain.usedFallback;
    modelUsed = chain.candidate.model;
    provider = chain.candidate.provider;
  } catch (err) {
    logger.error(
      { component: "ora-dataset-analysis", err },
      "All dataset-analysis candidates failed or returned invalid JSON",
    );
  }

  const latencyMs = Date.now() - start;

  logger.info(
    {
      component: "ora-dataset-analysis",
      model: modelUsed,
      provider,
      planTier,
      candidates: candidates.map((c) => `${c.provider}:${c.model}`),
      fileType: fileEntry.mimeType,
      rowCount: summary.rowCount,
      colCount: summary.colCount,
      sanitizedCellCount: summary.sanitizedCellCount,
      truncated: summary.truncated,
      usedFallback,
      latencyMs,
      maxTokens,
    },
    "Ora dataset-analysis completion",
  );

  if (!aiOutput) {
    if (authed) await refundOraQuota(authed.userId, "message");
    res.status(502).json({
      error: "Ora is temporarily unavailable. Please try again in a moment.",
    });
    return;
  }

  // The MESSAGE quota was reserved atomically up-front (consumeOraQuota); the
  // analysis succeeded so we keep the reservation — no extra increment.
  const { token, payload } = incrementMessageCount(session);
  setSessionCookie(res, token);

  const usage = await oraMessageFields(authed, payload.msgCount);
  res.json({
    result: {
      ...aiOutput,
      datasetProfile: {
        rowCount: summary.rowCount,
        colCount: summary.colCount,
        truncated: summary.truncated,
        sheetName: summary.sheetName,
      },
      usedFallback,
      sanitizedCellCount: summary.sanitizedCellCount,
      truncated: summary.truncated,
    },
    ...usage,
  });
});

export default router;
