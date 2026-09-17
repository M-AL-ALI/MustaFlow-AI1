import { describe, expect, it } from "vitest";
import { latestBuilderPlan } from "./latest-builder-plan";
const old = {
  id: 838,
  role: "assistant",
  planMode: true,
  plan: { goal: "Old goal", approach: "Old approach" },
};
describe("latest plan authority", () => {
  it.each([
    null,
    {},
    { intent: "plan", terminalRef: { taskId: 345 } },
    { kind: "error" },
    { kind: "cancelled" },
  ])("does not revive an older plan after a newer unavailable attempt %j", (plan) => {
    expect(latestBuilderPlan([old, { ...old, id: 842, plan }])).toEqual({
      messageId: 842,
      plan: null,
    });
  });
  it("uses the newest valid artifact", () => {
    const plan = { goal: "New goal", approach: "Client-only state" };
    expect(latestBuilderPlan([old, { ...old, id: 843, plan }])).toEqual({ messageId: 843, plan });
  });
  it("ignores user messages and non-plan reports without invalidating a valid plan", () => {
    expect(
      latestBuilderPlan([
        old,
        { ...old, id: 839, role: "user" },
        { ...old, id: 840, plan: { kind: "report" } },
      ])?.messageId,
    ).toBe(838);
  });
  it("distinguishes no plan from an unavailable plan", () => {
    expect(latestBuilderPlan(undefined)).toBeNull();
    expect(latestBuilderPlan([])).toBeNull();
  });
});
