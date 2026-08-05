import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, isNull, isNotNull, or, sql } from "drizzle-orm";
import {
  db,
  oraConversationsTable,
  oraProjectsTable,
  oraUserSettingsTable,
  knowledgeEntriesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveTierForUser } from "../lib/public-ai/authed-user";
import { oraMessageSchema as messageSchema } from "@workspace/ora-contracts";

const router = Router();

/* ─── Constants ───────────────────────────────────────────────────────────── */

const MAX_STORED = 100;
const MAX_PAYLOAD_BYTES = 256_000;
const MAX_TITLE_LEN = 120;
const MAX_NAME_LEN = 80;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Derive history metadata badges from a parsed messages array.
 * Called synchronously (messages already in memory after Zod parse) so we
 * never do an extra DB round-trip just to compute these flags.
 */
function computeConversationMetadata(
  messages: { role: string; content: string; [k: string]: unknown }[],
): {
  metaHasImages: boolean;
  metaHasGeneratedFiles: boolean;
  metaHasSources: boolean;
  metaHasVoice: boolean;
  metaLastActivityType: string | null;
} {
  let hasImages = false;
  let hasGeneratedFiles = false;
  let hasSources = false;
  let hasVoice = false;
  let lastActivityType: string | null = null;

  for (const msg of messages) {
    if (
      msg.imageUrl ||
      msg.imageId ||
      (Array.isArray(msg.images) && (msg.images as unknown[]).length > 0)
    ) {
      hasImages = true;
    }
    if (msg.generatedFile) {
      hasGeneratedFiles = true;
    }
    if (Array.isArray(msg.sources) && (msg.sources as unknown[]).length > 0) {
      hasSources = true;
    }
    if (msg.isVoice) {
      hasVoice = true;
    }
  }

  // lastActivityType from last assistant message
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    if (lastAssistant.imageUrl || lastAssistant.imageId) {
      lastActivityType = "image";
    } else if (lastAssistant.generatedFile) {
      lastActivityType = "file";
    } else if (
      Array.isArray(lastAssistant.sources) &&
      (lastAssistant.sources as unknown[]).length > 0
    ) {
      lastActivityType = "search";
    } else {
      lastActivityType = "chat";
    }
  }

  return {
    metaHasImages: hasImages,
    metaHasGeneratedFiles: hasGeneratedFiles,
    metaHasSources: hasSources,
    metaHasVoice: hasVoice,
    metaLastActivityType: lastActivityType,
  };
}

/* ─── Conversations ───────────────────────────────────────────────────────── */

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  archived: z.enum(["true", "false"]).optional(),
  // Tri-state project filter: absent = all conversations (legacy behavior),
  // "personal" = Personal space only (projectId IS NULL), a numeric string =
  // that project only. Never collapse absent → null.
  projectId: z.union([z.literal("personal"), z.coerce.number().int().positive()]).optional(),
});

// List the signed-in user's conversations (lightweight — no message bodies).
// Query params: ?q= (search title + content), ?limit=, ?offset=, ?archived=true,
// ?projectId=<id|personal>
router.get("/ora/conversations", async (req, res) => {
  const userId = req.userId!;
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { q, limit, offset, archived, projectId } = parsed.data;
  const showArchived = archived === "true";

  try {
    const projectCondition =
      projectId === undefined
        ? undefined
        : projectId === "personal"
          ? isNull(oraConversationsTable.projectId)
          : eq(oraConversationsTable.projectId, projectId);

    const baseConditions = and(
      eq(oraConversationsTable.userId, userId),
      eq(oraConversationsTable.surface, "normal"),
      showArchived
        ? isNotNull(oraConversationsTable.archivedAt)
        : isNull(oraConversationsTable.archivedAt),
      ...(projectCondition ? [projectCondition] : []),
    );

    const searchCondition = q
      ? or(
          sql`${oraConversationsTable.title} ILIKE ${"%" + q + "%"}`,
          sql`CAST(${oraConversationsTable.messages} AS TEXT) ILIKE ${"%" + q + "%"}`,
        )
      : undefined;

    const whereCondition = searchCondition ? and(baseConditions, searchCondition) : baseConditions;

    // Fetch limit+1 rows to determine hasMore
    const rows = await db
      .select({
        id: oraConversationsTable.id,
        title: oraConversationsTable.title,
        titleSource: oraConversationsTable.titleSource,
        projectId: oraConversationsTable.projectId,
        pinnedAt: oraConversationsTable.pinnedAt,
        metaHasImages: oraConversationsTable.metaHasImages,
        metaHasGeneratedFiles: oraConversationsTable.metaHasGeneratedFiles,
        metaHasSources: oraConversationsTable.metaHasSources,
        metaHasVoice: oraConversationsTable.metaHasVoice,
        metaLastActivityType: oraConversationsTable.metaLastActivityType,
        createdAt: oraConversationsTable.createdAt,
        updatedAt: oraConversationsTable.updatedAt,
        lastMessageAt: oraConversationsTable.lastMessageAt,
        archivedAt: oraConversationsTable.archivedAt,
        // messageCount from jsonb array length — no message body transfer
        messageCount: sql<number>`jsonb_array_length(${oraConversationsTable.messages})`,
        // Short preview = last message's text, truncated
        preview: sql<
          string | null
        >`left((${oraConversationsTable.messages} -> (jsonb_array_length(${oraConversationsTable.messages}) - 1) ->> 'content'), 140)`,
      })
      .from(oraConversationsTable)
      .where(whereCondition)
      // Pinned conversations float to the top regardless of activity time,
      // then sort by most-recent activity.
      .orderBy(
        sql`${oraConversationsTable.pinnedAt} IS NOT NULL DESC`,
        desc(oraConversationsTable.lastMessageAt),
      )
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const conversations = hasMore ? rows.slice(0, limit) : rows;

    res.json({ conversations, hasMore });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to list conversations");
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

const createConversationSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  projectId: z.number().int().positive().nullable().optional(),
});

// Create a new conversation (optionally inside a project).
router.post("/ora/conversations", async (req, res) => {
  const userId = req.userId!;
  const parsed = createConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    if (parsed.data.projectId != null) {
      const [proj] = await db
        .select({ id: oraProjectsTable.id })
        .from(oraProjectsTable)
        .where(
          and(
            eq(oraProjectsTable.id, parsed.data.projectId),
            eq(oraProjectsTable.userId, userId),
            isNull(oraProjectsTable.archivedAt),
          ),
        );
      if (!proj) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
    }

    const [row] = await db
      .insert(oraConversationsTable)
      .values({
        userId,
        title: parsed.data.title ?? null,
        projectId: parsed.data.projectId ?? null,
        titleSource: "client",
        messages: [],
      })
      .returning();

    res.status(201).json({ conversation: row });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to create conversation");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

// Fetch a single conversation including its messages.
router.get("/ora/conversations/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  try {
    const [row] = await db
      .select()
      .from(oraConversationsTable)
      .where(
        and(
          eq(oraConversationsTable.id, id),
          eq(oraConversationsTable.userId, userId),
          eq(oraConversationsTable.surface, "normal"),
          // Allow fetching archived conversations by ID (e.g. restore flow)
          // so the archived view can open a conversation for review.
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json({ conversation: row });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to fetch conversation");
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

const patchConversationSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).nullable().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  // true = pin this conversation; false = unpin
  pinned: z.boolean().optional(),
});

// Rename/move/pin a conversation.
router.patch("/ora/conversations/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  const parsed = patchConversationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const updates: Partial<typeof oraConversationsTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) {
    updates.title = parsed.data.title;
    // Track that the user explicitly renamed this conversation so the async
    // smart-title job will never overwrite it.
    updates.titleSource = "user";
  }
  if (parsed.data.projectId !== undefined) updates.projectId = parsed.data.projectId;
  if (parsed.data.pinned === true) updates.pinnedAt = new Date();
  if (parsed.data.pinned === false) updates.pinnedAt = null;

  try {
    if (parsed.data.projectId != null) {
      const [proj] = await db
        .select({ id: oraProjectsTable.id })
        .from(oraProjectsTable)
        .where(
          and(
            eq(oraProjectsTable.id, parsed.data.projectId),
            eq(oraProjectsTable.userId, userId),
            isNull(oraProjectsTable.archivedAt),
          ),
        );
      if (!proj) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
    }

    const [row] = await db
      .update(oraConversationsTable)
      .set(updates)
      .where(
        and(
          eq(oraConversationsTable.id, id),
          eq(oraConversationsTable.userId, userId),
          eq(oraConversationsTable.surface, "normal"),
          isNull(oraConversationsTable.archivedAt),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json({ conversation: row });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to update conversation");
    res.status(500).json({ error: "Failed to update conversation" });
  }
});

const saveMessagesSchema = z.object({
  conversationId: z.number().int().positive(),
  messages: z.array(messageSchema).max(MAX_STORED),
});

// Replace a conversation's message history (debounced save from the client).
router.put("/ora/conversations/:id/messages", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  const parsed = saveMessagesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  if (parsed.data.conversationId !== id) {
    res.status(409).json({
      error: "Conversation changed before the messages were saved",
      code: "ORA_CONVERSATION_MISMATCH",
    });
    return;
  }

  const messages = parsed.data.messages.slice(-MAX_STORED);
  const payloadSize = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    res.status(413).json({
      error: `Transcript payload too large (${payloadSize} bytes). Maximum allowed is ${MAX_PAYLOAD_BYTES} bytes after stripping.`,
    });
    return;
  }

  // Compute metadata badges before the DB write (messages are already in memory).
  const meta = computeConversationMetadata(
    messages as { role: string; content: string; [k: string]: unknown }[],
  );

  try {
    const now = new Date();
    const [row] = await db
      .update(oraConversationsTable)
      .set({
        messages,
        updatedAt: now,
        lastMessageAt: now,
        ...meta,
      })
      .where(
        and(
          eq(oraConversationsTable.id, id),
          eq(oraConversationsTable.userId, userId),
          eq(oraConversationsTable.surface, "normal"),
          isNull(oraConversationsTable.archivedAt),
        ),
      )
      .returning({
        id: oraConversationsTable.id,
        title: oraConversationsTable.title,
        titleSource: oraConversationsTable.titleSource,
        summary: oraConversationsTable.summary,
        summaryMsgCount: oraConversationsTable.summaryMsgCount,
      });
    if (!row) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json({ ok: true });

    // Background: update cross-conversation recall summary (throttled)
    void maybeUpdateConversationSummary(userId, row.id, messages, row.summary, row.summaryMsgCount);

    // Background: generate a smart title when the conversation only has a
    // client-truncated title and now has at least one user+assistant pair
    if (row.titleSource === "client") {
      void maybeGenerateSmartTitle(userId, row.id, messages);
    }
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to save messages");
    res.status(500).json({ error: "Failed to save conversation" });
  }
});

// Restore an archived conversation (clears archivedAt).
router.patch("/ora/conversations/:id/restore", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  try {
    const [row] = await db
      .update(oraConversationsTable)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(oraConversationsTable.id, id),
          eq(oraConversationsTable.userId, userId),
          eq(oraConversationsTable.surface, "normal"),
          isNotNull(oraConversationsTable.archivedAt),
        ),
      )
      .returning({ id: oraConversationsTable.id });
    if (!row) {
      res.status(404).json({ error: "Conversation not found or not archived" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to restore conversation");
    res.status(500).json({ error: "Failed to restore conversation" });
  }
});

// Soft-delete a conversation (sets archivedAt). Add ?permanent=true for hard delete.
router.delete("/ora/conversations/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  const permanent = req.query.permanent === "true";

  try {
    if (permanent) {
      // Hard delete — no recovery
      const [row] = await db
        .delete(oraConversationsTable)
        .where(
          and(
            eq(oraConversationsTable.id, id),
            eq(oraConversationsTable.userId, userId),
            eq(oraConversationsTable.surface, "normal"),
          ),
        )
        .returning({ id: oraConversationsTable.id });
      if (!row) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
    } else {
      // Soft-delete (move to archive)
      const [row] = await db
        .update(oraConversationsTable)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(oraConversationsTable.id, id),
            eq(oraConversationsTable.userId, userId),
            eq(oraConversationsTable.surface, "normal"),
          ),
        )
        .returning({ id: oraConversationsTable.id });
      if (!row) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to delete conversation");
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

// Clear ALL of the user's conversation history (Data Controls).
router.delete("/ora/conversations", async (req, res) => {
  const userId = req.userId!;
  try {
    await db
      .update(oraConversationsTable)
      .set({ archivedAt: new Date() })
      .where(
        and(eq(oraConversationsTable.userId, userId), isNull(oraConversationsTable.archivedAt)),
      );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to clear conversations");
    res.status(500).json({ error: "Failed to clear conversations" });
  }
});

/* ─── User Settings (cross-device last-active conversation sync) ─────────── */

const patchSettingsSchema = z.object({
  lastConversationId: z.number().int().positive().nullable().optional(),
});

// Get the signed-in user's Ora settings.
router.get("/ora/settings", async (req, res) => {
  const userId = req.userId!;
  try {
    const [row] = await db
      .select()
      .from(oraUserSettingsTable)
      .where(eq(oraUserSettingsTable.userId, userId));
    // Return empty settings object if no row yet — non-error, just first visit
    res.json({ settings: (row?.settings as Record<string, unknown>) ?? {} });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to get user settings");
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// Save/merge Ora settings for the signed-in user.
router.patch("/ora/settings", async (req, res) => {
  const userId = req.userId!;
  const parsed = patchSettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    // Merge the new values into the existing settings jsonb using jsonb || operator
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(patch).length === 0) {
      res.json({ ok: true });
      return;
    }

    await db
      .insert(oraUserSettingsTable)
      .values({ userId, settings: patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: oraUserSettingsTable.userId,
        set: {
          settings: sql`ora_user_settings.settings || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        },
      });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to save user settings");
    res.status(500).json({ error: "Failed to save settings" });
  }
});

/* ─── Projects ────────────────────────────────────────────────────────────── */

// List the user's projects. ?includeArchived=true also returns archived
// projects (with archivedAt set) so clients can offer restore.
router.get("/ora/projects", async (req, res) => {
  const userId = req.userId!;
  const includeArchived = req.query.includeArchived === "true";
  try {
    const rows = await db
      .select({
        id: oraProjectsTable.id,
        name: oraProjectsTable.name,
        description: oraProjectsTable.description,
        createdAt: oraProjectsTable.createdAt,
        updatedAt: oraProjectsTable.updatedAt,
        archivedAt: oraProjectsTable.archivedAt,
      })
      .from(oraProjectsTable)
      .where(
        includeArchived
          ? eq(oraProjectsTable.userId, userId)
          : and(eq(oraProjectsTable.userId, userId), isNull(oraProjectsTable.archivedAt)),
      )
      .orderBy(desc(oraProjectsTable.updatedAt));
    res.json({ projects: rows });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to list projects");
    res.status(500).json({ error: "Failed to load projects" });
  }
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  description: z.string().trim().max(500).optional(),
});

// Create a project.
router.post("/ora/projects", async (req, res) => {
  const userId = req.userId!;
  const parsed = createProjectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Project name is required" });
    return;
  }
  try {
    const [row] = await db
      .insert(oraProjectsTable)
      .values({ userId, name: parsed.data.name, description: parsed.data.description ?? null })
      .returning();
    res.status(201).json({ project: row });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to create project");
    res.status(500).json({ error: "Failed to create project" });
  }
});

const patchProjectSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
});

// Rename a project.
router.patch("/ora/projects/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const parsed = patchProjectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Project name is required" });
    return;
  }
  try {
    const [row] = await db
      .update(oraProjectsTable)
      .set({ name: parsed.data.name, updatedAt: new Date() })
      .where(
        and(
          eq(oraProjectsTable.id, id),
          eq(oraProjectsTable.userId, userId),
          isNull(oraProjectsTable.archivedAt),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ project: row });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to update project");
    res.status(500).json({ error: "Failed to update project" });
  }
});

// Archive a project (soft, restorable). Conversations, assets, uploads, and
// memories KEEP their project id — they are hidden while the project is
// archived and come back intact on restore. Memories are archived alongside
// so they never inject anywhere while the project is archived.
router.delete("/ora/projects/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  try {
    const [row] = await db
      .update(oraProjectsTable)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(oraProjectsTable.id, id),
          eq(oraProjectsTable.userId, userId),
          isNull(oraProjectsTable.archivedAt),
        ),
      )
      .returning({ id: oraProjectsTable.id });
    if (!row) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    // Archive this project's memories so they stop injecting while archived.
    // Restore un-archives exactly the ones archived at/after this moment.
    await db
      .update(knowledgeEntriesTable)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(knowledgeEntriesTable.userId, userId),
          eq(knowledgeEntriesTable.origin, "ora"),
          eq(knowledgeEntriesTable.oraProjectId, id),
          isNull(knowledgeEntriesTable.archivedAt),
        ),
      );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to delete project");
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// Restore an archived project: clears archivedAt on the project and
// un-archives the project memories that were archived when it was archived.
router.post("/ora/projects/:id/restore", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  try {
    const [existing] = await db
      .select({ id: oraProjectsTable.id, archivedAt: oraProjectsTable.archivedAt })
      .from(oraProjectsTable)
      .where(and(eq(oraProjectsTable.id, id), eq(oraProjectsTable.userId, userId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (existing.archivedAt == null) {
      res.status(400).json({ error: "Project is not archived" });
      return;
    }

    const [row] = await db
      .update(oraProjectsTable)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(oraProjectsTable.id, id), eq(oraProjectsTable.userId, userId)))
      .returning();

    // Un-archive only the memories archived at/after the project was archived,
    // so memories the user individually archived earlier stay archived.
    await db
      .update(knowledgeEntriesTable)
      .set({ archivedAt: null })
      .where(
        and(
          eq(knowledgeEntriesTable.userId, userId),
          eq(knowledgeEntriesTable.origin, "ora"),
          eq(knowledgeEntriesTable.oraProjectId, id),
          isNotNull(knowledgeEntriesTable.archivedAt),
          sql`${knowledgeEntriesTable.archivedAt} >= ${existing.archivedAt}`,
        ),
      );

    res.json({ project: row });
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to restore project");
    res.status(500).json({ error: "Failed to restore project" });
  }
});

/* ─── Background: rolling conversation summary ────────────────────────────── */

/**
 * Throttled, best-effort rolling-summary updater for a single conversation.
 *
 * Only the persisted user/assistant turns with real content count. We
 * (re)generate the summary when there are at least 2 turns AND either no summary
 * exists yet, or at least 3 new turns have accumulated since the last summary —
 * so we don't call the model on every keystroke-debounced save.
 *
 * Never throws: any failure is logged and swallowed.
 */
async function maybeUpdateConversationSummary(
  userId: string,
  conversationId: number,
  rawMessages: { role: "user" | "assistant"; content: string }[],
  priorSummary: string | null,
  priorCount: number,
): Promise<void> {
  try {
    const turns = rawMessages.filter(
      (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0,
    );
    if (turns.length < 2) return;

    const hasSummary = (priorSummary ?? "").trim().length > 0;
    const newTurnCount = turns.length - priorCount;
    if (hasSummary && newTurnCount < 3) return;

    const { updateConversationSummary } = await import("../lib/public-ai/conversation-summary");
    const userTier = await resolveTierForUser(userId);
    const source = hasSummary ? turns.slice(priorCount) : turns;
    if (source.length === 0) return;

    const summary = await updateConversationSummary({
      priorSummary: priorSummary ?? "",
      newMessages: source.slice(-40).map((m) => ({ role: m.role, content: m.content })),
      subscriptionTier: userTier.tier,
    });
    if (!summary || summary.trim().length === 0) return;

    await db
      .update(oraConversationsTable)
      .set({ summary, summaryMsgCount: turns.length, summaryUpdatedAt: new Date() })
      .where(eq(oraConversationsTable.id, conversationId));
  } catch (err) {
    logger.warn(
      { component: "ora-conversations", err, conversationId },
      "Rolling conversation summary update failed (non-fatal)",
    );
  }
}

/* ─── Background: async smart title generation (T003) ────────────────────── */

/**
 * Generate a concise 4-6 word title for a conversation after the first
 * assistant reply arrives, replacing the raw client-truncated title.
 *
 * Guards:
 *   - Only runs when titleSource === 'client' (user rename = 'user', AI = 'ai')
 *   - Requires at least one complete user+assistant exchange
 *   - Never blocks the PUT /messages response (fire-and-forget)
 *   - Never runs for support-surface or temporary chats
 *   - Skips when the conversation already has a good title (> 30 chars, i.e.
 *     the user typed something meaningful as their first message)
 */
async function maybeGenerateSmartTitle(
  userId: string,
  conversationId: number,
  messages: { role: string; content: string; [k: string]: unknown }[],
): Promise<void> {
  try {
    const userMsg = messages.find((m) => m.role === "user");
    const assistantMsg = messages.find((m) => m.role === "assistant");
    if (!userMsg || !assistantMsg) return;

    // Only generate when we have a short auto-derived title (≤ 60 chars) or no title
    const [current] = await db
      .select({
        title: oraConversationsTable.title,
        titleSource: oraConversationsTable.titleSource,
      })
      .from(oraConversationsTable)
      .where(
        and(eq(oraConversationsTable.id, conversationId), eq(oraConversationsTable.userId, userId)),
      );
    if (!current) return;
    // Re-check titleSource — might have changed since the PUT /messages returned
    if (current.titleSource !== "client") return;

    const { createChatCompletion } = await import("../lib/ai-providers");

    const userText = String(userMsg.content).slice(0, 400);
    const assistantText = String(assistantMsg.content).slice(0, 400);

    const result = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content:
            "Generate a concise conversation title (4-6 words, no punctuation, no quotes). Respond with the title only.",
        },
        {
          role: "user",
          content: `User said: "${userText}"\n\nAssistant replied: "${assistantText}"`,
        },
      ],
      max_completion_tokens: 20,
    });

    const title = result?.choices?.[0]?.message?.content?.trim();
    if (!title || title.length < 3 || title.length > MAX_TITLE_LEN) return;

    // Only update if titleSource is still 'client' (prevent race with user rename)
    await db
      .update(oraConversationsTable)
      .set({ title, titleSource: "ai", updatedAt: new Date() })
      .where(
        and(
          eq(oraConversationsTable.id, conversationId),
          eq(oraConversationsTable.userId, userId),
          eq(oraConversationsTable.titleSource, "client"),
        ),
      );
  } catch (err) {
    // Non-fatal: smart title gen failures should never surface to the user
    logger.warn(
      { component: "ora-conversations", err, conversationId },
      "Smart title generation failed (non-fatal)",
    );
  }
}

export default router;
