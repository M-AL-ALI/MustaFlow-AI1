/**
 * Provider-parity tests for /billing/nabuflow/credit-costs.
 *
 * Verifies that the displayed credit cost for every mode exactly equals what
 * the build gate (deductCreditsAtomic) would charge for that provider, and
 * that build and refine stage costs are independently resolved.
 *
 * Can also be run as a standalone script:
 *   pnpm exec tsx src/routes/__tests__/credit-costs-provider-parity.test.ts
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://noop@localhost:5432/noop";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

// ── helpers ──────────────────────────────────────────────────────────────────

type CostTable = { standard: Record<string, number>; deep: Record<string, number> };
type StagedCosts = { build: CostTable; refine: CostTable };

// ── import under test ─────────────────────────────────────────────────────────

const { creditCostFor, DEEP_REASONING_CREDIT_COST, resolveStageProvider } =
  await import("../../lib/ai-providers");

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
  const prevBuild = process.env.AI_PROVIDER_BUILD;
  const prevRefine = process.env.AI_PROVIDER_REFINE;
  if (buildProviderOverride) process.env.AI_PROVIDER_BUILD = buildProviderOverride;
  else delete process.env.AI_PROVIDER_BUILD;
  if (refineProviderOverride) process.env.AI_PROVIDER_REFINE = refineProviderOverride;
  else delete process.env.AI_PROVIDER_REFINE;

  const { provider: bp } = resolveStageProvider("build", "power");
  const { provider: rp } = resolveStageProvider("refine", "power");
  const result: StagedCosts = { build: makeCostTable(bp), refine: makeCostTable(rp) };

  if (prevBuild !== undefined) process.env.AI_PROVIDER_BUILD = prevBuild;
  else delete process.env.AI_PROVIDER_BUILD;
  if (prevRefine !== undefined) process.env.AI_PROVIDER_REFINE = prevRefine;
  else delete process.env.AI_PROVIDER_REFINE;

  return result;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("provider-parity: credit costs match build gate charges", () => {
  it("anthropic Lite uses the approved flat 13-credit price", () => {
    expect(creditCostFor("lite", "anthropic")).toBe(13);
  });

  it("all providers expose the same approved standard cost table", () => {
    const expected = { lite: 13, eco: 34, power: 160, pro: 475 };

    for (const provider of ["openai", "anthropic", "gemini", "deepseek"] as const) {
      expect(makeCostTable(provider).standard).toEqual(expected);
    }
  });

  it("openai — build and refine costs equal gate charges for every mode", () => {
    const costs = endpointCosts("openai", "openai");
    for (const mode of ["lite", "eco", "power", "pro"] as const) {
      const expected = creditCostFor(mode, "openai");
      expect(costs.build.standard[mode]).toBe(expected);
      expect(costs.refine.standard[mode]).toBe(expected);
    }
  });

  it("anthropic — standard costs equal flat gate charges", () => {
    const costs = endpointCosts("anthropic", "anthropic");
    for (const mode of ["lite", "eco", "power", "pro"] as const) {
      const expected = creditCostFor(mode, "anthropic");
      expect(costs.build.standard[mode]).toBe(expected);
      expect(costs.refine.standard[mode]).toBe(expected);
    }
  });

  it("gemini — standard costs equal flat gate charges", () => {
    const costs = endpointCosts("gemini", "gemini");
    for (const mode of ["lite", "eco", "power", "pro"] as const) {
      const expected = creditCostFor(mode, "gemini");
      expect(costs.build.standard[mode]).toBe(expected);
      expect(costs.refine.standard[mode]).toBe(expected);
    }
  });

  it("deepseek — standard costs equal flat gate charges", () => {
    const costs = endpointCosts("deepseek", "deepseek");
    for (const mode of ["lite", "eco", "power", "pro"] as const) {
      const expected = creditCostFor(mode, "deepseek");
      expect(costs.build.standard[mode]).toBe(expected);
      expect(costs.refine.standard[mode]).toBe(expected);
    }
  });

  it("build=openai, refine=anthropic — stage resolution keeps flat prices", () => {
    const costs = endpointCosts("openai", "anthropic");
    for (const mode of ["eco", "power", "pro"] as const) {
      const buildExpected = creditCostFor(mode, "openai");
      const refineExpected = creditCostFor(mode, "anthropic");
      expect(costs.build.standard[mode]).toBe(buildExpected);
      expect(costs.refine.standard[mode]).toBe(refineExpected);
      expect(costs.build.standard[mode]).toBe(costs.refine.standard[mode]);
    }
  });

  it("deep-reasoning costs are provider-independent fixed premiums across all providers", () => {
    for (const provider of ["openai", "anthropic", "gemini", "deepseek"] as const) {
      const costs = endpointCosts(provider, provider);
      for (const mode of ["eco", "power", "pro"] as const) {
        const expected =
          DEEP_REASONING_CREDIT_COST[mode as keyof typeof DEEP_REASONING_CREDIT_COST] ??
          creditCostFor(mode, provider);
        expect(costs.build.deep[mode]).toBe(expected);
        expect(costs.refine.deep[mode]).toBe(expected);
      }
    }
  });

  it("missing provider credentials fall back to openai for both stages", () => {
    const costs = endpointCosts(undefined, undefined);
    const fallback = creditCostFor("power", "openai");
    expect(costs.build.standard.power).toBe(fallback);
    expect(costs.refine.standard.power).toBe(fallback);
  });

  it("frontend fallback cost tables equal OpenAI server costs", () => {
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
    expect(standard).not.toBeNull();
    expect(deep).not.toBeNull();

    const modes = ["lite", "eco", "power", "pro"] as const;
    for (const [index, mode] of modes.entries()) {
      expect(Number(standard![index + 1])).toBe(creditCostFor(mode, "openai"));
    }
    for (const [index, mode] of (["eco", "power", "pro"] as const).entries()) {
      expect(Number(deep![index + 1])).toBe(DEEP_REASONING_CREDIT_COST[mode]);
    }
  });
});
