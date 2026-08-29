import { Router, type IRouter, type Request, type Response } from "express";
import {
  LookupAdminAccountQueryParams,
  LookupAdminAccountResponse,
  RestoreAdminAccountBody,
  RestoreAdminAccountParams,
  RestoreAdminAccountResponse,
  SuspendAdminAccountBody,
  SuspendAdminAccountParams,
  SuspendAdminAccountResponse,
} from "@workspace/api-zod";
import {
  findClerkAccountAccessByEmail,
  getClerkAccountAccessById,
  setClerkAccountBanned,
} from "../lib/clerk-users";
import {
  requireAdmin,
  requireOwner,
  resolveStaffPrincipal,
  writeAdminReceipt,
} from "../lib/adminAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const EMAIL_LIMIT = 320;
const REASON_MIN = 8;
const REASON_MAX = 500;

router.use("/admin/accounts", requireAdmin, requireOwner);

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function presentAccount(userId: string) {
  const [account, staff] = await Promise.all([
    getClerkAccountAccessById(userId),
    resolveStaffPrincipal(userId),
  ]);
  return account ? { ...account, staffRole: staff?.role ?? null } : null;
}

router.get("/admin/accounts/lookup", async (req, res): Promise<void> => {
  const candidate = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  const input = LookupAdminAccountQueryParams.safeParse({ email: candidate });
  if (!input.success || input.data.email.length > EMAIL_LIMIT) {
    res.status(400).json({
      error: "Enter a valid email address.",
      code: "admin_account_email_invalid",
    });
    return;
  }
  try {
    const account = await findClerkAccountAccessByEmail(input.data.email);
    if (!account) {
      res.status(404).json({
        error: "No NabuFlow account was found for that email address.",
        code: "admin_account_not_found",
      });
      return;
    }
    const staff = await resolveStaffPrincipal(account.userId);
    res.json(
      LookupAdminAccountResponse.parse({ account: { ...account, staffRole: staff?.role ?? null } }),
    );
  } catch {
    res.status(503).json({
      error: "Account access information is temporarily unavailable.",
      code: "admin_account_access_unavailable",
    });
  }
});

async function changeAccountAccess(req: Request, res: Response, banned: boolean): Promise<void> {
  const paramsSchema = banned ? SuspendAdminAccountParams : RestoreAdminAccountParams;
  const bodySchema = banned ? SuspendAdminAccountBody : RestoreAdminAccountBody;
  const params = paramsSchema.safeParse({ userId: one(req.params.userId).trim() });
  const body = bodySchema.safeParse({
    reason: typeof req.body?.reason === "string" ? req.body.reason.trim() : req.body?.reason,
  });
  if (!params.success || !params.data.userId || params.data.userId.length > 256) {
    res.status(400).json({ error: "A valid account is required.", code: "admin_account_invalid" });
    return;
  }
  if (!body.success) {
    res.status(400).json({
      error: `Give a reason between ${REASON_MIN} and ${REASON_MAX} characters.`,
      code: "admin_account_reason_invalid",
    });
    return;
  }

  const targetUserId = params.data.userId;
  const reason = body.data.reason;

  const actorUserId = req.userId!;
  if (banned && targetUserId === actorUserId) {
    res.status(409).json({
      error: "You cannot suspend your own account.",
      code: "admin_account_self_suspend_forbidden",
    });
    return;
  }

  try {
    const current = await presentAccount(targetUserId);
    if (!current) {
      res.status(404).json({
        error: "That NabuFlow account no longer exists.",
        code: "admin_account_not_found",
      });
      return;
    }
    if (banned && current.staffRole === "owner") {
      res.status(409).json({
        error: "An Owner account cannot be suspended. Transfer or remove the Owner role first.",
        code: "admin_account_owner_suspend_forbidden",
      });
      return;
    }

    if (current.banned === banned) {
      const responseSchema = banned ? SuspendAdminAccountResponse : RestoreAdminAccountResponse;
      res.json(responseSchema.parse({ ok: true, changed: false, account: current }));
      return;
    }

    const updated = await setClerkAccountBanned(targetUserId, banned);
    try {
      await writeAdminReceipt({
        actorUserId,
        actorRole: "owner",
        kind: "action",
        action: banned ? "account_access_suspended" : "account_access_restored",
        targetUserId,
        previousRole: current.staffRole,
        nextRole: current.staffRole,
        reason,
        outcome: "completed",
        requestMethod: req.method,
        requestPath: `/api/admin/accounts/:userId/${banned ? "suspend" : "restore"}`,
      });
    } catch (receiptError) {
      try {
        await setClerkAccountBanned(targetUserId, current.banned);
      } catch (rollbackError) {
        logger.error(
          { receiptError, rollbackError, targetUserId, banned },
          "Account access receipt and compensating rollback both failed",
        );
        res.status(503).json({
          error: "The account change could not be audited and requires immediate review.",
          code: "admin_account_access_review_required",
        });
        return;
      }
      res.status(503).json({
        error: "The account change was rolled back because its audit receipt could not be saved.",
        code: "admin_account_access_audit_unavailable",
      });
      return;
    }

    const responseSchema = banned ? SuspendAdminAccountResponse : RestoreAdminAccountResponse;
    res.json(
      responseSchema.parse({
        ok: true,
        changed: true,
        account: { ...updated, staffRole: current.staffRole },
      }),
    );
  } catch (error) {
    logger.warn({ error, targetUserId, banned }, "Admin account access change failed");
    res.status(503).json({
      error: "Account access could not be changed right now.",
      code: "admin_account_access_unavailable",
    });
  }
}

router.post("/admin/accounts/:userId/suspend", (req, res) => changeAccountAccess(req, res, true));
router.post("/admin/accounts/:userId/restore", (req, res) => changeAccountAccess(req, res, false));

export default router;
