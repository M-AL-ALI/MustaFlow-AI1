import { createHash } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { parseZeroTerminalV1 } from "@workspace/ora-contracts";
import {
  agentTasksTable,
  db,
  notificationsTable,
  platformDefectsTable,
  previewSnapshotsTable,
  projectsTable,
  projectVersionsTable,
  supportAccessGrantsTable,
  supportGrantEventsTable,
  supportTicketDefectLinksTable,
  supportTicketsTable,
  supportUserDeliveriesTable,
  supportZeroSessionsTable,
} from "@workspace/db";
import { requireAdmin, writeAdminReceipt } from "../lib/adminAuth";
import { nabuflowGateHttpError } from "../lib/nabuflow-billing";
import {
  findLiveSupportGrant,
  presentSupportGrants,
  recordSupportGrantEvent,
} from "../lib/support-access";
import { getServedBuildIdentity } from "../lib/build-info";
import { supportClassificationTemplate } from "../lib/emailTemplates";
import { deliverSupportConsequence, supportProductUrl } from "../lib/support-user-delivery";

const router: IRouter = Router();

const triageSchema = z.discriminatedUnion("resolutionClass", [
  z.object({ resolutionClass: z.literal("project") }).strict(),
  z
    .object({
      resolutionClass: z.literal("platform"),
      defectTitle: z.string().trim().min(8).max(180),
      fingerprintKey: z.string().trim().min(3).max(240),
    })
    .strict(),
  z
    .object({
      resolutionClass: z.literal("external"),
      blocker: z.string().trim().min(2).max(120),
      guidance: z.string().trim().min(8).max(1_500),
    })
    .strict(),
]);

function normalizedFingerprint(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

export function safeInternalProbePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("#")) return null;
  try {
    const parsed = new URL(trimmed, "http://nabuflow.internal");
    if (parsed.origin !== "http://nabuflow.internal") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function proveCurrentNabuFlowRoute(
  req: Request,
  route: string,
): Promise<{
  route: string;
  status: number;
  observedAt: string;
  durationMs: number;
} | null> {
  const port = Number(process.env.PORT);
  const path = safeInternalProbePath(route);
  if (!path || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const headers: Record<string, string> = {};
  const cookie = req.get("cookie");
  const authorization = req.get("authorization");
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (response.status < 200 || response.status > 299) return null;
    return {
      route: path,
      status: response.status,
      observedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return null;
  }
}

function boundedObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedTranscript(value: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((entry) => {
    const row = boundedObject(entry);
    if (typeof row.content !== "string") return [];
    return [
      {
        role: typeof row.role === "string" ? row.role.slice(0, 40) : "user",
        content: row.content.slice(0, 20_000),
      },
    ];
  });
}

function supportInstruction(input: {
  ticketId: number;
  subject: string;
  failingPath: string | null;
  evidenceBundle: Record<string, unknown>;
}): string | null {
  const evidence = JSON.stringify(input.evidenceBundle);
  const instruction = [
    `Resolve support ticket #${input.ticketId} in this project.`,
    `The user's report is: ${input.subject}`,
    input.failingPath ? `The reported path is ${input.failingPath}.` : null,
    "The complete support evidence follows as structured JSON. Preserve the user's words exactly; diagnose from the receipts and attached screenshots rather than asking staff to retype them.",
    evidence,
    "Diagnose the project and prepare one precise project-level plan. Do not write, delete, move, publish, or otherwise mutate project state.",
  ]
    .filter(Boolean)
    .join("\n");
  return instruction.length <= 60_000 ? instruction : null;
}

async function readTicket(ticketId: number) {
  const [ticket] = await db
    .select({
      id: supportTicketsTable.id,
      userId: supportTicketsTable.userId,
      userEmail: supportTicketsTable.userEmail,
      subject: supportTicketsTable.subject,
      category: supportTicketsTable.category,
      status: supportTicketsTable.status,
      resolutionClass: supportTicketsTable.resolutionClass,
      thirdPartyBlocker: supportTicketsTable.thirdPartyBlocker,
      resolutionEvidence: supportTicketsTable.resolutionEvidence,
      transcript: supportTicketsTable.transcript,
      attachments: supportTicketsTable.attachments,
      deviceInfo: supportTicketsTable.deviceInfo,
      projectId: supportTicketsTable.projectId,
      projectName: projectsTable.name,
      projectOwnerId: projectsTable.ownerId,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      createdAt: supportTicketsTable.createdAt,
    })
    .from(supportTicketsTable)
    .leftJoin(projectsTable, eq(projectsTable.id, supportTicketsTable.projectId))
    .where(eq(supportTicketsTable.id, ticketId))
    .limit(1);
  return ticket ?? null;
}

async function writeOutcomeReceipt(
  req: Request,
  action: string,
  targetUserId: string,
): Promise<void> {
  await writeAdminReceipt({
    actorUserId: req.userId!,
    actorRole: req.staffPrincipal!.role,
    kind: "action",
    action,
    targetUserId,
    outcome: "completed",
    requestMethod: req.method,
    requestPath: req.path,
  });
}

async function readGrantEvents(ticketId: number) {
  return db
    .select()
    .from(supportGrantEventsTable)
    .where(eq(supportGrantEventsTable.ticketId, ticketId))
    .orderBy(supportGrantEventsTable.createdAt)
    .limit(500);
}

async function readDefectImpact(defectIds: number[]) {
  if (defectIds.length === 0) return [];
  const rows = await db
    .select({
      defectId: supportTicketDefectLinksTable.defectId,
      ticketId: supportTicketsTable.id,
      userId: supportTicketsTable.userId,
      userEmail: supportTicketsTable.userEmail,
    })
    .from(supportTicketDefectLinksTable)
    .innerJoin(
      supportTicketsTable,
      eq(supportTicketsTable.id, supportTicketDefectLinksTable.ticketId),
    )
    .where(inArray(supportTicketDefectLinksTable.defectId, defectIds))
    .limit(1_000);
  return defectIds.map((defectId) => {
    const linked = rows.filter((row) => row.defectId === defectId);
    const accounts = [
      ...new Map(
        linked.map((row) => [row.userId, row.userEmail?.trim() || row.userId] as const),
      ).values(),
    ];
    return {
      defectId,
      affectedAccountCount: accounts.length,
      affectedAccounts: accounts,
      linkedTicketCount: linked.length,
    };
  });
}

router.get(
  "/admin/support-tickets/:id/operations",
  requireAdmin,
  async (req, res): Promise<void> => {
    const ticketId = Number(req.params.id);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
      res.status(400).json({ error: "Choose a valid support ticket." });
      return;
    }
    const ticket = await readTicket(ticketId);
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    const [grants, sessions, links, grantEvents, deliveries] = await Promise.all([
      db
        .select()
        .from(supportAccessGrantsTable)
        .where(eq(supportAccessGrantsTable.ticketId, ticketId))
        .orderBy(desc(supportAccessGrantsTable.requestedAt))
        .limit(20),
      db
        .select()
        .from(supportZeroSessionsTable)
        .where(eq(supportZeroSessionsTable.ticketId, ticketId))
        .orderBy(desc(supportZeroSessionsTable.createdAt))
        .limit(20),
      db
        .select({ defect: platformDefectsTable })
        .from(supportTicketDefectLinksTable)
        .innerJoin(
          platformDefectsTable,
          eq(platformDefectsTable.id, supportTicketDefectLinksTable.defectId),
        )
        .where(eq(supportTicketDefectLinksTable.ticketId, ticketId)),
      readGrantEvents(ticketId),
      db
        .select()
        .from(supportUserDeliveriesTable)
        .where(eq(supportUserDeliveriesTable.ticketId, ticketId))
        .orderBy(desc(supportUserDeliveriesTable.createdAt))
        .limit(100),
    ]);
    const defects = links.map((row) => row.defect);
    const defectImpact = await readDefectImpact(defects.map((defect) => defect.id));
    res.json({
      ticket,
      grants: presentSupportGrants(grants),
      grantEvents,
      sessions,
      defects,
      defectImpact,
      deliveries,
    });
  },
);

router.get("/support/tickets/:id/operations", async (req, res): Promise<void> => {
  const ticketId = Number(req.params.id);
  if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
    res.status(400).json({ error: "Choose a valid support ticket." });
    return;
  }
  const ticket = await readTicket(ticketId);
  if (!ticket || ticket.userId !== req.userId) {
    res.status(404).json({ error: "Support ticket not found." });
    return;
  }
  const [grants, sessions, defects, grantEvents, deliveries] = await Promise.all([
    db
      .select()
      .from(supportAccessGrantsTable)
      .where(eq(supportAccessGrantsTable.ticketId, ticketId))
      .orderBy(desc(supportAccessGrantsTable.requestedAt))
      .limit(20),
    db
      .select()
      .from(supportZeroSessionsTable)
      .where(eq(supportZeroSessionsTable.ticketId, ticketId))
      .orderBy(desc(supportZeroSessionsTable.createdAt))
      .limit(20),
    db
      .select({ defect: platformDefectsTable })
      .from(supportTicketDefectLinksTable)
      .innerJoin(
        platformDefectsTable,
        eq(platformDefectsTable.id, supportTicketDefectLinksTable.defectId),
      )
      .where(eq(supportTicketDefectLinksTable.ticketId, ticketId)),
    readGrantEvents(ticketId),
    db
      .select()
      .from(supportUserDeliveriesTable)
      .where(eq(supportUserDeliveriesTable.ticketId, ticketId))
      .orderBy(desc(supportUserDeliveriesTable.createdAt))
      .limit(100),
  ]);
  res.json({
    ticket,
    grants: presentSupportGrants(grants),
    grantEvents,
    sessions,
    defects: defects.map((row) => row.defect),
    deliveries,
  });
});

router.post("/admin/support-tickets/:id/triage", requireAdmin, async (req, res): Promise<void> => {
  const ticketId = Number(req.params.id);
  const parsed = triageSchema.safeParse(req.body ?? {});
  if (!Number.isSafeInteger(ticketId) || ticketId < 1 || !parsed.success) {
    res.status(400).json({ error: "Choose one outcome and complete its required details." });
    return;
  }
  const ticket = await readTicket(ticketId);
  if (!ticket) {
    res.status(404).json({ error: "Ticket not found." });
    return;
  }

  let platformImpact:
    | { affectedAccountCount: number; affectedAccounts: string[]; linkedTicketCount: number }
    | undefined;
  if (parsed.data.resolutionClass === "project") {
    if (!ticket.projectId || !ticket.projectOwnerId) {
      res.status(409).json({
        error: "A project-level ticket must name an active project.",
        code: "support_project_required",
      });
      return;
    }
    await db
      .update(supportTicketsTable)
      .set({
        resolutionClass: "project",
        status: "open",
        thirdPartyBlocker: null,
        resolutionEvidence: { classifiedBy: req.userId!, classifiedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(supportTicketsTable.id, ticketId));
  } else if (parsed.data.resolutionClass === "external") {
    await db
      .update(supportTicketsTable)
      .set({
        resolutionClass: "external",
        status: "blocked",
        thirdPartyBlocker: parsed.data.blocker,
        resolutionEvidence: {
          classifiedBy: req.userId!,
          classifiedAt: new Date().toISOString(),
          guidance: parsed.data.guidance,
        },
        updatedAt: new Date(),
      })
      .where(eq(supportTicketsTable.id, ticketId));
  } else {
    const fingerprint = normalizedFingerprint(parsed.data.fingerprintKey);
    const [defect] = await db
      .insert(platformDefectsTable)
      .values({
        fingerprint,
        title: parsed.data.defectTitle,
        createdBy: req.userId!,
        evidence: { fingerprintKey: parsed.data.fingerprintKey },
      })
      .onConflictDoUpdate({
        target: platformDefectsTable.fingerprint,
        set: { updatedAt: new Date() },
      })
      .returning();
    await db
      .insert(supportTicketDefectLinksTable)
      .values({ ticketId, defectId: defect!.id, linkedBy: req.userId! })
      .onConflictDoNothing();
    const affected = await db
      .select({
        ticketId: supportTicketsTable.id,
        userId: supportTicketsTable.userId,
        userEmail: supportTicketsTable.userEmail,
      })
      .from(supportTicketDefectLinksTable)
      .innerJoin(
        supportTicketsTable,
        eq(supportTicketsTable.id, supportTicketDefectLinksTable.ticketId),
      )
      .where(eq(supportTicketDefectLinksTable.defectId, defect!.id));
    platformImpact = {
      affectedAccountCount: new Set(affected.map((row) => row.userId)).size,
      affectedAccounts: [...new Set(affected.map((row) => row.userEmail || row.userId))],
      linkedTicketCount: affected.length,
    };
    await db
      .update(supportTicketsTable)
      .set({
        resolutionClass: "platform",
        status: "open",
        thirdPartyBlocker: null,
        resolutionEvidence: {
          classifiedBy: req.userId!,
          classifiedAt: new Date().toISOString(),
          defectId: defect!.id,
        },
        updatedAt: new Date(),
      })
      .where(eq(supportTicketsTable.id, ticketId));
  }

  await writeOutcomeReceipt(req, "support_ticket_triaged", ticket.userId);
  const explanation =
    parsed.data.resolutionClass === "project"
      ? `We are investigating this inside ${ticket.projectName ?? "your project"}. Nothing in your project changes without your approval.`
      : parsed.data.resolutionClass === "platform"
        ? "We identified a NabuFlow platform issue. Your ticket is linked to the shared defect and will update automatically when the verified fix ships."
        : `This is waiting on ${parsed.data.blocker}. ${parsed.data.guidance}`;
  const email = supportClassificationTemplate({
    ticketId,
    subject: ticket.subject,
    classification: parsed.data.resolutionClass,
    explanation,
    ticketUrl: supportProductUrl(`/support/tickets/${ticketId}`),
  });
  const delivery = await deliverSupportConsequence({
    ticketId,
    projectId: ticket.projectId,
    recipientUserId: ticket.userId,
    recipientEmail: ticket.userEmail,
    actorUserId: req.userId!,
    kind: parsed.data.resolutionClass === "external" ? "external_guidance" : "ticket_classified",
    notification: {
      type:
        parsed.data.resolutionClass === "external"
          ? "support_blocked_external"
          : "support_ticket_classified",
      title:
        parsed.data.resolutionClass === "project"
          ? "Support is investigating your project"
          : parsed.data.resolutionClass === "platform"
            ? "Your ticket is linked to a NabuFlow platform issue"
            : `Action needed with ${parsed.data.blocker}`,
      body: explanation,
      metadata: { resolutionClass: parsed.data.resolutionClass },
    },
    email,
  });
  res.json({
    ok: true,
    resolutionClass: parsed.data.resolutionClass,
    platformImpact,
    delivery,
  });
});

router.post(
  "/admin/support-tickets/:id/zero/proposals",
  requireAdmin,
  async (req, res): Promise<void> => {
    const ticketId = Number(req.params.id);
    const ticket = Number.isSafeInteger(ticketId) ? await readTicket(ticketId) : null;
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    if (ticket.resolutionClass !== "project" || !ticket.projectId || !ticket.projectOwnerId) {
      res.status(409).json({
        error: "Classify this as a project issue before asking Zero to propose a change.",
        code: "support_project_class_required",
      });
      return;
    }
    if (process.env.NABUFLOW_GLOBAL_PAUSE === "true") {
      res.status(423).json({
        error: "NabuFlow is globally paused. No project change can start.",
        code: "support_global_pause",
      });
      return;
    }
    const grant = await findLiveSupportGrant({
      projectId: ticket.projectId,
      staffUserId: req.userId!,
    });
    if (!grant || grant.ticketId !== ticketId || grant.ownerUserId !== ticket.projectOwnerId) {
      res.status(403).json({
        error: "The user has not granted you live access to this project.",
        code: "support_grant_required",
      });
      return;
    }
    const billingBlock = await nabuflowGateHttpError(ticket.projectOwnerId, {
      engineMode: "eco",
      deepReasoning: false,
      projectedCredits: 1,
      source: "pipeline",
    });
    if (billingBlock) {
      res.status(402).json({
        error: "This account's spend limit currently blocks a Zero change.",
        code: "support_spend_ceiling",
      });
      return;
    }

    const device = boundedObject(ticket.deviceInfo);
    const failingPath =
      typeof device.path === "string"
        ? device.path.slice(0, 500)
        : typeof device.route === "string"
          ? device.route.slice(0, 500)
          : null;
    const tasks = await db
      .select({
        id: agentTasksTable.id,
        status: agentTasksTable.status,
        completionKind: agentTasksTable.completionKind,
        terminal: agentTasksTable.terminal,
        createdAt: agentTasksTable.createdAt,
      })
      .from(agentTasksTable)
      .where(eq(agentTasksTable.projectId, ticket.projectId))
      .orderBy(desc(agentTasksTable.createdAt))
      .limit(20);
    const evidenceBundle = {
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        userWords: boundedTranscript(ticket.transcript),
        attachments: Array.isArray(ticket.attachments) ? ticket.attachments.slice(0, 10) : [],
      },
      project: {
        id: ticket.projectId,
        name: ticket.projectName,
        failingPath,
        servingVersionId: ticket.publishedSnapshotId,
      },
      receipts: tasks,
    };
    const instruction = supportInstruction({
      ticketId: ticket.id,
      subject: ticket.subject,
      failingPath,
      evidenceBundle,
    });
    if (!instruction) {
      res.status(409).json({
        error:
          "This ticket has too much evidence for one safe Zero proposal. Split the issue first.",
        code: "support_evidence_too_large",
      });
      return;
    }
    const [session] = await db
      .insert(supportZeroSessionsTable)
      .values({
        ticketId,
        grantId: grant.id,
        projectId: ticket.projectId,
        staffUserId: req.userId!,
        status: "diagnosing",
        evidenceBundle,
        proposal: {
          diagnosisInstruction: instruction,
          summary: `Zero is preparing a project-level proposal for ticket #${ticket.id}.`,
          requiresOwnerApproval: true,
        },
      })
      .returning();
    await recordSupportGrantEvent({
      grantId: grant.id,
      ticketId,
      projectId: ticket.projectId,
      actorUserId: req.userId!,
      event: "zero_proposal_created",
      detail: { supportSessionId: session!.id },
    });
    await writeOutcomeReceipt(req, "support_zero_proposal_created", ticket.userId);
    res.status(201).json({ session });
  },
);

router.get("/support/zero-sessions/:id", async (req, res): Promise<void> => {
  const sessionId = Number(req.params.id);
  const [row] = await db
    .select({ session: supportZeroSessionsTable, projectOwnerId: projectsTable.ownerId })
    .from(supportZeroSessionsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, supportZeroSessionsTable.projectId))
    .where(
      and(
        eq(supportZeroSessionsTable.id, sessionId),
        eq(projectsTable.ownerId, req.userId!),
        isNull(projectsTable.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Support proposal not found." });
    return;
  }
  res.json({ session: row.session });
});

const proposalDecisionSchema = z.object({ decision: z.enum(["approve", "decline"]) }).strict();

router.post("/support/zero-sessions/:id/decision", async (req, res): Promise<void> => {
  const sessionId = Number(req.params.id);
  const parsed = proposalDecisionSchema.safeParse(req.body ?? {});
  if (!Number.isSafeInteger(sessionId) || sessionId < 1 || !parsed.success) {
    res.status(400).json({ error: "Choose approve or decline." });
    return;
  }
  const [row] = await db
    .select({ session: supportZeroSessionsTable, ownerUserId: projectsTable.ownerId })
    .from(supportZeroSessionsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, supportZeroSessionsTable.projectId))
    .where(
      and(
        eq(supportZeroSessionsTable.id, sessionId),
        eq(projectsTable.ownerId, req.userId!),
        isNull(projectsTable.deletedAt),
      ),
    )
    .limit(1);
  if (!row || row.session.status !== "proposal_ready") {
    res.status(404).json({ error: "Pending support proposal not found." });
    return;
  }
  const grant = await findLiveSupportGrant({
    projectId: row.session.projectId,
    staffUserId: row.session.staffUserId,
  });
  if (!grant || grant.id !== row.session.grantId) {
    res.status(409).json({
      error: "This support access grant has ended. Nothing was changed.",
      code: "support_grant_ended",
    });
    return;
  }
  const now = new Date();
  const status = parsed.data.decision === "approve" ? "approved" : "declined";
  const [updated] = await db
    .update(supportZeroSessionsTable)
    .set({
      status,
      approvedBy: status === "approved" ? req.userId! : null,
      declinedBy: status === "declined" ? req.userId! : null,
      decidedAt: now,
      completedAt: status === "declined" ? now : null,
    })
    .where(
      and(
        eq(supportZeroSessionsTable.id, sessionId),
        eq(supportZeroSessionsTable.status, "proposal_ready"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({ error: "This proposal was already decided." });
    return;
  }
  await recordSupportGrantEvent({
    grantId: grant.id,
    ticketId: updated.ticketId,
    projectId: updated.projectId,
    actorUserId: req.userId!,
    event: status === "approved" ? "zero_proposal_approved" : "zero_proposal_declined",
    detail: { supportSessionId: sessionId },
  });
  res.json({
    session: updated,
    handoff: null,
  });
});

router.post("/admin/support-defects/:id/verify", requireAdmin, async (req, res): Promise<void> => {
  const defectId = Number(req.params.id);
  const parsed = z
    .object({
      shippedVersion: z.string().trim().min(7).max(100),
      liveTree: z.string().regex(/^[0-9a-f]{40}$/u),
      probe: z
        .object({
          route: z.string().trim().min(1).max(500),
        })
        .strict(),
    })
    .strict()
    .safeParse(req.body ?? {});
  if (!Number.isSafeInteger(defectId) || defectId < 1 || !parsed.success) {
    res.status(400).json({
      error: "Name the shipped version and attach its successful live route proof.",
    });
    return;
  }
  const liveIdentity = getServedBuildIdentity();
  if (!("tree" in liveIdentity) || liveIdentity.tree !== parsed.data.liveTree) {
    res.status(409).json({
      error: "The live NabuFlow build does not match that proof. No ticket was resolved.",
      code: "support_live_build_mismatch",
      liveIdentity: "tree" in liveIdentity ? liveIdentity : { identity: "unknown" },
    });
    return;
  }
  const liveProbe = await proveCurrentNabuFlowRoute(req, parsed.data.probe.route);
  if (!liveProbe) {
    res.status(409).json({
      error: "That NabuFlow route did not answer successfully. No ticket was resolved.",
      code: "support_live_route_unproven",
    });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [defect] = await tx
      .update(platformDefectsTable)
      .set({
        status: "verified",
        shippedVersion: parsed.data.shippedVersion,
        shippedAt: new Date(),
        verifiedAt: new Date(),
        evidence: {
          liveTree: parsed.data.liveTree,
          liveProbe,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformDefectsTable.id, defectId),
          inArray(platformDefectsTable.status, ["open", "fixing"]),
        ),
      )
      .returning();
    if (!defect) return null;
    const linked = await tx
      .select({
        ticketId: supportTicketsTable.id,
        userId: supportTicketsTable.userId,
        projectId: supportTicketsTable.projectId,
      })
      .from(supportTicketDefectLinksTable)
      .innerJoin(
        supportTicketsTable,
        eq(supportTicketsTable.id, supportTicketDefectLinksTable.ticketId),
      )
      .where(eq(supportTicketDefectLinksTable.defectId, defectId));
    if (linked.length > 0) {
      await tx
        .update(supportTicketsTable)
        .set({
          status: "resolved",
          resolutionEvidence: {
            defectId,
            shippedVersion: parsed.data.shippedVersion,
            liveTree: parsed.data.liveTree,
            liveProbe,
            resolvedTogether: true,
            resolvedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(
          inArray(
            supportTicketsTable.id,
            linked.map((row) => row.ticketId),
          ),
        );
      await tx.insert(notificationsTable).values(
        linked.map((row) => ({
          recipientId: row.userId,
          type: "support_platform_fix_shipped",
          title: "The NabuFlow issue you reported has been fixed",
          body: "The platform fix is live. Your linked support ticket has been updated automatically.",
          actorId: req.userId!,
          resourceType: "support_ticket",
          resourceId: String(row.ticketId),
          projectId: row.projectId,
          metadata: { defectId, shippedVersion: parsed.data.shippedVersion },
        })),
      );
    }
    return { defect, linked };
  });
  if (!result) {
    res.status(404).json({ error: "Open platform defect not found." });
    return;
  }
  const accountIds = [...new Set(result.linked.map((row) => row.userId))];
  res.json({
    defect: result.defect,
    resolvedTicketCount: result.linked.length,
    affectedAccountCount: accountIds.length,
    affectedAccountIds: accountIds,
    notificationsSent: result.linked.length,
    affectedAccountsNotified: accountIds.length,
  });
});

router.post(
  "/admin/support-tickets/:id/verify-project-resolution",
  requireAdmin,
  async (req, res): Promise<void> => {
    const ticketId = Number(req.params.id);
    const ticket = Number.isSafeInteger(ticketId) ? await readTicket(ticketId) : null;
    if (!ticket || ticket.resolutionClass !== "project" || !ticket.projectId) {
      res.status(409).json({ error: "This is not a project-level ticket." });
      return;
    }
    const [session] = await db
      .select()
      .from(supportZeroSessionsTable)
      .where(
        and(
          eq(supportZeroSessionsTable.ticketId, ticketId),
          eq(supportZeroSessionsTable.status, "applied"),
        ),
      )
      .orderBy(desc(supportZeroSessionsTable.completedAt))
      .limit(1);
    if (!session?.taskId || !session.appliedVersionId) {
      res.status(409).json({
        error: "Zero has not produced a verified project version for this ticket.",
        code: "support_project_proof_required",
      });
      return;
    }
    const [[task], [version], [preview]] = await Promise.all([
      db
        .select()
        .from(agentTasksTable)
        .where(
          and(
            eq(agentTasksTable.id, session.taskId),
            eq(agentTasksTable.projectId, ticket.projectId),
          ),
        )
        .limit(1),
      db
        .select()
        .from(projectVersionsTable)
        .where(
          and(
            eq(projectVersionsTable.id, session.appliedVersionId),
            eq(projectVersionsTable.projectId, ticket.projectId),
          ),
        )
        .limit(1),
      db
        .select()
        .from(previewSnapshotsTable)
        .where(
          and(
            eq(previewSnapshotsTable.taskId, session.taskId),
            eq(previewSnapshotsTable.projectId, ticket.projectId),
            eq(previewSnapshotsTable.versionId, session.appliedVersionId),
            gt(previewSnapshotsTable.expiresAt, new Date()),
          ),
        )
        .limit(1),
    ]);
    const terminal = parseZeroTerminalV1(task?.terminal);
    const mutationTerminal =
      terminal !== "UNKNOWN" &&
      (terminal.outcome === "mutation_succeeded" || terminal.outcome === "changed_with_issues")
        ? terminal
        : null;
    if (
      !mutationTerminal ||
      mutationTerminal.evidence.versionId !== session.appliedVersionId ||
      mutationTerminal.evidence.preview.state !== "ready" ||
      mutationTerminal.evidence.preview.receiptId !== `version:${session.appliedVersionId}` ||
      !["passed", "passed_with_warnings"].includes(version?.validationStatus ?? "") ||
      !preview
    ) {
      res.status(409).json({
        error: "The project change has not passed its build and preview proof yet.",
        code: "support_project_proof_required",
      });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(supportTicketsTable)
        .set({
          status: "resolved",
          resolutionEvidence: {
            supportSessionId: session.id,
            taskId: session.taskId,
            versionId: session.appliedVersionId,
            previewSnapshotId: preview.id,
            validationStatus: version!.validationStatus,
          },
          updatedAt: new Date(),
        })
        .where(eq(supportTicketsTable.id, ticketId));
      await tx.insert(notificationsTable).values({
        recipientId: ticket.userId,
        type: "support_project_fix_verified",
        title: "Your project fix is ready",
        body: "Zero completed the approved change and the new project version passed its checks.",
        actorId: req.userId!,
        resourceType: "support_ticket",
        resourceId: String(ticketId),
        projectId: ticket.projectId,
        metadata: { supportSessionId: session.id, versionId: session.appliedVersionId },
      });
    });
    await writeOutcomeReceipt(req, "support_project_resolution_verified", ticket.userId);
    res.json({ ok: true, versionId: session.appliedVersionId, previewSnapshotId: preview.id });
  },
);

router.post("/support/tickets/:id/confirm-external-resolved", async (req, res): Promise<void> => {
  const ticketId = Number(req.params.id);
  const [ticket] = await db
    .select()
    .from(supportTicketsTable)
    .where(
      and(
        eq(supportTicketsTable.id, ticketId),
        eq(supportTicketsTable.userId, req.userId!),
        eq(supportTicketsTable.resolutionClass, "external"),
        eq(supportTicketsTable.status, "blocked"),
      ),
    )
    .limit(1);
  if (!ticket) {
    res.status(404).json({ error: "Blocked external ticket not found." });
    return;
  }
  await db
    .update(supportTicketsTable)
    .set({
      status: "resolved",
      resolutionEvidence: {
        ...boundedObject(ticket.resolutionEvidence),
        confirmedResolvedBy: req.userId!,
        confirmedResolvedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(supportTicketsTable.id, ticketId));
  res.json({ ok: true });
});

export default router;
