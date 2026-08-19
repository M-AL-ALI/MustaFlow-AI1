import assert from "node:assert/strict";
import {
  ZERO_GUIDANCE_COVERAGE,
  buildZeroGuidanceInventory,
  renderZeroGuidanceCoverage,
  renderZeroGuidanceManifest,
  zeroGuidanceRepoRoot,
} from "./zero-guidance-manifest";

const first = await buildZeroGuidanceInventory(zeroGuidanceRepoRoot());
const second = await buildZeroGuidanceInventory(zeroGuidanceRepoRoot());

assert.equal(
  renderZeroGuidanceManifest(first.manifest),
  renderZeroGuidanceManifest(second.manifest),
);
assert.equal(first.manifestSha256, second.manifestSha256);
assert.equal(renderZeroGuidanceCoverage(), renderZeroGuidanceCoverage());

const sourceIds = first.manifest.sources.map((source) => source.id);
assert.equal(new Set(sourceIds).size, sourceIds.length);
assert.ok(first.manifest.sources.length > 170);

const byKind = new Map<string, typeof first.manifest.sources>();
for (const source of first.manifest.sources) {
  const group = byKind.get(source.kind) ?? [];
  group.push(source);
  byKind.set(source.kind, group);
}
assert.equal(byKind.get("skill-instructions")?.length, 31);
assert.equal(byKind.get("skill-eligibility")?.length, 31);
assert.equal(byKind.get("blueprint-instructions")?.length, 40);
assert.equal(byKind.get("blueprint-eligibility")?.length, 40);
assert.ok((byKind.get("static-prompt")?.length ?? 0) >= 30);

const coverageIds = new Set(ZERO_GUIDANCE_COVERAGE.map((definition) => definition.id));
const liveCoverageIds = new Set(
  ZERO_GUIDANCE_COVERAGE.filter((definition) => definition.layer === "live").map(
    (definition) => definition.id,
  ),
);
for (const source of first.manifest.sources) {
  assert.ok(!source.sourcePath.startsWith("/"));
  assert.ok(!/^[A-Za-z]:/u.test(source.sourcePath));
  assert.match(source.contentSha256, /^[0-9a-f]{64}$/u);
  assert.ok(source.contentBytes > 0);
  assert.ok(source.coverageIds.every((coverageId) => coverageIds.has(coverageId)));
  assert.ok(source.coverageIds.some((coverageId) => liveCoverageIds.has(coverageId)));
}

const rendered = renderZeroGuidanceManifest(first.manifest);
assert.ok(!rendered.includes(zeroGuidanceRepoRoot()));
assert.ok(!rendered.includes("AI_INTEGRATIONS_OPENAI_API_KEY"));
assert.ok(!rendered.includes("ENCRYPTION_KEY"));
const syntheticCredentialPrefix = ["sk", "test"].join("_") + "_";
assert.ok(!rendered.includes(syntheticCredentialPrefix));

console.log(`manifest_sources=${first.manifest.sources.length}`);
console.log(`manifest_sha256=${first.manifestSha256}`);
console.log("skills=31 blueprints=40");
console.log("database=not consulted");
console.log("zero_guidance_manifest_tests=PASS");
