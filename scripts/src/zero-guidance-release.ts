import type {
  ZeroGuidanceCoverageDefinition,
  ZeroGuidanceManifest,
} from "./zero-guidance-manifest";

export interface ZeroGuidanceLiveCaseResult {
  id: string;
  coverageId: string;
  score: number;
  passed: boolean;
  reasoning: string;
  error?: string;
}

export interface ZeroGuidanceLiveResult {
  schemaVersion: 1;
  resultId: string;
  gitSha: string;
  manifestSha256: string;
  fixtureSetSha256: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  results: ZeroGuidanceLiveCaseResult[];
}

export type ZeroGuidanceReleaseValidation =
  | { ok: true; code: "zero_guidance_live_result_valid" }
  | {
      ok: false;
      code:
        | "zero_guidance_live_result_invalid"
        | "zero_guidance_live_result_stale"
        | "zero_guidance_live_result_manifest_mismatch"
        | "zero_guidance_live_result_fixture_mismatch"
        | "zero_guidance_live_result_incomplete"
        | "zero_guidance_live_result_failed";
      detail: string;
    };

const TOOLING_PATHS = new Set([
  ".github/workflows/ci.yml",
  "scripts/src/eval-prompts.ts",
  "scripts/src/zero-guidance-cli.ts",
  "scripts/src/zero-guidance-live-eval.ts",
  "scripts/src/zero-guidance-live-cases.ts",
  "scripts/src/zero-guidance-manifest.test.ts",
  "scripts/src/zero-guidance-manifest.ts",
  "scripts/src/zero-guidance-release.test.ts",
  "scripts/src/zero-guidance-release.ts",
  "scripts/zero-guidance/coverage.json",
  "scripts/zero-guidance/manifest.json",
]);

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function zeroGuidanceChangeRequiresLiveEval(
  manifest: ZeroGuidanceManifest,
  changedPaths: readonly string[],
): boolean {
  const sourcePaths = new Set(manifest.sources.map((source) => source.sourcePath));
  return changedPaths.some((rawPath) => {
    const path = normalizePath(rawPath);
    return (
      sourcePaths.has(path) ||
      TOOLING_PATHS.has(path) ||
      path.startsWith("skills/") ||
      path.startsWith("blueprints/")
    );
  });
}

export function requiredLiveCoverageIds(
  coverage: readonly ZeroGuidanceCoverageDefinition[],
): string[] {
  return coverage
    .filter((definition) => definition.layer === "live")
    .map((definition) => definition.id)
    .sort();
}

export function validateZeroGuidanceLiveResult(input: {
  result: ZeroGuidanceLiveResult;
  expectedGitSha: string;
  expectedManifestSha256: string;
  expectedFixtureSetSha256: string;
  requiredCoverageIds: readonly string[];
  requiredCases: readonly { id: string; coverageId: string }[];
}): ZeroGuidanceReleaseValidation {
  const { result } = input;
  if (!/^[0-9a-f]{40}$/u.test(result.gitSha) || !result.model || !result.resultId) {
    return {
      ok: false,
      code: "zero_guidance_live_result_invalid",
      detail: "The named live result is missing a 40-hex head, model, or identity.",
    };
  }
  if (result.gitSha !== input.expectedGitSha) {
    return {
      ok: false,
      code: "zero_guidance_live_result_stale",
      detail: `Expected head ${input.expectedGitSha}; received ${result.gitSha}.`,
    };
  }
  if (result.manifestSha256 !== input.expectedManifestSha256) {
    return {
      ok: false,
      code: "zero_guidance_live_result_manifest_mismatch",
      detail: `Expected manifest ${input.expectedManifestSha256}; received ${result.manifestSha256}.`,
    };
  }
  if (result.fixtureSetSha256 !== input.expectedFixtureSetSha256) {
    return {
      ok: false,
      code: "zero_guidance_live_result_fixture_mismatch",
      detail: `Expected fixtures ${input.expectedFixtureSetSha256}; received ${result.fixtureSetSha256}.`,
    };
  }

  const expectedResultId = [
    "zero-guidance",
    result.gitSha,
    result.manifestSha256,
    result.fixtureSetSha256,
    result.model,
  ].join(":");
  if (result.resultId !== expectedResultId || result.totalCases !== result.results.length) {
    return {
      ok: false,
      code: "zero_guidance_live_result_invalid",
      detail: "The result identity or case count does not match its contents.",
    };
  }

  const observedCoverage = new Set(result.results.map((entry) => entry.coverageId));
  const missing = [...input.requiredCoverageIds].filter((id) => !observedCoverage.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "zero_guidance_live_result_incomplete",
      detail: `Missing live coverage: ${missing.sort().join(", ")}.`,
    };
  }

  const expectedCases = new Map(input.requiredCases.map((entry) => [entry.id, entry.coverageId]));
  const observedCases = new Map<string, string>();
  for (const entry of result.results) {
    if (observedCases.has(entry.id)) {
      return {
        ok: false,
        code: "zero_guidance_live_result_invalid",
        detail: `Duplicate live case result: ${entry.id}.`,
      };
    }
    observedCases.set(entry.id, entry.coverageId);
  }
  const missingCases = [...expectedCases.keys()].filter((id) => !observedCases.has(id));
  const unexpectedCases = [...observedCases.keys()].filter((id) => !expectedCases.has(id));
  const mismatchedCases = [...expectedCases].filter(
    ([id, coverageId]) => observedCases.get(id) !== coverageId,
  );
  if (
    result.results.length !== input.requiredCases.length ||
    missingCases.length > 0 ||
    unexpectedCases.length > 0 ||
    mismatchedCases.length > 0
  ) {
    return {
      ok: false,
      code: "zero_guidance_live_result_incomplete",
      detail: "The named result does not contain the exact declared live case set.",
    };
  }

  const passed = result.results.filter((entry) => entry.passed && !entry.error).length;
  const errored = result.results.filter((entry) => Boolean(entry.error)).length;
  const failed = result.results.length - passed - errored;
  if (result.passed !== passed || result.failed !== failed || result.errored !== errored) {
    return {
      ok: false,
      code: "zero_guidance_live_result_invalid",
      detail: "The aggregate counts do not match the case results.",
    };
  }
  if (failed > 0 || errored > 0) {
    return {
      ok: false,
      code: "zero_guidance_live_result_failed",
      detail: `${failed} live cases failed and ${errored} errored.`,
    };
  }
  return { ok: true, code: "zero_guidance_live_result_valid" };
}
