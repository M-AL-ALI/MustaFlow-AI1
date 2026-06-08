// ─────────────────────────────────────────────────────────────────────────────
// User Preferences — GET /api/me/preferences, PATCH /api/me/preferences
//
// Persists per-user preferences (e.g. onboarding dismissal) to the DB so they
// sync across devices. Created on first access via an upsert.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, userPreferencesTable } from "@workspace/db";

const router: IRouter = Router();

async function getOrCreatePreferences(userId: string) {
  const [existing] = await db
    .select()
    .from(userPreferencesTable)
    .where(eq(userPreferencesTable.userId, userId));

  if (existing) return existing;

  const [created] = await db.insert(userPreferencesTable).values({ userId }).returning();

  return created!;
}

router.get("/me/preferences", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const prefs = await getOrCreatePreferences(userId);
  res.json({
    userId: prefs.userId,
    dismissedOnboarding: prefs.dismissedOnboarding,
    preferredMode: prefs.preferredMode ?? null,
    voiceLang: prefs.voiceLang ?? null,
    autoReadReplies: prefs.autoReadReplies,
    updatedAt: prefs.updatedAt,
  });
});

const updatePreferencesSchema = z.object({
  dismissedOnboarding: z.boolean().optional(),
  preferredMode: z.enum(["builder", "developer", "ora"]).nullable().optional(),
  voiceLang: z.string().nullable().optional(),
  autoReadReplies: z.boolean().optional(),
});

router.patch("/me/preferences", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = updatePreferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: sql`now()` };
  if (parsed.data.dismissedOnboarding !== undefined) {
    updates.dismissedOnboarding = parsed.data.dismissedOnboarding;
  }
  if (parsed.data.preferredMode !== undefined) {
    updates.preferredMode = parsed.data.preferredMode;
  }
  if (parsed.data.voiceLang !== undefined) {
    updates.voiceLang = parsed.data.voiceLang;
  }
  if (parsed.data.autoReadReplies !== undefined) {
    updates.autoReadReplies = parsed.data.autoReadReplies;
  }

  const [updated] = await db
    .insert(userPreferencesTable)
    .values({ userId, ...parsed.data })
    .onConflictDoUpdate({
      target: userPreferencesTable.userId,
      set: updates,
    })
    .returning();

  res.json({
    userId: updated!.userId,
    dismissedOnboarding: updated!.dismissedOnboarding,
    preferredMode: updated!.preferredMode ?? null,
    voiceLang: updated!.voiceLang ?? null,
    autoReadReplies: updated!.autoReadReplies,
    updatedAt: updated!.updatedAt,
  });
});

export default router;
