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
import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { validateSession } from "../../lib/public-ai/session";
import { oraRealtimeSessionLimiter, oraRealtimeSessionTickLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { resolveAuthedOraUser, type AuthedOraUser } from "../../lib/public-ai/authed-user";
import { checkOraSpendCapAsync } from "../../lib/public-ai/ora-spend-cap";
import {
  startRealtimeSession,
  heartbeatRealtimeSession,
  endRealtimeSession,
  getRealtimeUsage,
  getRealtimeVoiceAllowance,
  REALTIME_HEARTBEAT_INTERVAL_SECONDS,
} from "../../lib/public-ai/ora-realtime-usage";
import { buildSystemPrompt, buildProfileContext, buildMemoryContext } from "./chat";

const router = Router();

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

const DEFAULT_REALTIME_MODEL = "gpt-realtime-mini";
const DEFAULT_REALTIME_VAD_TYPE = "semantic_vad";
const DEFAULT_REALTIME_VAD_EAGERNESS = "low";
const DEFAULT_REALTIME_VAD_THRESHOLD = 0.5;
const DEFAULT_REALTIME_VAD_PREFIX_PADDING_MS = 300;
const DEFAULT_REALTIME_VAD_SILENCE_DURATION_MS = 900;

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
 * Product-facing voice presets. The customer UI only ever shows these product
 * labels (Marine / Mustafa); the raw provider voice IDs below are an internal
 * implementation detail and are never returned to, or selectable by, normal
 * clients. Marine is the female voice (provider "marin", the long-standing
 * default); Mustafa is the male voice (provider "cedar", verified against the
 * current realtime model). A valid ORA_REALTIME_VOICE env override stays
 * compatible via resolveVoice() and is reported as a "Custom voice" when it is
 * not one of these two product voices.
 */
const VOICE_PRESETS = {
  marine: "marin",
  mustafa: "cedar",
} as const;

type VoicePresetKey = keyof typeof VOICE_PRESETS;

const DEFAULT_VOICE_PRESET: VoicePresetKey = "marine";

// The provider voice used when no product preset / valid raw voice / env override
// applies. Derived from the default product preset so the two never drift.
const DEFAULT_REALTIME_VOICE = VOICE_PRESETS[DEFAULT_VOICE_PRESET];

const VOICE_PRESET_LABELS: Record<VoicePresetKey, string> = {
  marine: "Marine",
  mustafa: "Mustafa",
};

/** Product options surfaced to clients so the selector stays server-driven. */
const VOICE_PRESET_OPTIONS: { key: VoicePresetKey; label: string }[] = (
  Object.keys(VOICE_PRESETS) as VoicePresetKey[]
).map((key) => ({ key, label: VOICE_PRESET_LABELS[key] }));

function isVoicePreset(value: string | undefined): value is VoicePresetKey {
  return !!value && Object.prototype.hasOwnProperty.call(VOICE_PRESETS, value);
}

/**
 * Reverse-map a resolved provider voice to its product preset, or null when the
 * provider voice (e.g. an ORA_REALTIME_VOICE override like "sage") is not one of
 * the two product voices. The raw provider id is never exposed to clients.
 */
function presetForProviderVoice(voice: string): VoicePresetKey | null {
  for (const key of Object.keys(VOICE_PRESETS) as VoicePresetKey[]) {
    if (VOICE_PRESETS[key] === voice) return key;
  }
  return null;
}

function voiceLabelForPreset(preset: VoicePresetKey | null): string {
  return preset ? VOICE_PRESET_LABELS[preset] : "Custom voice";
}

/**
 * Spoken-conversation behaviour layered on top of the standard Ora system
 * prompt. Voice answers must be short and plain — never markdown — and the model
 * must yield gracefully when the user barges in.
 */
const VOICE_ADDENDUM =
  "\n\n## Voice conversation mode\n" +
  "You are speaking out loud in a live, two-way voice conversation. Keep replies " +
  "short, natural, and conversational — usually a sentence or two, the way a person " +
  "actually talks. For straightforward factual questions, keep your answer to two or " +
  "three sentences; offer to explain more only when the user asks. Do NOT use markdown, " +
  "headings, bullet lists, tables, code blocks, or symbols like asterisks or pipes; " +
  "speak in plain spoken language. Never read out raw URLs, email addresses, markdown " +
  "syntax characters (asterisks, hash symbols, pipe characters), or code block fences " +
  "aloud — describe a link by its label (for example, 'the MustaFlow website') rather " +
  "than reading the address. Use natural contractions. If a complete answer would be " +
  "long, give the single most useful point first, then offer to go deeper. When you " +
  "explain something, teach it simply: lead with the direct answer, then add just " +
  "enough plain-spoken detail to make it land. Be honest about uncertainty — if you " +
  "are unsure or do not know, say so briefly instead of guessing, and suggest how the " +
  "user could find out. Expect to be interrupted: if the user starts speaking, stop " +
  "immediately and listen. Ask a brief clarifying question only when you genuinely " +
  "need one. Your identity rules from the main system prompt apply here too: if asked " +
  "who made you, what model powers you, what company is behind you, or what the name " +
  "'Ora' means, follow the exact identity and etymology rules from the main system " +
  "prompt — answer that you are Ora by MustaFlow AI, use the approved Ora name " +
  "explanation (connected to time and light, Greek hṓrā root, prayer in Latin, light " +
  "in Hebrew), and do not name or confirm any specific AI provider, model family, or " +
  "technology vendor. Keep the spoken answer concise (two to three sentences) while " +
  "covering the key points. Reply only to the person you are " +
  "talking with: ignore background speech, side conversations, and any turn the client " +
  "did not direct to you when deciding what to answer, which language to speak, and " +
  "what to remember. Your spoken audio and the visible transcript must always use the " +
  "same language. If the user selected a reply language, speak entirely in that " +
  "language. If the language is Auto, follow the user's latest spoken language. Do " +
  "not default to English when the selected language or the user's speech is non-English.";

const bodySchema = z.object({
  language: z.string().max(20).optional(),
  languageHint: z.string().max(40).optional(),
  // IANA timezone (e.g. "America/New_York") the client resolves from the device.
  // Used to render the user's local date/time in the authoritative date block.
  timeZone: z.string().max(64).optional(),
  voice: z.string().max(40).optional(),
  // Product-facing voice selection sent by normal clients (never a raw provider
  // voice id). The server maps it to a provider voice: marine -> female, mustafa
  // -> male. An invalid value is rejected (400) rather than silently swapped.
  voicePreset: z.enum(["marine", "mustafa"]).optional(),
  // Speaker-focus mode. "focused" (default) makes the SERVER stop auto-responding
  // (turn_detection.create_response=false) so the CLIENT decides — via its focus
  // filter — which transcripts deserve a reply, keeping Ora from answering nearby
  // background speakers. "normal" keeps the legacy open behavior (server auto
  // responds to every detected turn). Persisted client-side only; sent per session.
  focusMode: z.enum(["normal", "focused"]).optional(),
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

function clientIpForKey(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

/**
 * Derive the rolling-budget usage key for live-voice metering. Signed-in users
 * are keyed by their stable userId so the budget follows the account across
 * devices. Anonymous visitors are keyed by a non-reversible hash of their
 * ora-session token (stable for the life of that session cookie), falling back
 * to a hashed client IP when no token is present. The raw token/IP is never
 * stored — only the digest — and the same derivation is reused by /heartbeat,
 * /end and /diagnostics so a session always charges the same ledger row.
 */
function deriveUsageKey(
  authed: AuthedOraUser | null,
  sessionToken: string | undefined,
  req: Request,
): string {
  if (authed?.userId) return authed.userId;
  if (sessionToken) {
    return "anon:" + createHash("sha256").update(sessionToken).digest("hex").slice(0, 48);
  }
  return "anon:ip:" + createHash("sha256").update(clientIpForKey(req)).digest("hex").slice(0, 48);
}

function resolveVoice(requested: string | undefined): string {
  if (requested && (REALTIME_VOICES as readonly string[]).includes(requested)) return requested;
  const envVoice = process.env.ORA_REALTIME_VOICE;
  if (envVoice && (REALTIME_VOICES as readonly string[]).includes(envVoice)) return envVoice;
  return DEFAULT_REALTIME_VOICE;
}

/**
 * Resolve the provider voice + product preset for a session. A valid product
 * `voicePreset` always wins (this is what normal clients send). Otherwise we fall
 * back to the legacy raw `voice` param / ORA_REALTIME_VOICE env override / default
 * and reverse-map the result to a product preset when it maps to one. The raw
 * provider voice is used ONLY for the upstream OpenAI mint; clients receive the
 * product preset + label.
 */
function resolveVoiceSelection(
  preset: string | undefined,
  requestedVoice: string | undefined,
): { voice: string; preset: VoicePresetKey | null; label: string } {
  if (isVoicePreset(preset)) {
    return { voice: VOICE_PRESETS[preset], preset, label: VOICE_PRESET_LABELS[preset] };
  }
  const voice = resolveVoice(requestedVoice);
  const mapped = presetForProviderVoice(voice);
  return { voice, preset: mapped, label: voiceLabelForPreset(mapped) };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Whether the SERVER's VAD is allowed to interrupt (cancel) Ora's in-flight
 * response on detected user speech. Default FALSE: the client hooks own barge-in
 * via a confirmation guard (sustained speech or a real transcription delta), so
 * letting the server also cancel on raw VAD would re-introduce the self-interrupt
 * bug where Ora cuts itself off on its own speaker bleed, echo, or room noise.
 * Set ORA_REALTIME_INTERRUPT_RESPONSE=true only to restore server-side interrupt.
 */
function resolveInterruptResponse(): boolean {
  return process.env.ORA_REALTIME_INTERRUPT_RESPONSE?.trim().toLowerCase() === "true";
}

/**
 * Build the session's turn_detection config. `createResponse` controls whether
 * the OpenAI server auto-generates a reply after each detected user turn:
 *  - Normal mode passes `true` (legacy: server responds to every VAD turn).
 *  - Focused mode passes `false` so the server still does VAD + input
 *    transcription but never replies on its own; the client then sends an
 *    explicit `response.create` ONLY for transcripts that clear its speaker-focus
 *    filter, so Ora stops answering nearby background speakers.
 */
function resolveTurnDetection(createResponse: boolean):
  | {
      type: "semantic_vad";
      eagerness: string;
      create_response: boolean;
      interrupt_response: boolean;
    }
  | {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
      create_response: boolean;
      interrupt_response: boolean;
    } {
  const type = process.env.ORA_REALTIME_VAD_TYPE?.trim() || DEFAULT_REALTIME_VAD_TYPE;
  const interrupt_response = resolveInterruptResponse();

  if (type === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: process.env.ORA_REALTIME_VAD_EAGERNESS?.trim() || DEFAULT_REALTIME_VAD_EAGERNESS,
      create_response: createResponse,
      interrupt_response,
    };
  }

  if (type !== "server_vad") {
    logger.warn(
      { component: "ora-realtime", vadType: type },
      "Unsupported ORA_REALTIME_VAD_TYPE; falling back to semantic_vad",
    );
    return {
      type: "semantic_vad",
      eagerness: DEFAULT_REALTIME_VAD_EAGERNESS,
      create_response: createResponse,
      interrupt_response,
    };
  }

  return {
    type: "server_vad",
    threshold: numberFromEnv("ORA_REALTIME_VAD_THRESHOLD", DEFAULT_REALTIME_VAD_THRESHOLD),
    prefix_padding_ms: numberFromEnv(
      "ORA_REALTIME_VAD_PREFIX_PADDING_MS",
      DEFAULT_REALTIME_VAD_PREFIX_PADDING_MS,
    ),
    silence_duration_ms: numberFromEnv(
      "ORA_REALTIME_VAD_SILENCE_DURATION_MS",
      DEFAULT_REALTIME_VAD_SILENCE_DURATION_MS,
    ),
    create_response: createResponse,
    interrupt_response,
  };
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
  timeZone?: string;
  temporary?: boolean;
  referenceSavedMemories?: boolean;
  oraProjectId?: number | null;
  message?: string;
}): Promise<string> {
  const {
    authed,
    language,
    languageHint,
    timeZone,
    temporary,
    referenceSavedMemories,
    oraProjectId,
    message,
  } = opts;

  // Realtime instructions are minted ONCE at session start, so the date block is
  // labeled accordingly — a long voice call must not confidently state a stale
  // wall-clock time as if it were the current second.
  let instructions = buildSystemPrompt(
    language,
    languageHint,
    !!authed,
    timeZone,
    "the start of this voice session",
  );

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

  // ── Reserve live-voice minutes (per-plan rolling budget, FAIL-CLOSED) ───────
  // Unlike the spend cap above (which fails open), the minute budget gates real
  // audio cost: a DB outage must BLOCK voice (503) rather than grant unlimited
  // minutes. Anonymous callers are metered with the free allowance under their
  // hashed session key. The actual seconds are charged later via /heartbeat.
  const usageKey = deriveUsageKey(authed, sessionToken, req);
  let reservation: Awaited<ReturnType<typeof startRealtimeSession>>;
  try {
    reservation = await startRealtimeSession(usageKey, tier);
  } catch (err) {
    logger.error(
      { component: "ora-realtime", err },
      "Ora realtime budget reservation failed — failing closed",
    );
    res.status(503).json({
      error: "Voice conversations are temporarily unavailable. Please try again shortly.",
    });
    return;
  }
  if (reservation.status === "over_limit") {
    res.status(429).json({
      error:
        "You've used all your live voice time for now. It refreshes later — you can keep chatting with Ora by text in the meantime.",
      limitType: "realtime_voice_minutes",
      upgradeAvailable: tier !== "wave",
      remainingSeconds: 0,
      limitSeconds: reservation.limitSeconds,
      resetAt: reservation.resetsAt,
    });
    return;
  }
  if (reservation.status === "concurrent") {
    res.status(409).json({
      error: "You already have a live voice session running. End it before starting another.",
      limitType: "realtime_voice_concurrent",
      remainingSeconds: reservation.remainingSeconds,
      limitSeconds: reservation.limitSeconds,
      resetAt: reservation.resetsAt,
    });
    return;
  }
  const realtimeSessionId = reservation.sessionId;
  const maxDurationSeconds = reservation.maxDurationSeconds;

  const model = process.env.ORA_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
  const voiceSelection = resolveVoiceSelection(parsed.data.voicePreset, parsed.data.voice);
  const voice = voiceSelection.voice;
  // Speaker-focus posture. In Focused mode the server does NOT auto-respond
  // (create_response=false); the client owns response creation so Ora only replies
  // to transcripts that clear its focus filter. Normal mode keeps the legacy
  // behavior where the server replies to every detected turn.
  //
  // The product default ("focused") lives CLIENT-SIDE (localStorage / AsyncStorage)
  // and focus-aware clients always transmit their persisted preference. A MISSING
  // focusMode therefore means a focus-UNAWARE caller — e.g. an older mobile build
  // that predates this feature and never sends its own response.create. For those
  // we must keep the legacy auto-respond posture, so an absent value falls back to
  // "normal"; defaulting it to "focused" would leave such a client silent forever.
  const focusMode = parsed.data.focusMode ?? "normal";
  const createResponse = focusMode !== "focused";
  const turnDetection = resolveTurnDetection(createResponse);

  // If minting the upstream token fails for any reason, release the reserved
  // session so it neither holds the single-concurrency slot nor charges minutes
  // (ending with duration 0 charges nothing). Best-effort — never throws.
  const cancelReservation = async () => {
    try {
      await endRealtimeSession(realtimeSessionId, usageKey, tier, 0);
    } catch (err) {
      logger.warn(
        { component: "ora-realtime", err, realtimeSessionId },
        "Failed to release reserved realtime session after mint failure",
      );
    }
  };

  const instructions = await buildRealtimeInstructions({
    authed,
    language: parsed.data.language,
    languageHint: parsed.data.languageHint,
    timeZone: parsed.data.timeZone,
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
              turn_detection: turnDetection,
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
      await cancelReservation();
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
      await cancelReservation();
      res.status(502).json({ error: "Voice conversation failed to start. Please try again." });
      return;
    }

    // Privacy-safe session diagnostic: mode + whether the server will auto-respond.
    // No audio, transcript, or user content — only the focus posture for support.
    logger.info(
      { component: "ora-realtime", focusMode, createResponse, tier, model, voice },
      "Ora realtime session minted",
    );

    res.setHeader("Cache-Control", "no-store");
    // `model` is internal WebRTC transport data (the client builds the realtime
    // calls URL as ?model=...); it is required here but is NEVER shown in any
    // user-facing surface. The raw provider voice is intentionally NOT returned —
    // only the product preset + label, so customers never see provider voice ids.
    res.json({
      value,
      expiresAt,
      model,
      voicePreset: voiceSelection.preset,
      voiceLabel: voiceSelection.label,
      maxDurationSeconds,
      focusMode,
      createResponse,
      // Live-voice budget metering: the client stores realtimeSessionId, beats it
      // on heartbeatIntervalSeconds, and counts down from maxDurationSeconds /
      // remainingSeconds, ending at /end. resetsAt is when the budget refills.
      realtimeSessionId,
      remainingSeconds: reservation.remainingSeconds,
      limitSeconds: reservation.limitSeconds,
      resetsAt: reservation.resetsAt,
      heartbeatIntervalSeconds: REALTIME_HEARTBEAT_INTERVAL_SECONDS,
    });
  } catch (err) {
    logger.warn({ component: "ora-realtime", err }, "Ora realtime mint threw");
    await cancelReservation();
    res.status(502).json({ error: "Voice conversation failed to start. Please try again." });
  }
});

const tickBodySchema = z.object({
  realtimeSessionId: z.string().uuid(),
  // The client's own measured session duration (seconds). Advisory only — the
  // server clamps it to [alreadyCharged, min(serverElapsed, maxDuration)] so it
  // can never inflate the charge beyond the authoritative server clock.
  durationSeconds: z.number().int().nonnegative().max(86_400).optional(),
});

/**
 * POST /api/public-ai/realtime/heartbeat
 *
 * Charges elapsed live-voice seconds for an active session and reports the
 * remaining budget. Idempotent and safe to call repeatedly (~every 30s). Returns
 * ended:true when the session has hit its cap so the client tears down audio.
 * FAIL-CLOSED: a metering DB error returns 503 + ended:true so the client stops.
 */
router.post("/public-ai/realtime/heartbeat", oraRealtimeSessionTickLimiter, async (req, res) => {
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken || !validateSession(sessionToken)) {
    res.status(401).json({ error: "No active session.", ended: true });
    return;
  }
  const parsed = tickBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid heartbeat request." });
    return;
  }
  const authed = await resolveAuthedOraUser(req);
  const tier = authed?.tier ?? "anonymous";
  const usageKey = deriveUsageKey(authed, sessionToken, req);
  try {
    const result = await heartbeatRealtimeSession(parsed.data.realtimeSessionId, usageKey, tier);
    res.setHeader("Cache-Control", "no-store");
    if (result.status === "not_found") {
      res.status(404).json({ status: "not_found", ended: true });
      return;
    }
    res.json({
      status: result.status,
      ended: result.ended,
      remainingSeconds: result.remainingSeconds,
      limitSeconds: result.limitSeconds,
      resetsAt: result.resetsAt,
    });
  } catch (err) {
    logger.warn(
      { component: "ora-realtime", err },
      "Ora realtime heartbeat failed — failing closed",
    );
    res.status(503).json({ error: "Voice metering is temporarily unavailable.", ended: true });
  }
});

/**
 * POST /api/public-ai/realtime/end
 *
 * Finalizes a live-voice session on graceful client teardown (or page-hide
 * beacon). Idempotent: ending an unknown/already-ended session is a no-op
 * success so retries and beacons never error. The optional durationSeconds is
 * clamped server-side and can neither inflate nor refund the charge.
 */
router.post("/public-ai/realtime/end", oraRealtimeSessionTickLimiter, async (req, res) => {
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken || !validateSession(sessionToken)) {
    res.status(401).json({ error: "No active session.", ended: true });
    return;
  }
  const parsed = tickBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid end request." });
    return;
  }
  const authed = await resolveAuthedOraUser(req);
  const tier = authed?.tier ?? "anonymous";
  const usageKey = deriveUsageKey(authed, sessionToken, req);
  try {
    const result = await endRealtimeSession(
      parsed.data.realtimeSessionId,
      usageKey,
      tier,
      parsed.data.durationSeconds,
    );
    res.setHeader("Cache-Control", "no-store");
    if (result.status === "not_found") {
      // Idempotent: nothing to finalize — treat as a successful end.
      res.json({ status: "ended", ended: true });
      return;
    }
    res.json({
      status: result.status,
      ended: true,
      remainingSeconds: result.remainingSeconds,
      limitSeconds: result.limitSeconds,
      resetsAt: result.resetsAt,
    });
  } catch (err) {
    logger.warn({ component: "ora-realtime", err }, "Ora realtime end failed");
    res.status(503).json({ error: "Could not finalize the voice session.", ended: true });
  }
});

// Privacy-safe client diagnostics payload. `.strict()` + a closed reason enum +
// bounded numbers guarantee no transcript, audio, or free-form text can ever be
// logged here — only high-signal lifecycle reasons and small counts.
const clientDiagBodySchema = z
  .object({
    reason: z.enum([
      "connection_drop",
      "reconnect_scheduled",
      "reconnect_succeeded",
      "reconnect_exhausted",
      "legacy_fallback",
      "stuck_thinking",
      "stuck_speaking",
      "silent_audio",
    ]),
    surface: z.enum(["web", "mobile"]),
    realtimeSessionId: z.string().uuid().optional(),
    attempt: z.number().int().nonnegative().max(1_000).optional(),
    drops: z.number().int().nonnegative().max(100_000).optional(),
    networkQuality: z.enum(["good", "degraded", "reconnecting", "legacy"]).optional(),
  })
  .strict();

/**
 * POST /api/public-ai/realtime/client-diag
 *
 * Best-effort, non-charging sink for a handful of privacy-safe live-voice
 * lifecycle SIGNALS (connection drops, reconnect-ladder progress, watchdog
 * escalations, legacy fallback) so support/on-call can SEE when a "Talk to Ora"
 * session got stuck or gave up — previously invisible server-side because the
 * client kept its diagnostics ring in memory only. The strict enum + bounded
 * numeric schema makes it impossible to smuggle transcript/audio/PII. Rate-limited
 * like the other per-session tick endpoints; always 204 on accept.
 */
router.post("/public-ai/realtime/client-diag", oraRealtimeSessionTickLimiter, async (req, res) => {
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken || !validateSession(sessionToken)) {
    res.status(401).json({ error: "No active session." });
    return;
  }
  const parsed = clientDiagBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid diagnostics report." });
    return;
  }
  let tier = "anonymous";
  try {
    const authed = await resolveAuthedOraUser(req);
    tier = authed?.tier ?? "anonymous";
  } catch {
    // Best-effort — diagnostics must never block on auth resolution.
  }
  logger.info(
    {
      component: "ora-realtime",
      event: "client_diag",
      reason: parsed.data.reason,
      surface: parsed.data.surface,
      tier,
      realtimeSessionId: parsed.data.realtimeSessionId ?? null,
      attempt: parsed.data.attempt ?? null,
      drops: parsed.data.drops ?? null,
      networkQuality: parsed.data.networkQuality ?? null,
    },
    "Ora realtime client diagnostic",
  );
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});

/**
 * GET /api/public-ai/realtime/diagnostics
 *
 * Non-charging capability + configuration probe for the "Talk to Ora" realtime
 * voice feature. Powers the settings diagnostics card so a user (or support) can
 * see whether live voice is available, which model/voice is in use, and the
 * per-tier session length — WITHOUT minting a token or consuming any daily
 * spend-cap units. Read-only: no ora-session cookie required, no OpenAI call.
 */
router.get("/public-ai/realtime/diagnostics", async (req, res) => {
  const killSwitch = isKillSwitchActive("realtime");
  const envDisabled = process.env.ORA_REALTIME_ENABLED === "false";
  const configured = !!process.env.OPENAI_API_KEY;

  let tier = "anonymous";
  let authed: AuthedOraUser | null = null;
  try {
    authed = await resolveAuthedOraUser(req);
    tier = authed?.tier ?? "anonymous";
  } catch {
    // Best-effort — diagnostics must never block on auth resolution.
  }

  const allowance = getRealtimeVoiceAllowance(tier);

  // Live usage is best-effort here: diagnostics must never hard-block, so a
  // metering DB error leaves the usage fields null and the card just shows the
  // static allowance. Enforcement still happens FAIL-CLOSED at /session +
  // /heartbeat. The usage key mirrors the /session derivation so the numbers
  // match the budget that will actually be charged.
  let usedSeconds: number | null = null;
  let remainingSeconds: number | null = null;
  let resetsAt: string | null = null;
  try {
    const sessionToken = req.cookies?.["ora-session"] as string | undefined;
    const usageKey = deriveUsageKey(authed, sessionToken, req);
    const usage = await getRealtimeUsage(usageKey, tier);
    usedSeconds = usage.usedSeconds;
    remainingSeconds = usage.remainingSeconds;
    resetsAt = usage.resetsAt;
  } catch {
    // Leave nulls — the UI shows the allowance without live usage.
  }

  // Product-safe diagnostics: the underlying model/provider and raw provider
  // voice ids are deliberately omitted so they never surface in the settings UI.
  const defaultSelection = resolveVoiceSelection(undefined, undefined);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    enabled: !killSwitch && !envDisabled,
    configured,
    killSwitch,
    defaultVoicePreset: defaultSelection.preset,
    defaultVoiceLabel: defaultSelection.label,
    voices: VOICE_PRESET_OPTIONS,
    tier,
    // Technical per-session ceiling (a single session can never run longer).
    maxDurationSeconds: allowance.sessionCapSeconds,
    // Rolling per-plan voice budget for the tier and how it refills.
    limitSeconds: allowance.limitSeconds,
    windowHours: allowance.windowHours,
    usedSeconds,
    remainingSeconds,
    resetsAt,
  });
});

export default router;
