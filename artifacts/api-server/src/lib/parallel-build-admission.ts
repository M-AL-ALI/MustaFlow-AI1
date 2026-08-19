import { createHash } from "node:crypto";
import {
  getNabuflowSubscription,
  isNabuflowBillingExempt,
  isSealedStagingAcceptanceExempt,
  nabuflowTestBypassActive,
} from "./nabuflow-billing";
import { getNabuflowOrgSeatContext } from "./nabuflow-org";
import { getNabuflowPlan, NABUFLOW_PLANS, type NabuflowPlanId } from "./nabuflow-plans";

export const EXEMPT_PARALLEL_BUILD_LIMIT = NABUFLOW_PLANS.constellation.parallelBuildLimit;
export const PARALLEL_BUILD_ADMISSION_UNAVAILABLE_MESSAGE =
  "This build did not start because capacity checks are temporarily unavailable. Try again shortly.";

export type ParallelBuildAdmissionScope =
  | {
      kind: "owner";
      ownerId: string;
      planId: NabuflowPlanId | "bounded-no-plan" | "bounded-exempt";
      limit: number;
      lockId: number;
    }
  | {
      kind: "nabuflow-org";
      orgId: number;
      planId: "constellation";
      limit: number;
      lockId: number;
    };

export type ParallelBuildAdmissionDecision =
  | { allowed: true; limit: number; activeBuilds: number }
  | {
      allowed: false;
      code: "parallel_build_limit_reached";
      message: string;
      planId: ParallelBuildAdmissionScope["planId"];
      limit: number;
      activeBuilds: number;
      retryable: true;
    };

function admissionLockId(identity: string): number {
  return createHash("sha256")
    .update(`nabuflow-parallel-build-v1:${identity}`)
    .digest()
    .readInt32BE(0);
}

export function evaluateParallelBuildAdmission(
  scope: Pick<ParallelBuildAdmissionScope, "planId" | "limit">,
  activeBuilds: number,
): ParallelBuildAdmissionDecision {
  const normalizedActive = Math.max(0, Math.floor(activeBuilds));
  if (normalizedActive < scope.limit) {
    return { allowed: true, limit: scope.limit, activeBuilds: normalizedActive };
  }

  return {
    allowed: false,
    code: "parallel_build_limit_reached",
    message: `Your plan allows ${scope.limit} running build${scope.limit === 1 ? "" : "s"} at once. Wait for one to finish, then try again.`,
    planId: scope.planId,
    limit: scope.limit,
    activeBuilds: normalizedActive,
    retryable: true,
  };
}

/**
 * Resolve the billable account that owns build admission. Collaborators consume
 * the project's owner/org allowance; request-caller identity is deliberately not
 * accepted here. Existing subscription/org helpers remain the only tier authority.
 */
export async function resolveParallelBuildAdmissionScope(
  ownerId: string,
): Promise<ParallelBuildAdmissionScope> {
  if (nabuflowTestBypassActive() || (await isSealedStagingAcceptanceExempt(ownerId))) {
    return {
      kind: "owner",
      ownerId,
      planId: "bounded-exempt",
      limit: EXEMPT_PARALLEL_BUILD_LIMIT,
      lockId: admissionLockId(`owner:${ownerId}`),
    };
  }

  const orgContext = await getNabuflowOrgSeatContext(ownerId);
  if (orgContext) {
    const limit = NABUFLOW_PLANS.constellation.parallelBuildLimit;
    return {
      kind: "nabuflow-org",
      orgId: orgContext.org.id,
      planId: "constellation",
      limit,
      lockId: admissionLockId(`nabuflow-org:${orgContext.org.id}`),
    };
  }

  if (await isNabuflowBillingExempt(ownerId)) {
    return {
      kind: "owner",
      ownerId,
      planId: "bounded-exempt",
      limit: EXEMPT_PARALLEL_BUILD_LIMIT,
      lockId: admissionLockId(`owner:${ownerId}`),
    };
  }

  const subscription = await getNabuflowSubscription(ownerId);
  if (subscription) {
    const plan = getNabuflowPlan(subscription.planId);
    if (!plan) throw new Error("NabuFlow subscription has an unknown admission plan");
    return {
      kind: "owner",
      ownerId,
      planId: plan.id,
      limit: plan.parallelBuildLimit,
      lockId: admissionLockId(`owner:${ownerId}`),
    };
  }

  // The existing billing gate remains authoritative for the honest no-plan
  // terminal. Keep admission bounded without shadowing that more specific error.
  return {
    kind: "owner",
    ownerId,
    planId: "bounded-no-plan",
    limit: EXEMPT_PARALLEL_BUILD_LIMIT,
    lockId: admissionLockId(`owner:${ownerId}`),
  };
}
