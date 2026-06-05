import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { scanUserInput, ORA_SYSTEM_PROMPT } from "../../lib/public-ai/prompt";

import { generateFileFromPrompt } from "../../lib/public-ai/file-builder";
import { type OraTopic } from "../../lib/public-ai/classifier";
import {
  routeOraMessage,
  checkToolAccess,
  detectMemorySaveCandidate,
  ORA_TOOL_REGISTRY,
} from "../../lib/public-ai/orchestrator";
import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db, knowledgeEntriesTable, generatedImagesTable } from "@workspace/db";
import { deductCreditsAtomic, getOrCreateCredits } from "../credits";

// Authenticated Ora users are not subject to the anonymous visitor message cap;
// they draw on their monthly credit balance instead. We still return a numeric
// limit to the client so the UI's "messages remaining" affordance has a value.
const UNLIMITED_MSGS = 1_000_000;

// Per-action credit costs now come from the orchestrator tool registry
// (ORA_TOOL_REGISTRY[tool].creditCost) so chat.ts no longer hard-codes them.

const DEEP_SYSTEM_ADDENDUM = `\n\n## Deep Thinking mode\nYou are in DEEP THINKING mode. Take extra care: reason step by step before answering, weigh trade-offs explicitly, surface assumptions and edge cases, and give a thorough, well-structured response. Prefer concrete specifics (data models, flows, sequencing) over generalities. It is acceptable to be longer here than in normal replies.`;

/**
 * Fetch the user's saved Ora memories and format them as a compact context
 * block for the system prompt. Returns an empty string when there is nothing
 * to inject.
 *
 * ISOLATION: Ora is a standalone assistant kept fully separate from the AI
 * Builder. This intentionally injects ONLY user-scoped Ora memories
 * (scope="user"). It must never pull project-scoped Knowledge Vault entries
 * (scope="project", auto-populated by the Builder's build/refine pipeline) into
 * Ora's context — doing so would leak Builder project knowledge into Ora.
 */
async function buildMemoryContext(userId: string): Promise<string> {
  try {
    const rows = await db
      .select({
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
      })
      .from(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.userId, userId),
          eq(knowledgeEntriesTable.scope, "user"),
          isNull(knowledgeEntriesTable.archivedAt),
        ),
      )
      .orderBy(desc(knowledgeEntriesTable.createdAt))
      .limit(15);

    if (rows.length === 0) return "";

    const lines = rows.map((r) => `- ${r.title}${r.content ? `: ${r.content}` : ""}`).join("\n");
    return `\n\n## Saved memories\nThe user has saved these preferences and facts about themselves and their projects. Apply them when relevant, but defer to anything they say in the current conversation:\n${lines}`;
  } catch {
    // Memory injection is best-effort — never block a reply on it.
    return "";
  }
}

const IMAGE_GENERATE_CTA =
  "Image generation is available for signed-in MustaFlow users. Sign up at mustaflow.app to access AI image generation, including inline images here in Ora and the full Image Studio with quality presets, aspect ratios, and style controls.";

const SEARCH_SIGNIN_CTA =
  "Live web search is available for signed-in MustaFlow users. Sign up at mustaflow.app and I'll search the web for you, then answer with up-to-date information and cited sources.";

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
  mode: z.enum(["instant", "deep"]).default("instant"),
  referenceSavedMemories: z.boolean().default(true),
  referenceChatHistory: z.boolean().default(true),
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

  const {
    message,
    messages,
    language,
    languageHint,
    mode,
    referenceSavedMemories,
    referenceChatHistory,
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
  const authed = await resolveAuthedOraUser(req);
  const effectiveMsgLimit = authed ? UNLIMITED_MSGS : MSG_LIMIT_VALUE;

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

  // Route the message through the Ora orchestrator. Ora is a STANDALONE
  // assistant: build/"make me an app" requests are answered as normal
  // conversation — never refused, never auto-handed-off to the Builder.
  const decision = await routeOraMessage({ message, mode });
  const toolMeta = ORA_TOOL_REGISTRY[decision.tool];
  const deepAllowed = decision.tool === "deep_thinking";

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

  // Per-action credit cost for authenticated users (Free tier included — Free
  // draws on its monthly grant). Visitors are metered by the session cap only.
  const messageCost = toolMeta.creditCost;
  if (authed) {
    const credits = await getOrCreateCredits(authed.userId);
    if (credits.balance < messageCost) {
      res.status(402).json({
        error: "You're out of credits. Top up or upgrade your plan to keep chatting with Ora.",
        upgradeCta: true,
        balance: credits.balance,
        cost: messageCost,
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
    try {
      const result = await generateFileFromPrompt(message, detectedFormat, history, language);
      if (authed) {
        await deductCreditsAtomic(authed.userId, messageCost, {
          type: "converse",
          description: `Ora file generation (${detectedFormat})`,
        });
      }
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      res.json({
        reply: result.reply,
        fileName: result.fileName,
        fileData: result.fileData,
        mimeType: result.mimeType,
        msgCount: payload.msgCount,
        msgLimit: effectiveMsgLimit,
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
      logger.error(
        { component: "ora-chat-file", format: detectedFormat, err },
        "Auto file generation failed",
      );
      res.status(500).json({ error: "Failed to generate file. Please try again." });
    }
    return;
  }

  // ── Image generation tool (inline, signed-in users) ─────────────────────────
  // Anonymous visitors are caught by checkToolAccess above (image_signin_required).
  if (decision.tool === "image_generation") {
    const { generateImage, isImageProviderConfigured } = await import("../../lib/image-provider");
    if (!isImageProviderConfigured()) {
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      res.json({
        reply:
          "Image generation isn't configured on this server right now. Please try again later.",
        msgCount: payload.msgCount,
        msgLimit: effectiveMsgLimit,
      });
      return;
    }
    try {
      const result = await generateImage({
        prompt: message,
        quality: "standard",
        aspectRatio: "1:1",
        style: "vivid",
      });
      let editableImageId: number | undefined;
      if (authed) {
        await deductCreditsAtomic(authed.userId, messageCost, {
          type: "creative",
          description: "Ora inline image generation",
        });
        // Persist the image into generated_images so it carries an editable id.
        // This is what powers inline editing: the existing /images/:id/edit
        // pipeline keys off a generated_images row (parent fileUrl + ownership).
        // Credits were already charged via the Ora message cost above, so this
        // record is creditCost:0 to avoid double-billing.
        try {
          const { storeGeneratedImage } = await import("../../lib/image-storage");
          const [imageRow] = await db
            .insert(generatedImagesTable)
            .values({
              userId: authed.userId,
              prompt: message,
              quality: "standard",
              aspectRatio: "1:1",
              style: "vivid",
              providerName: "openai",
              modelName: process.env.IMAGE_MODEL ?? "gpt-image-1",
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
      res.json({
        reply: "Here's the image you asked for. Tap Edit to refine it with an instruction.",
        imageUrl: result.openaiUrl,
        ...(editableImageId ? { imageId: editableImageId } : {}),
        msgCount: payload.msgCount,
        msgLimit: effectiveMsgLimit,
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
                prompt: message,
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
      logger.error({ component: "ora-chat-image", err }, "Inline image generation failed");
      res.status(500).json({ error: "Failed to generate the image. Please try again." });
    }
    return;
  }

  // ── Web search tool (live, grounded, cited) ─────────────────────────────────
  // Anonymous visitors are caught by checkToolAccess above (search_signin_required).
  if (decision.tool === "search") {
    const { isWebSearchConfigured, runOraWebSearch } =
      await import("../../lib/public-ai/web-search");
    if (!isWebSearchConfigured()) {
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      res.json({
        reply:
          "Live web search isn't configured on this server right now. I can still help from what I already know.",
        msgCount: payload.msgCount,
        msgLimit: effectiveMsgLimit,
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
    try {
      const result = await runOraWebSearch({ query: message, history, language });
      if (authed) {
        await deductCreditsAtomic(authed.userId, messageCost, {
          type: "converse",
          description: "Ora web search",
        });
      }
      const { token, payload } = incrementMessageCount(session);
      setSessionCookie(res, token);
      res.json({
        reply: result.reply,
        sources: result.sources,
        msgCount: payload.msgCount,
        msgLimit: effectiveMsgLimit,
      });
    } catch (err) {
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

  const premiumModel = process.env.ORA_PREMIUM_MODEL ?? "gpt-5.4";
  const deepModel = process.env.ORA_DEEP_MODEL ?? premiumModel;
  const fallbackModel = "claude-sonnet-4-6";

  // Deep Thinking always uses the strongest model with a larger token budget so
  // the step-by-step reasoning has room to land. Otherwise fall back to the
  // mini model only when the classifier is highly confident this is a simple FAQ.
  const usesMini =
    !deepAllowed &&
    classifierResult.intent === "simple_faq" &&
    classifierResult.confidence === "high";
  const primaryModel = deepAllowed ? deepModel : usesMini ? "gpt-5-mini" : premiumModel;
  const maxTokens = deepAllowed ? 2400 : usesMini ? 400 : 1200;

  // Chat history is opt-out: when the user turns off "reference chat history"
  // in their memory settings, each message is treated as a fresh conversation.
  const historyMessages: Array<{ role: "user" | "assistant"; content: string }> =
    referenceChatHistory
      ? messages.slice(-20).map((m) => ({ role: m.role, content: m.content }))
      : [];

  // Saved memories are opt-out and only available to signed-in users.
  const memoryContext =
    authed && referenceSavedMemories ? await buildMemoryContext(authed.userId) : "";

  const systemPrompt =
    buildSystemPrompt(language, languageHint) +
    (deepAllowed ? DEEP_SYSTEM_ADDENDUM : "") +
    memoryContext;

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

  // Charge credits for authenticated users now that the reply succeeded, so a
  // failed generation never costs the user. Best-effort: the atomic helper
  // no-ops when enforcement is disabled and we already pre-flighted the balance.
  if (authed) {
    await deductCreditsAtomic(authed.userId, messageCost, {
      type: "converse",
      description: deepAllowed ? "Ora Deep Thinking message" : "Ora message",
    });
  }

  const { token, payload } = incrementMessageCount(session);
  setSessionCookie(res, token);

  // Ora is a standalone assistant. It NEVER proactively pushes the AI Builder —
  // no topic- or message-count-based handoff. The Builder handoff stays an
  // explicit, user-initiated action handled by a separate endpoint.

  // Surface a memory-save candidate when the user stated a durable fact. This is
  // a non-binding suggestion for signed-in users; the client decides whether to
  // offer the save. It never persists anything on its own.
  const memoryCandidate = authed ? detectMemorySaveCandidate(message) : null;

  res.json({
    reply,
    suggestions,
    ...(memoryCandidate
      ? {
          memorySaveCandidate: memoryCandidate.fact,
          memorySaveCandidateConfidence: memoryCandidate.confidence,
        }
      : {}),
    mode: deepAllowed ? "deep" : "instant",
    msgCount: payload.msgCount,
    msgLimit: effectiveMsgLimit,
  });
});

export default router;
