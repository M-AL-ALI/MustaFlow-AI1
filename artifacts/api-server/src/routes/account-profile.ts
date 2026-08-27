import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  getSharedAccountProfile,
  presentSharedAccountProfile,
  updateSharedAccountProfile,
} from "../lib/clerk-users";
import { logger } from "../lib/logger";
import { requireAdmin, requireOwner, writeAdminReceipt } from "../lib/adminAuth";
import { migrateSharedProfiles } from "../lib/shared-profile-migration";

const router: IRouter = Router();

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    preferredLanguage: z.string().trim().max(80).nullable().optional(),
    whatIBuild: z.string().trim().max(280).nullable().optional(),
  })
  .strict();

router.get("/me/account-profile", async (req, res): Promise<void> => {
  const profile = await getSharedAccountProfile(req.userId!);
  if (!profile) {
    res.status(503).json({
      error: "Your account profile is temporarily unavailable.",
      code: "shared_profile_unavailable",
    });
    return;
  }
  res.json({ profile: presentSharedAccountProfile(profile, "nabuflow") });
});

router.put("/me/account-profile", async (req, res): Promise<void> => {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Check the profile fields and try again.",
      code: "shared_profile_invalid",
    });
    return;
  }
  try {
    const profile = await updateSharedAccountProfile(req.userId!, parsed.data);
    res.json({ profile: presentSharedAccountProfile(profile, "nabuflow") });
  } catch (error) {
    logger.error({ component: "account-profile", error }, "Shared account profile update failed");
    res.status(503).json({
      error: "Your profile could not be saved right now. Please try again.",
      code: "shared_profile_save_unavailable",
    });
  }
});

const migrationSchema = z
  .object({
    mode: z.enum(["dry-run", "apply"]),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

router.post(
  "/admin/shared-profile-migration",
  requireAdmin,
  requireOwner,
  async (req, res): Promise<void> => {
    const parsed = migrationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a bounded profile migration run." });
      return;
    }
    const result = await migrateSharedProfiles(parsed.data);
    await writeAdminReceipt({
      actorUserId: req.userId!,
      actorRole: req.staffPrincipal!.role,
      kind: "action",
      action: `shared_profile_migration_${parsed.data.mode}`,
      outcome: result.blocked.length > 0 ? "partial" : "completed",
      requestMethod: req.method,
      requestPath: req.path,
    });
    res.json(result);
  },
);

export default router;
