import { Router } from "express";
import { z } from "zod";
import { validateSession } from "../../lib/public-ai/session";
import { getFile } from "../../lib/public-ai/file-store";
import { summarizeDocumentForMemory, detectSensitiveFact } from "../../lib/public-ai/orchestrator";
import { logger } from "../../lib/logger";

const router = Router();

const bodySchema = z.object({
  fileRef: z.string().uuid(),
  /** When true, the caller has acknowledged a sensitive-info warning and wants
   * to persist anyway. Required to save a summary flagged as sensitive. */
  confirmSensitive: z.boolean().optional(),
  /** When set, the document memory is anchored to an Ora project (recalled in
   * that project's chats alongside global memories). Ownership-validated
   * server-side — never trusted from the body alone. (Phase 7) */
  oraProjectId: z.number().int().positive().nullable().optional(),
});

const MAX_TITLE = 200;

function deriveTitle(filename: string): string {
  const name = filename.trim() || "Document";
  return name.length > MAX_TITLE ? `${name.slice(0, MAX_TITLE - 1).trimEnd()}…` : name;
}

/**
 * Task #1372 — Ora document memory (opt-in).
 *
 * Persists a CONCISE SUMMARY (never the raw bytes) of an analyzed document into
 * the signed-in user's Ora memory so it is recalled across sessions. The save is
 * always opt-in (triggered by an explicit user click) and Ora-scoped:
 * scope="user", origin="ora", type="note", category="document" — it never goes
 * to the AI Builder Knowledge Vault and flows through the existing recall path
 * (buildMemoryContext) and the Memory Center.
 *
 * Sensitive content respects the same confirmation guard as the chat memory
 * candidate: a summary flagged sensitive is NOT saved until the caller re-sends
 * with confirmSensitive=true.
 */
router.post("/public-ai/remember-document", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }
  const { fileRef, confirmSensitive, oraProjectId } = parsed.data;

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

  // Document memory is per-user — only signed-in users have a memory to save to.
  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Sign in to save documents to Ora's memory." });
    return;
  }

  // ── Daily spend cap (global + per-user) ────────────────────────────────
  {
    const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
    const capResult = await checkOraSpendCapAsync(
      req,
      "remember_document",
      authed.userId,
      authed.tier,
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
  }

  // Project-scoped saves require the caller to OWN the (non-archived) project.
  // Reject outright rather than silently downgrading to a global save, so the
  // client's scope badge never lies about where a memory landed.
  if (typeof oraProjectId === "number") {
    const { db, oraProjectsTable } = await import("@workspace/db");
    const { and, eq, isNull } = await import("drizzle-orm");
    const [owned] = await db
      .select({ id: oraProjectsTable.id })
      .from(oraProjectsTable)
      .where(
        and(
          eq(oraProjectsTable.id, oraProjectId),
          eq(oraProjectsTable.userId, authed.userId),
          isNull(oraProjectsTable.archivedAt),
        ),
      )
      .limit(1);
    if (!owned) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
  }

  const fileEntry = getFile(fileRef, session.sessionId);
  if (!fileEntry) {
    res.status(404).json({
      error: "This file is no longer available. It may have expired. Please upload it again.",
    });
    return;
  }

  const summary = await summarizeDocumentForMemory(
    fileEntry.filename,
    fileEntry.extractedText,
    authed.tier,
  );
  if (!summary) {
    res.status(422).json({
      error: "Couldn't summarize this document for memory. Please try again.",
    });
    return;
  }

  // Apply the same sensitive guard as the chat memory candidate: scan both the
  // generated summary and the (bounded) source text. A sensitive summary is
  // never persisted until the user explicitly confirms.
  const sensitive =
    detectSensitiveFact(summary) || detectSensitiveFact(fileEntry.extractedText.slice(0, 4000));
  if (sensitive && !confirmSensitive) {
    res.json({ saved: false, requiresConfirmation: true, summary, sensitive: true });
    return;
  }

  try {
    const { db, knowledgeEntriesTable } = await import("@workspace/db");
    const [row] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title: deriveTitle(fileEntry.filename),
        content: summary,
        type: "note",
        category: "document",
        severity: "info",
        scope: "user",
        origin: "ora",
        userId: authed.userId,
        projectId: null,
        oraProjectId: typeof oraProjectId === "number" ? oraProjectId : null,
        enabled: true,
        approvedForReuse: false,
      })
      .returning({
        id: knowledgeEntriesTable.id,
        title: knowledgeEntriesTable.title,
        content: knowledgeEntriesTable.content,
        category: knowledgeEntriesTable.category,
        enabled: knowledgeEntriesTable.enabled,
        createdAt: knowledgeEntriesTable.createdAt,
        oraProjectId: knowledgeEntriesTable.oraProjectId,
      });

    logger.info(
      {
        component: "ora-doc-memory",
        userId: authed.userId,
        memoryId: row?.id,
        sensitive,
        oraProjectId: row?.oraProjectId ?? null,
      },
      "Document memory saved",
    );
    res.status(201).json({ saved: true, sensitive, memory: row });
  } catch (err) {
    logger.error({ component: "ora-doc-memory", err }, "Failed to save document memory");
    res.status(500).json({ error: "Failed to save document to memory." });
  }
});

export default router;
