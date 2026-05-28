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
  isBuilderRequest,
  ORA_SYSTEM_PROMPT,
  BUILDER_REFUSAL,
} from "../../lib/public-ai/prompt";
import { classifyIntent } from "../../lib/public-ai/classifier";

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  messages: z.array(messageItemSchema).max(20).default([]),
  language: z.string().max(20).optional(),
});

/**
 * Build the system prompt, injecting an explicit language instruction when
 * the caller specifies one. This ensures the language selector in the UI
 * actually influences model output.
 */
function buildSystemPrompt(language: string | undefined): string {
  if (!language || language === "auto") {
    return ORA_SYSTEM_PROMPT;
  }
  return (
    ORA_SYSTEM_PROMPT +
    `\n\n## Language override\nThe user has selected "${language}" as their preferred language. Respond entirely in that language for this conversation, regardless of the language the user writes in.`
  );
}

router.post("/public-ai/chat", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { message, messages, language } = parsed.data;

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

  if (session.msgCount >= MSG_LIMIT_VALUE) {
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

  if (isBuilderRequest(message)) {
    const { token, payload } = incrementMessageCount(session);
    setSessionCookie(res, token);
    res.json({
      reply: BUILDER_REFUSAL,
      handoffCta: true,
      msgCount: payload.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  const classifierResult = await classifyIntent(message);

  if (classifierResult.intent === "builder_request") {
    const { token, payload } = incrementMessageCount(session);
    setSessionCookie(res, token);
    res.json({
      reply: BUILDER_REFUSAL,
      handoffCta: true,
      msgCount: payload.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  const premiumModel = process.env.ORA_PREMIUM_MODEL ?? "gpt-5.4";
  const fallbackModel = "claude-sonnet-4-6";

  // Use mini only when the classifier is highly confident this is a simple FAQ.
  // All other intents — including low-confidence simple_faq — use the premium model.
  const usesMini =
    classifierResult.intent === "simple_faq" && classifierResult.confidence === "high";
  const primaryModel = usesMini ? "gpt-5-mini" : premiumModel;
  const maxTokens = usesMini ? 400 : 1200;

  const historyMessages: Array<{ role: "user" | "assistant"; content: string }> = messages
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  const systemPrompt = buildSystemPrompt(language);

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...historyMessages,
    { role: "user" as const, content: message },
  ];

  const start = Date.now();
  let usedFallback = false;
  let modelUsed = primaryModel;
  let provider: "openai" | "anthropic" = "openai";
  let reply: string | null = null;

  try {
    const { createChatCompletion } = await import("../../lib/ai-providers");
    const result = await createChatCompletion({
      provider: "openai",
      model: primaryModel,
      messages: callMessages,
      response_format: { type: "text" },
      max_completion_tokens: maxTokens,
    });
    reply = result.choices[0]?.message?.content?.trim() ?? null;
  } catch (primaryErr) {
    logger.warn(
      { component: "ora-chat", model: primaryModel, err: primaryErr },
      "Primary model failed — trying fallback",
    );
    usedFallback = true;
    modelUsed = fallbackModel;
    provider = "anthropic";
    try {
      const { createChatCompletion } = await import("../../lib/ai-providers");
      const result = await createChatCompletion({
        provider: "anthropic",
        model: fallbackModel,
        messages: callMessages,
        response_format: { type: "text" },
        max_completion_tokens: maxTokens,
      });
      reply = result.choices[0]?.message?.content?.trim() ?? null;
    } catch (fallbackErr) {
      logger.error({ component: "ora-chat", err: fallbackErr }, "Fallback model also failed");
    }
  }

  const latencyMs = Date.now() - start;

  logger.info(
    {
      component: "ora-chat",
      model: modelUsed,
      provider,
      intent: classifierResult.intent,
      confidence: classifierResult.confidence,
      latencyMs,
      usedFallback,
      maxTokens,
    },
    "Ora chat completion",
  );

  if (!reply) {
    res
      .status(502)
      .json({ error: "Ora is temporarily unavailable. Please try again in a moment." });
    return;
  }

  const { token, payload } = incrementMessageCount(session);
  setSessionCookie(res, token);

  // Show the "Continue in Builder" CTA after every substantive answer so visitors
  // are reminded they can take the conversation further inside MustaFlow.
  // (builder_request is already handled with an early return above, so we always
  // reach this point for simple_faq and premium intents only.)
  const handoffCta = true;

  res.json({
    reply,
    handoffCta,
    msgCount: payload.msgCount,
    msgLimit: MSG_LIMIT_VALUE,
  });
});

export default router;
