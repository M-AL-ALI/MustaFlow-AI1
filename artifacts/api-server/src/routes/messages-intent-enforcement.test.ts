import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");

describe("authoritative message intent wiring", () => {
  it("uses the same durable receipt judge before both message route dispatches", () => {
    expect(source.match(/await persistAuthoritativeIntent\(\{/g)).toHaveLength(2);
    expect(source.match(/intentReceiptId: intentReceipt\.receiptId/g)).toHaveLength(2);
    expect(source).not.toContain("persistShadowIntent");
    expect(source).not.toContain("StreamResolvedIntent");
  });

  it("reuses a stream receipt when the regular route owns plan or mutation execution", () => {
    expect(source).toContain("intentReceiptStore.find(input.projectId, input.requestId)");
    expect(source).toContain('resolvedIntent === "plan" || resolvedIntent === "mutate"');
    expect(source).toContain('type: "fallback", intent: resolvedIntent');
  });

  it("persists answer-family tasks as answering and emits the receipt intent event", () => {
    expect(source.match(/status: "answering"/g)).toHaveLength(2);
    expect(source).toContain('type: "intent"');
    expect(source).toContain("receiptId: intentReceipt.receiptId");
  });

  it("keeps tagged project-choice captures answer-only even when an old client requests mutation", () => {
    expect(source.match(/isZeroProjectChoiceCaptureOnlyMessage\(content\)/g)).toHaveLength(2);
    expect(source.match(/explicitControl: authoritativeExplicitAgentIntent/g)).toHaveLength(2);
  });

  it("binds whole-project no-change controls before both route dispatches", () => {
    expect(
      source.match(/mutationForbidden: isExplicitNoProjectMutationRequest\(content\)/g),
    ).toHaveLength(2);
  });
});
