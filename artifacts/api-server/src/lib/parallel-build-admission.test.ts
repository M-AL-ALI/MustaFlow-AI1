import { beforeEach, describe, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  isExempt: vi.fn(),
  isStagingAcceptanceExempt: vi.fn(),
  testBypassActive: vi.fn(),
}));
const org = vi.hoisted(() => ({ getSeatContext: vi.fn() }));

vi.mock("./nabuflow-billing", () => ({
  getNabuflowSubscription: billing.getSubscription,
  isNabuflowBillingExempt: billing.isExempt,
  isSealedStagingAcceptanceExempt: billing.isStagingAcceptanceExempt,
  nabuflowTestBypassActive: billing.testBypassActive,
}));
vi.mock("./nabuflow-org", () => ({
  getNabuflowOrgSeatContext: org.getSeatContext,
}));

import {
  evaluateParallelBuildAdmission,
  EXEMPT_PARALLEL_BUILD_LIMIT,
  resolveParallelBuildAdmissionScope,
} from "./parallel-build-admission";

describe("parallel build admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    org.getSeatContext.mockResolvedValue(null);
    billing.isExempt.mockResolvedValue(false);
    billing.isStagingAcceptanceExempt.mockResolvedValue(false);
    billing.testBypassActive.mockReturnValue(false);
    billing.getSubscription.mockResolvedValue(null);
  });

  it.each([
    ["orbit", 1],
    ["comet", 3],
    ["nova", 6],
    ["constellation", 12],
  ] as const)("admits within and rejects at the %s plan limit", (planId, limit) => {
    expect(evaluateParallelBuildAdmission({ planId, limit }, limit - 1)).toEqual({
      allowed: true,
      limit,
      activeBuilds: limit - 1,
    });
    expect(evaluateParallelBuildAdmission({ planId, limit }, limit)).toMatchObject({
      allowed: false,
      code: "parallel_build_limit_reached",
      planId,
      limit,
      activeBuilds: limit,
      retryable: true,
      message: expect.stringContaining(`${limit} running build`),
    });
  });

  it("uses the project owner's live personal plan, not the requesting collaborator", async () => {
    billing.getSubscription.mockResolvedValue({ planId: "nova" });

    const scope = await resolveParallelBuildAdmissionScope("project-owner");

    expect(scope).toMatchObject({
      kind: "owner",
      ownerId: "project-owner",
      planId: "nova",
      limit: 6,
    });
    expect(billing.getSubscription).toHaveBeenCalledWith("project-owner");
  });

  it("shares the Constellation allowance across an existing organization", async () => {
    org.getSeatContext.mockResolvedValue({ org: { id: 47 } });

    await expect(resolveParallelBuildAdmissionScope("member-user")).resolves.toMatchObject({
      kind: "nabuflow-org",
      orgId: 47,
      planId: "constellation",
      limit: 12,
    });
    expect(billing.getSubscription).not.toHaveBeenCalled();
  });

  it("keeps exempt and no-plan owners bounded without changing the billing verdict", async () => {
    billing.isExempt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(resolveParallelBuildAdmissionScope("exempt-owner")).resolves.toMatchObject({
      planId: "bounded-exempt",
      limit: EXEMPT_PARALLEL_BUILD_LIMIT,
    });
    await expect(resolveParallelBuildAdmissionScope("no-plan-owner")).resolves.toMatchObject({
      planId: "bounded-no-plan",
      limit: EXEMPT_PARALLEL_BUILD_LIMIT,
    });
  });

  it.each(["test bypass", "sealed staging acceptance"] as const)(
    "keeps a subscribed %s identity explicitly bounded at twelve",
    async (mode) => {
      billing.getSubscription.mockResolvedValue({ planId: "orbit" });
      if (mode === "test bypass") {
        billing.testBypassActive.mockReturnValue(true);
      } else {
        billing.isStagingAcceptanceExempt.mockResolvedValue(true);
      }

      await expect(
        resolveParallelBuildAdmissionScope("subscribed-test-owner"),
      ).resolves.toMatchObject({
        kind: "owner",
        ownerId: "subscribed-test-owner",
        planId: "bounded-exempt",
        limit: EXEMPT_PARALLEL_BUILD_LIMIT,
      });
      expect(org.getSeatContext).not.toHaveBeenCalled();
      expect(billing.getSubscription).not.toHaveBeenCalled();
    },
  );

  it("derives a stable account lock while separating owner and organization identities", async () => {
    billing.getSubscription.mockResolvedValue({ planId: "orbit" });
    const first = await resolveParallelBuildAdmissionScope("same-id");
    const second = await resolveParallelBuildAdmissionScope("same-id");
    org.getSeatContext.mockResolvedValue({ org: { id: 9 } });
    const organization = await resolveParallelBuildAdmissionScope("same-id");

    expect(first.lockId).toBe(second.lockId);
    expect(organization.lockId).not.toBe(first.lockId);
  });

  it("shares one owner identity across projects while keeping different owners independent", async () => {
    billing.getSubscription.mockResolvedValue({ planId: "comet" });

    const firstProject = await resolveParallelBuildAdmissionScope("owner-one");
    const secondProject = await resolveParallelBuildAdmissionScope("owner-one");
    const otherOwner = await resolveParallelBuildAdmissionScope("owner-two");

    expect(firstProject.lockId).toBe(secondProject.lockId);
    expect(firstProject.lockId).not.toBe(otherOwner.lockId);
    expect(firstProject).toMatchObject({ ownerId: "owner-one", limit: 3 });
    expect(otherOwner).toMatchObject({ ownerId: "owner-two", limit: 3 });
  });
});
