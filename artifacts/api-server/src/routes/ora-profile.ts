import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, oraProfilesTable } from "@workspace/db";
import { logger } from "../lib/logger";

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
    const [row] = await db
      .select()
      .from(oraProfilesTable)
      .where(eq(oraProfilesTable.userId, userId));
    res.json({ profile: row ?? null });
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
    preferredName: emptyToNull(parsed.data.preferredName),
    occupation: emptyToNull(parsed.data.occupation),
    industry: emptyToNull(parsed.data.industry),
    goals: emptyToNull(parsed.data.goals),
    skillLevel: emptyToNull(parsed.data.skillLevel),
    preferredLanguage: emptyToNull(parsed.data.preferredLanguage),
    responseStyle: emptyToNull(parsed.data.responseStyle),
    avoid: emptyToNull(parsed.data.avoid),
  };

  try {
    const [row] = await db
      .insert(oraProfilesTable)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: oraProfilesTable.userId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    res.json({ profile: row });
  } catch (err) {
    logger.error({ component: "ora-profile", err }, "Failed to save profile");
    res.status(500).json({ error: "Failed to save profile" });
  }
});

export default router;
