import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

// Static JRN151 regressions against the actual factory template. Avoid importing
// builder.ts and its runtime dependencies. These do not evaluate model output,
// interpolated platform guidance, intent routing, or execution enforcement.
const builderSource = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");
const factoryMatch = builderSource.match(
  /export function createConverseSystemPrompt\(\): string \{\r?\n  return `([\s\S]*?)`;\r?\n\}/,
);
assert.ok(factoryMatch, "The converse prompt factory template must be available");
const prompt = factoryMatch[1];

test("OBSERVE requires a meaningful diagnosis tied to the original request and evidence", () => {
  assert.match(prompt, /For an OBSERVE request, address the full original request/);
  assert.match(prompt, /using only the project context actually supplied in this turn/);
  assert.match(
    prompt,
    /provide a meaningful diagnosis from the available evidence or an explicit inability/,
  );
  assert.match(
    prompt,
    /Name the SPECIFIC file, line\/section, and suspected cause only when supported by supplied evidence/,
  );
  assert.match(prompt, /explain how that evidence relates to the reported symptom/);
  assert.match(
    prompt,
    /Distinguish observed facts from suspected causes and state the limits of static analysis/,
  );
});

test("missing context permits an honest inability and specific evidence request", () => {
  assert.match(
    prompt,
    /If supplied context is missing or too short, explicitly state what cannot be determined/,
  );
  assert.match(prompt, /identify the specific file, log output, or result needed/);
  assert.match(prompt, /Still report any supported partial findings/);
  assert.match(prompt, /Never invent evidence, a root cause, or a successful check/);
  assert.doesNotMatch(
    prompt,
    /NEVER say "I can't open tabs"|You DO have the file contents in your context/,
  );
});

test("run and verification requests cannot produce false action or next-turn promises", () => {
  assert.match(
    prompt,
    /This converse response does not open files or logs, run commands\/tests, or inspect live runtime/,
  );
  assert.match(
    prompt,
    /Never claim those actions happened or promise they will happen after another message/,
  );
  assert.match(
    prompt,
    /If execution is requested, state that it cannot be performed in this response/,
  );
  assert.match(prompt, /supplied results may be described only as supplied evidence/);
  assert.match(
    prompt,
    /NEVER replace a requested run, test, verification, or investigation with a generic action promise/,
  );
  assert.match(
    prompt,
    /Finish with the current diagnosis or explicit inability, not a generic promise/,
  );
  assert.doesNotMatch(
    prompt,
    /I'll (?:do that now|fix this now)|just send any message|next message they send|the previous classifier picked "explain"/i,
  );
  assert.doesNotMatch(
    prompt,
    /redirect the user to send any message|tell the user to trigger it|tell them to resend the request/i,
  );
});

test("OBSERVE preserves the no-mutation boundary despite general builder capabilities", () => {
  assert.match(
    prompt,
    /These read-only rules take precedence over general builder or image capability guidance/,
  );
  assert.match(prompt, /OBSERVE never mutates/);
  assert.match(
    prompt,
    /Do not edit files, apply repairs, write data, generate file modifications, or trigger builder execution/,
  );
  assert.match(
    prompt,
    /A request to investigate, run, test, or verify does not authorize mutation/,
  );
  assert.match(
    prompt,
    /NEVER treat an OBSERVE request, missing evidence, or a user follow-up as authorization to mutate/,
  );
  assert.match(prompt, /a separately authorized mutation path/);
});

test("an observed typed failure stays terminal without a success or repair fallback", () => {
  assert.match(prompt, /A supplied typed failure is terminal for this response/);
  assert.match(prompt, /explain the known failure and its limits/);
  assert.match(prompt, /do not turn it into success, an automatic retry, or a fallback repair/);
});

test("existing converse answer restrictions remain present", () => {
  const unchangedRestrictions = [
    "NEVER write a pre-written message for the user to copy-paste and send.",
    'Only suggest "Next steps:" for things the USER controls (UI settings, external config, third-party services)',
    "Never produce JSON, build reports, or file modifications in this mode",
    "Keep responses focused",
    "If the user asks something you genuinely don't know about their codebase, say so and tell them which file or tab to check",
  ];
  for (const restriction of unchangedRestrictions) {
    assert.ok(prompt.includes(restriction), `Missing existing restriction: ${restriction}`);
  }
});
