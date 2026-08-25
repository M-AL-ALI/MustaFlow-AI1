import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
import { TEST_GENERATION_MAX_STEPS, TEST_GENERATION_SYSTEM_PROMPT } from "./builder";

describe("browser test-generation contract", () => {
  it("leaves enough bounded steps to exercise invalid and successful form outcomes", () => {
    expect(TEST_GENERATION_MAX_STEPS).toBe(10);
    expect(TEST_GENERATION_SYSTEM_PROMPT).toContain(
      "submit invalid input and assert its user-visible error",
    );
    expect(TEST_GENERATION_SYSTEM_PROMPT).toContain(
      "then fill valid input, submit, and assert the user-visible success state",
    );
    expect(TEST_GENERATION_SYSTEM_PROMPT).toContain("Maximum 10 steps total");
    expect(TEST_GENERATION_SYSTEM_PROMPT).not.toContain("Maximum 5 steps total");
  });
});
