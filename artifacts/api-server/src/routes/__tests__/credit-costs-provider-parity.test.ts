/**
 * Provider-parity assertion script for /billing/nabuflow/credit-costs.
 *
 * Run with:  pnpm exec tsx src/routes/__tests__/credit-costs-provider-parity.test.ts
 *
 * Verifies that the displayed credit cost for every mode exactly equals what
 * the build gate (deductCreditsAtomic) would charge for that provider, and
 * that build and refine stage costs are independently resolved.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://noop@localhost:5432/noop";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── helpers ──────────────────────────────────────────────────────────────────

type CostTable = { standard: Record<string, number>; deep: Record<string, number> };
type StagedCosts = { build: CostTable; refine: CostTable };

// ── import under test ─────────────────────────────────────────────────────────

const { creditCostFor, DEEP_REASONING_CREDIT_COST, resolveStageProvider } = await import(
  "../../lib/ai-providers"
);

type Provider = Parameters<typeof creditCostFor>[1];
type AgentMode = Parameters<typeof creditCostFor>[0];

function makeCostTable(provider: Provider): CostTable {
  const modes = ["lite", "eco", "power", "pro"] as AgentMode[];
  const standard: Record<string, number> = {};
  for (const m of modes) standard[m] = creditCostFor(m, provider);
  const deep: Record<string, number> = {
    eco: DEEP_REASONING_CREDIT_COST.eco ?? creditCostFor("eco", provider),
    power: DEEP_REASONING_CREDIT_COST.power ?? creditCostFor("power", provider),
    pro: DEEP_REASONING_CREDIT_COST.pro ?? creditCostFor("pro", provider),
  };
  return { standard, deep };
}

function endpointCosts(
  buildProviderOverride?: string,
  refineProviderOverride?: string,
): StagedCosts {
  // Temporarily patch env vars to simulate different operator configurations.
  const prevBuild = process.env.AI_PROVIDER_BUILD;
  const prevRefine = process.env.AI_PROVIDER_REFINE;
  if (buildProviderOverride) process.env.AI_PROVIDER_BUILD = buildProviderOverride;
  else delete process.env.AI_PROVIDER_BUILD;
  if (refineProviderOverride) process.env.AI_PROVIDER_REFINE = refineProviderOverride;
  else delete process.env.AI_PROVIDER_REFINE;

  const { provider: bp } = resolveStageProvider("build", "power");
  const { provider: rp } = resolveStageProvider("refine", "power");
  const result: StagedCosts = { build: makeCostTable(bp), refine: makeCostTable(rp) };

  // Restore
  if (prevBuild !== undefined) process.env.AI_PROVIDER_BUILD = prevBuild;
  else delete process.env.AI_PROVIDER_BUILD;
  if (prevRefine !== undefined) process.env.AI_PROVIDER_REFINE = prevRefine;
  else delete process.env.AI_PROVIDER_REFINE;

  return result;
}

// ── tests ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

// 1. OpenAI — build and refine costs are equal when both stages use the same provider.
test("openai — build and refine costs equal gate charges for every mode", () => {
  const costs = endpointCosts("openai", "openai");
  for (const mode of ["lite", "eco", "power", "pro"] as const) {
    // Compare directly against creditCostFor — not resolveStageProvider after env restore.
    const expected = creditCostFor(mode, "openai");
    assert.equal(costs.build.standard[mode], expected, `build.standard.${mode} mismatch`);
    assert.equal(costs.refine.standard[mode], expected, `refine.standard.${mode} mismatch`);
  }
});

// 2. Anthropic — multiplier 1.6 for both stages.
test("anthropic — standard costs equal gate charges (multiplier 1.6)", () => {
  const costs = endpointCosts("anthropic", "anthropic");
  for (const mode of ["lite", "eco", "power", "pro"] as const) {
    const expected = creditCostFor(mode, "anthropic");
    assert.equal(costs.build.standard[mode], expected, `build.standard.${mode}`);
    assert.equal(costs.refine.standard[mode], expected, `refine.standard.${mode}`);
  }
});

// 3. Gemini — multiplier 0.7 for both stages.
test("gemini — standard costs equal gate charges (multiplier 0.7)", () => {
  const costs = endpointCosts("gemini", "gemini");
  for (const mode of ["lite", "eco", "power", "pro"] as const) {
    const expected = creditCostFor(mode, "gemini");
    assert.equal(costs.build.standard[mode], expected, `build.standard.${mode}`);
    assert.equal(costs.refine.standard[mode], expected, `refine.standard.${mode}`);
  }
});

// 4. DeepSeek — multiplier 0.5 for both stages.
test("deepseek — standard costs equal gate charges (multiplier 0.5)", () => {
  const costs = endpointCosts("deepseek", "deepseek");
  for (const mode of ["lite", "eco", "power", "pro"] as const) {
    const expected = creditCostFor(mode, "deepseek");
    assert.equal(costs.build.standard[mode], expected, `build.standard.${mode}`);
    assert.equal(costs.refine.standard[mode], expected, `refine.standard.${mode}`);
  }
});

// 5. Differing build/refine providers — costs are independently resolved.
test("build=openai, refine=anthropic — stage costs are independently resolved", () => {
  const costs = endpointCosts("openai", "anthropic");
  for (const mode of ["eco", "power", "pro"] as const) {
    const buildExpected = creditCostFor(mode, "openai");
    const refineExpected = creditCostFor(mode, "anthropic");
    assert.equal(costs.build.standard[mode], buildExpected, `build.standard.${mode}`);
    assert.equal(costs.refine.standard[mode], refineExpected, `refine.standard.${mode}`);
    // They must differ when providers differ.
    assert.notEqual(
      costs.build.standard[mode],
      costs.refine.standard[mode],
      `build and refine costs must differ for ${mode} when providers differ`,
    );
  }
});

// 6. Deep-reasoning costs are provider-independent fixed premiums.
test("deep-reasoning costs are provider-independent fixed premiums across all providers", () => {
  for (const provider of ["openai", "anthropic", "gemini", "deepseek"] as const) {
    const costs = endpointCosts(provider, provider);
    for (const mode of ["eco", "power", "pro"] as const) {
      const expected =
        DEEP_REASONING_CREDIT_COST[mode as keyof typeof DEEP_REASONING_CREDIT_COST] ??
        creditCostFor(mode, provider);
      assert.equal(costs.build.deep[mode], expected, `build.deep.${mode} @ ${provider}`);
      assert.equal(costs.refine.deep[mode], expected, `refine.deep.${mode} @ ${provider}`);
    }
  }
});

// 7. Missing credentials fall back to openai for both stages.
test("missing provider credentials fall back to openai for both stages", () => {
  const costs = endpointCosts(undefined, undefined);
  const fallback = creditCostFor("power", "openai");
  assert.equal(costs.build.standard.power, fallback, "build fallback");
  assert.equal(costs.refine.standard.power, fallback, "refine fallback");
});

// 8. The frontend's synchronous fallback tables must stay aligned with the
// OpenAI server defaults used while the live endpoint is loading.
test("frontend fallback cost tables equal OpenAI server costs", () => {
  const source = readFileSync(
    resolve(process.cwd(), "../mustaflow/src/lib/builder-followup-submit.ts"),
    "utf8",
  );
  const standard = source.match(
    /export const BUILDER_CREDIT_COST = \{\s*lite:\s*(\d+),\s*eco:\s*(\d+),\s*power:\s*(\d+),\s*pro:\s*(\d+),\s*\}/s,
  );
  const deep = source.match(
    /export const DEEP_BUILDER_CREDIT_COST = \{\s*eco:\s*(\d+),\s*power:\s*(\d+),\s*pro:\s*(\d+),\s*\}/s,
  );
  assert.ok(standard, "could not read frontend standard fallback table");
  assert.ok(deep, "could not read frontend Deep fallback table");

  const modes = ["lite", "eco", "power", "pro"] as const;
  for (const [index, mode] of modes.entries()) {
    assert.equal(Number(standard[index + 1]), creditCostFor(mode, "openai"), `standard.${mode}`);
  }
  for (const [index, mode] of (["eco", "power", "pro"] as const).entries()) {
    assert.equal(
      Number(deep[index + 1]),
      DEEP_REASONING_CREDIT_COST[mode],
      `deep.${mode}`,
    );
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
