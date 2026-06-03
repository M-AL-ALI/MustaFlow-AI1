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
  detectFileRequest,
  ORA_SYSTEM_PROMPT,
  BUILDER_REFUSAL,
} from "../../lib/public-ai/prompt";

import { generateFileFromPrompt } from "../../lib/public-ai/file-builder";
import { classifyIntent, type OraTopic } from "../../lib/public-ai/classifier";

const IMAGE_GENERATE_CTA =
  "Image generation is available for signed-in MustaFlow users. Sign up at mustaflow.app to access AI image generation, including the Image Studio with quality presets, aspect ratios, and style controls.";

const ORA_IMAGE_PATTERNS: RegExp[] = [
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

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const bodySchema = z.object({
  message: z.string().min(1),
  messages: z.array(messageItemSchema).max(20).default([]),
  language: z.string().max(20).optional(),
  languageHint: z.string().max(20).optional(),
});

/**
 * Build the system prompt, injecting an explicit language instruction when
 * the caller specifies one. When the user's selector is "auto", a browser
 * locale hint (`languageHint`) is used as a tiebreaker for ambiguous or
 * very short messages so the model defaults to the user's preferred language
 * instead of picking arbitrarily.
 */
function buildSystemPrompt(language: string | undefined, languageHint: string | undefined): string {
  if (!language || language === "auto") {
    if (!languageHint) return ORA_SYSTEM_PROMPT;
    // Normalise: "fr-FR" → "fr", "en-US" → "en"
    const primaryLang = languageHint.split("-")[0].toLowerCase();
    if (primaryLang === "en") return ORA_SYSTEM_PROMPT; // English is the default — no hint needed
    return (
      ORA_SYSTEM_PROMPT +
      `\n\n## Language tiebreaker\nThe visitor's browser is set to "${languageHint}". When their message is too short or ambiguous to reliably detect a language, default to responding in ${primaryLang}. If the message is clearly in a different language, match that language instead.`
    );
  }
  return (
    ORA_SYSTEM_PROMPT +
    `\n\n## Language override\nThe user has selected "${language}" as their preferred language. Respond entirely in that language for this conversation, regardless of the language the user writes in.`
  );
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

  const { message, messages, language, languageHint } = parsed.data;

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

  // Auto-detect file generation requests and handle them inline so users
  // don't need to use the format picker — typing "make me a CSV" just works.
  const detectedFormat = detectFileRequest(message);
  if (detectedFormat) {
    const history = messages
      .slice(-10)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    try {
      const result = await generateFileFromPrompt(message, detectedFormat, history, language);
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      res.json({
        reply: result.reply,
        fileName: result.fileName,
        fileData: result.fileData,
        mimeType: result.mimeType,
        msgCount: payload.msgCount,
        msgLimit: MSG_LIMIT_VALUE,
      });
    } catch (err) {
      logger.error(
        { component: "ora-chat-file", format: detectedFormat, err },
        "Auto file generation failed",
      );
      res.status(500).json({ error: "Failed to generate file. Please try again." });
    }
    return;
  }

  // Guard: image generation is not available to public/anonymous users.
  if (ORA_IMAGE_PATTERNS.some((p) => p.test(message))) {
    const { token, payload } = incrementMessageCount(session);
    setSessionCookie(res, token);
    res.json({
      reply: IMAGE_GENERATE_CTA,
      handoffCta: true,
      msgCount: payload.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
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

  const systemPrompt = buildSystemPrompt(language, languageHint);

  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...historyMessages,
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
  const { createChatCompletion } = await import("../../lib/ai-providers");

  // Run the main reply and suggestion generation in parallel to reduce latency.
  // Suggestions use the conversation history + current message + topic context;
  // the main reply is not yet available but topic-enriched guidance compensates.
  const start = Date.now();

  const [mainResult, suggestionResult] = await Promise.allSettled([
    (async () => {
      try {
        const result = await createChatCompletion({
          provider: "openai",
          model: primaryModel,
          messages: callMessages,
          response_format: { type: "text" },
          max_completion_tokens: maxTokens,
        });
        return {
          reply: result.choices[0]?.message?.content?.trim() ?? null,
          usedFallback: false,
          modelUsed: primaryModel,
          provider: "openai" as const,
        };
      } catch (primaryErr) {
        logger.warn(
          { component: "ora-chat", model: primaryModel, err: primaryErr },
          "Primary model failed — trying fallback",
        );
        const result = await createChatCompletion({
          provider: "anthropic",
          model: fallbackModel,
          messages: callMessages,
          response_format: { type: "text" },
          max_completion_tokens: maxTokens,
        });
        return {
          reply: result.choices[0]?.message?.content?.trim() ?? null,
          usedFallback: true,
          modelUsed: fallbackModel,
          provider: "anthropic" as const,
        };
      }
    })(),
    createChatCompletion({
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
  let provider: "openai" | "anthropic" = "openai";

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

  // Extract suggestions — failures are silently swallowed so the main reply is never blocked.
  let suggestions: string[] = [];
  if (suggestionResult.status === "fulfilled") {
    try {
      const raw = suggestionResult.value.choices[0]?.message?.content?.trim() ?? "{}";
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

  const { token, payload } = incrementMessageCount(session);
  setSessionCookie(res, token);

  // Show the CTA only when the topic signals a build intent, OR after at least
  // 3 messages have been exchanged (conversation is substantive). Always suppress
  // for high-confidence simple FAQ answers — those are informational, not build-intent.
  const BUILDER_TOPICS: OraTopic[] = ["app-planning", "saas", "ecommerce", "mobile", "technical"];
  const isHighConfidenceFaq =
    classifierResult.intent === "simple_faq" && classifierResult.confidence === "high";
  const handoffCta =
    !isHighConfidenceFaq &&
    (BUILDER_TOPICS.includes(classifierResult.topic) || payload.msgCount >= 3);

  res.json({
    reply,
    handoffCta,
    suggestions,
    msgCount: payload.msgCount,
    msgLimit: MSG_LIMIT_VALUE,
  });
});

export default router;
