import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  projectsTable,
  supportAccessGrantsTable,
  supportGrantEventsTable,
  supportTicketsTable,
} from "@workspace/db";
import { requireAdmin, writeAdminReceipt } from "../lib/adminAuth";
import { resolveStaffPrincipal } from "../lib/adminAuth";
import { getSharedAccountProfile } from "../lib/clerk-users";
import { supportAccessRequestTemplate } from "../lib/emailTemplates";
import {
  effectiveSupportGrantStatus,
  MAX_SUPPORT_GRANT_MS,
  presentSupportGrants,
  recordSupportGrantEvent,
} from "../lib/support-access";
import { withActiveProjectLifecycle } from "../lib/project-lifecycle";
import { deliverSupportConsequence, supportProductUrl } from "../lib/support-user-delivery";

const router: IRouter = Router();

const requestSchema = z
  .object({
    reason: z.string().trim().min(8).max(500),
    staffUserId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

router.post(
  "/admin/support-tickets/:id/access-request",
  requireAdmin,
  async (req, res): Promise<void> => {
    const ticketId = Number(req.params.id);
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0 || !parsed.success) {
      res.status(400).json({ error: "Choose a ticket and explain why access is needed." });
      return;
    }
    const requestedStaffId = parsed.data.staffUserId ?? req.userId!;
    if (requestedStaffId !== req.userId && req.staffPrincipal?.role !== "owner") {
      res.status(403).json({ error: "Only an Owner can request access for another staff member." });
      return;
    }
    const [requestedPrincipal, requestedIdentity] = await Promise.all([
      resolveStaffPrincipal(requestedStaffId),
      getSharedAccountProfile(requestedStaffId),
    ]);
    if (
      !requestedPrincipal ||
      !["owner", "operator", "support"].includes(requestedPrincipal.role)
    ) {
      res.status(403).json({
        error: "That staff account is not allowed to enter user projects.",
        code: "support_staff_role_required",
      });
      return;
    }
    if (!requestedIdentity?.displayName || !requestedIdentity.imageUrl) {
      res.status(409).json({
        error: "That staff account needs a name and picture before requesting project access.",
        code: "support_staff_identity_required",
      });
      return;
    }
    const staffDisplayName = requestedIdentity.displayName;
    const staffImageUrl = requestedIdentity.imageUrl;
    const [ticket] = await db
      .select({
        id: supportTicketsTable.id,
        userId: supportTicketsTable.userId,
        userEmail: supportTicketsTable.userEmail,
        projectId: supportTicketsTable.projectId,
        projectName: projectsTable.name,
        projectOwnerId: projectsTable.ownerId,
      })
      .from(supportTicketsTable)
      .leftJoin(projectsTable, eq(projectsTable.id, supportTicketsTable.projectId))
      .where(and(eq(supportTicketsTable.id, ticketId), isNull(projectsTable.deletedAt)));
    if (!ticket || !ticket.projectId || !ticket.userId || ticket.userId !== ticket.projectOwnerId) {
      res.status(409).json({
        error: "This ticket is not linked to a project owned by the requester.",
        code: "support_project_not_consentable",
      });
      return;
    }
    const projectId = ticket.projectId;
    const ownerUserId = ticket.userId;
    const projectName = ticket.projectName ?? `Project #${projectId}`;
    try {
      const lifecycle = await withActiveProjectLifecycle(projectId, async () => {
        const now = new Date();
        const expiredOpenGrants = await db
          .update(supportAccessGrantsTable)
          .set({ status: "expired", closedAt: now })
          .where(
            and(
              eq(supportAccessGrantsTable.ticketId, ticketId),
              inArray(supportAccessGrantsTable.status, ["pending", "active"]),
              lte(supportAccessGrantsTable.expiresAt, now),
            ),
          )
          .returning();
        for (const expiredGrant of expiredOpenGrants) {
          await recordSupportGrantEvent({
            grantId: expiredGrant.id,
            ticketId,
            projectId: expiredGrant.projectId,
            actorUserId: req.userId!,
            event: "grant_expired_before_new_request",
            detail: { expiredAt: now.toISOString() },
          });
        }
        const requestExpiresAt = new Date(Date.now() + MAX_SUPPORT_GRANT_MS);
        const [grant] = await db
          .insert(supportAccessGrantsTable)
          .values({
            ticketId,
            projectId,
            ownerUserId,
            staffUserId: requestedStaffId,
            requestedBy: req.userId!,
            reason: parsed.data.reason,
            status: "pending",
            expiresAt: requestExpiresAt,
          })
          .returning();
        await recordSupportGrantEvent({
          grantId: grant!.id,
          ticketId,
          projectId,
          actorUserId: req.userId!,
          event: "access_requested",
          detail: {
            reason: parsed.data.reason,
            staffUserId: requestedStaffId,
            staffDisplayName,
            staffImageUrl,
            requestExpiresAt: requestExpiresAt.toISOString(),
          },
        });
        const email = supportAccessRequestTemplate({
          ticketId,
          projectName,
          staffName: staffDisplayName,
          reason: parsed.data.reason,
          requestExpiresAt,
          decisionUrl: supportProductUrl(`/support/tickets/${ticketId}`),
        });
        const delivery = await deliverSupportConsequence({
          ticketId,
          projectId,
          recipientUserId: ownerUserId,
          recipientEmail: ticket.userEmail,
          actorUserId: req.userId!,
          actorName: staffDisplayName,
          kind: "access_request",
          notification: {
            type: "support_access_requested",
            title: `${staffDisplayName} is requesting project access`,
            body: `${projectName}: ${parsed.data.reason}`,
            metadata: { requestExpiresAt: requestExpiresAt.toISOString(), grantId: grant!.id },
          },
          email,
        });
        return { grant, delivery };
      });
      if (lifecycle.state === "inactive") {
        res.status(409).json({
          error: "This ticket is not linked to an active project owned by the requester.",
          code: "support_project_not_consentable",
        });
        return;
      }
      res.status(201).json(lifecycle.value);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "23505") {
        res.status(409).json({ error: "This ticket already has an open access request." });
        return;
      }
      throw error;
    }
  },
);

router.get("/support/access-requests", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(supportAccessGrantsTable)
    .where(eq(supportAccessGrantsTable.ownerUserId, req.userId!))
    .orderBy(desc(supportAccessGrantsTable.requestedAt))
    .limit(100);
  const now = new Date();
  res.json({
    grants: rows.map((row) => ({ ...row, status: effectiveSupportGrantStatus(row, now) })),
  });
});

router.get("/support/projects/:id/access-history", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    res.status(400).json({ error: "Choose a valid project." });
    return;
  }
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, projectId),
        eq(projectsTable.ownerId, req.userId!),
        isNull(projectsTable.deletedAt),
      ),
    )
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const grants = await db
    .select()
    .from(supportAccessGrantsTable)
    .where(
      and(
        eq(supportAccessGrantsTable.projectId, projectId),
        eq(supportAccessGrantsTable.ownerUserId, req.userId!),
      ),
    )
    .orderBy(desc(supportAccessGrantsTable.requestedAt))
    .limit(50);
  const events =
    grants.length === 0
      ? []
      : await db
          .select()
          .from(supportGrantEventsTable)
          .where(
            inArray(
              supportGrantEventsTable.grantId,
              grants.map((grant) => grant.id),
            ),
          )
          .orderBy(desc(supportGrantEventsTable.createdAt))
          .limit(500);
  const staffProfiles = Object.fromEntries(
    await Promise.all(
      [...new Set(grants.map((grant) => grant.staffUserId))].map(async (staffUserId) => {
        const profile = await getSharedAccountProfile(staffUserId);
        return [
          staffUserId,
          profile
            ? { displayName: profile.displayName, imageUrl: profile.imageUrl }
            : { displayName: null, imageUrl: null },
        ];
      }),
    ),
  );
  res.json({ grants: presentSupportGrants(grants), events, staffProfiles });
});

const decisionSchema = z
  .object({
    decision: z.enum(["grant", "decline"]),
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
  })
  .strict();

router.post("/support/access-requests/:id/decision", async (req, res): Promise<void> => {
  const grantId = Number(req.params.id);
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!Number.isSafeInteger(grantId) || grantId <= 0 || !parsed.success) {
    res.status(400).json({ error: "Choose grant or decline." });
    return;
  }
  const [grant] = await db
    .select()
    .from(supportAccessGrantsTable)
    .where(
      and(
        eq(supportAccessGrantsTable.id, grantId),
        eq(supportAccessGrantsTable.ownerUserId, req.userId!),
      ),
    );
  if (!grant || grant.status !== "pending") {
    res.status(404).json({ error: "Access request not found." });
    return;
  }
  const lifecycle = await withActiveProjectLifecycle(grant.projectId, async () => {
    const [currentGrant] = await db
      .select()
      .from(supportAccessGrantsTable)
      .where(
        and(
          eq(supportAccessGrantsTable.id, grantId),
          eq(supportAccessGrantsTable.ownerUserId, req.userId!),
          eq(supportAccessGrantsTable.status, "pending"),
        ),
      );
    if (!currentGrant) return { state: "not_found" as const };

    const now = new Date();
    if (effectiveSupportGrantStatus(currentGrant, now) === "expired") {
      return { state: "expired" as const };
    }
    const expiresAt =
      parsed.data.decision === "grant"
        ? new Date(
            now.getTime() +
              Math.min((parsed.data.durationMinutes ?? 60) * 60_000, MAX_SUPPORT_GRANT_MS),
          )
        : null;
    const status = parsed.data.decision === "grant" ? "active" : "declined";
    const [updated] = await db
      .update(supportAccessGrantsTable)
      .set({ status, decidedAt: now, expiresAt })
      .where(
        and(
          eq(supportAccessGrantsTable.id, grantId),
          eq(supportAccessGrantsTable.status, "pending"),
        ),
      )
      .returning();
    if (!updated) return { state: "already_decided" as const };
    await recordSupportGrantEvent({
      grantId,
      ticketId: updated.ticketId,
      projectId: updated.projectId,
      actorUserId: req.userId!,
      event: status === "active" ? "access_granted" : "access_declined",
      detail: expiresAt ? { expiresAt: expiresAt.toISOString() } : {},
    });
    return { state: "updated" as const, grant: updated };
  });
  if (lifecycle.state === "inactive" || lifecycle.value.state === "not_found") {
    res.status(404).json({ error: "Access request not found." });
    return;
  }
  if (lifecycle.value.state === "expired") {
    res.status(410).json({ error: "This access request has expired. Nothing was granted." });
    return;
  }
  if (lifecycle.value.state === "already_decided") {
    res.status(409).json({ error: "This request was already decided." });
    return;
  }
  res.json({ grant: lifecycle.value.grant });
});

router.post("/support/access-grants/:id/revoke", async (req, res): Promise<void> => {
  const grantId = Number(req.params.id);
  if (!Number.isSafeInteger(grantId) || grantId <= 0) {
    res.status(400).json({ error: "Invalid access grant." });
    return;
  }
  const [updated] = await db
    .update(supportAccessGrantsTable)
    .set({ status: "revoked", revokedAt: new Date(), closedAt: new Date() })
    .where(
      and(
        eq(supportAccessGrantsTable.id, grantId),
        eq(supportAccessGrantsTable.ownerUserId, req.userId!),
        eq(supportAccessGrantsTable.status, "active"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Active access grant not found." });
    return;
  }
  await recordSupportGrantEvent({
    grantId,
    ticketId: updated.ticketId,
    projectId: updated.projectId,
    actorUserId: req.userId!,
    event: "access_revoked",
  });
  res.json({ ok: true });
});

router.get("/support/access-grants/:id/receipt", async (req, res): Promise<void> => {
  const grantId = Number(req.params.id);
  const [grant] = await db
    .select()
    .from(supportAccessGrantsTable)
    .where(
      and(
        eq(supportAccessGrantsTable.id, grantId),
        eq(supportAccessGrantsTable.ownerUserId, req.userId!),
      ),
    );
  if (!grant) {
    res.status(404).json({ error: "Access receipt not found." });
    return;
  }
  const events = await db
    .select()
    .from(supportGrantEventsTable)
    .where(eq(supportGrantEventsTable.grantId, grantId))
    .orderBy(supportGrantEventsTable.createdAt);
  res.json({ grant: { ...grant, status: effectiveSupportGrantStatus(grant) }, events });
});

router.post("/admin/support-grants/:id/close", requireAdmin, async (req, res): Promise<void> => {
  const grantId = Number(req.params.id);
  const [updated] = await db
    .update(supportAccessGrantsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(
      and(
        eq(supportAccessGrantsTable.id, grantId),
        eq(supportAccessGrantsTable.staffUserId, req.userId!),
        eq(supportAccessGrantsTable.status, "active"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Active access grant not found." });
    return;
  }
  await recordSupportGrantEvent({
    grantId,
    ticketId: updated.ticketId,
    projectId: updated.projectId,
    actorUserId: req.userId!,
    event: "access_closed",
  });
  await writeAdminReceipt({
    actorUserId: req.userId!,
    actorRole: req.staffPrincipal!.role,
    kind: "action",
    action: "support_access_closed",
    targetUserId: updated.ownerUserId,
    outcome: "completed",
    requestMethod: req.method,
    requestPath: req.path,
  });
  res.json({ ok: true });
});

export default router;
