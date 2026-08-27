import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, oraProfilesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { getSharedAccountProfile, updateSharedAccountProfile } from "../lib/clerk-users";

const router = Router();

/* ─── Ora profile ─────────────────────────────────────────────────────────────
 *
 * The Ora "About you" / custom-instructions block. ISOLATION: this is an Ora-only
 * concept stored in its own table and injected only into the standalone Ora
 * assistant's system prompt — never into the AI Builder.
 */

const MAX_SHORT = 200;
const MAX_LONG = 2000;

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

// Fetch the signed-in user's Ora profile (null when not set up yet).
router.get("/ora/profile", async (req, res) => {
  const userId = req.userId!;
  try {
    const [[row], identity] = await Promise.all([
      db.select().from(oraProfilesTable).where(eq(oraProfilesTable.userId, userId)),
      getSharedAccountProfile(userId),
    ]);
    if (!identity) {
      res.status(503).json({ error: "Your account profile is temporarily unavailable." });
      return;
    }
    res.json({
      profile: {
        ...(row ?? {
          id: 0,
          userId,
          occupation: null,
          industry: null,
          goals: null,
          skillLevel: null,
          responseStyle: null,
          avoid: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
        preferredName: identity.displayName,
        preferredLanguage: identity.preferredLanguage,
      },
    });
  } catch (err) {
    logger.error({ component: "ora-profile", err }, "Failed to load profile");
    res.status(500).json({ error: "Failed to load profile" });
  }
});

const putProfileSchema = z.object({
  preferredName: z.string().max(MAX_SHORT).nullable().optional(),
  occupation: z.string().max(MAX_SHORT).nullable().optional(),
  industry: z.string().max(MAX_SHORT).nullable().optional(),
  goals: z.string().max(MAX_LONG).nullable().optional(),
  skillLevel: z.string().max(MAX_SHORT).nullable().optional(),
  preferredLanguage: z.string().max(MAX_SHORT).nullable().optional(),
  responseStyle: z.string().max(MAX_LONG).nullable().optional(),
  avoid: z.string().max(MAX_LONG).nullable().optional(),
});

// Create or update the user's Ora profile (upsert on user_id).
router.put("/ora/profile", async (req, res) => {
  const userId = req.userId!;
  const parsed = putProfileSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const values = {
    preferredName: null,
    occupation: emptyToNull(parsed.data.occupation),
    industry: emptyToNull(parsed.data.industry),
    goals: emptyToNull(parsed.data.goals),
    skillLevel: emptyToNull(parsed.data.skillLevel),
    preferredLanguage: null,
    responseStyle: emptyToNull(parsed.data.responseStyle),
    avoid: emptyToNull(parsed.data.avoid),
  };

  try {
    const currentIdentity = await getSharedAccountProfile(userId);
    const requestedName = emptyToNull(parsed.data.preferredName);
    if (!currentIdentity?.displayName && !requestedName) {
      res.status(503).json({ error: "Your account profile is temporarily unavailable." });
      return;
    }
    const identity = await updateSharedAccountProfile(userId, {
      displayName: requestedName ?? currentIdentity!.displayName!,
      preferredLanguage: emptyToNull(parsed.data.preferredLanguage),
      whatIBuild: currentIdentity?.whatIBuild,
    });
    const [row] = await db
      .insert(oraProfilesTable)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: oraProfilesTable.userId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    res.json({
      profile: {
        ...row,
        preferredName: identity.displayName,
        preferredLanguage: identity.preferredLanguage,
      },
    });
  } catch (err) {
    logger.error({ component: "ora-profile", err }, "Failed to save profile");
    res.status(500).json({ error: "Failed to save profile" });
  }
});

export default router;
