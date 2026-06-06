// ─────────────────────────────────────────────────────────────────────────────
// Admin support inbox routes — all require admin RBAC
//
//   GET   /api/admin/support-tickets                          — list + filter
//   GET   /api/admin/support-tickets/:id                      — full ticket detail
//   PATCH /api/admin/support-tickets/:id                      — change status
//   POST  /api/admin/support-tickets/:id/reply               — email the requester
//   GET   /api/admin/support-tickets/:id/attachments/:assetId — download attachment
//
// The support inbox lets staff triage escalated tickets (from Ora Support Mode)
// without leaving the product. Tickets are persisted by the escalation flow in
// routes/help.ts; this surface is read/triage/reply only — it never creates a
// ticket. Attachment downloads are proxied here (admin-scoped) because the
// public /ora/assets/:id/download route is owner-scoped and a triaging admin
// does not own the requester's uploaded files.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, desc, count, sql, ilike, or } from "drizzle-orm";
import {
  db,
  supportTicketsTable,
  projectsTable,
  oraAssetsTable,
  SUPPORT_TICKET_STATUSES,
  type SupportTicketStatus,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { requireAdmin } from "../lib/adminAuth";
import { r2GetObject } from "../lib/cloudflare";
import { sendEmailWithStatus } from "../lib/emailClient";
import { supportReplyTemplate } from "../lib/emailTemplates";

const router: IRouter = Router();

// All routes here are admin-only.
router.use("/admin/support-tickets", requireAdmin);

interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  staffReply?: boolean;
  at?: string;
}

interface TicketAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
}

function asTranscript(raw: unknown): TranscriptMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => m != null && typeof m === "object")
    .map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: typeof m.content === "string" ? m.content : "",
      staffReply: m.staffReply === true ? true : undefined,
      at: typeof m.at === "string" ? m.at : undefined,
    }));
}

function asAttachments(raw: unknown): TicketAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => a != null && typeof a === "object")
    .map((a) => ({
      fileName: typeof a.fileName === "string" ? a.fileName : "attachment",
      mimeType: typeof a.mimeType === "string" ? a.mimeType : "application/octet-stream",
      size: typeof a.size === "number" ? a.size : 0,
      url: typeof a.url === "string" ? a.url : "",
    }));
}

// Extract the numeric ora-asset id embedded in a stored attachment URL of the
// form `/api/ora/assets/{assetId}/download?download=1`. Returns null when the
// URL does not match (e.g. a legacy or external link).
function assetIdFromUrl(url: string): number | null {
  const m = /\/ora\/assets\/(\d+)\/download/.exec(url);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function toIso(d: Date | string | null | undefined): string {
  if (d == null) return "";
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

// Normalise a stored status for display: legacy "closed" maps to "resolved".
function normalizeStatus(raw: string): SupportTicketStatus {
  if (raw === "closed") return "resolved";
  return (SUPPORT_TICKET_STATUSES as readonly string[]).includes(raw)
    ? (raw as SupportTicketStatus)
    : "new";
}

// ── GET /api/admin/support-tickets ────────────────────────────────────────────
// Query params: status (new|open|resolved|all), q (subject/email/user search),
// limit (1–100, default 50), offset (default 0).
router.get("/admin/support-tickets", async (req, res): Promise<void> => {
  const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "all";
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
  const rawLimit = Number(req.query.limit ?? 50);
  const rawOffset = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 100);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  try {
    const conditions = [];
    if (statusParam && statusParam !== "all") {
      if (statusParam === "resolved") {
        // Treat legacy "closed" as resolved so old tickets remain visible.
        conditions.push(
          or(eq(supportTicketsTable.status, "resolved"), eq(supportTicketsTable.status, "closed")),
        );
      } else {
        conditions.push(eq(supportTicketsTable.status, statusParam));
      }
    }
    if (q) {
      const like = `%${q}%`;
      conditions.push(
        or(
          ilike(supportTicketsTable.subject, like),
          ilike(supportTicketsTable.userEmail, like),
          ilike(supportTicketsTable.userId, like),
        ),
      );
    }
    const whereClause = conditions.length ? and(...conditions) : undefined;

    const [rows, [totalRow], statusCountRows] = await Promise.all([
      db
        .select({
          id: supportTicketsTable.id,
          userId: supportTicketsTable.userId,
          userEmail: supportTicketsTable.userEmail,
          plan: supportTicketsTable.plan,
          category: supportTicketsTable.category,
          status: supportTicketsTable.status,
          subject: supportTicketsTable.subject,
          projectId: supportTicketsTable.projectId,
          projectName: projectsTable.name,
          attachmentCount: sql<number>`coalesce(jsonb_array_length(${supportTicketsTable.attachments}), 0)::int`,
          emailStatus: supportTicketsTable.emailStatus,
          createdAt: supportTicketsTable.createdAt,
          updatedAt: supportTicketsTable.updatedAt,
        })
        .from(supportTicketsTable)
        .leftJoin(projectsTable, eq(projectsTable.id, supportTicketsTable.projectId))
        .where(whereClause)
        .orderBy(desc(supportTicketsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(supportTicketsTable).where(whereClause),
      db
        .select({ status: supportTicketsTable.status, n: count() })
        .from(supportTicketsTable)
        .groupBy(supportTicketsTable.status),
    ]);

    const statusCounts = { new: 0, open: 0, resolved: 0 };
    for (const r of statusCountRows) {
      const s = normalizeStatus(r.status);
      statusCounts[s] += Number(r.n);
    }

    res.json({
      tickets: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        plan: r.plan,
        category: r.category,
        status: normalizeStatus(r.status),
        subject: r.subject,
        projectId: r.projectId,
        projectName: r.projectId != null ? (r.projectName ?? "(deleted)") : null,
        attachmentCount: Number(r.attachmentCount ?? 0),
        emailStatus: r.emailStatus,
        createdAt: toIso(r.createdAt),
        updatedAt: toIso(r.updatedAt),
      })),
      total: totalRow?.total ?? 0,
      statusCounts,
      limit,
      offset,
    });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to list support tickets");
    res.status(500).json({ error: "Failed to load support tickets" });
  }
});

// ── GET /api/admin/support-tickets/:id ────────────────────────────────────────
router.get("/admin/support-tickets/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }
  try {
    const [row] = await db
      .select({
        id: supportTicketsTable.id,
        userId: supportTicketsTable.userId,
        userEmail: supportTicketsTable.userEmail,
        plan: supportTicketsTable.plan,
        category: supportTicketsTable.category,
        status: supportTicketsTable.status,
        subject: supportTicketsTable.subject,
        transcript: supportTicketsTable.transcript,
        projectId: supportTicketsTable.projectId,
        projectName: projectsTable.name,
        attachments: supportTicketsTable.attachments,
        deviceInfo: supportTicketsTable.deviceInfo,
        supportEmailUsed: supportTicketsTable.supportEmailUsed,
        emailStatus: supportTicketsTable.emailStatus,
        createdAt: supportTicketsTable.createdAt,
        updatedAt: supportTicketsTable.updatedAt,
      })
      .from(supportTicketsTable)
      .leftJoin(projectsTable, eq(projectsTable.id, supportTicketsTable.projectId))
      .where(eq(supportTicketsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    // Rewrite each attachment to an admin-scoped download URL so a triaging
    // admin (who does not own the asset) can still fetch it.
    const attachments = asAttachments(row.attachments).map((a) => {
      const assetId = assetIdFromUrl(a.url);
      return {
        fileName: a.fileName,
        mimeType: a.mimeType,
        size: a.size,
        assetId,
        downloadUrl:
          assetId != null ? `/api/admin/support-tickets/${id}/attachments/${assetId}` : null,
      };
    });

    res.json({
      id: row.id,
      userId: row.userId,
      userEmail: row.userEmail,
      plan: row.plan,
      category: row.category,
      status: normalizeStatus(row.status),
      subject: row.subject,
      transcript: asTranscript(row.transcript),
      projectId: row.projectId,
      projectName: row.projectId != null ? (row.projectName ?? "(deleted)") : null,
      attachments,
      deviceInfo: (row.deviceInfo as Record<string, unknown> | null) ?? null,
      supportEmailUsed: row.supportEmailUsed,
      emailStatus: row.emailStatus,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to load support ticket");
    res.status(500).json({ error: "Failed to load support ticket" });
  }
});

// ── PATCH /api/admin/support-tickets/:id ──────────────────────────────────────
// Body: { status: "new" | "open" | "resolved" }
router.patch("/admin/support-tickets/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }
  const status = (req.body as { status?: string })?.status;
  if (!status || !(SUPPORT_TICKET_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: "status must be one of: new, open, resolved" });
    return;
  }
  try {
    const [row] = await db
      .update(supportTicketsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, id))
      .returning({ id: supportTicketsTable.id, status: supportTicketsTable.status });
    if (!row) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }
    res.json({ ok: true, id: row.id, status: normalizeStatus(row.status) });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to update ticket status");
    res.status(500).json({ error: "Failed to update ticket" });
  }
});

// ── POST /api/admin/support-tickets/:id/reply ─────────────────────────────────
// Body: { message: string }. Emails the requester (if an email is on file) and
// records the reply in the ticket transcript so the thread stays auditable.
router.post("/admin/support-tickets/:id/reply", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }
  const message = (req.body as { message?: string })?.message;
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const body = message.trim().slice(0, 8000);

  try {
    const [row] = await db
      .select({
        id: supportTicketsTable.id,
        subject: supportTicketsTable.subject,
        userEmail: supportTicketsTable.userEmail,
        transcript: supportTicketsTable.transcript,
        status: supportTicketsTable.status,
      })
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    if (!row.userEmail) {
      res.status(400).json({
        error: "No email address on file for this requester — cannot send a reply.",
      });
      return;
    }

    const tpl = supportReplyTemplate({ ticketId: id, subject: row.subject, replyBody: body });
    const emailStatus = await sendEmailWithStatus({
      to: row.userEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });

    // Record the staff reply in the transcript and move a "new" ticket to "open"
    // so the inbox reflects that it is being worked.
    const transcript = asTranscript(row.transcript);
    transcript.push({
      role: "assistant",
      content: body,
      staffReply: true,
      at: new Date().toISOString(),
    });
    const nextStatus = normalizeStatus(row.status) === "new" ? "open" : normalizeStatus(row.status);

    await db
      .update(supportTicketsTable)
      .set({ transcript, status: nextStatus, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, id));

    res.json({ ok: true, emailStatus, status: nextStatus });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to send support reply");
    res.status(500).json({ error: "Failed to send reply" });
  }
});

// ── GET /api/admin/support-tickets/:id/attachments/:assetId ───────────────────
// Admin-scoped attachment download. Verifies the asset is actually referenced by
// the ticket before streaming (defense in depth) and bypasses the owner scope
// that the public /ora/assets route enforces.
router.get("/admin/support-tickets/:id/attachments/:assetId", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const assetId = Number(req.params.assetId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(assetId) || assetId <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [ticket] = await db
      .select({ attachments: supportTicketsTable.attachments })
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id));
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }
    const referenced = asAttachments(ticket.attachments).some(
      (a) => assetIdFromUrl(a.url) === assetId,
    );
    if (!referenced) {
      res.status(404).json({ error: "Attachment not found on this ticket" });
      return;
    }

    const [asset] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, assetId));
    if (!asset || asset.deletedAt) {
      res.status(404).json({ error: "Attachment file not found" });
      return;
    }

    let buf: Buffer | null = null;
    if (asset.storageKey) {
      const obj = await r2GetObject(asset.storageKey);
      if (obj) buf = obj.body;
    }
    if (!buf && asset.data) buf = Buffer.from(asset.data, "base64");
    if (!buf) {
      res.status(502).json({ error: "Attachment temporarily unavailable" });
      return;
    }

    const safeName = asset.fileName.replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(buf);
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to download ticket attachment");
    res.status(500).json({ error: "Failed to download attachment" });
  }
});

export default router;
