import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, isNull, ilike, or, sql } from "drizzle-orm";
import {
  db,
  helpArticlesTable,
  supportTicketsTable,
  oraConversationsTable,
  projectsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveAuthedOraUser } from "../lib/public-ai/authed-user";
import { scanUserInput, ORA_SUPPORT_SYSTEM_PROMPT } from "../lib/public-ai/prompt";
import { persistOraAsset } from "../lib/ora-assets";
import { sendEmailWithStatus, type EmailDeliveryStatus } from "../lib/emailClient";
import { supportTicketTemplate } from "../lib/emailTemplates";
import { getClerkUserById } from "../lib/clerk-users";

async function resolveUserEmail(userId: string): Promise<string | null> {
  try {
    const u = await getClerkUserById(userId);
    return u?.email ?? null;
  } catch {
    return null;
  }
}

const router = Router();

/* ─────────────────────────────────────────────────────────────────────────────
 * Help Center + Ora Support Mode (Task #1312)
 *
 * Articles are public (browse without sign-in). Support chat / conversation
 * history / escalation all require a signed-in user (resolveAuthedOraUser).
 *
 * ISOLATION: Support Mode is fully separate from the AI Builder and from normal
 * Ora chat. It uses its own system prompt (ORA_SUPPORT_SYSTEM_PROMPT), its own
 * conversation surface ("support"), and never exposes builder/file/image/search
 * tools. It is grounded ONLY in Help Center articles + a small, ownership-safe
 * account/project context. It must never pull the Builder Knowledge Vault.
 * ───────────────────────────────────────────────────────────────────────────── */

const SUPPORT_FALLBACK_REPLY =
  "I'm having trouble responding right now. If this keeps happening, you can escalate this conversation to the MustaFlow support team and a ticket will be created with your messages.";

function mapArticle(row: typeof helpArticlesTable.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    category: row.category,
    title: row.title,
    body: row.body,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    isFaq: row.isFaq,
    sortOrder: row.sortOrder,
  };
}

// ── GET /help/articles (PUBLIC) ───────────────────────────────────────────────
router.get("/help/articles", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
  const category =
    typeof req.query.category === "string" ? req.query.category.trim().slice(0, 60) : "";

  try {
    const conditions = [];
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(helpArticlesTable.title, like),
          ilike(helpArticlesTable.body, like),
          sql`${helpArticlesTable.tags}::text ilike ${like}`,
        ),
      );
    }
    if (category) conditions.push(eq(helpArticlesTable.category, category));

    const rows = await db
      .select()
      .from(helpArticlesTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(helpArticlesTable.category, helpArticlesTable.sortOrder)
      .limit(200);

    const mapped = rows.map(mapArticle);
    res.json({
      articles: mapped.filter((a) => !a.isFaq),
      faqs: mapped.filter((a) => a.isFaq),
    });
  } catch (err) {
    logger.error({ component: "help", err }, "Failed to list help articles");
    res.status(500).json({ error: "Failed to load help articles" });
  }
});

/* ─── Support Mode helpers ──────────────────────────────────────────────────── */

const supportMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
});

const supportChatSchema = z.object({
  message: z.string().min(1).max(8000),
  messages: z.array(supportMessageSchema).max(20).optional(),
  projectId: z.number().int().nullable().optional(),
  category: z.string().max(60).optional(),
  language: z.string().max(20).optional(),
  languageHint: z.string().max(20).optional(),
});

/**
 * Retrieve the most relevant Help Center articles for a support query using a
 * simple keyword-overlap score (title/tags weighted). Falls back to the lowest
 * sort-ordered articles so the assistant always has some grounding.
 */
async function retrieveHelpArticles(message: string, limit = 5): Promise<string> {
  try {
    const rows = await db.select().from(helpArticlesTable).limit(200);
    if (rows.length === 0) return "";

    const words = message
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    const wordSet = new Set(words);

    const scored = rows.map((r) => {
      const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
      const hayTitle = r.title.toLowerCase();
      const hayBody = r.body.toLowerCase();
      let score = 0;
      for (const w of wordSet) {
        if (tags.some((t) => t.toLowerCase().includes(w))) score += 3;
        if (hayTitle.includes(w)) score += 2;
        if (hayBody.includes(w)) score += 1;
      }
      return { r, score };
    });

    scored.sort((a, b) => b.score - a.score || a.r.sortOrder - b.r.sortOrder);
    const top = scored.slice(0, limit).filter((s, i) => s.score > 0 || i < 3);
    if (top.length === 0) return "";

    const block = top.map((s) => `### ${s.r.title} (${s.r.category})\n${s.r.body}`).join("\n\n");
    return `\n\n## Help Center articles (your knowledge base)\nGround your answer in these articles. Do not invent steps that are not described here.\n\n${block}`;
  } catch (err) {
    logger.warn({ component: "help", err }, "Help article retrieval failed (non-fatal)");
    return "";
  }
}

/**
 * Build a small, ownership-safe account/project context. Only includes a
 * project block when the project is verified to belong to the requesting user.
 * Never includes secrets, file contents, or Builder Knowledge Vault material.
 */
async function buildSupportContext(
  userId: string,
  userEmail: string | null,
  tier: string,
  projectId: number | null | undefined,
): Promise<string> {
  const lines = [
    "\n\n## Signed-in user context (safe to reference)",
    `- User is signed in.`,
    `- Plan/tier: ${tier}`,
  ];
  if (userEmail) lines.push(`- Account email: ${userEmail}`);

  if (projectId != null) {
    try {
      const [proj] = await db
        .select({
          id: projectsTable.id,
          name: projectsTable.name,
          status: projectsTable.status,
        })
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.id, projectId),
            eq(projectsTable.ownerId, userId),
            isNull(projectsTable.deletedAt),
          ),
        );
      if (proj) {
        lines.push(
          `- Current project: "${proj.name}" (id ${proj.id}, status: ${proj.status ?? "unknown"}).`,
        );
      } else {
        lines.push(
          `- A project id was provided but it does not belong to this user; do not reference it.`,
        );
      }
    } catch {
      // best-effort
    }
  }
  return lines.join("\n");
}

function supportLanguageAddendum(language?: string, languageHint?: string): string {
  if (language && language !== "auto") {
    return `\n\n## Language\nRespond entirely in "${language}".`;
  }
  if (languageHint) {
    const primary = languageHint.split("-")[0].toLowerCase();
    return `\n\n## Language\nWhen the user's message is short or ambiguous, default to ${primary}; otherwise match the language they write in.`;
  }
  return `\n\n## Language\nMatch the language the user writes in; default to English when ambiguous.`;
}

// ── POST /help/support/chat (AUTH) ────────────────────────────────────────────
router.post("/help/support/chat", async (req, res) => {
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Sign in to use MustaFlow Support." });
    return;
  }

  const parsed = supportChatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { message, messages = [], projectId, language, languageHint } = parsed.data;

  // Prompt-injection guard — refuse manipulative input rather than process it.
  if (!scanUserInput(message)) {
    res.status(200).json({
      reply:
        "I can only help with using MustaFlow. Let me know what you're trying to do and I'll walk you through it, or you can escalate to the support team.",
      canEscalate: true,
    });
    return;
  }

  const userEmail = await resolveUserEmail(authed.userId);

  const [articleContext, accountContext] = await Promise.all([
    retrieveHelpArticles(message),
    buildSupportContext(authed.userId, userEmail, authed.tier, projectId),
  ]);

  const systemPrompt =
    ORA_SUPPORT_SYSTEM_PROMPT +
    supportLanguageAddendum(language, languageHint) +
    accountContext +
    articleContext;

  const history = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const callMessages = [
    { role: "system" as const, content: systemPrompt },
    ...history,
    { role: "user" as const, content: message },
  ];

  let reply: string | null = null;
  try {
    const { createChatCompletion } = await import("../lib/ai-providers");
    const premiumModel = process.env.ORA_PREMIUM_MODEL ?? "gpt-5.4";
    try {
      const result = await createChatCompletion({
        provider: "openai",
        model: premiumModel,
        messages: callMessages,
        response_format: { type: "text" },
        max_completion_tokens: 1000,
      });
      reply = result.choices[0]?.message?.content?.trim() ?? null;
    } catch (primaryErr) {
      logger.warn(
        { component: "help-support", err: primaryErr },
        "Support primary model failed — trying fallback",
      );
      const result = await createChatCompletion({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: callMessages,
        response_format: { type: "text" },
        max_completion_tokens: 1000,
      });
      reply = result.choices[0]?.message?.content?.trim() ?? null;
    }
  } catch (err) {
    logger.error({ component: "help-support", err }, "Support chat completion failed");
  }

  const finalReply = reply ?? SUPPORT_FALLBACK_REPLY;

  // Persist to the dedicated "support" surface so it never appears in the
  // normal Ora sidebar. Best-effort: a persistence failure must not block the
  // reply the user already sees.
  void persistSupportTurn(authed.userId, projectId ?? null, [
    ...history,
    { role: "user" as const, content: message },
    { role: "assistant" as const, content: finalReply },
  ]).catch((err) =>
    logger.warn({ component: "help-support", err }, "Failed to persist support turn"),
  );

  res.status(200).json({ reply: finalReply, canEscalate: true });
});

/**
 * Persist (or update) the user's single rolling support conversation on the
 * "support" surface. Keeps the most recent messages only.
 */
async function persistSupportTurn(
  userId: string,
  projectId: number | null,
  fullMessages: { role: "user" | "assistant"; content: string }[],
): Promise<void> {
  const trimmed = fullMessages.slice(-100);
  const [existing] = await db
    .select({ id: oraConversationsTable.id })
    .from(oraConversationsTable)
    .where(
      and(
        eq(oraConversationsTable.userId, userId),
        eq(oraConversationsTable.surface, "support"),
        isNull(oraConversationsTable.archivedAt),
      ),
    )
    .orderBy(desc(oraConversationsTable.lastMessageAt))
    .limit(1);

  if (existing) {
    await db
      .update(oraConversationsTable)
      .set({ messages: trimmed, lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(oraConversationsTable.id, existing.id));
  } else {
    await db.insert(oraConversationsTable).values({
      userId,
      title: "Support conversation",
      projectId: null,
      surface: "support",
      messages: trimmed,
    });
  }
}

// ── GET /help/support/conversations (AUTH) ────────────────────────────────────
router.get("/help/support/conversations", async (req, res) => {
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Sign in to view your support conversations." });
    return;
  }
  try {
    const rows = await db
      .select({
        id: oraConversationsTable.id,
        title: oraConversationsTable.title,
        createdAt: oraConversationsTable.createdAt,
        updatedAt: oraConversationsTable.updatedAt,
        lastMessageAt: oraConversationsTable.lastMessageAt,
        preview: sql<
          string | null
        >`left((${oraConversationsTable.messages} -> (jsonb_array_length(${oraConversationsTable.messages}) - 1) ->> 'content'), 140)`,
      })
      .from(oraConversationsTable)
      .where(
        and(
          eq(oraConversationsTable.userId, authed.userId),
          // ONLY support-surface conversations — never normal Ora chats.
          eq(oraConversationsTable.surface, "support"),
          isNull(oraConversationsTable.archivedAt),
        ),
      )
      .orderBy(desc(oraConversationsTable.lastMessageAt));

    res.json({
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt?.toISOString?.() ?? String(r.createdAt),
        updatedAt: r.updatedAt?.toISOString?.() ?? String(r.updatedAt),
        lastMessageAt: r.lastMessageAt?.toISOString?.() ?? String(r.lastMessageAt),
        preview: r.preview,
      })),
    });
  } catch (err) {
    logger.error({ component: "help-support", err }, "Failed to list support conversations");
    res.status(500).json({ error: "Failed to load support conversations" });
  }
});

/* ─── Escalation (persist ticket BEFORE email) ──────────────────────────────── */

const ALLOWED_ATTACHMENT_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
const BLOCKED_EXTENSIONS =
  /\.(exe|sh|bat|cmd|com|msi|app|dll|scr|ps1|js|mjs|cjs|jar|py|rb|php|pl|vbs|wsf|apk|deb|rpm|bin|elf)$/i;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const MAX_ATTACHMENTS = 5;

// Server-side content sniffing: verify the leading bytes actually match the
// declared MIME so a hostile client cannot smuggle arbitrary bytes through by
// labelling an executable as image/png. Returns true if the magic bytes match
// one of the allowed types for the declared MIME.
function magicBytesMatch(mime: string, buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const b = buf;
  switch (mime) {
    case "image/png":
      return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    case "image/jpeg":
    case "image/jpg":
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38; // GIF8
    case "image/webp":
      // "RIFF"...."WEBP"
      return (
        buf.length >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
      );
    case "application/pdf":
      // "%PDF"
      return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
    default:
      return false;
  }
}

const escalateSchema = z.object({
  subject: z.string().min(1).max(200),
  category: z.string().max(60).optional(),
  transcript: z.array(supportMessageSchema).max(100),
  projectId: z.number().int().nullable().optional(),
  attachments: z
    .array(
      z.object({
        fileName: z.string().min(1).max(200),
        mimeType: z.string().min(1).max(120),
        dataBase64: z.string().min(1),
      }),
    )
    .max(MAX_ATTACHMENTS)
    .optional(),
  deviceInfo: z.record(z.unknown()).nullable().optional(),
});

// ── POST /help/support/escalate (AUTH) ────────────────────────────────────────
router.post("/help/support/escalate", async (req, res) => {
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Sign in to contact the support team." });
    return;
  }

  const parsed = escalateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { subject, category, transcript, projectId, attachments = [], deviceInfo } = parsed.data;

  // Verify project ownership server-side before storing the reference.
  let safeProjectId: number | null = null;
  if (projectId != null) {
    try {
      const [proj] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.id, projectId),
            eq(projectsTable.ownerId, authed.userId),
            isNull(projectsTable.deletedAt),
          ),
        );
      safeProjectId = proj ? proj.id : null;
    } catch {
      safeProjectId = null;
    }
  }

  // Validate + persist attachments. We store safe metadata + a download link in
  // the ticket and email — never raw bytes in the email.
  const storedAttachments: { fileName: string; mimeType: string; size: number; url: string }[] = [];
  for (const att of attachments) {
    const mime = att.mimeType.toLowerCase();
    if (!ALLOWED_ATTACHMENT_MIME.has(mime)) {
      res.status(400).json({ error: `Attachment type not allowed: ${att.mimeType}` });
      return;
    }
    if (BLOCKED_EXTENSIONS.test(att.fileName)) {
      res.status(400).json({ error: `Executable attachments are not allowed: ${att.fileName}` });
      return;
    }
    // Strip any data: prefix and validate decoded size.
    const base64 = att.dataBase64.includes(",")
      ? att.dataBase64.slice(att.dataBase64.indexOf(",") + 1)
      : att.dataBase64;
    const size = Buffer.byteLength(base64, "base64");
    if (size === 0) {
      res.status(400).json({ error: `Attachment is empty: ${att.fileName}` });
      return;
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      res.status(400).json({ error: `Attachment too large (max 5 MB): ${att.fileName}` });
      return;
    }
    // Content sniffing — the declared MIME must match the file's magic bytes so
    // a spoofed image/png can't carry an executable payload.
    const head = Buffer.from(base64.slice(0, 64), "base64");
    if (!magicBytesMatch(mime, head)) {
      res
        .status(400)
        .json({ error: `Attachment content does not match its type: ${att.fileName}` });
      return;
    }

    const ext = mime === "application/pdf" ? "pdf" : (mime.split("/")[1] ?? "bin");
    const assetId = await persistOraAsset({
      userId: authed.userId,
      kind: "file",
      fileName: att.fileName,
      mimeType: mime,
      format: ext,
      prompt: `Support attachment: ${subject}`,
      base64,
    });
    if (assetId == null) {
      res.status(400).json({ error: `Could not store attachment: ${att.fileName}` });
      return;
    }
    storedAttachments.push({
      fileName: att.fileName,
      mimeType: mime,
      size,
      url: `/api/ora/assets/${assetId}/download?download=1`,
    });
  }

  const userEmail = await resolveUserEmail(authed.userId);
  const recipient = process.env.SUPPORT_EMAIL || "Mustafa_alali74@yahoo.com";

  // 1) Persist the ticket FIRST so an email failure can never lose the request.
  let ticketId: number;
  try {
    const [row] = await db
      .insert(supportTicketsTable)
      .values({
        userId: authed.userId,
        userEmail,
        plan: authed.tier,
        category: category ?? "other",
        status: "open",
        subject,
        transcript,
        projectId: safeProjectId,
        attachments: storedAttachments,
        deviceInfo: deviceInfo ?? null,
        supportEmailUsed: recipient,
        emailStatus: "skipped",
      })
      .returning({ id: supportTicketsTable.id });
    ticketId = row.id;
  } catch (err) {
    logger.error({ component: "help-support", err }, "Failed to persist support ticket");
    res.status(500).json({ error: "Could not create your support ticket. Please try again." });
    return;
  }

  // 2) Attempt the email AFTER the ticket exists; record the outcome.
  let emailStatus: EmailDeliveryStatus;
  try {
    const tpl = supportTicketTemplate({
      ticketId,
      userEmail,
      userId: authed.userId,
      plan: authed.tier,
      category: category ?? "other",
      subject,
      transcript,
      attachments: storedAttachments,
      projectId: safeProjectId,
      deviceInfo: deviceInfo ?? null,
    });
    emailStatus = await sendEmailWithStatus({
      to: recipient,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
  } catch (err) {
    logger.warn({ component: "help-support", err }, "Support ticket email send threw");
    emailStatus = "failed";
  }

  // 3) Update the ticket with the final delivery status (best-effort).
  try {
    await db
      .update(supportTicketsTable)
      .set({ emailStatus, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, ticketId));
  } catch (err) {
    logger.warn({ component: "help-support", err }, "Failed to update ticket email status");
  }

  res.status(201).json({ ticketId, emailStatus, supportEmailUsed: recipient });
});

export default router;
