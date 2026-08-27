import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CORE_ZERO_CALL_SITES = [
  "builder.ts",
  "agent-loop.ts",
  "architect.ts",
  "planning-brain.ts",
  "subagent.ts",
  "ai.ts",
] as const;

describe("Zero model call identity coverage", () => {
  it.each(CORE_ZERO_CALL_SITES)("requires one explicit identity at every call in %s", (file) => {
    const source = readFileSync(resolve(here, file), "utf8");
    const providerCalls = source.match(/(?:create|stream)ChatCompletion\(\{/gu)?.length ?? 0;
    const identities = source.match(/\bzeroCall\s*:/gu)?.length ?? 0;

    expect(providerCalls, `${file} must continue to contain a provider call`).toBeGreaterThan(0);
    expect(identities, `${file} has a Zero call without a first-class identity`).toBe(
      providerCalls,
    );
  });
});
