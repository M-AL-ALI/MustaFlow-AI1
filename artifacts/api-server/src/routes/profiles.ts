/**
 * Task #631 — Community profiles routes.
 *
 *   GET  /profiles/:username              — public profile
 *   GET  /profiles/:username/projects     — public projects for a profile
 *   GET  /me/profile                      — own profile (auth)
 *   POST /me/profile                      — create / update own profile (auth)
 *   GET  /me/profile/badge                — badge embed snippet (auth)
 *   POST /profiles/:username/follow       — follow a user (auth)
 *   DELETE /profiles/:username/follow     — unfollow (auth)
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, communityProfilesTable, profileFollowsTable, projectsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

// Public sub-router — mounted BEFORE attachUser
export const publicProfilesRouter: IRouter = Router();

// ── GET /profiles/:username ───────────────────────────────────────────────────
publicProfilesRouter.get("/profiles/:username", async (req, res): Promise<void> => {
  try {
    const [profile] = await db
      .select({
        id: communityProfilesTable.id,
        userId: communityProfilesTable.userId,
        username: communityProfilesTable.username,
        displayName: communityProfilesTable.displayName,
        bio: communityProfilesTable.bio,
        avatarUrl: communityProfilesTable.avatarUrl,
        websiteUrl: communityProfilesTable.websiteUrl,
        twitterHandle: communityProfilesTable.twitterHandle,
        githubHandle: communityProfilesTable.githubHandle,
        location: communityProfilesTable.location,
        showcasedProjectIds: communityProfilesTable.showcasedProjectIds,
        followerCount: communityProfilesTable.followerCount,
        followingCount: communityProfilesTable.followingCount,
        badgeEmbedEnabled: communityProfilesTable.badgeEmbedEnabled,
        createdAt: communityProfilesTable.createdAt,
      })
      .from(communityProfilesTable)
      .where(
        and(
          eq(communityProfilesTable.username, req.params.username),
          eq(communityProfilesTable.profilePublic, true),
        ),
      );

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Check if signed-in user follows this profile
    const viewerId = (req as { userId?: string }).userId;
    let isFollowing = false;
    if (viewerId && viewerId !== profile.userId) {
      const [follow] = await db
        .select({ id: profileFollowsTable.id })
        .from(profileFollowsTable)
        .where(
          and(
            eq(profileFollowsTable.followerId, viewerId),
            eq(profileFollowsTable.followingId, profile.userId),
          ),
        );
      isFollowing = !!follow;
    }

    res.json({ ...profile, isFollowing });
  } catch (err) {
    logger.error({ err }, "Failed to get profile");
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// ── GET /profiles/:username/projects ─────────────────────────────────────────
publicProfilesRouter.get("/profiles/:username/projects", async (req, res): Promise<void> => {
  try {
    const [profile] = await db
      .select({
        userId: communityProfilesTable.userId,
        publicProjectIds: communityProfilesTable.publicProjectIds,
        showcasedProjectIds: communityProfilesTable.showcasedProjectIds,
        profilePublic: communityProfilesTable.profilePublic,
      })
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.username, req.params.username));

    if (!profile || !profile.profilePublic) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const showcasedIds = (profile.showcasedProjectIds as number[]) ?? [];
    const publicIds = (profile.publicProjectIds as number[]) ?? [];
    const allIds = [...new Set([...showcasedIds, ...publicIds])];

    if (allIds.length === 0) {
      res.json([]);
      return;
    }

    const projects = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        description: projectsTable.description,
        kind: projectsTable.kind,
        platform: projectsTable.platform,
        status: projectsTable.status,
        publicSlug: projectsTable.publicSlug,
        createdAt: projectsTable.createdAt,
        updatedAt: projectsTable.updatedAt,
      })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.ownerId, profile.userId),
          sql`${projectsTable.id} = ANY(ARRAY[${sql.join(
            allIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
          sql`${projectsTable.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(projectsTable.updatedAt));

    res.json(projects);
  } catch (err) {
    logger.error({ err }, "Failed to get profile projects");
    res.status(500).json({ error: "Failed to load projects" });
  }
});

// ── GET /me/profile ──────────────────────────────────────────────────────────
router.get("/me/profile", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [profile] = await db
      .select()
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.userId, userId));

    res.json(profile ?? null);
  } catch (err) {
    logger.error({ err }, "Failed to get own profile");
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// ── POST /me/profile ──────────────────────────────────────────────────────────
const profileSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, underscores")
    .optional(),
  displayName: z.string().max(80).optional(),
  bio: z.string().max(300).optional(),
  avatarUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  twitterHandle: z.string().max(50).optional(),
  githubHandle: z.string().max(50).optional(),
  location: z.string().max(100).optional(),
  profilePublic: z.boolean().optional(),
  badgeEmbedEnabled: z.boolean().optional(),
  publicProjectIds: z.array(z.number().int()).max(100).optional(),
  showcasedProjectIds: z.array(z.number().int()).max(12).optional(),
});

router.post("/me/profile", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: communityProfilesTable.id, userId: communityProfilesTable.userId })
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.userId, userId));

    // Username uniqueness check
    if (parsed.data.username) {
      const [conflict] = await db
        .select({ id: communityProfilesTable.id })
        .from(communityProfilesTable)
        .where(eq(communityProfilesTable.username, parsed.data.username));
      if (conflict && (!existing || conflict.id !== existing.id)) {
        res.status(409).json({ error: "Username already taken" });
        return;
      }
    }

    if (existing) {
      const [updated] = await db
        .update(communityProfilesTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(communityProfilesTable.userId, userId))
        .returning();
      res.json(updated);
    } else {
      if (!parsed.data.username) {
        res.status(400).json({ error: "username is required when creating a profile" });
        return;
      }
      const [created] = await db
        .insert(communityProfilesTable)
        .values({
          userId,
          username: parsed.data.username,
          ...parsed.data,
        })
        .returning();
      res.status(201).json(created);
    }
  } catch (err) {
    logger.error({ err }, "Failed to save profile");
    res.status(500).json({ error: "Failed to save profile" });
  }
});

// ── GET /me/profile/badge ─────────────────────────────────────────────────────
router.get("/me/profile/badge", async (req, res): Promise<void> => {
  const userId = (req as { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [profile] = await db
      .select({ username: communityProfilesTable.username })
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.userId, userId));

    if (!profile) {
      res.status(404).json({ error: "Profile not found — create your profile first" });
      return;
    }

    const origin = process.env.PLATFORM_DOMAIN
      ? `https://${process.env.PLATFORM_DOMAIN}`
      : "https://mustaflow.app";

    const badgeUrl = `${origin}/badge/built-with-mustaflow.svg`;
    const profileUrl = `${origin}/u/${profile.username}`;

    const htmlSnippet = `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer"><img src="${badgeUrl}" alt="Built with MustaFlow" height="20" /></a>`;
    const markdownSnippet = `[![Built with MustaFlow](${badgeUrl})](${profileUrl})`;

    res.json({ html: htmlSnippet, markdown: markdownSnippet, badgeUrl, profileUrl });
  } catch (err) {
    logger.error({ err }, "Failed to get badge");
    res.status(500).json({ error: "Failed to load badge" });
  }
});

// ── POST /profiles/:username/follow ───────────────────────────────────────────
router.post("/profiles/:username/follow", async (req, res): Promise<void> => {
  const viewerId = (req as { userId?: string }).userId;
  if (!viewerId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [target] = await db
      .select({ userId: communityProfilesTable.userId })
      .from(communityProfilesTable)
      .where(
        and(
          eq(communityProfilesTable.username, req.params.username),
          eq(communityProfilesTable.profilePublic, true),
        ),
      );

    if (!target) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    if (target.userId === viewerId) {
      res.status(400).json({ error: "You cannot follow yourself" });
      return;
    }

    await db
      .insert(profileFollowsTable)
      .values({ followerId: viewerId, followingId: target.userId })
      .onConflictDoNothing();

    // Update counts
    await db
      .update(communityProfilesTable)
      .set({
        followerCount: sql`${communityProfilesTable.followerCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(communityProfilesTable.userId, target.userId));

    await db
      .update(communityProfilesTable)
      .set({
        followingCount: sql`${communityProfilesTable.followingCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(communityProfilesTable.userId, viewerId));

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to follow profile");
    res.status(500).json({ error: "Failed to follow" });
  }
});

// ── DELETE /profiles/:username/follow ─────────────────────────────────────────
router.delete("/profiles/:username/follow", async (req, res): Promise<void> => {
  const viewerId = (req as { userId?: string }).userId;
  if (!viewerId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const [target] = await db
      .select({ userId: communityProfilesTable.userId })
      .from(communityProfilesTable)
      .where(eq(communityProfilesTable.username, req.params.username));

    if (!target) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    await db
      .delete(profileFollowsTable)
      .where(
        and(
          eq(profileFollowsTable.followerId, viewerId),
          eq(profileFollowsTable.followingId, target.userId),
        ),
      );

    await db
      .update(communityProfilesTable)
      .set({
        followerCount: sql`GREATEST(${communityProfilesTable.followerCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(communityProfilesTable.userId, target.userId));

    await db
      .update(communityProfilesTable)
      .set({
        followingCount: sql`GREATEST(${communityProfilesTable.followingCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(communityProfilesTable.userId, viewerId));

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to unfollow profile");
    res.status(500).json({ error: "Failed to unfollow" });
  }
});

export default router;
