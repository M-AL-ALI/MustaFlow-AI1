/**
 * Tests for Ora's rolling conversation summary (Task #1373).
 *
 * Covers:
 *   1. Empty overflow + no prior summary → ""
 *   2. Empty overflow but a prior summary → prior summary unchanged (no AI call)
 *   3. New overflow turns → merged summary returned from the model
 *   4. Whitespace-only messages are ignored (treated as nothing to fold in)
 *   5. Model error → fails safe to the prior summary
 *   6. Empty model output → fails safe to the prior summary
 *   7. Constants stay in lockstep with the documented contract
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const createChatCompletion = vi.fn();

vi.mock("../../ai-providers", () => ({
  createChatCompletion: (...args: unknown[]) => createChatCompletion(...args),
}));

import {
  updateConversationSummary,
  ORA_RECENT_WINDOW,
  ORA_SUMMARIZE_BATCH_MAX,
  type SummaryTurn,
} from "../conversation-summary";

function mockReply(content: string | null) {
  createChatCompletion.mockResolvedValueOnce({
    choices: [{ message: { content } }],
  });
}

const TURNS: SummaryTurn[] = [
  { role: "user", content: "My name is Sam and I run a bakery." },
  { role: "assistant", content: "Nice to meet you, Sam." },
];

describe("updateConversationSummary", () => {
  beforeEach(() => {
    createChatCompletion.mockReset();
  });

  it("returns empty string with no prior summary and nothing to fold in", async () => {
    const out = await updateConversationSummary({ priorSummary: "", newMessages: [] });
    expect(out).toBe("");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("keeps the prior summary unchanged when there is no new overflow", async () => {
    const out = await updateConversationSummary({
      priorSummary: "The user is Sam, a baker.",
      newMessages: [],
    });
    expect(out).toBe("The user is Sam, a baker.");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("merges prior summary with new overflow via the model", async () => {
    mockReply("The user is Sam, runs a bakery.");
    const out = await updateConversationSummary({
      priorSummary: "",
      newMessages: TURNS,
    });
    expect(out).toBe("The user is Sam, runs a bakery.");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("ignores whitespace-only messages (nothing to fold in)", async () => {
    const out = await updateConversationSummary({
      priorSummary: "prior",
      newMessages: [
        { role: "user", content: "   " },
        { role: "assistant", content: "\n\t" },
      ],
    });
    expect(out).toBe("prior");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("fails safe to the prior summary on model error", async () => {
    createChatCompletion.mockRejectedValueOnce(new Error("upstream 500"));
    const out = await updateConversationSummary({
      priorSummary: "The user is Sam.",
      newMessages: TURNS,
    });
    expect(out).toBe("The user is Sam.");
  });

  it("fails safe to the prior summary on empty model output", async () => {
    mockReply("   ");
    const out = await updateConversationSummary({
      priorSummary: "The user is Sam.",
      newMessages: TURNS,
    });
    expect(out).toBe("The user is Sam.");
  });

  it("keeps window/batch constants in lockstep with the documented contract", () => {
    expect(ORA_RECENT_WINDOW).toBe(20);
    expect(ORA_SUMMARIZE_BATCH_MAX).toBe(40);
  });
});
