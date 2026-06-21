import { Router } from "express";
import { z } from "zod";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { db, oraConversationsTable, oraProjectsTable, knowledgeEntriesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { resolveTierForUser } from "../lib/public-ai/authed-user";
import { oraMessageSchema as messageSchema } from "@workspace/ora-contracts";

const router = Router();

/* ─── Message validation ───────────────────────────────────────────────────
 * The canonical Ora message schema lives in @workspace/ora-contracts so the
 * server, the legacy/anonymous transcript store, and the mobile client share a
 * single wire contract. Imported above as `messageSchema`. */

const MAX_STORED = 100;
const MAX_PAYLOAD_BYTES = 256_000;
const MAX_TITLE_LEN = 120;
const MAX_NAME_LEN = 80;

/* ─── Conversations ───────────────────────────────────────────────────────── */

// List the signed-in user's conversations (lightweight — no message bodies).
router.get("/ora/conversations", async (req, res) => {
  const userId = req.userId!;
  try {
    const rows = await db
      .select({
        id: oraConversationsTable.id,
        title: oraConversationsTable.title,
        projectId: oraConversationsTable.projectId,
        createdAt: oraConversationsTable.createdAt,
        updatedAt: oraConversationsTable.updatedAt,
        lastMessageAt: oraConversationsTable.lastMessageAt,
        // Short preview = last message's text, truncated. Computed in SQL so we
        // never transfer full message bodies just to render the History list.
        preview: sql<
          string | null
        >`left((${oraConversationsTable.messages} -> (jsonb_array_length(${oraConversationsTable.messages}) - 1) ->> 'content'), 140)`,
      })
      .from(oraConversationsTable)
      .where(
        and(
          eq(oraConversationsTable.userId, userId),
          // Support Mode conversations live on a separate surface and must never
          // appear in the normal Ora sidebar/history (Task #1312).
          eq(oraConversationsTable.surface, "normal"),
          isNull(oraConversationsTable.archivedAt),
        ),
      )
      .orderBy(desc(oraConversationsTable.lastMessageAt));

    res.json({ conversations: rows });
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
    // Validate project ownership if a projectId was supplied.
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
          // Support Mode conversations are isolated — never reachable via the
          // normal Ora single-conversation endpoints (Task #1312).
          eq(oraConversationsTable.surface, "normal"),
          isNull(oraConversationsTable.archivedAt),
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
});

// Rename a conversation or move it between projects (null = standalone).
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
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.projectId !== undefined) updates.projectId = parsed.data.projectId;

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
          // Support Mode conversations are isolated (Task #1312).
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

  const messages = parsed.data.messages.slice(-MAX_STORED);
  const payloadSize = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    res.status(413).json({
      error: `Transcript payload too large (${payloadSize} bytes). Maximum allowed is ${MAX_PAYLOAD_BYTES} bytes after stripping.`,
    });
    return;
  }

  try {
    const now = new Date();
    const [row] = await db
      .update(oraConversationsTable)
      .set({ messages, updatedAt: now, lastMessageAt: now })
      .where(
        and(
          eq(oraConversationsTable.id, id),
          eq(oraConversationsTable.userId, userId),
          // Support Mode conversations are isolated (Task #1312).
          eq(oraConversationsTable.surface, "normal"),
          isNull(oraConversationsTable.archivedAt),
        ),
      )
      .returning({
        id: oraConversationsTable.id,
        summary: oraConversationsTable.summary,
        summaryMsgCount: oraConversationsTable.summaryMsgCount,
      });
    if (!row) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json({ ok: true });

    // Cross-conversation recall (single writer): keep a rolling, model-generated
    // summary of this conversation so another conversation can recall its gist.
    // This PUT is the ONLY place that writes ora_conversations.summary, so there
    // is no double-write race. Best-effort and fully detached from the response:
    // it never blocks the save and never throws into the request.
    void maybeUpdateConversationSummary(userId, row.id, messages, row.summary, row.summaryMsgCount);
  } catch (err) {
    logger.error({ component: "ora-conversations", err }, "Failed to save messages");
    res.status(500).json({ error: "Failed to save conversation" });
  }
});

/**
 * Throttled, best-effort rolling-summary updater for a single conversation.
 *
 * Only the persisted user/assistant turns with real content count. We
 * (re)generate the summary when there are at least 2 turns AND either no summary
 * exists yet, or at least 3 new turns have accumulated since the last summary —
 * so we don't call the model on every keystroke-debounced save.
 *
 * Never throws: any failure is logged and swallowed so transcript saving and
 * the chat reply are unaffected.
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
    // When we already have a summary, only fold in the turns added since it was
    // generated; otherwise summarise the whole (bounded) conversation.
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
      .set({
        summary,
        summaryMsgCount: turns.length,
        summaryUpdatedAt: new Date(),
      })
      .where(eq(oraConversationsTable.id, conversationId));
  } catch (err) {
    logger.warn(
      { component: "ora-conversations", err, conversationId },
      "Rolling conversation summary update failed (non-fatal)",
    );
  }
}

// Soft-delete a conversation.
router.delete("/ora/conversations/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid conversation id" });
    return;
  }
  try {
    const [row] = await db
      .update(oraConversationsTable)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(oraConversationsTable.id, id),
          eq(oraConversationsTable.userId, userId),
          // Support Mode conversations are isolated (Task #1312). A support-surface
          // id matches nothing here, so the endpoint 404s instead of silently
          // reporting success (Task #1314).
          eq(oraConversationsTable.surface, "normal"),
        ),
      )
      .returning({ id: oraConversationsTable.id });
    if (!row) {
      res.status(404).json({ error: "Conversation not found" });
      return;
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

/* ─── Projects ────────────────────────────────────────────────────────────── */

// List the user's projects.
router.get("/ora/projects", async (req, res) => {
  const userId = req.userId!;
  try {
    const rows = await db
      .select({
        id: oraProjectsTable.id,
        name: oraProjectsTable.name,
        description: oraProjectsTable.description,
        createdAt: oraProjectsTable.createdAt,
        updatedAt: oraProjectsTable.updatedAt,
      })
      .from(oraProjectsTable)
      .where(and(eq(oraProjectsTable.userId, userId), isNull(oraProjectsTable.archivedAt)))
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

// Soft-delete a project. Its conversations are detached (kept as standalone).
router.delete("/ora/projects/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  try {
    await db
      .update(oraProjectsTable)
      .set({ archivedAt: new Date() })
      .where(and(eq(oraProjectsTable.id, id), eq(oraProjectsTable.userId, userId)));
    // Detach conversations so they remain accessible as standalone chats.
    await db
      .update(oraConversationsTable)
      .set({ projectId: null })
      .where(
        and(eq(oraConversationsTable.projectId, id), eq(oraConversationsTable.userId, userId)),
      );
    // Remove this project's persistent memories — they are scoped to the project
    // and must not survive (or leak into user-level retrieval) once it's gone.
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

export default router;
