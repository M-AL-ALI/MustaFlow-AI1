import { Router, type IRouter } from "express";
import { and, eq, isNull, desc } from "drizzle-orm";
import {
  db,
  organizationsTable,
  orgMembersTable,
  orgInvitesTable,
  projectsTable,
} from "@workspace/db";
import { z } from "zod";
import { randomBytes } from "crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function makeUniqueSlug(base: string): string {
  return `${base}-${randomBytes(3).toString("hex")}`;
}

// Resolve the requesting user's role in an org. Returns null if not a member.
async function getUserOrgRole(
  userId: string,
  orgId: number,
): Promise<string | null> {
  const [member] = await db
    .select({ role: orgMembersTable.role })
    .from(orgMembersTable)
    .where(and(eq(orgMembersTable.organizationId, orgId), eq(orgMembersTable.userId, userId)));
  return member?.role ?? null;
}

const ROLE_RANK: Record<string, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

function hasMinRole(userRole: string, minRole: string): boolean {
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[minRole] ?? 999);
}

// ── List orgs for the current user ───────────────────────────────────────────
router.get("/orgs", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const memberships = await db
    .select({
      role: orgMembersTable.role,
      joinedAt: orgMembersTable.joinedAt,
      org: organizationsTable,
    })
    .from(orgMembersTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, orgMembersTable.organizationId))
    .where(
      and(eq(orgMembersTable.userId, userId), isNull(organizationsTable.deletedAt)),
    )
    .orderBy(desc(orgMembersTable.joinedAt));

  res.json(
    memberships.map((m) => ({
      ...m.org,
      myRole: m.role,
      joinedAt: m.joinedAt,
    })),
  );
});

// ── Get single org ────────────────────────────────────────────────────────────
router.get("/orgs/:orgId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (!role) { res.status(403).json({ error: "Not a member" }); return; }

  const [org] = await db
    .select()
    .from(organizationsTable)
    .where(and(eq(organizationsTable.id, orgId), isNull(organizationsTable.deletedAt)));
  if (!org) { res.status(404).json({ error: "Not found" }); return; }

  res.json({ ...org, myRole: role });
});

// ── Create org ────────────────────────────────────────────────────────────────
const CreateOrgBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  billingEmail: z.string().email().optional(),
});

router.post("/orgs", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const parsed = CreateOrgBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { name, description, billingEmail } = parsed.data;
  const baseSlug = generateSlug(name);

  // Check slug uniqueness; append random suffix if taken
  const existing = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, baseSlug));

  const slug = existing.length > 0 ? makeUniqueSlug(baseSlug) : baseSlug;

  const [org] = await db
    .insert(organizationsTable)
    .values({ name, slug, description, billingEmail, createdByUserId: userId, type: "team" })
    .returning();

  if (!org) { res.status(500).json({ error: "Failed to create org" }); return; }

  // Auto-add creator as owner
  await db.insert(orgMembersTable).values({
    organizationId: org.id,
    userId,
    role: "owner",
  });

  res.status(201).json({ ...org, myRole: "owner" });
});

// ── Update org ────────────────────────────────────────────────────────────────
const UpdateOrgBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  billingEmail: z.string().email().optional(),
  avatarUrl: z.string().url().max(500).optional(),
});

router.patch("/orgs/:orgId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (!role || !hasMinRole(role, "admin")) { res.status(403).json({ error: "Insufficient role" }); return; }

  const parsed = UpdateOrgBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [org] = await db
    .update(organizationsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId))
    .returning();

  res.json(org);
});

// ── Delete org ────────────────────────────────────────────────────────────────
router.delete("/orgs/:orgId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (role !== "owner") { res.status(403).json({ error: "Only the owner can delete an org" }); return; }

  const [org] = await db
    .select({ type: organizationsTable.type })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (org?.type === "personal") { res.status(400).json({ error: "Cannot delete personal org" }); return; }

  await db
    .update(organizationsTable)
    .set({ deletedAt: new Date() })
    .where(eq(organizationsTable.id, orgId));

  res.json({ deleted: true });
});

// ── List members ──────────────────────────────────────────────────────────────
router.get("/orgs/:orgId/members", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (!role) { res.status(403).json({ error: "Not a member" }); return; }

  const members = await db
    .select()
    .from(orgMembersTable)
    .where(eq(orgMembersTable.organizationId, orgId))
    .orderBy(desc(orgMembersTable.joinedAt));

  res.json(members);
});

// ── Update member role ────────────────────────────────────────────────────────
const UpdateMemberBody = z.object({
  role: z.enum(["viewer", "member", "admin", "owner"]),
});

router.patch("/orgs/:orgId/members/:memberId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  if (!Number.isFinite(orgId) || !Number.isFinite(memberId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const role = await getUserOrgRole(userId, orgId);
  if (!role || !hasMinRole(role, "admin")) { res.status(403).json({ error: "Insufficient role" }); return; }

  const parsed = UpdateMemberBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Cannot promote someone to a role higher than your own
  if ((ROLE_RANK[parsed.data.role] ?? 0) > (ROLE_RANK[role] ?? 0)) {
    res.status(403).json({ error: "Cannot promote above your own role" }); return;
  }

  const [updated] = await db
    .update(orgMembersTable)
    .set({ role: parsed.data.role, updatedAt: new Date() })
    .where(and(eq(orgMembersTable.id, memberId), eq(orgMembersTable.organizationId, orgId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "Member not found" }); return; }
  res.json(updated);
});

// ── Remove member ─────────────────────────────────────────────────────────────
router.delete("/orgs/:orgId/members/:memberId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  const memberId = parseInt(req.params.memberId, 10);
  if (!Number.isFinite(orgId) || !Number.isFinite(memberId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const [target] = await db
    .select()
    .from(orgMembersTable)
    .where(and(eq(orgMembersTable.id, memberId), eq(orgMembersTable.organizationId, orgId)));
  if (!target) { res.status(404).json({ error: "Member not found" }); return; }

  // Allow self-removal (leaving) OR admin/owner removing others
  if (target.userId !== userId) {
    const role = await getUserOrgRole(userId, orgId);
    if (!role || !hasMinRole(role, "admin")) {
      res.status(403).json({ error: "Insufficient role" }); return;
    }
    // Cannot remove the owner unless you are the owner
    if (target.role === "owner") {
      const myRole = await getUserOrgRole(userId, orgId);
      if (myRole !== "owner") { res.status(403).json({ error: "Cannot remove the owner" }); return; }
    }
  }

  await db
    .delete(orgMembersTable)
    .where(eq(orgMembersTable.id, memberId));

  res.json({ removed: true });
});

// ── Invite member ─────────────────────────────────────────────────────────────
const CreateInviteBody = z.object({
  email: z.string().email(),
  role: z.enum(["viewer", "member", "admin"]).default("member"),
});

router.post("/orgs/:orgId/invites", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (!role || !hasMinRole(role, "admin")) { res.status(403).json({ error: "Insufficient role" }); return; }

  const parsed = CreateInviteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invite] = await db
    .insert(orgInvitesTable)
    .values({
      organizationId: orgId,
      token,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: userId,
      expiresAt,
    })
    .returning();

  logger.info({ orgId, email: parsed.data.email }, "Org invite created");
  res.status(201).json(invite);
});

// ── List invites ──────────────────────────────────────────────────────────────
router.get("/orgs/:orgId/invites", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (!role || !hasMinRole(role, "admin")) { res.status(403).json({ error: "Insufficient role" }); return; }

  const invites = await db
    .select()
    .from(orgInvitesTable)
    .where(eq(orgInvitesTable.organizationId, orgId))
    .orderBy(desc(orgInvitesTable.createdAt));

  res.json(invites);
});

// ── Revoke invite ─────────────────────────────────────────────────────────────
router.delete("/orgs/:orgId/invites/:inviteId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  const inviteId = parseInt(req.params.inviteId, 10);
  if (!Number.isFinite(orgId) || !Number.isFinite(inviteId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const role = await getUserOrgRole(userId, orgId);
  if (!role || !hasMinRole(role, "admin")) { res.status(403).json({ error: "Insufficient role" }); return; }

  await db
    .update(orgInvitesTable)
    .set({ status: "revoked" })
    .where(and(eq(orgInvitesTable.id, inviteId), eq(orgInvitesTable.organizationId, orgId)));

  res.json({ revoked: true });
});

// ── Accept invite (by token) ──────────────────────────────────────────────────
router.post("/orgs/invites/:token/accept", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const { token } = req.params;

  const [invite] = await db
    .select()
    .from(orgInvitesTable)
    .where(eq(orgInvitesTable.token, token));

  if (!invite) { res.status(404).json({ error: "Invite not found" }); return; }
  if (invite.status !== "pending") { res.status(400).json({ error: `Invite is ${invite.status}` }); return; }
  if (invite.expiresAt < new Date()) { res.status(400).json({ error: "Invite expired" }); return; }

  // Add member if not already in org
  await db
    .insert(orgMembersTable)
    .values({ organizationId: invite.organizationId, userId, role: invite.role })
    .onConflictDoNothing();

  await db
    .update(orgInvitesTable)
    .set({ status: "accepted", acceptedByUserId: userId, acceptedAt: new Date() })
    .where(eq(orgInvitesTable.id, invite.id));

  res.json({ accepted: true, organizationId: invite.organizationId, role: invite.role });
});

// ── List projects for an org ──────────────────────────────────────────────────
router.get("/orgs/:orgId/projects", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const orgId = parseInt(req.params.orgId, 10);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "Invalid org id" }); return; }

  const role = await getUserOrgRole(userId, orgId);
  if (!role) { res.status(403).json({ error: "Not a member" }); return; }

  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.organizationId, orgId), isNull(projectsTable.deletedAt)))
    .orderBy(desc(projectsTable.updatedAt));

  res.json(projects);
});

export default router;
