import assert from "node:assert/strict";
import { RUFLO_MCP_POLICY_VERSION, RUFLO_PINNED_VERSION } from "./ruflo-mcp-policy";
import type { RufloToolTransport } from "./ruflo-mcp-client";
import { RufloReadOnlyReviewAdapter } from "./ruflo-orchestration-adapter";

const calls: { name: string; args: Record<string, unknown> }[] = [];
const transport: RufloToolTransport = {
  async callTool(name, args) {
    calls.push({ name, args });
    if (name === "analyze_diff-risk") {
      return { ref: args.ref, risk: { overall: "high", score: 52, breakdown: {} } };
    }
    if (name === "analyze_diff-classify") {
      return { ref: args.ref, classification: { primary: "feature", confidence: 0.9 } };
    }
    if (name === "analyze_diff-stats") {
      return { totalFiles: 4, totalAdditions: 180, totalDeletions: 12 };
    }
    throw new Error(`unexpected tool ${name}`);
  },
};

const adapter = new RufloReadOnlyReviewAdapter(transport);
const subject = {
  baseRef: "main",
  headCommit: "a".repeat(40),
  headTree: "b".repeat(40),
};
const receipt = await adapter.review(subject);

assert.deepEqual(receipt, {
  schemaVersion: 1,
  provider: "ruflo",
  providerVersion: RUFLO_PINNED_VERSION,
  policy: RUFLO_MCP_POLICY_VERSION,
  subject,
  assessment: {
    risk: "high",
    riskScore: 52,
    classification: "feature",
    totalFiles: 4,
    totalAdditions: 180,
    totalDeletions: 12,
  },
  evidence: {
    tools: ["analyze_diff-risk", "analyze_diff-classify", "analyze_diff-stats"],
    noMutationAuthority: true,
  },
});
assert.deepEqual(calls.map((call) => call.name).sort(), [
  "analyze_diff-classify",
  "analyze_diff-risk",
  "analyze_diff-stats",
]);
assert.equal(
  calls.every((call) => call.args.ref === "main"),
  true,
);

await assert.rejects(
  () => adapter.review({ ...subject, headCommit: "not-a-commit" }),
  /ruflo_review_subject_invalid/u,
);

const malformed = new RufloReadOnlyReviewAdapter({
  async callTool(name) {
    if (name === "analyze_diff-risk") return { risk: { overall: "unknown", score: 1 } };
    if (name === "analyze_diff-classify") return { classification: { primary: "feature" } };
    return { totalFiles: 1, totalAdditions: 1, totalDeletions: 0 };
  },
});
await assert.rejects(() => malformed.review(subject), /ruflo_review_risk_invalid/u);

console.log("typed_receipt=PASS malformed_upstream=FAIL_CLOSED");
console.log("mutation_authority=NONE tools=3");
console.log("database=NONE environment=LAB store=IN_MEMORY kind=unit-test");
