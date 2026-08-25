import assert from "node:assert/strict";
import {
  buildPromptEvalCandidateEvidence,
  classifyPromptEvalGeneration,
  parsePromptEvalJudgeDecision,
  promptEvalJudgeInstruction,
  selectPromptEvalJudgeConsensus,
} from "./prompt-eval-evidence";

const longContent = `HEAD_SENTINEL${"x".repeat(40_000)}TAIL_SENTINEL`;
const validJson = JSON.stringify({
  files: [{ path: "index.html", content: longContent, mimeType: "text/html" }],
  unchangedFiles: [],
});
const first = buildPromptEvalCandidateEvidence(validJson, true);
const second = buildPromptEvalCandidateEvidence(validJson, true);

assert.deepEqual(first, second, "candidate evidence must be deterministic");
assert.equal(first.jsonValid, true);
assert.match(first.display, /parsed successfully/u);
assert.match(first.display, /HEAD_SENTINEL/u);
assert.match(first.display, /TAIL_SENTINEL/u);
assert.match(first.display, /"truncated": true/u);
assert.ok(first.display.length <= 24_000);
assert.match(first.outputSha256, /^[0-9a-f]{64}$/u);

const invalid = buildPromptEvalCandidateEvidence('{"files":[', true);
assert.equal(invalid.jsonValid, false);
assert.match(invalid.display, /did not parse/u);

const fitsWhole = buildPromptEvalCandidateEvidence(
  JSON.stringify({ content: `HEAD${"m".repeat(14_000)}MIDDLE_SENTINEL${"n".repeat(3_000)}TAIL` }),
  true,
);
assert.equal(fitsWhole.jsonValid, true);
assert.match(fitsWhole.display, /MIDDLE_SENTINEL/u);
assert.doesNotMatch(fitsWhole.display, /"truncated": true/u);

const plain = buildPromptEvalCandidateEvidence(longContent, false);
assert.equal(plain.jsonValid, null);
assert.match(plain.display, /HEAD_SENTINEL/u);
assert.match(plain.display, /TAIL_SENTINEL/u);

const sourceAudit = buildPromptEvalCandidateEvidence(
  "The supplied source requires a request-bound receipt.",
  false,
  "source-audit-answer",
);
assert.match(sourceAudit.display, /complete explanatory answer/u);
assert.doesNotMatch(sourceAudit.display, /Candidate is plain text/u);

assert.deepEqual(parsePromptEvalJudgeDecision('{"score":8,"reasoning":"Meets the rubric."}'), {
  score: 8,
  reasoning: "Meets the rubric.",
});
assert.equal(parsePromptEvalJudgeDecision("not-json"), null);
assert.equal(parsePromptEvalJudgeDecision('{"score":11,"reasoning":"Invalid score."}'), null);
assert.equal(parsePromptEvalJudgeDecision('{"score":8,"reasoning":""}'), null);

assert.deepEqual(selectPromptEvalJudgeConsensus([{ score: 8, reasoning: "passes" }]), {
  decision: { score: 8, reasoning: "passes" },
  requiresConsensus: false,
});
assert.equal(selectPromptEvalJudgeConsensus([{ score: 3, reasoning: "first failure" }]), null);
assert.deepEqual(
  selectPromptEvalJudgeConsensus([
    { score: 2, reasoning: "false negative" },
    { score: 8, reasoning: "passes" },
    { score: 9, reasoning: "passes strongly" },
  ]),
  { decision: { score: 8, reasoning: "passes" }, requiresConsensus: true },
);

assert.equal(classifyPromptEvalGeneration("", true), "empty");
assert.equal(classifyPromptEvalGeneration("  \n", false), "empty");
assert.equal(classifyPromptEvalGeneration('{"files":[', true), "invalid_json");
assert.equal(classifyPromptEvalGeneration('{"files":[]}', true), null);
assert.equal(classifyPromptEvalGeneration("A complete plain-text reply.", false), null);

assert.match(promptEvalJudgeInstruction("source-audit-answer"), /explanatory answer/u);
assert.match(promptEvalJudgeInstruction("source-audit-answer"), /Do not require source files/u);
assert.doesNotMatch(promptEvalJudgeInstruction("artifact"), /Do not require source files/u);

console.log("prompt_eval_evidence_tests=PASS");
console.log("database=not consulted");
