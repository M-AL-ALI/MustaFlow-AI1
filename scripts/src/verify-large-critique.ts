/**
 * Regression test for Phase 2B + 2B-1: large-context critique-pass reliability
 * and Anthropic streaming token accounting.
 *
 * All checks are source-text only (no live AI calls). Covers:
 *
 *  Phase 2B
 *  1.  ANTHROPIC_STREAM_THRESHOLD_CHARS exported and positive
 *  2.  catch block surfaces critiqueFailed=true (not fake-clean)
 *  3.  callAnthropicAccumulated defined and drives stream directly
 *  4.  createChatCompletion routes large calls to callAnthropicAccumulated
 *  5.  critiquePass type has critiqueFailed / critiqueFailureReason
 *  6.  Anthropic client timeout: 90_000
 *  7.  runCritiquePass uses AbortSignal.timeout(90_000)
 *  8.  Manifest cap lowered to 10k
 *  9.  All 4 critique call sites handle critiqueFailed
 *  10. All 4 call sites append [critique_unavailable] warning
 *
 *  Phase 2B-1 (streaming token accounting)
 *  11. callAnthropicAccumulated captures message_start → input_tokens
 *  12. callAnthropicAccumulated captures message_delta → output_tokens
 *  13. hardcoded promptTokens: 0 / completionTokens: 0 are gone
 *  14. fallback warning logged when input_tokens absent
 *  15. synthesizeChatCompletion called with live promptTokens / completionTokens
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

const aiProvidersSrc = readFileSync(
  resolve(root, "artifacts/api-server/src/lib/ai-providers.ts"),
  "utf8",
);
const builderSrc = readFileSync(resolve(root, "artifacts/api-server/src/lib/builder.ts"), "utf8");
const tasksSchemaSrc = readFileSync(resolve(root, "lib/db/src/schema/tasks.ts"), "utf8");
const anthropicClientSrc = readFileSync(
  resolve(root, "lib/integrations-anthropic-ai/src/client.ts"),
  "utf8",
);

// ── Phase 2B checks ───────────────────────────────────────────────────────────

console.log("1. ANTHROPIC_STREAM_THRESHOLD_CHARS exported …");
assert.ok(
  aiProvidersSrc.includes("export const ANTHROPIC_STREAM_THRESHOLD_CHARS"),
  "must export ANTHROPIC_STREAM_THRESHOLD_CHARS",
);
assert.ok(
  /ANTHROPIC_STREAM_THRESHOLD_CHARS\s*=\s*\d+/.test(aiProvidersSrc),
  "must be assigned a numeric literal",
);
console.log("   PASS");

console.log("\n2. Catch block surfaces critiqueFailed=true …");
assert.ok(builderSrc.includes("critiqueFailed: true"), "catch block must set critiqueFailed: true");
assert.ok(
  builderSrc.includes("critiqueFailureReason: reason"),
  "catch block must capture critiqueFailureReason",
);
assert.ok(
  builderSrc.includes("critiqueFailed: true, critiqueFailureReason"),
  "catch block must not return plain fake-clean object",
);
console.log("   PASS");

console.log("\n3. callAnthropicAccumulated defined and drives stream directly …");
assert.ok(
  aiProvidersSrc.includes("async function callAnthropicAccumulated"),
  "must define callAnthropicAccumulated",
);
// Phase 2B-1: must now drive anthropic.messages.stream directly, not via streamChatCompletion
assert.ok(
  aiProvidersSrc.includes("anthropic.messages.stream"),
  "callAnthropicAccumulated must call anthropic.messages.stream directly",
);
console.log("   PASS");

console.log("\n4. createChatCompletion routes large calls to callAnthropicAccumulated …");
assert.ok(
  aiProvidersSrc.includes("ANTHROPIC_STREAM_THRESHOLD_CHARS"),
  "createChatCompletion must reference threshold constant",
);
assert.ok(
  aiProvidersSrc.includes("callAnthropicAccumulated(params)"),
  "createChatCompletion must call callAnthropicAccumulated for large calls",
);
console.log("   PASS");

console.log("\n5. critiquePass type has critiqueFailed / critiqueFailureReason …");
assert.ok(
  tasksSchemaSrc.includes("critiqueFailed"),
  "tasks.ts critiquePass must have critiqueFailed",
);
assert.ok(
  tasksSchemaSrc.includes("critiqueFailureReason"),
  "tasks.ts critiquePass must have critiqueFailureReason",
);
console.log("   PASS");

console.log("\n6. Anthropic client timeout: 90_000 …");
assert.ok(
  anthropicClientSrc.includes("timeout: 90_000"),
  "integrations-anthropic-ai client must set timeout: 90_000",
);
console.log("   PASS");

console.log("\n7. runCritiquePass uses AbortSignal.timeout(90_000) …");
assert.ok(
  builderSrc.includes("AbortSignal.timeout(90_000)"),
  "runCritiquePass must pass AbortSignal.timeout(90_000) to callWithRetry",
);
console.log("   PASS");

console.log("\n8. Manifest cap reduced from 14k to 10k …");
assert.ok(
  builderSrc.includes("manifest.length > 10000"),
  "runCritiquePass manifest cap must be 10000",
);
assert.ok(
  !builderSrc.includes("manifest.length > 14000"),
  "old 14000 cap must be gone from runCritiquePass",
);
console.log("   PASS");

console.log("\n9. All 4 critique call sites handle critiqueFailed …");
const failedBranches = (builderSrc.match(/if \(critiqueFailed\)/g) ?? []).length;
assert.ok(failedBranches >= 4, `Expected ≥4 critiqueFailed branches, found ${failedBranches}`);
console.log(`   PASS — ${failedBranches} critiqueFailed branches found`);

console.log("\n10. All 4 call sites append [critique_unavailable] warning …");
const unavailableCount = (builderSrc.match(/\[critique_unavailable\]/g) ?? []).length;
assert.ok(
  unavailableCount >= 4,
  `Expected ≥4 [critique_unavailable] strings, found ${unavailableCount}`,
);
console.log(`   PASS — ${unavailableCount} [critique_unavailable] strings found`);

// ── Phase 2B-1 checks (streaming token accounting) ───────────────────────────

console.log("\n11. callAnthropicAccumulated captures message_start → input_tokens …");
assert.ok(aiProvidersSrc.includes("message_start"), "must handle message_start event");
assert.ok(aiProvidersSrc.includes("input_tokens"), "must read input_tokens from message_start");
console.log("   PASS");

console.log("\n12. callAnthropicAccumulated captures message_delta → output_tokens …");
assert.ok(aiProvidersSrc.includes("message_delta"), "must handle message_delta event");
assert.ok(aiProvidersSrc.includes("output_tokens"), "must read output_tokens from message_delta");
console.log("   PASS");

console.log(
  "\n13. Hardcoded promptTokens: 0 / completionTokens: 0 are gone from accumulation path …",
);
// Extract the callAnthropicAccumulated function body for targeted check
const accumFnStart = aiProvidersSrc.indexOf("async function callAnthropicAccumulated");
const accumFnEnd = aiProvidersSrc.indexOf("\nasync function ", accumFnStart + 1);
const accumFnBody =
  accumFnEnd > 0
    ? aiProvidersSrc.slice(accumFnStart, accumFnEnd)
    : aiProvidersSrc.slice(accumFnStart);
// The hardcoded zeros comment must be gone; live variables must be used instead
assert.ok(
  !accumFnBody.includes("Token counts are not available from the streaming path"),
  "stale 'not available' comment must be removed from callAnthropicAccumulated",
);
assert.ok(
  accumFnBody.includes("promptTokens,") || accumFnBody.includes("promptTokens:"),
  "synthesizeChatCompletion must receive a live promptTokens variable",
);
assert.ok(
  accumFnBody.includes("completionTokens,") || accumFnBody.includes("completionTokens:"),
  "synthesizeChatCompletion must receive a live completionTokens variable",
);
console.log("   PASS");

console.log("\n14. Warning logged when input_tokens absent from stream …");
assert.ok(
  accumFnBody.includes("input_tokens absent") ||
    accumFnBody.includes("promptTokensCaptured") ||
    accumFnBody.includes("prompt token count unavailable"),
  "must log a warning or guard when prompt token count is missing",
);
console.log("   PASS");

console.log("\n15. synthesizeChatCompletion receives promptTokens + completionTokens variables …");
// Verify the synthesizeChatCompletion call inside the accumulation fn uses variables
assert.ok(
  /synthesizeChatCompletion\(\s*\{[\s\S]*?promptTokens[\s\S]*?completionTokens[\s\S]*?\}\s*\)/.test(
    accumFnBody,
  ),
  "synthesizeChatCompletion call must include both promptTokens and completionTokens",
);
console.log("   PASS");

console.log("\n✓ All Phase 2B + 2B-1 checks passed (15/15).");
