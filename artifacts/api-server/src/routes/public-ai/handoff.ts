// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — POST /api/public-ai/handoff/create
//
// PUBLIC route (no Clerk auth). Requires a valid Ora session cookie.
// Creates a short-lived opaque handoff token containing a sanitized AI summary
// of the conversation. Returns only {token, expiresAt} — the summary is NEVER
// returned here. The token is exchanged for the summary by the protected
// /api/builder/handoff/exchange endpoint AFTER the user authenticates.
//
// SECURITY BOUNDARY: This file intentionally has NO imports from:
//   billing / credits / projects / secrets / users / Builder / DB modules.
// Phase 6 test (phase6.test.ts) statically verifies this.
//
// Kill-switch: ORA_HANDOFF_ENABLED=false disables this route independently
//   from PUBLIC_AI_ENABLED. Lets ops disable handoff without touching Ora chat.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { validateSession } from "../../lib/public-ai/session";
import { storeHandoff, type HandoffSummary } from "../../lib/public-ai/handoff-store";
import { oraHandoffLimiter } from "../../lib/rateLimit";

const router = Router();

// ── Input sanitization ────────────────────────────────────────────────────────
// The frontend is untrusted. Strip all sensitive / binary / reference fields.
// Max 8 messages, 300 chars each, 2000 chars total.

function sanitizeMessageContent(raw: string): string {
  return (
    raw
      // Strip HTML tags and scripts
      .replace(/<[^>]*>/g, " ")
      // Strip base64 / data URLs
      .replace(/data:[a-z/+]+;base64,[^\s"']*/gi, "[binary]")
      // Strip fileRef / imageRef / datasetRef / sessionId lookups
      .replace(/\b(?:fileRef|imageRef|datasetRef|sessionId|fileId)\s*[:=]\s*\S+/gi, "[ref]")
      // Strip URLs (potential PII leak via query params)
      .replace(/https?:\/\/\S+/gi, "[url]")
      // Strip email addresses
      .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email]")
      // Strip phone-like patterns
      .replace(/\b\+?[\d\s\-().]{7,}\d\b/g, "[phone]")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  );
}

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z
    .string()
    .max(1000) // reject huge individual messages before sanitizing
    .transform(sanitizeMessageContent),
});

const bodySchema = z.object({
  messages: z.array(messageItemSchema).max(8).default([]),
});

// ── Safe deterministic fallback ───────────────────────────────────────────────
// Used when the AI call fails, produces no output, or the conversation is not
// about building an app. Does NOT quote raw user messages (correction #2).
const SAFE_FALLBACK_SUMMARY: HandoffSummary = {
  summary: "Visitor wants to continue an idea from Ora inside the MustaFlow Builder.",
  appIdea: "Start a new MustaFlow project based on the visitor's current idea.",
  keyFeatures: [],
  suggestedNextStep: "Describe your idea in the Builder and click Build.",
  source: "ora_public_handoff",
};

// ── Summary generation ────────────────────────────────────────────────────────
// Uses a direct fetch (no ai-providers.ts / billing imports) so this route
// stays inside the public-AI security boundary.

async function generateSummary(
  messages: Array<{ role: string; content: string }>,
): Promise<HandoffSummary> {
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  if (!baseUrl || !apiKey || messages.length === 0) return SAFE_FALLBACK_SUMMARY;

  const systemPrompt = [
    "You extract a buildable app idea from a public Ora AI chat session.",
    "Output ONLY valid JSON with exactly these five keys:",
    '  "summary": string (2-3 sentences describing an app concept; generic product language; no personal details),',
    '  "appIdea": string (one actionable sentence describing what to build),',
    '  "keyFeatures": string[] (2-4 short feature names; no user quotes; max 60 chars each),',
    '  "suggestedNextStep": string (one sentence telling the Builder user what to do next),',
    '  "source": the literal string "ora_public_handoff".',
    "",
    "CRITICAL rules:",
    "- NEVER include: raw user quotes, names, emails, phone numbers, IDs, file names, URLs, refs, or private details.",
    "- If the conversation is NOT about building an app (personal advice, troubleshooting, general Q&A),",
    '  set appIdea to "Describe what you want to build in MustaFlow Builder." and keyFeatures to [].',
    "- Do not invent details the user did not mention.",
    "Output ONLY the JSON object. No markdown fences, no explanation.",
  ].join("\n");

  // Trim total input to 2000 chars before the model call
  const truncatedHistory = messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Visitor" : "Ora"}: ${m.content}`)
    .join("\n")
    .slice(0, 2000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        response_format: { type: "json_object" },
        max_tokens: 400,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: truncatedHistory },
        ],
      }),
    });

    if (!response.ok) return SAFE_FALLBACK_SUMMARY;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return SAFE_FALLBACK_SUMMARY;

    const parsed: unknown = JSON.parse(raw);

    const summarySchema = z.object({
      summary: z.string().min(1).max(600),
      appIdea: z.string().min(1).max(300),
      keyFeatures: z.array(z.string().max(80)).max(4),
      suggestedNextStep: z.string().min(1).max(300),
      source: z.literal("ora_public_handoff"),
    });

    const validated = summarySchema.safeParse(parsed);
    return validated.success ? validated.data : SAFE_FALLBACK_SUMMARY;
  } catch {
    return SAFE_FALLBACK_SUMMARY;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/public-ai/handoff/create", oraHandoffLimiter, async (req, res) => {
  // Phase-specific kill-switch (correction #10)
  if (process.env.ORA_HANDOFF_ENABLED === "false") {
    res.status(503).json({ error: "Builder handoff is currently unavailable." });
    return;
  }

  // Validate Ora session cookie (real session required, not just any request)
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  const session = sessionToken ? validateSession(sessionToken) : null;
  if (!session) {
    res.status(401).json({ error: "A valid Ora session is required to create a handoff." });
    return;
  }

  // Require at least one message in the session
  if (session.msgCount < 1) {
    res.status(400).json({
      error: "Please have a conversation with Ora before continuing to the Builder.",
    });
    return;
  }

  // Validate + sanitize input (untrusted frontend)
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request payload." });
    return;
  }

  // Total character guard after sanitization
  const totalChars = parsed.data.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > 2000) {
    res.status(400).json({ error: "Message payload too large." });
    return;
  }

  const start = Date.now();

  // Hashed identifiers only — never log raw values (correction #9)
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
  const sessionIdHash = crypto
    .createHash("sha256")
    .update(session.sessionId)
    .digest("hex")
    .slice(0, 16);

  let summary: HandoffSummary;
  try {
    summary = await generateSummary(parsed.data.messages);
  } catch {
    summary = SAFE_FALLBACK_SUMMARY;
  }

  const { token, expiresAt } = storeHandoff(summary, sessionIdHash);
  const latencyMs = Date.now() - start;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);

  logger.info(
    {
      event: "handoff_created",
      tokenHash,
      expiresAt,
      latencyMs,
      ipHash,
      sessionIdHash,
    },
    "ora handoff token created",
  );

  // Return ONLY the opaque token — summary stays on the server (correction #2)
  res.json({ token, expiresAt });
});

export default router;
