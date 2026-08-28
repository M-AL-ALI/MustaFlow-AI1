// ─────────────────────────────────────────────────────────────────────────────
// Admin support inbox routes — all require admin RBAC
//
//   GET   /api/admin/support-tickets                          — list + filter
//   GET   /api/admin/support-tickets/:id                      — full ticket detail
//   PATCH /api/admin/support-tickets/:id                      — change status
//   POST  /api/admin/support-tickets/:id/reply               — email the requester
//   GET   /api/admin/support-tickets/:id/attachments/:assetId — download attachment
//   POST  /api/admin/email/test                              — send a test email to SUPPORT_EMAIL
//
// The support inbox lets staff triage escalated tickets (from Ora Support Mode)
// without leaving the product. Tickets are persisted by the escalation flow in
// routes/help.ts; this surface is read/triage/reply only — it never creates a
// ticket. Attachment downloads are proxied here (admin-scoped) because the
// public /ora/assets/:id/download route is owner-scoped and a triaging admin
// does not own the requester's uploaded files.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { ListAdminSupportAssigneesResponse } from "@workspace/api-zod";
import { and, eq, desc, count, sql, ilike, inArray, or } from "drizzle-orm";
import {
  db,
  supportTicketsTable,
  projectsTable,
  userRolesTable,
  oraAssetsTable,
  type StaffRole,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { requireAdmin, writeAdminReceipt } from "../lib/adminAuth";
import { r2GetObject } from "../lib/cloudflare";
import { sendEmailWithStatus } from "../lib/emailClient";
import { supportReplyTemplate } from "../lib/emailTemplates";
import { resolveDefaultSender, resolveSupportRecipient } from "../lib/support-contact";
import { deliverSupportConsequence } from "../lib/support-user-delivery";
import { getSharedAccountProfile } from "../lib/clerk-users";
import {
  formatSupportTicketNumber,
  isSupportTicketPriority,
  normalizeSupportTicketStatus,
  SUPPORT_TICKET_RESOLVER_ROLES,
} from "../lib/support-ticket-workflow";

const router: IRouter = Router();

// All routes here are admin-only.
router.use("/admin/support-tickets", requireAdmin);
router.use("/admin/support-assignees", requireAdmin);
router.use("/admin/email", requireAdmin);

async function recordTicketReceipt(
  req: Parameters<typeof requireAdmin>[0],
  action: string,
  targetUserId: string,
): Promise<void> {
  await writeAdminReceipt({
    actorUserId: req.userId!,
    actorRole: req.staffPrincipal!.role,
    kind: req.method === "GET" ? "access" : "action",
    action,
    targetUserId,
    outcome: "completed",
    requestMethod: req.method,
    requestPath: req.originalUrl.split("?", 1)[0] ?? req.path,
  });
}

interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  staffReply?: boolean;
  internalNote?: boolean;
  authorId?: string;
  at?: string;
  deliveryId?: number;
  deliveryStatus?: "pending" | "sent" | "delivered" | "failed";
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
      internalNote: m.internalNote === true ? true : undefined,
      authorId: typeof m.authorId === "string" ? m.authorId : undefined,
      at: typeof m.at === "string" ? m.at : undefined,
      deliveryId:
        typeof m.deliveryId === "number" && Number.isSafeInteger(m.deliveryId)
          ? m.deliveryId
          : undefined,
      deliveryStatus:
        m.deliveryStatus === "pending" ||
        m.deliveryStatus === "sent" ||
        m.deliveryStatus === "delivered" ||
        m.deliveryStatus === "failed"
          ? m.deliveryStatus
          : undefined,
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

type PublicTicketStatus = ReturnType<typeof normalizeSupportTicketStatus>;

// ── GET /api/admin/support-tickets ────────────────────────────────────────────
// Query params: status (new|open|blocked|resolved|all), q (subject/email/user search),
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
      } else if (statusParam === "blocked_on_third_party") {
        conditions.push(
          or(
            eq(supportTicketsTable.status, "blocked_on_third_party"),
            eq(supportTicketsTable.status, "blocked"),
          ),
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
          priority: supportTicketsTable.priority,
          assignedToUserId: supportTicketsTable.assignedToUserId,
          resolutionClass: supportTicketsTable.resolutionClass,
          thirdPartyBlocker: supportTicketsTable.thirdPartyBlocker,
          subject: supportTicketsTable.subject,
          projectId: supportTicketsTable.projectId,
          projectName: projectsTable.name,
          attachmentCount: sql<number>`coalesce(jsonb_array_length(${supportTicketsTable.attachments}), 0)::int`,
          emailStatus: supportTicketsTable.emailStatus,
          resolvedByUserId: supportTicketsTable.resolvedByUserId,
          resolvedByRole: supportTicketsTable.resolvedByRole,
          resolvedAt: supportTicketsTable.resolvedAt,
          ageMinutes: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - ${supportTicketsTable.createdAt})) / 60))::int`,
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

    const statusCounts: Record<PublicTicketStatus, number> = {
      new: 0,
      open: 0,
      waiting_on_user: 0,
      blocked_on_third_party: 0,
      resolved: 0,
    };
    for (const r of statusCountRows) {
      const s = normalizeSupportTicketStatus(r.status);
      statusCounts[s] += Number(r.n);
    }

    res.json({
      tickets: rows.map((r) => ({
        id: r.id,
        ticketNumber: formatSupportTicketNumber(r.id),
        userId: r.userId,
        userEmail: r.userEmail,
        plan: r.plan,
        category: r.category,
        status: normalizeSupportTicketStatus(r.status),
        priority: r.priority,
        assignedToUserId: r.assignedToUserId,
        resolutionClass: r.resolutionClass,
        thirdPartyBlocker: r.thirdPartyBlocker,
        subject: r.subject,
        projectId: r.projectId,
        projectName: r.projectId != null ? (r.projectName ?? "(deleted)") : null,
        attachmentCount: Number(r.attachmentCount ?? 0),
        emailStatus: r.emailStatus,
        resolvedByUserId: r.resolvedByUserId,
        resolvedByRole: r.resolvedByRole,
        resolvedAt: toIso(r.resolvedAt),
        ageMinutes: Number(r.ageMinutes ?? 0),
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
        priority: supportTicketsTable.priority,
        assignedToUserId: supportTicketsTable.assignedToUserId,
        resolutionClass: supportTicketsTable.resolutionClass,
        thirdPartyBlocker: supportTicketsTable.thirdPartyBlocker,
        resolutionEvidence: supportTicketsTable.resolutionEvidence,
        subject: supportTicketsTable.subject,
        transcript: supportTicketsTable.transcript,
        projectId: supportTicketsTable.projectId,
        projectName: projectsTable.name,
        attachments: supportTicketsTable.attachments,
        deviceInfo: supportTicketsTable.deviceInfo,
        supportEmailUsed: supportTicketsTable.supportEmailUsed,
        emailStatus: supportTicketsTable.emailStatus,
        resolvedByUserId: supportTicketsTable.resolvedByUserId,
        resolvedByRole: supportTicketsTable.resolvedByRole,
        resolvedAt: supportTicketsTable.resolvedAt,
        ageMinutes: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - ${supportTicketsTable.createdAt})) / 60))::int`,
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

    await recordTicketReceipt(req, "support_ticket_viewed", row.userId);

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
      ticketNumber: formatSupportTicketNumber(row.id),
      userId: row.userId,
      userEmail: row.userEmail,
      plan: row.plan,
      category: row.category,
      status: normalizeSupportTicketStatus(row.status),
      priority: row.priority,
      assignedToUserId: row.assignedToUserId,
      resolutionClass: row.resolutionClass,
      thirdPartyBlocker: row.thirdPartyBlocker,
      resolutionEvidence: row.resolutionEvidence,
      subject: row.subject,
      transcript: asTranscript(row.transcript),
      projectId: row.projectId,
      projectName: row.projectId != null ? (row.projectName ?? "(deleted)") : null,
      attachments,
      deviceInfo: (row.deviceInfo as Record<string, unknown> | null) ?? null,
      supportEmailUsed: row.supportEmailUsed,
      emailStatus: row.emailStatus,
      resolvedByUserId: row.resolvedByUserId,
      resolvedByRole: row.resolvedByRole,
      resolvedAt: toIso(row.resolvedAt),
      ageMinutes: Number(row.ageMinutes ?? 0),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to load support ticket");
    res.status(500).json({ error: "Failed to load support ticket" });
  }
});

// ── PATCH /api/admin/support-tickets/:id ──────────────────────────────────────
// Body may update the non-terminal workflow status, priority and/or assignee.
// Resolution is evidence-gated and uses class-specific operations.
router.patch("/admin/support-tickets/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }
  const input = (req.body ?? {}) as {
    status?: unknown;
    priority?: unknown;
    assigneeUserId?: unknown;
  };
  const hasStatus = input.status !== undefined;
  const hasPriority = input.priority !== undefined;
  const hasAssignee = Object.prototype.hasOwnProperty.call(input, "assigneeUserId");
  if (!hasStatus && !hasPriority && !hasAssignee) {
    res.status(400).json({ error: "Choose a status, priority or assignee to update." });
    return;
  }
  if (
    hasStatus &&
    input.status !== "new" &&
    input.status !== "open" &&
    input.status !== "waiting_on_user"
  ) {
    res.status(409).json({
      error: "Blocked and resolved states require their evidence-bearing support action.",
      code: "support_resolution_proof_required",
    });
    return;
  }
  if (hasPriority && !isSupportTicketPriority(input.priority)) {
    res.status(400).json({ error: "Choose low, normal, high or urgent priority." });
    return;
  }
  const assigneeUserId =
    input.assigneeUserId === null
      ? null
      : typeof input.assigneeUserId === "string" && input.assigneeUserId.length <= 256
        ? input.assigneeUserId.trim()
        : undefined;
  if (hasAssignee && assigneeUserId === undefined) {
    res.status(400).json({ error: "Choose a valid staff assignee or leave it unassigned." });
    return;
  }
  try {
    if (assigneeUserId) {
      const [assignee] = await db
        .select({ role: userRolesTable.role })
        .from(userRolesTable)
        .where(eq(userRolesTable.userId, assigneeUserId));
      if (
        !assignee ||
        !(SUPPORT_TICKET_RESOLVER_ROLES as readonly string[]).includes(assignee.role)
      ) {
        res.status(409).json({
          error: "Choose an active Owner, Operator or Support staff member.",
          code: "support_assignee_not_eligible",
        });
        return;
      }
      const identity = await getSharedAccountProfile(assigneeUserId);
      if (!identity?.displayName) {
        res.status(409).json({
          error: "That staff member needs a display name before tickets can be assigned to them.",
          code: "support_assignee_identity_required",
        });
        return;
      }
    }
    const changes: {
      status?: "new" | "open" | "waiting_on_user";
      priority?: "low" | "normal" | "high" | "urgent";
      assignedToUserId?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (hasStatus) changes.status = input.status as typeof changes.status;
    if (hasPriority) changes.priority = input.priority as typeof changes.priority;
    if (hasAssignee) changes.assignedToUserId = assigneeUserId ?? null;
    const [row] = await db
      .update(supportTicketsTable)
      .set(changes)
      .where(eq(supportTicketsTable.id, id))
      .returning({
        id: supportTicketsTable.id,
        status: supportTicketsTable.status,
        priority: supportTicketsTable.priority,
        assignedToUserId: supportTicketsTable.assignedToUserId,
        userId: supportTicketsTable.userId,
      });
    if (!row) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }
    await recordTicketReceipt(req, "support_ticket_workflow_updated", row.userId);
    res.json({
      ok: true,
      id: row.id,
      ticketNumber: formatSupportTicketNumber(row.id),
      status: normalizeSupportTicketStatus(row.status),
      priority: row.priority,
      assignedToUserId: row.assignedToUserId,
    });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to update ticket status");
    res.status(500).json({ error: "Failed to update ticket" });
  }
});

router.get("/admin/support-assignees", async (_req, res): Promise<void> => {
  try {
    const rows = await db
      .select({ userId: userRolesTable.userId, role: userRolesTable.role })
      .from(userRolesTable)
      .where(inArray(userRolesTable.role, [...SUPPORT_TICKET_RESOLVER_ROLES]))
      .orderBy(userRolesTable.userId)
      .limit(100);
    const assignees = await Promise.all(
      rows.map(async (row) => {
        const profile = await getSharedAccountProfile(row.userId);
        return {
          userId: row.userId,
          role: row.role as StaffRole,
          displayName: profile?.displayName ?? null,
          imageUrl: profile?.imageUrl ?? null,
          assignable: Boolean(profile?.displayName),
        };
      }),
    );
    res.json(ListAdminSupportAssigneesResponse.parse({ assignees }));
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to list support assignees");
    res.status(500).json({ error: "Failed to load support assignees" });
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
        userId: supportTicketsTable.userId,
        projectId: supportTicketsTable.projectId,
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
    const delivery = await deliverSupportConsequence({
      ticketId: id,
      projectId: row.projectId,
      recipientUserId: row.userId,
      recipientEmail: row.userEmail,
      actorUserId: req.userId!,
      kind: "ticket_reply",
      notification: {
        type: "support_ticket_reply",
        title: `NabuFlow Support replied to ticket ${formatSupportTicketNumber(id)}`,
        body,
      },
      email: tpl,
    });

    // Record the staff reply in the transcript and move a "new" ticket to "open"
    // so the inbox reflects that it is being worked.
    const transcript = asTranscript(row.transcript);
    transcript.push({
      role: "assistant",
      content: body,
      staffReply: true,
      at: new Date().toISOString(),
      deliveryId: delivery.id,
      deliveryStatus: delivery.emailStatus,
    });
    const nextStatus =
      normalizeSupportTicketStatus(row.status) === "new"
        ? "open"
        : normalizeSupportTicketStatus(row.status);

    await db
      .update(supportTicketsTable)
      .set({ transcript, status: nextStatus, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, id));

    await recordTicketReceipt(req, "support_ticket_replied", row.userId);

    res.json({
      ok: true,
      emailStatus: delivery.emailStatus,
      delivery,
      status: nextStatus,
    });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to send support reply");
    res.status(500).json({ error: "Failed to send reply" });
  }
});

// ── POST /api/admin/support-tickets/:id/note ──────────────────────────────────
// Body: { note: string }. Records an internal, staff-only note in the ticket
// transcript with `internalNote: true`. Unlike /reply, this NEVER sends an email
// and is only ever surfaced through the admin-gated detail endpoint, so the
// requester can never see it. Adding a note does not change ticket status.
router.post("/admin/support-tickets/:id/note", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }
  const note = (req.body as { note?: string })?.note;
  if (typeof note !== "string" || !note.trim()) {
    res.status(400).json({ error: "note is required" });
    return;
  }
  const body = note.trim().slice(0, 8000);

  try {
    const [row] = await db
      .select({
        id: supportTicketsTable.id,
        userId: supportTicketsTable.userId,
        transcript: supportTicketsTable.transcript,
      })
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    const authorId = req.userId ?? undefined;
    const message: TranscriptMessage = {
      role: "assistant",
      content: body,
      internalNote: true,
      authorId,
      at: new Date().toISOString(),
    };

    const transcript = asTranscript(row.transcript);
    transcript.push(message);

    await db
      .update(supportTicketsTable)
      .set({ transcript, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, id));

    await recordTicketReceipt(req, "support_ticket_note_added", row.userId);

    res.json({ ok: true, message });
  } catch (err) {
    logger.error({ component: "admin-support", err }, "Failed to add support note");
    res.status(500).json({ error: "Failed to add note" });
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
      .select({
        attachments: supportTicketsTable.attachments,
        userId: supportTicketsTable.userId,
      })
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

    await recordTicketReceipt(req, "support_ticket_attachment_viewed", ticket.userId);

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

// ── POST /api/admin/email/test ─────────────────────────────────────────────────
// Sends a one-line diagnostic email to SUPPORT_EMAIL so admins can confirm
// Resend delivery without creating a real support ticket.
// Returns: { ok, emailStatus, recipient } — never throws.
router.post("/admin/email/test", async (req, res): Promise<void> => {
  const recipient = resolveSupportRecipient();
  const smtpFrom = resolveDefaultSender("SMTP_FROM");

  if (!process.env.RESEND_API_KEY) {
    res.status(503).json({
      ok: false,
      emailStatus: "skipped",
      recipient: null,
      error: "RESEND_API_KEY is not configured. Set it in environment secrets and redeploy.",
    });
    return;
  }
  const now = new Date().toUTCString();
  const emailStatus = await sendEmailWithStatus({
    to: recipient,
    subject: `[MustaFlow] Test email — ${now}`,
    html: `<p style="font-family:sans-serif">This is a delivery test from the MustaFlow admin panel.</p><p style="font-family:sans-serif;color:#666;font-size:12px">Sent at: ${now}<br>From: ${smtpFrom}<br>To: ${recipient}</p>`,
    text: `MustaFlow admin email delivery test.\n\nSent at: ${now}\nFrom: ${smtpFrom}\nTo: ${recipient}`,
  });

  logger.info({ component: "admin-email-test", emailStatus, recipient }, "Admin test email result");

  res.json({ ok: emailStatus === "sent", emailStatus, recipient });
});

export default router;
