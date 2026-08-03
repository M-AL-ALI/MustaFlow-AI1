import { afterEach, describe, expect, it } from "vitest";
import { creditCostFor } from "../ai-providers";
import { estimateQueueCreditCost } from "../queue-credit-costs";

const providerEnvKeys = ["AI_PROVIDER_BUILD", "AI_PROVIDER_REFINE"] as const;
const savedEnv = Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of providerEnvKeys) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("estimateQueueCreditCost", () => {
  it("prices an empty project as one build followed by stage-specific refines", () => {
    process.env.AI_PROVIDER_BUILD = "openai";
    process.env.AI_PROVIDER_REFINE = "deepseek";

    expect(
      estimateQueueCreditCost({
        taskCount: 3,
        hasFiles: false,
        agentMode: "power",
        deepReasoning: false,
      }),
    ).toBe(creditCostFor("power", "openai") + 2 * creditCostFor("power", "deepseek"));
  });

  it("prices every queued task as a refine for a project that already has files", () => {
    process.env.AI_PROVIDER_BUILD = "openai";
    process.env.AI_PROVIDER_REFINE = "deepseek";

    expect(
      estimateQueueCreditCost({
        taskCount: 2,
        hasFiles: true,
        agentMode: "power",
        deepReasoning: false,
      }),
    ).toBe(2 * creditCostFor("power", "deepseek"));
  });

  it("uses the queued task's Deep setting for each stage cost", () => {
    process.env.AI_PROVIDER_BUILD = "openai";
    process.env.AI_PROVIDER_REFINE = "deepseek";

    expect(
      estimateQueueCreditCost({
        taskCount: 2,
        hasFiles: false,
        agentMode: "pro",
        deepReasoning: true,
      }),
    ).toBe(creditCostFor("pro", "openai", true) + creditCostFor("pro", "deepseek", true));
  });
});
