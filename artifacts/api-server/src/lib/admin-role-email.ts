import type { RequestHandler } from "express";
import { findClerkAccountAccessByEmail } from "./clerk-users";

const EMAIL_LIMIT = 320;
const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const resolveAdminRoleGrantEmail: RequestHandler = async (req, res, next) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || email.length > EMAIL_LIMIT || !BASIC_EMAIL.test(email)) {
    res.status(400).json({
      error: "Enter a valid NabuFlow account email address.",
      code: "admin_role_email_invalid",
    });
    return;
  }

  try {
    const account = await findClerkAccountAccessByEmail(email);
    if (!account) {
      res.status(404).json({
        error:
          "No NabuFlow account was found for that email address. Ask the user to sign in first.",
        code: "admin_role_account_not_found",
      });
      return;
    }
    req.body = { ...req.body, email, userId: account.userId };
    next();
  } catch {
    res.status(503).json({
      error: "Staff identity verification is temporarily unavailable.",
      code: "admin_role_identity_unavailable",
    });
  }
};
