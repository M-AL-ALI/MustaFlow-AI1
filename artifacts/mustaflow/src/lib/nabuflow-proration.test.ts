import { describe, expect, it } from "vitest";

import { parseProrationPreview } from "./nabuflow-billing";

describe("NabuFlow plan-switch proration preview", () => {
  it("keeps the immediate delta separate from the next full-cycle charge", () => {
    expect(
      parseProrationPreview({
        currentPlanId: "orbit",
        targetPlanId: "comet",
        amountDueCents: 2996,
        nextCycleAmountCents: 5000,
        nextCycleStartsAt: "2026-10-01T01:35:23.000Z",
        currency: "usd",
        periodEnd: "2026-10-01T01:35:23.000Z",
        lines: [
          { description: "Unused time on NabuFlow Orbit", amountCents: -1997 },
          { description: "Remaining time on NabuFlow Comet", amountCents: 4993 },
        ],
      }),
    ).toEqual({
      currentPlanId: "orbit",
      targetPlanId: "comet",
      amountDueCents: 2996,
      nextCycleAmountCents: 5000,
      nextCycleStartsAt: "2026-10-01T01:35:23.000Z",
      currency: "usd",
      periodEnd: "2026-10-01T01:35:23.000Z",
      lines: [
        { description: "Unused time on NabuFlow Orbit", amountCents: -1997 },
        { description: "Remaining time on NabuFlow Comet", amountCents: 4993 },
      ],
    });
  });
});
