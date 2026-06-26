/**
 * POST /api/public-ai/realtime/session
 *
 * Mints a short-lived ephemeral OpenAI Realtime client secret so the browser
 * (or mobile app) can open a TRUE realtime voice conversation with Ora directly
 * over WebRTC. The real OPENAI_API_KEY never leaves the server — only the
 * single-use `ek_...` token is returned to the client.
 *
 * This is the live "Talk to Ora" path. It is intentionally separate from:
 *   - the composer microphone/dictation flow (Whisper transcribe), and
 *   - the legacy transcribe -> chat -> tts fallback loop.
 *
 * All standard Ora rules are preserved: anonymous + signed-in sessions, tier
 * resolver (free/core/wave), daily spend caps, kill switch, rate limiting,
 * selected language, project/conversation context, saved-memory + profile
 * injection (signed-in, non-temporary only), and strict Ora-vs-Builder
 * isolation (instructions are assembled from Ora-only context).
 */
import { Router } from "express";
import { z } from "zod";
import { validateSession } from "../../lib/public-ai/session";
import { oraRealtimeSessionLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { resolveAuthedOraUser, type AuthedOraUser } from "../../lib/public-ai/authed-user";
import { checkOraSpendCapAsync } from "../../lib/public-ai/ora-spend-cap";
import { buildSystemPrompt, buildProfileContext, buildMemoryContext } from "./chat";

const router = Router();

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

const DEFAULT_REALTIME_MODEL = "gpt-realtime-mini";
const DEFAULT_REALTIME_VOICE = "marin";

// Realtime voices accepted by the GA Realtime API. Kept as an allowlist so a bad
// client value or stale env override can never be forwarded verbatim to OpenAI.
const REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

/**
 * Spoken-conversation behaviour layered on top of the standard Ora system
 * prompt. Voice answers must be short and plain — never markdown — and the model
 * must yield gracefully when the user barges in.
 */
const VOICE_ADDENDUM =
  "\n\n## Voice conversation mode\n" +
  "You are speaking out loud in a live, two-way voice conversation. Keep replies " +
  "short, natural, and conversational — usually a sentence or two, the way a person " +
  "actually talks. Do NOT use markdown, headings, bullet lists, tables, code blocks, " +
  "or symbols like asterisks or pipes; speak in plain spoken language. Use natural " +
  "contractions. If a complete answer would be long, give the single most useful point " +
  "first, then offer to go deeper. Expect to be interrupted: if the user starts " +
  "speaking, stop immediately and listen. Ask a brief clarifying question only when you " +
  "genuinely need one.";

const bodySchema = z.object({
  language: z.string().max(20).optional(),
  languageHint: z.string().max(40).optional(),
  voice: z.string().max(40).optional(),
  temporary: z.boolean().optional(),
  referenceSavedMemories: z.boolean().optional(),
  oraProjectId: z.number().int().positive().nullable().optional(),
  // The website sends a numeric conversation id for signed-in chats and a string
  // (or null) elsewhere. Accept both so a valid call never 400s into the fallback
  // loop. It is currently used only as an opaque context signal.
  conversationId: z
    .union([z.string().max(100), z.number().int()])
    .nullable()
    .optional(),
  // Optional recent context (e.g. the topic or last user utterance) used ONLY to
  // rank saved-memory recall. There is no "message" at the start of a voice
  // session, so memory recall is skipped entirely when this is absent.
  message: z.string().max(4000).optional(),
});

/**
 * Hard cap on a single continuous voice session, by tier. The server cannot
 * meter audio after the ephemeral token is issued, so the client must force a
 * disconnect at this duration. Charged once up-front via the spend cap.
 */
function maxDurationForTier(tier: string): number {
  if (tier === "wave") return 900; // 15 min
  if (tier === "core") return 600; // 10 min
  return 300; // anonymous + free: 5 min
}

function resolveVoice(requested: string | undefined): string {
  if (requested && (REALTIME_VOICES as readonly string[]).includes(requested)) return requested;
  const envVoice = process.env.ORA_REALTIME_VOICE;
  if (envVoice && (REALTIME_VOICES as readonly string[]).includes(envVoice)) return envVoice;
  return DEFAULT_REALTIME_VOICE;
}

/**
 * Assemble the realtime session instructions from Ora-only context. Mirrors the
 * text-chat assembly but omits per-message expertise tuning (there is no current
 * message) and only injects saved-memory recall when a ranking hint is provided.
 *
 * ISOLATION: only the standalone Ora system prompt, the user's Ora profile, and
 * Ora-scoped saved memories are injected. Never Builder/project knowledge unless
 * the caller is inside an Ora project (oraProjectId), matching the chat route.
 *
 * Recent text conversation is NOT injected here — it is seeded client-side as
 * lower-authority conversation items so user transcript text can never override
 * the system rules or Ora isolation.
 */
async function buildRealtimeInstructions(opts: {
  authed: AuthedOraUser | null;
  language?: string;
  languageHint?: string;
  temporary?: boolean;
  referenceSavedMemories?: boolean;
  oraProjectId?: number | null;
  message?: string;
}): Promise<string> {
  const {
    authed,
    language,
    languageHint,
    temporary,
    referenceSavedMemories,
    oraProjectId,
    message,
  } = opts;

  let instructions = buildSystemPrompt(language, languageHint, !!authed);

  if (authed) {
    const profile = await buildProfileContext(authed.userId).catch(() => "");
    instructions += profile;

    // Saved memories are opt-out and only available to signed-in, non-temporary
    // chats. With no current message there is nothing to rank against, so recall
    // is skipped unless the client passes a ranking hint.
    const wantMemory =
      referenceSavedMemories !== false && !temporary && !!message && message.trim().length > 0;
    if (wantMemory) {
      try {
        const memory = await buildMemoryContext(
          authed.userId,
          oraProjectId ?? null,
          message,
          authed.tier,
        );
        instructions += memory.text;
      } catch {
        // Memory injection is best-effort — never block a session on it.
      }
    }
  }

  instructions += VOICE_ADDENDUM;
  return instructions;
}

router.post("/public-ai/realtime/session", oraRealtimeSessionLimiter, async (req, res) => {
  // ── Kill switch + explicit feature gate ────────────────────────────────────
  if (isKillSwitchActive("realtime")) {
    res.status(503).json(killSwitchBody("realtime"));
    return;
  }
  // Enabled by default; ORA_REALTIME_ENABLED="false" turns the feature off
  // without needing the kill switch (belt-and-suspenders for staged rollout).
  if (process.env.ORA_REALTIME_ENABLED === "false") {
    res.status(503).json({
      error: "Talk to Ora is temporarily unavailable. Please try again later.",
      disabled: true,
      feature: "realtime",
    });
    return;
  }

  // ── Session cookie (anonymous or signed-in both carry ora-session) ─────────
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

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid voice session request." });
    return;
  }

  // ── OpenAI key (direct client — the AI-integrations proxy rejects audio) ────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn(
      { component: "ora-realtime" },
      "OPENAI_API_KEY missing — Talk to Ora realtime voice unavailable",
    );
    res.status(503).json({ error: "Voice conversations are not configured." });
    return;
  }

  // ── Tier + daily spend cap (global + per-user + per-IP anonymous) ──────────
  const authed = await resolveAuthedOraUser(req);
  const tier = authed?.tier ?? "anonymous";

  try {
    const capResult = await checkOraSpendCapAsync(
      req,
      "realtime_voice",
      authed?.userId ?? null,
      tier,
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
  } catch (err) {
    logger.warn({ component: "ora-realtime", err }, "Ora realtime spend-cap check failed open");
  }

  const model = process.env.ORA_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
  const voice = resolveVoice(parsed.data.voice);
  const maxDurationSeconds = maxDurationForTier(tier);

  const instructions = await buildRealtimeInstructions({
    authed,
    language: parsed.data.language,
    languageHint: parsed.data.languageHint,
    temporary: parsed.data.temporary,
    referenceSavedMemories: parsed.data.referenceSavedMemories,
    oraProjectId: parsed.data.oraProjectId,
    message: parsed.data.message,
  });

  // ── Mint the ephemeral client secret (GA Realtime shape) ───────────────────
  try {
    const mintResp = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions,
          audio: {
            output: { voice },
            input: {
              transcription: {
                model:
                  process.env.ORA_REALTIME_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
              },
              turn_detection: { type: "server_vad" },
            },
          },
        },
      }),
    });

    if (!mintResp.ok) {
      const detail = await mintResp.text().catch(() => "");
      logger.warn(
        {
          component: "ora-realtime",
          status: mintResp.status,
          model,
          voice,
          detail: detail.slice(0, 400),
        },
        "Ora realtime client-secret mint failed",
      );
      res.status(502).json({ error: "Voice conversation failed to start. Please try again." });
      return;
    }

    const minted = (await mintResp.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value?: string; expires_at?: number };
    };
    const value = minted.value ?? minted.client_secret?.value;
    const expiresAt = minted.expires_at ?? minted.client_secret?.expires_at ?? null;

    if (!value) {
      logger.warn(
        { component: "ora-realtime", model, voice },
        "Ora realtime mint returned no client secret value",
      );
      res.status(502).json({ error: "Voice conversation failed to start. Please try again." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ value, expiresAt, model, voice, maxDurationSeconds });
  } catch (err) {
    logger.warn({ component: "ora-realtime", err }, "Ora realtime mint threw");
    res.status(502).json({ error: "Voice conversation failed to start. Please try again." });
  }
});

export default router;
