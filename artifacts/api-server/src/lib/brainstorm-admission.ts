import { createHash } from "node:crypto";
import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { admissionClientIp } from "./rateLimit";
import {
  reserveDualWindowAdmission,
  type DualWindowAdmissionResult,
} from "./brainstorm-admission-store";
import { logger } from "./logger";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function brainstormAdmissionConfig() {
  return {
    accountHourly: positiveIntegerEnv("BRAINSTORM_ACCOUNT_HOURLY_UNITS", 60),
    accountDaily: positiveIntegerEnv("BRAINSTORM_ACCOUNT_DAILY_UNITS", 200),
    authenticatedIpHourly: positiveIntegerEnv("BRAINSTORM_AUTHENTICATED_IP_HOURLY_UNITS", 120),
    authenticatedIpDaily: positiveIntegerEnv("BRAINSTORM_AUTHENTICATED_IP_DAILY_UNITS", 400),
    anonymousIpHourly: positiveIntegerEnv("BRAINSTORM_ANONYMOUS_IP_HOURLY_UNITS", 60),
    anonymousIpDaily: positiveIntegerEnv("BRAINSTORM_ANONYMOUS_IP_DAILY_UNITS", 200),
  };
}

function admissionKey(kind: "account" | "ip", identity: string): string {
  const digest = createHash("sha256")
    .update(`brainstorm-admission-v1:${kind}:${identity}`)
    .digest("hex");
  return `brainstorm_admission:v1:${kind}:${digest}`;
}

export function brainstormAdmissionWeight(req: Request): 1 | 2 {
  return req.path.endsWith("/resolve") ? 2 : 1;
}

export function attachOptionalClerkUser(req: Request, _res: Response, next: NextFunction): void {
  try {
    const auth = getAuth(req);
    const userId = (auth?.sessionClaims?.["userId"] as string | undefined) ?? auth?.userId;
    if (userId) req.userId = userId;
  } catch {
    // Public chat stays public. An invalid optional session is anonymous and
    // still receives the stricter anonymous-IP hour/day boundary.
  }
  next();
}

function limitResponse(res: Response, decision: DualWindowAdmissionResult): void {
  const blockedWindow = decision.blockedWindow ?? "hour";
  const resetAtMs = blockedWindow === "day" ? decision.dayResetAtMs : decision.hourResetAtMs;
  res.status(429).json({
    error: `You've reached the brainstorming limit for this ${blockedWindow}. Try again after ${new Date(resetAtMs).toISOString()}.`,
    code: "brainstorm_limit_reached",
    limitWindow: blockedWindow,
    retryAfter: Math.max(1, Math.ceil((resetAtMs - decision.serverNowMs) / 1000)),
    resetAt: new Date(resetAtMs).toISOString(),
  });
}

async function reserve(input: {
  kind: "account" | "ip";
  identity: string;
  hourlyLimit: number;
  dailyLimit: number;
  weight: number;
}): Promise<DualWindowAdmissionResult> {
  return reserveDualWindowAdmission({
    key: admissionKey(input.kind, input.identity),
    hourlyLimit: input.hourlyLimit,
    dailyLimit: input.dailyLimit,
    weight: input.weight,
  });
}

export function brainstormAdmissionLimiter(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const config = brainstormAdmissionConfig();
    const weight = brainstormAdmissionWeight(req);
    const ip = admissionClientIp(req);

    try {
      if (req.userId) {
        const accountDecision = await reserve({
          kind: "account",
          identity: req.userId,
          hourlyLimit: config.accountHourly,
          dailyLimit: config.accountDaily,
          weight,
        });
        if (!accountDecision.allowed) {
          limitResponse(res, accountDecision);
          return;
        }

        const ipDecision = await reserve({
          kind: "ip",
          identity: ip,
          hourlyLimit: config.authenticatedIpHourly,
          dailyLimit: config.authenticatedIpDaily,
          weight,
        });
        if (!ipDecision.allowed) {
          limitResponse(res, ipDecision);
          return;
        }
      } else {
        const anonymousDecision = await reserve({
          kind: "ip",
          identity: ip,
          hourlyLimit: config.anonymousIpHourly,
          dailyLimit: config.anonymousIpDaily,
          weight,
        });
        if (!anonymousDecision.allowed) {
          limitResponse(res, anonymousDecision);
          return;
        }
      }
    } catch (err) {
      logger.warn(
        { errorClass: err instanceof Error ? err.constructor.name : "UnknownError" },
        "Brainstorm admission store unavailable",
      );
      res.status(503).json({
        error:
          "Brainstorming is temporarily unavailable because usage checks could not complete. Please try again shortly.",
        code: "brainstorm_admission_unavailable",
        retryable: true,
      });
      return;
    }

    next();
  })();
}
