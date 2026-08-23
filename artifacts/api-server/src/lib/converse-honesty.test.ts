import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EmptyCompletionError } from "./empty-completion";
import { describeConverseFailure, EMPTY_COMPLETION_USER_MESSAGE } from "./converse-failure";

const builderSource = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");
const providersSource = readFileSync(new URL("./ai-providers.ts", import.meta.url), "utf8");
const messagesSource = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");

describe("converse completion honesty", () => {
  it("keeps the mode-to-model table explicit and gives converse a reasoning-aware budget", () => {
    expect(builderSource).toContain('lite: "gpt-5-nano"');
    expect(builderSource).toContain('eco: "gpt-5-mini"');
    expect(builderSource).toContain('power: "gpt-5.4"');
    expect(builderSource).toContain('pro: "gpt-5.4"');
    expect(builderSource).toContain("const CONVERSE_MAX_COMPLETION_TOKENS = 4_096");
    expect(builderSource.match(/disableThinking: true/g)).toHaveLength(2);
    expect(builderSource).toContain('cProvider === "gemini"');
    expect(builderSource).toContain('streamProv === "gemini"');
    expect(builderSource.match(/reasoning_effort: "low"/g)).toHaveLength(2);
    expect(providersSource).toContain("Provider parameter mapping:");
    expect(providersSource).toContain("disableThinking is consumed only by this branch");
    expect(providersSource).toContain('"AI stream completion summary"');
  });

  it("maps an empty completion to an honest typed user outcome", () => {
    const failure = describeConverseFailure(
      new EmptyCompletionError({
        finishReason: "length",
        outputTokens: 1_200,
        reasoningTokens: 1_200,
      }),
    );

    expect(failure).toEqual({
      code: "empty_completion",
      message: "Zero couldn't finish this response. Please try again.",
    });
    expect(EMPTY_COMPLETION_USER_MESSAGE).toContain("couldn't finish");
    expect(EMPTY_COMPLETION_USER_MESSAGE).toContain("try again");
  });

  it("persists typed failures and interrupted partial responses through both converse terminals", () => {
    expect(messagesSource.match(/describeConverseFailure\(err\)/g)).toHaveLength(2);
    expect(messagesSource.match(/cause: \{ code: failure\.code, stage:/g)).toHaveLength(1);
    expect(messagesSource.match(/err instanceof ConverseCompletionInterruptedError/g)).toHaveLength(
      2,
    );
    expect(messagesSource.match(/cause: interruption\.code/g)).toHaveLength(2);
    expect(messagesSource.match(/stopEvidence: converseResult\.stopEvidence/g)).toHaveLength(2);
    expect(messagesSource.match(/partialText\.trim\(\)/g)).toHaveLength(3);
    expect(
      (messagesSource.match(/intentReceiptId: terminalIntentReceiptId/g) ?? []).length,
    ).toBeGreaterThanOrEqual(4);
    expect(messagesSource).toContain("evidence: { summary: failure.message }");
  });

  it("makes the former 49-character mask unwritable anywhere under artifacts", () => {
    const forbidden = ["I couldn't generate", " a response. Please try again."].join("");
    const result = spawnSync("git", ["grep", "-n", "-F", forbidden, "--", "artifacts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stdout || result.stderr).toBe(1);
  });
});
