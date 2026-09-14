import { describe, expect, it } from "vitest";
import { builderClarificationReply, builderPlanExecutionOptions } from "./builder-explicit-actions";

describe("explicit project execution controls", () => {
  it("makes Build now and Background execute with Main Agent, not a sticky planning mode", () => {
    expect(builderPlanExecutionOptions()).toEqual({
      planMode: false,
      agentIdentity: "main",
      agentIntent: "mutate",
    });
  });

  it("preserves the full request when an owner chooses Repair it now", () => {
    const request =
      "Execute this plan: repair the existing English-and-Arabic notebook. Preserve its files and database. Do not publish it.";
    const result = builderClarificationReply("Repair it now", request);
    expect(result.content).toBe(request + "\n\nMy answer to your clarification: Repair it now");
    expect(result.options).toEqual(builderPlanExecutionOptions());
  });

  it("keeps Investigate only read-only even when the original request mentions repairs", () => {
    expect(
      builderClarificationReply("Investigate only", "Investigate and repair this notebook").options,
    ).toEqual({ planMode: false, agentIdentity: "main", agentIntent: "observe" });
  });

  it.each([
    "Do not change this project. Inspect the failure.",
    "Save this as a project rejection: never add a database. Do not build or change files.",
  ])("does not override a protected request: %s", (request) => {
    const result = builderClarificationReply("Repair it now", request);
    expect(result.options.agentIntent).toBe("answer");
    expect(result.content.startsWith(request)).toBe(true);
  });

  it.each(["Change the layout", "Plan it first", "Repair it now and delete all files"])(
    "does not invent mutation approval from an unknown option: %s",
    (option) => {
      expect(builderClarificationReply(option, "Maybe the header").options).toEqual({
        planMode: false,
        agentIdentity: "main",
      });
    },
  );

  it("handles a missing visible original request without inventing context", () => {
    expect(builderClarificationReply("Repair it now")).toEqual({
      content: "Repair it now",
      options: builderPlanExecutionOptions(),
    });
  });
});
