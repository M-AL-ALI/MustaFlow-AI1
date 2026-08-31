import { describe, expect, it } from "vitest";
import {
  isProjectRetirementExecutionEnabled,
  PROJECT_RETIREMENT_EXECUTION_FLAG,
} from "./project-retirement-activation";

describe("project retirement activation", () => {
  it("fails closed when the rollout flag is absent or imprecise", () => {
    expect(isProjectRetirementExecutionEnabled({})).toBe(false);
    expect(
      isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "false" }),
    ).toBe(false);
    expect(isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "1" })).toBe(
      false,
    );
    expect(
      isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "TRUE" }),
    ).toBe(false);
  });

  it("enables provider cleanup only for the exact governed value", () => {
    expect(
      isProjectRetirementExecutionEnabled({ [PROJECT_RETIREMENT_EXECUTION_FLAG]: "true" }),
    ).toBe(true);
  });
});
