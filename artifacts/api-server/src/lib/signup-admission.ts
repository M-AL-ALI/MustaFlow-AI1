import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  reserveDualWindowAdmission,
  type DualWindowAdmissionResult,
} from "./brainstorm-admission-store";
import { logger } from "./logger";
import { admissionClientIp } from "./rateLimit";

export type ClerkSignupMutationStage =
  | "create"
  | "update"
  | "prepare_verification"
  | "attempt_verification";

export interface ClerkSignupMutation {
  stage: ClerkSignupMutationStage;
  weight: number;
}

// Clerk's installed SDK sends one create plus verification mutations during a
// normal email signup. Create carries three units; update/verification carry
// one. The 60/200 ceilings therefore admit twelve complete password-signup
// flows per hour and forty per day per accepted socket identity, while Clerk's
// own documented 5-create/10-second and 3-verification/10-second limits remain
// the short-burst boundary. Operators can tighten these without a code change.
export const SIGNUP_CREATE_WEIGHT = 3;
export const SIGNUP_FOLLOWUP_WEIGHT = 1;
export const SIGNUP_SOCKET_HOURLY_UNITS_DEFAULT = 60;
export const SIGNUP_SOCKET_DAILY_UNITS_DEFAULT = 200;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function signupAdmissionConfig() {
  return {
    socketHourly: positiveIntegerEnv(
      "SIGNUP_SOCKET_HOURLY_UNITS",
      SIGNUP_SOCKET_HOURLY_UNITS_DEFAULT,
    ),
    socketDaily: positiveIntegerEnv("SIGNUP_SOCKET_DAILY_UNITS", SIGNUP_SOCKET_DAILY_UNITS_DEFAULT),
  };
}

function clerkProxyPathname(originalUrl: string): string {
  return originalUrl.split("?", 1)[0] ?? "";
}

/**
 * Classify only the mutation paths emitted by the installed Clerk SDK.
 *
 * @clerk/clerk-js 6.14.0 declares pathRoot="/client/sign_ups" and uses:
 * - POST  /v1/client/sign_ups
 * - PATCH /v1/client/sign_ups/{id}
 * - POST  /v1/client/sign_ups/{id}/prepare_verification
 * - POST  /v1/client/sign_ups/{id}/attempt_verification
 *
 * SDK assets, environment/client reads, session refresh, sign-in, and unknown
 * future paths deliberately remain outside this classifier. A source-contract
 * regression makes any installed-SDK path change explicit instead of guessing.
 */
export function classifyClerkSignupMutation(
  method: string,
  originalUrl: string,
): ClerkSignupMutation | null {
  const verb = method.toUpperCase();
  const path = clerkProxyPathname(originalUrl);
  const root = "/api/__clerk/v1/client/sign_ups";

  if (verb === "POST" && path === root) {
    return { stage: "create", weight: SIGNUP_CREATE_WEIGHT };
  }

  const id = "[A-Za-z0-9_-]{1,128}";
  if (verb === "PATCH" && new RegExp(`^${root}/${id}$`).test(path)) {
    return { stage: "update", weight: SIGNUP_FOLLOWUP_WEIGHT };
  }

  const action = new RegExp(`^${root}/${id}/(prepare_verification|attempt_verification)$`).exec(
    path,
  )?.[1];
  if (verb === "POST" && action === "prepare_verification") {
    return { stage: "prepare_verification", weight: SIGNUP_FOLLOWUP_WEIGHT };
  }
  if (verb === "POST" && action === "attempt_verification") {
    return { stage: "attempt_verification", weight: SIGNUP_FOLLOWUP_WEIGHT };
  }
  return null;
}

function signupAdmissionKey(identity: string): string {
  const digest = createHash("sha256").update(`signup-admission-v1:ip:${identity}`).digest("hex");
  return `signup-admission:v1:ip:${digest}`;
}

function limitResponse(
  res: Response,
  mutation: ClerkSignupMutation,
  decision: DualWindowAdmissionResult,
): void {
  const blockedWindow = decision.blockedWindow ?? "hour";
  const resetAtMs = blockedWindow === "day" ? decision.dayResetAtMs : decision.hourResetAtMs;
  res.status(429).json({
    error: `You've reached the account creation limit for this ${blockedWindow}. Try again after ${new Date(resetAtMs).toISOString()}.`,
    code: "signup_limit_reached",
    stage: mutation.stage,
    limitWindow: blockedWindow,
    retryAfter: Math.max(1, Math.ceil((resetAtMs - decision.serverNowMs) / 1000)),
    resetAt: new Date(resetAtMs).toISOString(),
  });
}

export function clerkSignupAdmissionLimiter(req: Request, res: Response, next: NextFunction): void {
  // The Clerk proxy is production-only. Keep local/dev passthrough behavior
  // byte-identical when no upstream proxy will dispatch.
  if (process.env.NODE_ENV !== "production" || !process.env.CLERK_SECRET_KEY) {
    next();
    return;
  }

  const mutation = classifyClerkSignupMutation(req.method, req.originalUrl);
  if (!mutation) {
    next();
    return;
  }

  void (async () => {
    const config = signupAdmissionConfig();
    try {
      const decision = await reserveDualWindowAdmission({
        key: signupAdmissionKey(admissionClientIp(req)),
        hourlyLimit: config.socketHourly,
        dailyLimit: config.socketDaily,
        weight: mutation.weight,
      });
      if (!decision.allowed) {
        limitResponse(res, mutation, decision);
        return;
      }
    } catch (error) {
      logger.warn(
        {
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
          stage: mutation.stage,
        },
        "Signup admission store unavailable",
      );
      res.status(503).json({
        error:
          "Account creation is temporarily unavailable because usage checks could not complete. Please try again shortly.",
        code: "signup_admission_unavailable",
        stage: mutation.stage,
        retryable: true,
      });
      return;
    }

    next();
  })();
}
