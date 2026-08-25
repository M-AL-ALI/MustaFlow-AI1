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

const refinementPrompt = first.contentBySourceId.get("prompt:builder:REFINE_SYSTEM_PROMPT");
assert.ok(refinementPrompt, "the production refinement prompt must be inventoried");
assert.match(refinementPrompt, /MINIMUM-DIFF DISCIPLINE/u);
assert.match(refinementPrompt, /Preserve all content, structure, styling, and behavior unrelated/u);
assert.match(refinementPrompt, /do not rewrite, restyle, reorganize, add meta tags or scripts/u);
assert.match(refinementPrompt, /localised change in a file of ANY size/u);
assert.match(refinementPrompt, /exact copy, selector, or value correction/u);
assert.match(refinementPrompt, /EXACT-CORRECTION EXAMPLE/u);
assert.match(refinementPrompt, /changing any other byte is incorrect/u);
assert.doesNotMatch(refinementPrompt, /\$\{REFINE_BIAS_TO_ACTION\}/u);
assert.doesNotMatch(refinementPrompt, /\$\{CODE_QUALITY_RULES\}/u);
const refinementPrompts = [...first.contentBySourceId.entries()].filter(([id]) =>
  id.endsWith("REFINE_SYSTEM_PROMPT"),
);
assert.equal(refinementPrompts.length, 13);
for (const [id, content] of refinementPrompts) {
  assert.match(content, /FINAL CHANGE-SCOPE OVERRIDE/u, `${id} must close on minimum-diff law`);
  assert.doesNotMatch(content, /\$\{REFINE_SCOPE_CLOSER\}/u, `${id} must resolve its closer`);
}

console.log(`manifest_sources=${first.manifest.sources.length}`);
console.log(`manifest_sha256=${first.manifestSha256}`);
console.log("skills=31 blueprints=40");
console.log("database=not consulted");
console.log("zero_guidance_manifest_tests=PASS");
