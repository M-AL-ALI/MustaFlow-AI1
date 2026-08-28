import { createHash, randomBytes } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import {
  db,
  notificationsTable,
  projectActivityTable,
  projectCollaboratorsTable,
  projectInvitesTable,
  projectsTable,
} from "@workspace/db";
import { checkProjectAccess, requireProjectAccess } from "../lib/auth";
import {
  findClerkUserByEmail,
  getClerkUserById,
  getClerkUserSummaries,
  getSharedAccountProfile,
} from "../lib/clerk-users";
import { sendProjectInvite } from "../lib/emailClient";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ProjectRole = z.enum(["owner", "publisher", "editor", "viewer"]);
const InviteBody = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("email"),
    email: z.string().email().max(320),
    role: ProjectRole,
  }),
  z.object({ mode: z.literal("link"), role: ProjectRole }),
]);
const UpdateRoleBody = z.object({ role: ProjectRole });

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function projectIdFrom(req: Request): number | null {
  const projectId = Number.parseInt(routeParam(req.params.id), 10);
  return Number.isFinite(projectId) && projectId > 0 ? projectId : null;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function baseUrl(req: Request): string {
  return (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/u, "");
}

function derivedInviteStatus(invite: {
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: Date;
}): "pending" | "accepted" | "revoked" | "expired" {
  return invite.status === "pending" && invite.expiresAt.getTime() <= Date.now()
    ? "expired"
    : invite.status;
}

async function projectContext(projectId: number) {
  const [project] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      ownerId: projectsTable.ownerId,
      workspaceId: projectsTable.workspaceId,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  return project ?? null;
}

async function recordActivity(input: {
  projectId: number;
  actorId: string;
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
}) {
  await db.insert(projectActivityTable).values({
    projectId: input.projectId,
    actorId: input.actorId,
    actorName: null,
    eventType: input.eventType,
    summary: input.summary,
    metadata: input.metadata,
  });
}

router.get(
  "/projects/:id/collaboration",
  requireProjectAccess("viewer"),
  async (req, res): Promise<void> => {
    const projectId = projectIdFrom(req);
    if (!projectId || !req.userId) {
      res.status(400).json({ error: "That project could not be opened." });
      return;
    }
    const project = await projectContext(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const members = await db
      .select()
      .from(projectCollaboratorsTable)
      .where(eq(projectCollaboratorsTable.projectId, projectId))
      .orderBy(desc(projectCollaboratorsTable.joinedAt));
    const summaries = await getClerkUserSummaries(members.map((member) => member.userId));
    const canManage = (await checkProjectAccess(req.userId, projectId, "owner")) === "granted";
    const invites = canManage
      ? await db
          .select()
          .from(projectInvitesTable)
          .where(eq(projectInvitesTable.projectId, projectId))
          .orderBy(desc(projectInvitesTable.createdAt))
      : [];

    res.json({
      project: { id: project.id, name: project.name },
      canManage,
      members: members.map((member) => {
        const profile = summaries.get(member.userId);
        return {
          userId: member.userId,
          role: member.role,
          displayName: profile?.displayName ?? null,
          email: profile?.email ?? null,
          imageUrl: profile?.imageUrl ?? null,
          joinedAt: member.joinedAt.toISOString(),
          isProjectOwner: member.userId === project.ownerId,
        };
      }),
      invites: invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        status: derivedInviteStatus(invite),
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      })),
    });
  },
);

router.post(
  "/projects/:id/invites",
  requireProjectAccess("owner"),
  async (req, res): Promise<void> => {
    const projectId = projectIdFrom(req);
    const parsed = InviteBody.safeParse(req.body);
    if (!projectId || !req.userId || !parsed.success) {
      res.status(400).json({ error: "Choose a valid invite type and project role." });
      return;
    }
    const project = await projectContext(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const email = parsed.data.mode === "email" ? parsed.data.email.trim().toLowerCase() : null;
    if (email) {
      await db
        .update(projectInvitesTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(projectInvitesTable.projectId, projectId),
            eq(projectInvitesTable.email, email),
            eq(projectInvitesTable.status, "pending"),
            lte(projectInvitesTable.expiresAt, new Date()),
          ),
        );
      const account = await findClerkUserByEmail(email);
      if (account) {
        const [existing] = await db
          .select({ userId: projectCollaboratorsTable.userId })
          .from(projectCollaboratorsTable)
          .where(
            and(
              eq(projectCollaboratorsTable.projectId, projectId),
              eq(projectCollaboratorsTable.userId, account.userId),
            ),
          );
        if (existing) {
          res.status(409).json({ error: "That person already has access to this project." });
          return;
        }
      }
      const [pending] = await db
        .select({ id: projectInvitesTable.id })
        .from(projectInvitesTable)
        .where(
          and(
            eq(projectInvitesTable.projectId, projectId),
            eq(projectInvitesTable.email, email),
            eq(projectInvitesTable.status, "pending"),
            gt(projectInvitesTable.expiresAt, new Date()),
          ),
        );
      if (pending) {
        res.status(409).json({ error: "That invitation is already waiting to be accepted." });
        return;
      }
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const [invite] = await db
      .insert(projectInvitesTable)
      .values({
        projectId,
        workspaceId: project.workspaceId,
        email,
        tokenHash: tokenDigest(token),
        role: parsed.data.role,
        invitedBy: req.userId,
        expiresAt,
      })
      .returning();
    if (!invite) {
      res.status(500).json({ error: "The invitation could not be created." });
      return;
    }
    const acceptUrl = `${baseUrl(req)}/projects/invites/${token}`;
    const inviter = await getSharedAccountProfile(req.userId);
    let emailStatus: "not_requested" | "sent" | "skipped" | "failed" = "not_requested";
    if (email) {
      emailStatus = await sendProjectInvite({
        to: email,
        projectName: project.name,
        inviterName: inviter?.displayName ?? null,
        role: parsed.data.role,
        acceptUrl,
        expiresAt,
      });
      const invitedAccount = await findClerkUserByEmail(email);
      if (invitedAccount) {
        await db.insert(notificationsTable).values({
          recipientId: invitedAccount.userId,
          type: "project_invite",
          title: `${inviter?.displayName ?? "A teammate"} invited you to ${project.name}`,
          body: `Open the invitation to join as ${parsed.data.role}.`,
          actorId: req.userId,
          resourceType: "project_invite",
          resourceId: String(invite.id),
          // The one-time token is deliberately absent. Notifications link to
          // the authenticated invitation surface, never a copied credential.
          metadata: { projectId, projectName: project.name, role: parsed.data.role },
        });
      }
    }
    await recordActivity({
      projectId,
      actorId: req.userId,
      eventType: "project_invite_created",
      summary: email ? `Invited ${email} as ${parsed.data.role}` : `Created a private join link`,
      metadata: {
        inviteId: invite.id,
        role: parsed.data.role,
        mode: parsed.data.mode,
        emailStatus,
      },
    });
    res.status(201).json({
      id: invite.id,
      role: invite.role,
      email: invite.email,
      status: invite.status,
      expiresAt: expiresAt.toISOString(),
      acceptUrl,
      emailStatus,
    });
  },
);

router.post(
  "/projects/:id/invites/:inviteId/revoke",
  requireProjectAccess("owner"),
  async (req, res): Promise<void> => {
    const projectId = projectIdFrom(req);
    const inviteId = Number.parseInt(routeParam(req.params.inviteId), 10);
    if (!projectId || !Number.isFinite(inviteId) || !req.userId) {
      res.status(400).json({ error: "That invitation could not be found." });
      return;
    }
    const [invite] = await db
      .update(projectInvitesTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(projectInvitesTable.id, inviteId),
          eq(projectInvitesTable.projectId, projectId),
          eq(projectInvitesTable.status, "pending"),
        ),
      )
      .returning();
    if (!invite) {
      res.status(404).json({ error: "That pending invitation could not be found." });
      return;
    }
    await recordActivity({
      projectId,
      actorId: req.userId,
      eventType: "project_invite_revoked",
      summary: "Revoked a project invitation",
      metadata: { inviteId },
    });
    res.json({ revoked: true });
  },
);

router.get("/project-invites/:token", async (req, res): Promise<void> => {
  const token = routeParam(req.params.token);
  if (token.length < 32) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  const [invite] = await db
    .select({
      id: projectInvitesTable.id,
      projectId: projectInvitesTable.projectId,
      email: projectInvitesTable.email,
      role: projectInvitesTable.role,
      status: projectInvitesTable.status,
      expiresAt: projectInvitesTable.expiresAt,
      projectName: projectsTable.name,
    })
    .from(projectInvitesTable)
    .innerJoin(projectsTable, eq(projectsTable.id, projectInvitesTable.projectId))
    .where(eq(projectInvitesTable.tokenHash, tokenDigest(token)));
  if (!invite) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  res.json({
    ...invite,
    status: derivedInviteStatus(invite),
    expiresAt: invite.expiresAt.toISOString(),
  });
});

router.post("/project-invites/:token/accept", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Sign in to accept this invitation." });
    return;
  }
  const token = routeParam(req.params.token);
  const [invite] = await db
    .select()
    .from(projectInvitesTable)
    .where(eq(projectInvitesTable.tokenHash, tokenDigest(token)));
  if (!invite) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  if (invite.status !== "pending") {
    res.status(409).json({ error: `This invitation is ${invite.status}.` });
    return;
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    await db
      .update(projectInvitesTable)
      .set({ status: "expired" })
      .where(and(eq(projectInvitesTable.id, invite.id), eq(projectInvitesTable.status, "pending")));
    res
      .status(410)
      .json({ error: "This invitation has expired. Ask the project owner for a new one." });
    return;
  }
  const profile = await getClerkUserById(req.userId);
  if (invite.email && profile?.email?.toLowerCase() !== invite.email.toLowerCase()) {
    res.status(403).json({ error: "This invitation was sent to a different email address." });
    return;
  }
  const project = await projectContext(invite.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const accepted = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(projectInvitesTable)
      .set({ status: "accepted", acceptedBy: req.userId!, acceptedAt: new Date() })
      .where(
        and(
          eq(projectInvitesTable.id, invite.id),
          eq(projectInvitesTable.status, "pending"),
          gt(projectInvitesTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: projectInvitesTable.id });
    if (!claimed) return false;
    await tx
      .insert(projectCollaboratorsTable)
      .values({
        projectId: invite.projectId,
        workspaceId: invite.workspaceId,
        userId: req.userId!,
        role: invite.role,
        invitedBy: invite.invitedBy,
      })
      .onConflictDoUpdate({
        target: [projectCollaboratorsTable.projectId, projectCollaboratorsTable.userId],
        set: { role: invite.role, updatedAt: new Date() },
      });
    return true;
  });
  if (!accepted) {
    res.status(409).json({ error: "This invitation has already been used or has expired." });
    return;
  }
  await recordActivity({
    projectId: invite.projectId,
    actorId: req.userId,
    eventType: "project_invite_accepted",
    summary: `Joined the project as ${invite.role}`,
    metadata: { inviteId: invite.id, role: invite.role },
  });
  res.json({
    accepted: true,
    projectId: invite.projectId,
    projectName: project.name,
    role: invite.role,
  });
});

router.patch(
  "/projects/:id/members/:userId",
  requireProjectAccess("owner"),
  async (req, res): Promise<void> => {
    const projectId = projectIdFrom(req);
    const parsed = UpdateRoleBody.safeParse(req.body);
    const targetUserId = routeParam(req.params.userId);
    if (!projectId || !req.userId || !targetUserId || !parsed.success) {
      res.status(400).json({ error: "Choose a valid project role." });
      return;
    }
    const project = await projectContext(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (targetUserId === project.ownerId && parsed.data.role !== "owner") {
      res.status(409).json({ error: "The project owner must keep the Owner role." });
      return;
    }
    const [updated] = await db
      .update(projectCollaboratorsTable)
      .set({ role: parsed.data.role, updatedAt: new Date() })
      .where(
        and(
          eq(projectCollaboratorsTable.projectId, projectId),
          eq(projectCollaboratorsTable.userId, targetUserId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Project member not found" });
      return;
    }
    await recordActivity({
      projectId,
      actorId: req.userId,
      eventType: "project_member_role_changed",
      summary: `Changed a project member to ${parsed.data.role}`,
      metadata: { targetUserId, role: parsed.data.role },
    });
    res.json({ updated: true, role: updated.role });
  },
);

router.delete(
  "/projects/:id/members/:userId",
  requireProjectAccess("owner"),
  async (req, res): Promise<void> => {
    const projectId = projectIdFrom(req);
    const targetUserId = routeParam(req.params.userId);
    if (!projectId || !req.userId || !targetUserId) {
      res.status(400).json({ error: "Project member not found" });
      return;
    }
    const project = await projectContext(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (targetUserId === project.ownerId) {
      res.status(409).json({ error: "The project owner cannot be removed." });
      return;
    }
    const [removed] = await db
      .delete(projectCollaboratorsTable)
      .where(
        and(
          eq(projectCollaboratorsTable.projectId, projectId),
          eq(projectCollaboratorsTable.userId, targetUserId),
        ),
      )
      .returning();
    if (!removed) {
      res.status(404).json({ error: "Project member not found" });
      return;
    }
    await recordActivity({
      projectId,
      actorId: req.userId,
      eventType: "project_member_removed",
      summary: "Removed a project member",
      metadata: { targetUserId },
    });
    logger.info({ projectId, targetUserId, actorUserId: req.userId }, "Project access removed");
    res.json({ removed: true });
  },
);

export default router;
