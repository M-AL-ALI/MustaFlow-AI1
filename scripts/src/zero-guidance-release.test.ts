import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ZERO_GUIDANCE_COVERAGE,
  buildZeroGuidanceInventory,
  zeroGuidanceRepoRoot,
} from "./zero-guidance-manifest";
import {
  ZERO_GUIDANCE_FIXTURE_SET_SHA256,
  ZERO_GUIDANCE_LIVE_CASES,
} from "./zero-guidance-live-cases";
import {
  requiredLiveCoverageIds,
  expectedZeroGuidanceEvaluatedHead,
  ZERO_GUIDANCE_LIVE_RECEIPT_PATH,
  validateZeroGuidanceLiveResult,
  zeroGuidanceChangeRequiresLiveEval,
  type ZeroGuidanceLiveResult,
} from "./zero-guidance-release";

const inventory = await buildZeroGuidanceInventory(zeroGuidanceRepoRoot());
const head = "a".repeat(40);
const requiredCoverage = requiredLiveCoverageIds(ZERO_GUIDANCE_COVERAGE);
const results = ZERO_GUIDANCE_LIVE_CASES.map((liveCase) => ({
  id: liveCase.id,
  coverageId: liveCase.coverageId,
  score: 8,
  passed: true,
  reasoning: "Simulated deterministic release receipt.",
  outputChars: 120,
  outputSha256: "e".repeat(64),
  candidateEvidenceChars: 180,
  jsonValid: liveCase.jsonMode ? true : null,
  generationAttempts: 1,
  judgeAttempts: 1,
}));
const valid: ZeroGuidanceLiveResult = {
  schemaVersion: 1,
  resultId: [
    "zero-guidance",
    head,
    inventory.manifestSha256,
    ZERO_GUIDANCE_FIXTURE_SET_SHA256,
    "gpt-5-mini",
  ].join(":"),
  gitSha: head,
  manifestSha256: inventory.manifestSha256,
  fixtureSetSha256: ZERO_GUIDANCE_FIXTURE_SET_SHA256,
  model: "gpt-5-mini",
  startedAt: "2026-08-19T00:00:00.000Z",
  finishedAt: "2026-08-19T00:01:00.000Z",
  totalCases: results.length,
  passed: results.length,
  failed: 0,
  errored: 0,
  results,
};

const validate = (result: ZeroGuidanceLiveResult) =>
  validateZeroGuidanceLiveResult({
    result,
    expectedGitSha: head,
    expectedManifestSha256: inventory.manifestSha256,
    expectedFixtureSetSha256: ZERO_GUIDANCE_FIXTURE_SET_SHA256,
    requiredCoverageIds: requiredCoverage,
    requiredCases: ZERO_GUIDANCE_LIVE_CASES,
  });

assert.deepEqual(validate(valid), { ok: true, code: "zero_guidance_live_result_valid" });

assert.equal(
  expectedZeroGuidanceEvaluatedHead({
    releaseHead: "f".repeat(40),
    parentHead: head,
    changedPathsFromParent: [ZERO_GUIDANCE_LIVE_RECEIPT_PATH],
  }),
  head,
);
assert.equal(
  expectedZeroGuidanceEvaluatedHead({
    releaseHead: "f".repeat(40),
    parentHead: head,
    changedPathsFromParent: [ZERO_GUIDANCE_LIVE_RECEIPT_PATH, "artifacts/api-server/src/app.ts"],
  }),
  "f".repeat(40),
);

const stale = structuredClone(valid);
stale.gitSha = "b".repeat(40);
assert.equal(validate(stale).code, "zero_guidance_live_result_stale");

const wrongManifest = structuredClone(valid);
wrongManifest.manifestSha256 = "c".repeat(64);
assert.equal(validate(wrongManifest).code, "zero_guidance_live_result_manifest_mismatch");

const wrongFixtures = structuredClone(valid);
wrongFixtures.fixtureSetSha256 = "d".repeat(64);
assert.equal(validate(wrongFixtures).code, "zero_guidance_live_result_fixture_mismatch");

const incomplete = structuredClone(valid);
incomplete.results.pop();
incomplete.totalCases = incomplete.results.length;
incomplete.passed = incomplete.results.length;
assert.equal(validate(incomplete).code, "zero_guidance_live_result_incomplete");

const wrongCaseSet = structuredClone(valid);
wrongCaseSet.results[0]!.id = "undeclared-live-case";
assert.equal(validate(wrongCaseSet).code, "zero_guidance_live_result_incomplete");

const failed = structuredClone(valid);
failed.results[0]!.passed = false;
failed.results[0]!.score = 2;
failed.results[0]!.failureEvidence = "Bounded failed candidate specimen.";
failed.passed -= 1;
failed.failed = 1;
assert.equal(validate(failed).code, "zero_guidance_live_result_failed");

const failedWithoutEvidence = structuredClone(failed);
delete failedWithoutEvidence.results[0]!.failureEvidence;
assert.equal(validate(failedWithoutEvidence).code, "zero_guidance_live_result_invalid");

assert.equal(ZERO_GUIDANCE_LIVE_CASES.length, requiredCoverage.length);
assert.deepEqual(
  ZERO_GUIDANCE_LIVE_CASES.map((liveCase) => liveCase.coverageId).sort(),
  requiredCoverage,
);
assert.equal(
  new Set(ZERO_GUIDANCE_LIVE_CASES.map((liveCase) => liveCase.id)).size,
  ZERO_GUIDANCE_LIVE_CASES.length,
);
const sourcesById = new Map(inventory.manifest.sources.map((source) => [source.id, source]));
for (const liveCase of ZERO_GUIDANCE_LIVE_CASES) {
  assert.ok(liveCase.sourceIds.length > 0);
  for (const sourceId of liveCase.sourceIds) {
    const source = sourcesById.get(sourceId);
    assert.ok(source, `Live case ${liveCase.id} references missing source ${sourceId}`);
    assert.ok(
      source.coverageIds.includes(liveCase.coverageId),
      `Live case ${liveCase.id} maps ${sourceId} to ${liveCase.coverageId}, but the manifest declares ${source.coverageIds.join(", ")}`,
    );
  }
}

const representativeByKind = new Map<string, string>();
for (const source of inventory.manifest.sources) {
  if (!representativeByKind.has(source.kind))
    representativeByKind.set(source.kind, source.sourcePath);
}
for (const sourcePath of representativeByKind.values()) {
  assert.equal(zeroGuidanceChangeRequiresLiveEval(inventory.manifest, [sourcePath]), true);
}
assert.equal(zeroGuidanceChangeRequiresLiveEval(inventory.manifest, ["skills/new/SKILL.md"]), true);
assert.equal(
  zeroGuidanceChangeRequiresLiveEval(inventory.manifest, ["blueprints/new/blueprint.json"]),
  true,
);
assert.equal(
  zeroGuidanceChangeRequiresLiveEval(inventory.manifest, ["docs/unrelated-release-note.md"]),
  false,
);

const ciWorkflow = await readFile(join(zeroGuidanceRepoRoot(), ".github/workflows/ci.yml"), "utf8");
const promptEvalJob = ciWorkflow.slice(
  ciWorkflow.indexOf("  prompt-evals:"),
  ciWorkflow.indexOf("  # ── Task #753"),
);
assert.match(
  promptEvalJob,
  /fetch-depth:\s*0/u,
  "The release evaluator must fetch the full commit graph so a multi-commit push can inspect its exact before SHA",
);
assert.doesNotMatch(
  promptEvalJob,
  /AI_INTEGRATIONS_OPENAI_(?:API_KEY|BASE_URL)/u,
  "GitHub must not receive network-bound production AI credentials",
);
assert.match(
  promptEvalJob,
  /Validate the governed live-eval receipt/u,
  "Changed release heads must validate the governed receipt",
);

console.log(`required_live_coverage=${requiredCoverage.length}`);
console.log("stale_head=REJECTED manifest_mismatch=REJECTED fixture_mismatch=REJECTED");
console.log(`change_classes_selected=${representativeByKind.size}`);
console.log("database=not consulted");
console.log("zero_guidance_release_tests=PASS");
